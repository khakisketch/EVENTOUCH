'use strict';
// Isolated participant-page drafts and synthetic images; no external upload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { floorplanPng } = require('../tests/helpers/floorplan-image.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'theme-recovery-before' : 'theme-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    const uploads = [];
    let releaseFirstLoss = () => {};
    let markFirstCommit = () => {};
    const firstCommitted = new Promise((resolve) => { markFirstCommit = resolve; });
    const firstLossReleased = new Promise((resolve) => { releaseFirstLoss = resolve; });
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      let key = '';
      if (body.command === 'attendee.page.save' && body.payload.intro.startsWith('합성 페이지 복구')) key = body.payload.intro;
      if (body.command === 'attendee.page.publish-reviewed') key = 'publish';
      if (!key) return route.continue();
      const rows = requests.get(key) || [];
      rows.push(body); requests.set(key, rows);
      if (key.endsWith('수정 후 거부')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      if (rows.length === 1) {
        const response = await route.fetch();
        assert.ok(response.ok(), `${key} committed before response fault`);
        if (key.endsWith('부분 응답')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ draftVersion: body.payload.expectedDraftVersion + 1, draft: { intro: '다른 소개' } }) });
        if (!before && key.endsWith('원래 요청')) { markFirstCommit(); await firstLossReleased; }
        return route.abort('failed');
      }
      if (rows.length === 2 && !key.endsWith('부분 응답')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      if (key === 'publish' && rows.length === 3) {
        const response = await route.fetch();
        assert.ok(response.ok());
        const altered = await response.json();
        altered.published.intro = '다른 게시 내용';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(altered) });
      }
      return route.continue();
    });
    await page.route('**/api/events/*/files?*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'POST' || url.searchParams.get('name') !== 'synthetic-banner.png') return route.continue();
      uploads.push(url.searchParams.get('commandId'));
      if (uploads.length === 1) { const response = await route.fetch(); assert.ok(response.ok()); return route.abort('failed'); }
      if (uploads.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/page`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^소개와 공개 범위/ }).click();
    const intro = page.locator('#home-intro');
    const save = page.getByRole('button', { name: '초안 저장', exact: true });
    const original = '합성 페이지 복구 원래 요청';
    phase = 'draft commit, lost response and later denial';
    await intro.fill(original);
    assert.equal(await save.isEnabled(), true);
    const contrastSamples = [];
    const sampleContrast = async (state, target = save) => {
      contrastSamples.push(...await target.evaluate(async (element, state) => {
        const channel = value => { const part = value / 255; return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4; };
        const luminance = color => { const rgb = (color.match(/[0-9.]+/g) || []).slice(0, 3).map(Number); return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]); };
        const frames = [];
        for (let frame = 0; frame < 14; frame++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const style = getComputedStyle(element), fore = luminance(style.color), back = luminance(style.backgroundColor);
          frames.push({ state, frame, foreground: style.color, background: style.backgroundColor, ratio: (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05) });
        }
        return frames;
      }, state));
    };
    await save.hover(); await sampleContrast('hover');
    await page.mouse.move(0, 0); await sampleContrast('leave');
    const publicContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const publicPage = await publicContext.newPage();
    await publicPage.goto(fixture.baseUrl, { waitUntil: 'networkidle' });
    // Reopened 2026-11-25 (owner: 랜딩 문의 모달과 새 CTA): 랜딩의 주 행동은 링크가 아니라 문의 창을 여는 '도입 문의하기' 버튼이다.
    const publicAction = publicPage.getByRole('main').getByRole('button', { name: '도입 문의하기', exact: true }).first();
    assert.match(await publicAction.getAttribute('class'), /primaryAction/, 'the sampled control is the landing primary action');
    await publicAction.hover(); await sampleContrast('landing-hover', publicAction);
    await publicPage.screenshot({ path: path.join(out, 'landing-primary-hover.png') });
    await publicPage.mouse.move(0, 0); await sampleContrast('landing-leave', publicAction);
    await publicContext.close();

    fs.writeFileSync(path.join(out, 'button-contrast.json'), JSON.stringify(contrastSamples, null, 2), { mode: 0o600 });
    assert.ok(contrastSamples.every(frame => frame.ratio >= 4.5), `primary button contrast drops during its transition: ${Math.min(...contrastSamples.map(frame => frame.ratio)).toFixed(2)}`);

    await save.click();
    if (!before) {
      let deadline;
      try {
        await Promise.race([firstCommitted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('the initial save did not commit')), 15000); })]);
      } finally { clearTimeout(deadline); }
      await page.getByLabel('참가자 티켓').focus();
      releaseFirstLoss();
    }
    await page.getByRole('alert').filter({ hasText: /저장 응답을 확인하지 못했습니다/ }).waitFor();
    if (!before) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByLabel('참가자 티켓').evaluate((element) => element === document.activeElement), true, 'a later error must not steal focus moved by the operator');
    }
    const denied = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await save.click();
    await denied;
    if (before) {
      await page.getByText('이 행사의 참가자 화면을 관리할 권한이 없습니다.').waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-denial-390.png'), fullPage: true });
      console.log('Theme before capture: a later denial replaces the draft editor');
      return;
    }
    await page.getByRole('alert').filter({ hasText: /이미 반영됐을 수 있습니다/ }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'theme-error');
    assert.equal(await intro.inputValue(), original, 'a later denial keeps the editor and its values');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'denial-recovery-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)));
    fs.writeFileSync(path.join(out, 'axe-details.json'), JSON.stringify(violations, null, 2), { mode: 0o600 });
    assert.deepEqual(violations.map(v => v.id), []);
    await save.click();
    await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
    assert.equal(new Set(requests.get(original).map((item) => item.commandId)).size, 1);
    assert.equal(new Set(requests.get(original).map((item) => JSON.stringify(item.payload))).size, 1);
    assert.equal((await workspace()).pageExperience.draft.intro, original);
    const afterFirst = (await workspace()).pageExperience.draftVersion;

    phase = 'partial draft response';
    await page.setViewportSize({ width: 1280, height: 900 });
    const partial = '합성 페이지 복구 부분 응답';
    await intro.fill(partial);
    await save.click();
    await page.getByRole('alert').filter({ hasText: /저장 결과를 확인하지 못했습니다/ }).waitFor();
    assert.equal(await intro.inputValue(), partial);
    await save.click();
    await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
    const afterPartial = (await workspace()).pageExperience;
    assert.equal(afterPartial.draftVersion, afterFirst + 1);
    assert.equal(afterPartial.draft.intro, partial);
    assert.equal(new Set(requests.get(partial).map((item) => item.commandId)).size, 1);

    phase = 'publication retains its version and request';
    async function publish() {
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      await page.getByRole('dialog', { name: '참가자 페이지 게시 검토', exact: true }).getByRole('button', { name: '게시하기', exact: true }).click();
    }
    await publish();
    await page.getByRole('alert').filter({ hasText: /게시 응답을 확인하지 못했습니다/ }).waitFor();
    const deniedPublish = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await publish();
    await deniedPublish;
    await page.getByRole('alert').filter({ hasText: /이미 게시됐을 수 있습니다/ }).waitFor();
    assert.equal(await intro.inputValue(), partial);
    await publish();
    await page.getByRole('alert').filter({ hasText: /게시 결과를 확인하지 못했습니다/ }).waitFor();
    const retained = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(retained.includes('attendee.page.publish-reviewed'), 'a wrong published body keeps its scoped receipt');
    await publish();
    await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
    assert.equal(new Set(requests.get('publish').map((item) => item.commandId)).size, 1);
    assert.equal((await workspace()).pageExperience.publishedVersion, afterPartial.draftVersion);

    phase = 'banner upload retains the same file and request';
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: /^배너/ }).click();
    await page.getByLabel('배너 이미지 선택').setInputFiles({ name: 'synthetic-banner.png', mimeType: 'image/png', buffer: floorplanPng() });
    const fileAlert = page.getByRole('alert').filter({ hasText: /업로드 응답을 확인하지 못했습니다/ });
    await fileAlert.waitFor();
    const deniedUpload = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/files?'));
    await fileAlert.getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await deniedUpload;
    const stillUnconfirmed = page.getByRole('alert').filter({ hasText: /이미 올라갔을 수 있으므로/ });
    await stillUnconfirmed.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'banner-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await stillUnconfirmed.getByRole('button', { name: '같은 요청으로 다시 시도' }).click();
    await page.getByText('배너 이미지를 올렸습니다. 참가자에게 보이려면 초안을 저장하고 게시하세요.', { exact: true }).waitFor();
    assert.equal(new Set(uploads).size, 1);
    assert.ok(uploads[0]);
    assert.equal((await fixture.harness.database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'synthetic-banner.png'])).rowCount, 1);

    phase = 'edited draft remains visible if a later different request is denied';
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: /^소개와 공개 범위/ }).click();
    const earlier = '합성 페이지 복구 수정 전 유실';
    const edited = '합성 페이지 복구 수정 후 거부';
    await intro.fill(earlier);
    await save.click();
    await page.getByRole('alert').filter({ hasText: /저장 응답을 확인하지 못했습니다/ }).waitFor();
    await intro.fill(edited);
    const differentDenial = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await save.click(); await differentDenial;
    await page.getByRole('alert').filter({ hasText: /편집 내용은 유지했습니다/ }).waitFor();
    assert.equal(await intro.inputValue(), edited);
    assert.notEqual(requests.get(earlier)[0].commandId, requests.get(edited)[0].commandId);
    assert.equal((await workspace()).pageExperience.draft.intro, earlier);
    const previousPointer = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(previousPointer.includes(requests.get(earlier)[0].commandId) && !previousPointer.includes(earlier) && !previousPointer.includes(edited));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, sameIdAndPayload: true, after403: true, validatesDraftAndVersion: true, uploadDuplicates: 0 }, null, 2), { mode: 0o600 });
    console.log('Participant page: draft, publication and banner recover their original requests after loss');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
