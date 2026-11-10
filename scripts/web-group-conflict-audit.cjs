'use strict';
// Two operators, real isolated API/database, and synthetic response faults.
// No message is submitted to a provider.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'group-conflict-before' : 'group-conflict');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const run = async (command, payload) => {
      const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie,
        body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.json));
      return response.json;
    };
    await run('group.save', { name: '합성 VIP' });
    await run('group.save', { name: '합성 발표자' });
    const { participants: people } = await run('participant.import', { rows: [1, 2, 3].map((n) => ({ name: `그룹 검증 ${n}`, phone: `0107755000${n}`, company: '합성 회사' })) });
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants?group=${encodeURIComponent('일반')}`, { waitUntil: 'networkidle' });
    await page.locator('#roster-search').fill('그룹 검증');
    const checkbox = (person) => page.getByRole('checkbox', { name: `${person.name} 선택`, exact: true });
    await checkbox(people[0]).check(); await checkbox(people[1]).check();
    await page.getByRole('button', { name: '그룹 변경', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '그룹 지정' });
    await dialog.getByLabel('그룹', { exact: true }).selectOption('합성 발표자');
    await page.screenshot({ path: path.join(out, 'before-conflict-1280.png'), fullPage: true });
    if (before) { console.log('Group assignment previous-build capture passed'); return; }
    const attempts = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      const body = request.postDataJSON(); if (body?.command === 'group.assign') attempts.push(body);
    });
    phase = 'two operators';
    await run('group.assign', { group: '합성 VIP', ids: [people[0].id] });
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await dialog.getByRole('heading', { name: '선택한 참가자의 그룹이 변경됐습니다' }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'group-conflict-heading');
    let stored = await workspace();
    assert.equal(stored.participants.find((p) => p.id === people[0].id).group, '합성 VIP');
    assert.equal(stored.participants.find((p) => p.id === people[1].id).group, '일반');
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].payload.expectedGroups.map((p) => p.group), ['일반', '일반']);
    let badRead = 'failure';
    await page.route('**/api/events/*/bootstrap', async (route) => {
      if (badRead === 'failure') { badRead = 'partial'; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      if (badRead === 'partial') {
        badRead = 'pass'; const response = await route.fetch(); const body = await response.json();
        delete body.state.workspaces[fixture.eventId].participants.find((p) => p.id === people[0].id).group;
        return route.fulfill({ response, json: body });
      }
      return route.continue();
    });
    phase = 'read failures preserve selection';
    await dialog.getByRole('button', { name: '최신 명단 확인' }).click();
    await dialog.getByRole('alert').getByText(/최신 명단을 확인하지 못했습니다/).waitFor();
    await dialog.getByRole('button', { name: '최신 명단 확인' }).click();
    await dialog.getByRole('alert').getByText(/최신 명단을 확인하지 못했습니다/).waitFor();
    assert.equal(await dialog.getByLabel('그룹', { exact: true }).inputValue(), '합성 발표자');
    await dialog.getByRole('button', { name: '최신 명단 확인' }).click();
    await dialog.getByText('변경된 참가자 1명').waitFor();
    await dialog.getByText(/일반 → 합성 VIP/).waitFor();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(out, `conflict-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    }
    phase = 'review does not write';
    await dialog.getByRole('button', { name: '최신 명단으로 다시 검토' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(attempts.length, 1, 'review never saves');
    assert.equal(await dialog.getByLabel('그룹', { exact: true }).inputValue(), '합성 발표자');
    await dialog.getByText(/선택한 2명의 그룹을 바꿉니다/).waitFor();
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1].payload.expectedGroups.map((p) => p.group), ['합성 VIP', '일반']);
    stored = await workspace();
    assert.equal(stored.participants.find((p) => p.id === people[0].id).group, '합성 발표자');
    assert.equal(stored.participants.find((p) => p.id === people[1].id).group, '합성 발표자');
    assert.equal(stored.participants.find((p) => p.id === people[2].id).group, '일반');
    phase = 'ambiguous retry then definite group conflict';
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('combobox', { name: '그룹별 보기' }).selectOption('');
    await checkbox(people[2]).check();
    await page.getByRole('button', { name: '그룹 변경', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '그룹 지정' });
    await dialog.getByLabel('그룹', { exact: true }).selectOption('합성 VIP');
    let fault = 'abort';
    await page.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'group.assign') return route.continue();
      if (fault === 'abort') { fault = 'deny'; return route.abort('failed'); }
      if (fault === 'deny') { fault = 'pass'; return route.fulfill({ status: 403, json: { error: '접근을 확인하세요' } }); }
      return route.continue();
    });
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await dialog.getByText(/같은 요청으로 다시 시도/).waitFor();
    await run('group.assign', { group: '합성 발표자', ids: [people[2].id] });
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await checkbox(people[0]).check();
    await page.getByRole('button', { name: '그룹 지정 다시 확인' }).click();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.getByText(/같은 요청으로 다시 시도/).waitFor();
    await dialog.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.getByRole('heading', { name: '선택한 참가자의 그룹이 변경됐습니다' }).waitFor();
    assert.equal(new Set(attempts.slice(2, 5).map((attempt) => attempt.commandId)).size, 1, 'ambiguous retries use the original id');
    await dialog.getByRole('button', { name: '최신 명단 확인' }).click();
    await dialog.getByText(/일반 → 합성 발표자/).waitFor();
    await dialog.getByRole('button', { name: '최신 명단으로 다시 검토' }).click();
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    stored = await workspace();
    assert.equal(stored.participants.find((p) => p.id === people[2].id).group, '합성 VIP');
    assert.equal(await checkbox(people[0]).isChecked(), true, 'a separate later selection survives the original group request');
    phase = 'late response after moving to another event';
    const nextEventId = `group-next-${crypto.randomUUID()}`;
    const nextWorkspace = fixture.helpers.emptyWorkspace();
    nextWorkspace.groups = ['일반', '합성 VIP'];
    nextWorkspace.participants = [{ ...stored.participants.find((person) => person.id === people[0].id), name: '다른 행사 참가자', group: '일반' }];
    await fixture.helpers.insertEvent(fixture.harness.database, { orgId: fixture.helpers.LEGACY_ORG, id: nextEventId, slug: nextEventId,
      payload: { id: nextEventId, slug: nextEventId, name: '다른 합성 행사', date: '2026-12-01', start: '09:00', end: '17:00', stage: 'READY', features: [], capacity: 100 }, workspace: nextWorkspace });
    await fixture.helpers.insertMembership(fixture.harness.database, fixture.manager.id, nextEventId, ['all']);
    await page.goto(`${fixture.baseUrl}/console/events/${nextEventId}/participants`, { waitUntil: 'networkidle' });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'networkidle' });
    await page.locator('#roster-search').fill('그룹 검증');
    await checkbox(people[0]).check();
    await page.getByRole('button', { name: '그룹 변경', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '그룹 지정' });
    await dialog.getByLabel('그룹', { exact: true }).selectOption('합성 VIP');
    let releaseResponse, committed;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    const committedGate = new Promise((resolve) => { committed = resolve; });
    await page.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'group.assign') return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200); committed();
      await responseGate;
      await route.fulfill({ response }).catch(() => {});
    });
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await committedGate;
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '참가자 명단' }).waitFor();
    const secondEventPerson = page.getByRole('checkbox', { name: '다른 행사 참가자 선택', exact: true });
    await secondEventPerson.check();
    releaseResponse();
    await page.waitForTimeout(250);
    assert.equal(await secondEventPerson.isChecked(), true, 'late previous-event response does not clear new-event selection');
    assert.equal(await page.getByText(/명을 합성 VIP\(으\)로 지정했습니다/).count(), 0, 'old event notice is not shown on the other event');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ staleAtomicRejection: true, failedAndPartialReadsPreserve: true,
      noWriteOnReview: true, explicitSave: true, allTargetsPreserved: true, ambiguousDenialThenDefiniteConflict: true,
      unrelatedSelectionPreserved: true, keyboardFocusAndEnter: true, lateResponseAfterBrowserBack: true,
      routeComponentReuseNotProven: true, responsiveAndAxe: [320, 390, 1280] }, null, 2), { mode: 0o600 });
    console.log('Group assignment conflict: atomic rejection, review and explicit save passed');
    await context.close();
  } finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch((error) => { console.error(`Group conflict failed at ${phase}:`, error); process.exitCode = 1; });
