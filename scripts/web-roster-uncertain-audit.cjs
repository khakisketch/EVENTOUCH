'use strict';
// Real isolated API and database, with post-commit response faults only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let stage = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'roster-uncertain-before' : 'roster-uncertain');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const run = async (command, payload) => {
      const res = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.json));
      return res.json;
    };
    await run('group.save', { name: '합성 그룹' });
    const created = await run('participant.import', { rows: Array.from({ length: 4 }, (_, i) => ({ name: `합성 복구 참가자 ${i + 1}`, phone: `0107777000${i + 1}`, company: '합성 회사' })) });
    const people = created.participants;
    await run('participant.status', { ids: people.map((person) => person.id), status: 'PENDING' });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'networkidle' });
    await page.locator('#roster-search').fill(people[0].name);
    await page.getByRole('checkbox', { name: `${people[0].name} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '그룹 변경', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('그룹', { exact: true }).selectOption('합성 그룹');
    await page.screenshot({ path: path.join(out, 'group-form-1280.png'), fullPage: true });
    let mode = 'lost';
    const requestIds = { 'group.assign': [], 'participant.status': [], 'reward.create': [] };
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (!Object.hasOwn(requestIds, body.command)) return route.continue();
      requestIds[body.command].push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${body.command} committed before fault`);
        mode = mode === 'lost' ? 'rejected' : 'pass';
        return mode === 'rejected' ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      if (mode === 'rate') { mode = 'pass'; return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시 시도하세요"}' }); }
      return route.continue();
    });

    stage = 'group request retains original selection';
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await dialog.getByText(/같은 요청으로 다시 시도/).waitFor();
    await page.screenshot({ path: path.join(out, 'group-unconfirmed-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'group-unconfirmed-390.png'), fullPage: true });
    if (before) { console.log('Roster uncertain before capture passed'); return; }
    assert.equal(await dialog.getByLabel('그룹', { exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('#roster-search').fill(people[1].name);
    await page.getByRole('checkbox', { name: `${people[1].name} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '그룹 지정 다시 확인' }).click();
    await dialog.getByText(/현재 선택과는 별개입니다/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.getByText(/같은 요청으로 다시 시도/).waitFor();
    assert.equal(await dialog.getByLabel('그룹', { exact: true }).isDisabled(), true);
    mode = 'rate';
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.getByText(/잠시 후 다시 시도하세요/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(requestIds['group.assign']).size, 1);
    let latest = await workspace();
    assert.equal(latest.participants.find((p) => p.id === people[0].id).group, '합성 그룹');
    assert.notEqual(latest.participants.find((p) => p.id === people[1].id).group, '합성 그룹');
    assert.equal(await page.getByRole('checkbox', { name: `${people[1].name} 선택`, exact: true }).isChecked(), true, 'a new selection is not silently cleared');

    stage = 'bulk approval after loss and rejection';
    await page.locator('#roster-search').fill('합성 복구 참가자');
    await page.getByRole('checkbox', { name: `${people[2].name} 선택`, exact: true }).check();
    mode = 'lost';
    await page.locator('#roster-approve-selected').click();
    const bulk = page.locator('#roster-bulk-retry-message');
    await bulk.getByRole('button', { name: '같은 요청으로 다시 시도' }).waitFor();
    await bulk.getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await bulk.getByText(/결과가 미확인/).waitFor();
    await bulk.getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await bulk.waitFor({ state: 'hidden' });
    assert.equal(new Set(requestIds['participant.status'].slice(-3)).size, 1);
    latest = await workspace();
    assert.equal(latest.participants.find((p) => p.id === people[1].id).status, 'APPROVED');
    assert.equal(latest.participants.find((p) => p.id === people[2].id).status, 'APPROVED');

    stage = 'reward registration after malformed response and rejection';
    await page.getByRole('button', { name: `${people[1].name} 참가자 상세` }).click();
    await page.getByRole('dialog').getByRole('button', { name: '경품 등록' }).click();
    const rewardDialog = page.getByRole('dialog', { name: `경품 등록 · ${people[1].name}` });
    await page.locator('#reward-name').fill('합성 경품');
    mode = 'malformed';
    await rewardDialog.getByRole('button', { name: '등록', exact: true }).click();
    await rewardDialog.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    assert.equal(await page.locator('#reward-name').getAttribute('readonly'), '');
    await rewardDialog.getByRole('button', { name: '닫기', exact: true }).click();
    await rewardDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '경품 등록 다시 확인' }).click();
    mode = 'rejected';
    await rewardDialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await rewardDialog.getByText(/같은 요청으로 다시 시도/).waitFor();
    await rewardDialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await rewardDialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(requestIds['reward.create']).size, 1);
    latest = await workspace();
    assert.equal(latest.rewards.filter((r) => r.name === '합성 경품' && r.participantId === people[1].id).length, 1);

    stage = 'reward pointer after reload';
    await page.getByRole('dialog', { name: people[1].name }).getByRole('button', { name: '경품 등록' }).click();
    await page.locator('#reward-name').fill('합성 재확인 경품');
    mode = 'malformed';
    await rewardDialog.getByRole('button', { name: '등록', exact: true }).click();
    await rewardDialog.getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    const savedPointer = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(savedPointer.includes('reward.create') && !savedPointer.includes('합성 재확인 경품'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    await page.getByRole('button', { name: `${people[1].name} 참가자 상세` }).click();
    const inspector = page.getByRole('dialog', { name: people[1].name });
    assert.equal(await inspector.getByRole('button', { name: '경품 등록' }).isDisabled(), true);
    const beforeCheck = requestIds['reward.create'].length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '경품 등록' && !button.disabled));
    assert.equal(requestIds['reward.create'].length, beforeCheck, 'server status lookup never creates another reward');
    latest = await workspace();
    assert.equal(latest.rewards.filter((r) => r.name === '합성 재확인 경품').length, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, groupSnapshotSurvivesSelectionChange: true, retainedOtherSelections: true, lostThenRejected: true, duplicateRewards: 0 }, null, 2), { mode: 0o600 });
    console.log('Roster: bulk, group and reward recovery use the original targets and request ids');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${stage}`, error); process.exitCode = 1; });
