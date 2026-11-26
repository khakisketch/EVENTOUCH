'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'display-continuity'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  const { baseUrl, eventId, slug } = fixture;
  const endpoint = `/api/events/${eventId}/commands`;
  const publicUrl = `${baseUrl}/api/public/events/${slug}`;
  const run = async (command, payload) => {
    const result = await fixture.helpers.requestJson(fixture.harness.baseUrl, endpoint, {
      cookie: fixture.manager.cookie, method: 'POST', body: { commandId: randomUUID(), command, payload },
    });
    assert.ok(result.status >= 200 && result.status < 300, `${command}: ${result.status}`);
    return result.json;
  };
  let browser;
  try {
    const first = (await run('notice.save', { title: '동문 입장 안내', body: '동문 데스크에서 티켓을 확인합니다.', published: true })).notice;
    const second = (await run('notice.save', { title: '파트너 세션 안내', body: '두 번째 세션은 그랜드홀에서 열립니다.', published: true })).notice;
    const draw = (await run('module.save', { type: 'draw', title: '파트너 무대 추첨' })).module;
    await run('module.status', { id: draw.id, status: 'OPEN' });
    await run('display.set', { type: 'idle' });

    browser = await launchBrowser();
    const operatorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await operatorContext.addCookies([{ ...cookieForContext(fixture, 'manager'), url: baseUrl }]);
    const operator = await operatorContext.newPage();
    await operator.goto(`${baseUrl}/console/events/${eventId}/settings#settings-features`);
    const screenFeature = operator.getByRole('checkbox', { name: '행사장 출력', exact: true });
    await screenFeature.waitFor();
    assert.equal(await screenFeature.isChecked(), true);

    const publicContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const screen = await publicContext.newPage();
    const heading = screen.locator('.display-frame h2');
    const inactive = screen.getByRole('heading', { name: '잠시 후 화면이 표시됩니다', exact: true });
    await screen.goto(`${baseUrl}/screen/${slug}`, { waitUntil: 'networkidle' });
    await heading.waitFor();
    const initial = await heading.innerText();
    const observedAt = Date.now();
    assert.ok([first.title, second.title].includes(initial));
    const [fast] = await Promise.all([screen.waitForResponse(response => response.url() === publicUrl), screen.waitForTimeout(1400)]);
    assert.equal(fast.status(), 200);
    await fast.finished();
    const afterFastPoll = await heading.innerText();
    const fastPollKeptFrame = initial === afterFastPoll;
    if (process.argv.includes('--before')) await screen.screenshot({ path: path.join(out, 'rotation-baseline.png') });
    else {
      assert.equal(fastPollKeptFrame, true, 'a draw poll must not advance the ordinary frame');
      await screen.waitForFunction(previous => document.querySelector('.display-frame h2')?.textContent !== previous, initial, { timeout: 7000 });
      assert.ok(Date.now() - observedAt >= 4000, 'ordinary rotation must allow time to read');
      const lastFrame = await heading.innerText();
      await screen.route(publicUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
      const staleFrame = screen.getByRole('status').filter({ hasText: '마지막 화면입니다' });
      await staleFrame.waitFor();
      assert.equal(await heading.innerText(), lastFrame);
      // The screen has no refresh button: its own next poll recovers it.
      await staleFrame.waitFor({ state: 'hidden' });
      assert.equal(await heading.innerText(), lastFrame, 'recovering must not immediately advance the last good frame');
    }

    await run('display.set', { type: 'notice', noticeId: first.id });
    await screen.getByRole('heading', { name: first.title, exact: true }).waitFor();
    const save = operator.getByRole('button', { name: '운영 기능 저장', exact: true });
    const setEnabled = async enabled => {
      await screenFeature.setChecked(enabled);
      const [response] = await Promise.all([
        operator.waitForResponse(item => new URL(item.url()).pathname === endpoint && item.request().method() === 'POST'),
        save.click(),
      ]);
      assert.equal(response.status(), 200);
      await save.waitFor();
    };
    await setEnabled(false);
    await screen.bringToFront();
    const disabledProjection = await screen.request.get(publicUrl);
    const disabledSelection = (await disabledProjection.json()).workspace.display.type;
    if (process.argv.includes('--before')) {
      await screen.waitForResponse(response => response.url() === publicUrl);
      await screen.screenshot({ path: path.join(out, 'disabled-baseline.png') });
      console.log(JSON.stringify({ fastPollKeptFrame, disabledSelection, outputStopped: await inactive.isVisible() }));
      assert.ok(fastPollKeptFrame && disabledSelection === 'idle' && await inactive.isVisible(), 'baseline still advances ordinary slides early or projects disabled output');
      return;
    }
    assert.equal(disabledSelection, 'idle');
    await inactive.waitFor();
    assert.equal(await heading.count(), 0);
    assert.equal(await screen.getByText(first.body, { exact: true }).count(), 0);
    await screen.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await screen.setViewportSize({ width, height: 844 });
      assert.ok(await screen.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await screen.evaluate(async () => (await window.axe.run()).violations.map(item => item.id)), []);
      if (width !== 320) await screen.screenshot({ path: path.join(out, `output-disabled-${width}.png`) });
    }
    await screen.route(publicUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await screen.getByRole('status').filter({ hasText: '마지막으로 확인한 상태입니다' }).waitFor();
    assert.equal(await heading.count(), 0, 'an unavailable read must keep disabled output off');
    await screen.getByRole('status').filter({ hasText: '마지막으로 확인한 상태입니다' }).waitFor({ state: 'hidden' });
    assert.equal(await inactive.isVisible(), true);
    await setEnabled(true);
    await screen.bringToFront();
    await screen.getByRole('heading', { name: first.title, exact: true }).waitFor();
    await screen.screenshot({ path: path.join(out, 'output-restored-1280.png') });
    await run('event.stage', { stage: 'ENDED' });
    const ended = await (await screen.request.get(publicUrl)).json();
    assert.equal(ended.event.stage, 'ENDED');
    assert.equal(ended.workspace.display.noticeId, first.id);
    await run('form.close', {});
    await run('module.status', { id: draw.id, status: 'CLOSED' });
    await run('event.stage', { stage: 'ARCHIVED' });
    await screen.getByRole('heading', { name: '행사를 찾을 수 없습니다', exact: true }).waitFor();
    assert.equal(await heading.count(), 0);
    console.log('Fast draw reads keep the normal frame, disabled output stops and resumes in place, and archive removes the frame.');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => {
  console.error(String(error?.message || error).split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url]'));
  process.exitCode = 1;
});
