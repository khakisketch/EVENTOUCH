'use strict';

// Synthetic end-to-end recovery: a committed response is lost, reloading
// retains only opaque pointers, and a GET confirms without another write.
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { openProgram } = require('./ui-journey-helpers.cjs');
let stage = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-receipts');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture({ loseFirstResponseFor: 'response.submit' });
  let browser;
  try {
    const { database } = fixture.harness;
    const workspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const person = workspace.participants.find(p => p.status === 'APPROVED');
    assert.ok(person?.ticket);
    workspace.modules.push({ id: 'receipt-poll', type: 'poll', title: '결과 확인 투표', status: 'OPEN', published: true, options: ['첫째', '둘째'] });
    workspace.modules.push({ id: 'receipt-qa', type: 'qa', title: '질문 작성', status: 'OPEN', published: true });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    const event = (await database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    event.features = [...new Set([...(event.features || []), 'poll', 'qa'])];
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [fixture.eventId, JSON.stringify(event)]);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands')) writes += 1; });
    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/engage?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle' });
    const qa = await openProgram(page, '질문 작성');
    const input = qa.getByLabel('질문하기');
    await input.fill('잃어버리면 안 되는 합성 질문');
    stage = 'cancel navigation';
    const warning = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await page.getByRole('link', { name: '← 참가자 홈으로' }).click({ noWaitAfter: true });
    assert.match(await warning, /작성 중인 입력/);
    assert.equal(await input.inputValue(), '잃어버리면 안 되는 합성 질문');
    assert.match(new URL(page.url()).pathname, /\/engage$/);
    const beforeUnload = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    assert.equal(beforeUnload, true, 'dirty input registers browser-exit protection');

    const poll = await openProgram(page, '결과 확인 투표');
    await poll.getByRole('radio', { name: /^첫째/ }).check();
    await poll.getByRole('button', { name: '투표하기' }).click();
    const pending = page.locator('section').filter({ has: page.getByRole('heading', { name: '요청 결과 확인', exact: true }) });
    await pending.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    assert.equal(writes, 1);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await pending.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `recovery-${width}.png`), fullPage: true });
    }
    const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('eventouch.receipts.guest.')));
    assert.equal(stored.length, 1);
    const pointers = JSON.parse(stored[0][1]);
    assert.deepEqual(Object.keys(pointers[0]).sort(), ['command', 'commandId', 'eventId']);
    assert.equal(pointers[0].command, 'response.submit');
    assert.equal(stored[0][1].includes(person.ticket), false);
    assert.equal(stored[0][1].includes('첫째'), false);
    assert.equal(stored[0][1].includes('잃어버리면 안 되는'), false);
    stage = 'reload with only pointer';
    page.once('dialog', d => d.accept());
    await page.reload({ waitUntil: 'networkidle' });
    const saved = page.locator('section').filter({ has: page.getByRole('heading', { name: '서버 처리 결과 확인', exact: true }) });
    await saved.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    const withoutModules = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const savedModules = withoutModules.modules;
    withoutModules.modules = [];
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(withoutModules)]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('게시된 프로그램이 없습니다.', { exact: true }).waitFor();
    await saved.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    assert.equal(await page.getByRole('link', { name: '참가자 홈으로', exact: true }).count(), 1, 'a long recovery state retains its footer return');
    let lookups = 0;
    const routePattern = '**/command-receipts/*';
    await page.route(routePattern, route => { lookups += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'UNCONFIRMED' }) }); });
    await saved.getByRole('button', { name: '서버 처리 확인' }).click();
    await saved.getByRole('status').filter({ hasText: '아직 서버 처리 여부를 확인할 수 없습니다' }).waitFor();
    assert.equal(writes, 1, 'unconfirmed lookup never resends the write');
    assert.equal(lookups, 1);
    await page.unroute(routePattern);
    stage = 'server confirms commit';
    await saved.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.getByRole('status').filter({ hasText: '서버에 처리가 반영된 것을 확인했습니다' }).waitFor();
    assert.equal(writes, 1, 'confirmed lookup never resends the write');
    const after = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(after.responses.filter(row => row.moduleId === 'receipt-poll' && row.participantId === person.id).length, 1);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('eventouch.receipts.guest.'))), false);
    const restored = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    restored.modules = savedModules;
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(restored)]);
    await page.reload({ waitUntil: 'networkidle' });

    stage = 'storage unavailable';
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('eventouch.receipts.guest.')) throw new Error('synthetic blocked storage');
        return original.call(this, key, value);
      };
    });
    await page.route('**/api/events/*/commands', route => {
      let command;
      try { command = route.request().postDataJSON().command; } catch {}
      return command === 'question.submit' ? route.abort('failed') : route.continue();
    });
    const qaAgain = await openProgram(page, '질문 작성');
    await qaAgain.getByLabel('질문하기').fill('보관이 막힌 합성 질문');
    await qaAgain.getByRole('button', { name: '질문 등록' }).click();
    const storageWarning = page.locator('section').filter({ has: page.getByRole('heading', { name: '요청 결과 확인', exact: true }) });
    await storageWarning.getByRole('alert').filter({ hasText: '이 브라우저에서 결과 확인 정보를 저장할 수 없습니다' }).waitFor();
    assert.equal(await qaAgain.getByLabel('질문하기').inputValue(), '보관이 막힌 합성 질문');
    await context.close();
    process.stdout.write('Attendee receipt recovery: guarded draft, minimal tab pointer, unconfirmed and confirmed GET, no resend or duplicate passed\n');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => {
  const message = String(error && error.message || 'Unknown failure').split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url redacted]');
  console.error(`Stage ${stage}: ${message}`);
  process.exitCode = 1;
});
