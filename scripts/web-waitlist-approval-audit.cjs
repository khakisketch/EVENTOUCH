'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'waitlist-approval');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const people = (await read()).participants.slice(0, 6);
    const request = (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.equal((await request('participant.status', { ids: people.slice(0, 3).map(p => p.id), status: 'WAITLIST' })).status, 200);
    assert.equal((await request('participant.status', { id: people[3].id, status: 'PENDING' })).status, 200);
    assert.equal((await request('participant.status', { id: people[4].id, status: 'WAITLIST' })).status, 200);
    const conflict = await read(); conflict.participants.find(item => item.id === people[4].id).cancelled = true;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(conflict)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    const checkbox = person => page.getByRole('checkbox', { name: `${person.name} 선택`, exact: true });
    await checkbox(people[0]).check(); await checkbox(people[1]).check();
    if (process.argv.includes('--before')) {
      assert.equal(await page.locator('#roster-approve-selected').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: /대기자.*확정/ }).count(), 0);
      await page.screenshot({ path: path.join(out, 'before-1280.png'), fullPage: true });
      console.log('REPRODUCED: selected waitlist participants cannot be approved together'); return;
    }
    await checkbox(people[3]).check();
    await checkbox(people[4]).check();
    await page.getByText(/취소 기록 확인이 필요한 1명은 승인·확정에서 제외됩니다/).waitFor();
    assert.match(await page.getByRole('row').filter({ has: checkbox(people[4]) }).innerText(), /취소 상태 확인 필요/, 'the excluded person is identifiable in the desktop list');
    assert.equal(await page.getByRole('button', { name: '신청 승인 1', exact: true }).isEnabled(), true);
    const approve = page.getByRole('button', { name: '대기자 확정 2', exact: true });
    assert.equal(await approve.isEnabled(), true);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      if (width <= 768) assert.match(await checkbox(people[4]).locator('xpath=ancestor::li[1]').innerText(), /취소 상태 확인 필요/, 'the excluded person is identifiable on mobile');
      if (width !== 320) await page.screenshot({ path: path.join(out, `selected-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    let first = true; const attempts = [];
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'participant.status' || body.payload?.expectedStatus !== 'WAITLIST') return route.continue();
      attempts.push(body);
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch(); assert.equal(response.status(), 200);
      await route.abort('failed');
    });
    await approve.click();
    await page.getByText(/이전 대기자 확정 요청 2명/).waitFor();
    const afterCommit = await read();
    assert.deepEqual(people.slice(0, 2).map(p => afterCommit.participants.find(item => item.id === p.id).status), ['APPROVED', 'APPROVED']);
    assert.equal(afterCommit.participants.find(item => item.id === people[3].id).status, 'PENDING');
    assert.equal(afterCommit.participants.find(item => item.id === people[4].id).status, 'WAITLIST', 'cancel conflict stays excluded');
    await checkbox(people[0]).uncheck(); await checkbox(people[2]).check();
    await page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await page.getByText(/대기자 2명을 참가 확정했습니다/).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1], 'retry keeps the same targets, expected state and request ID');
    const messageHref = new URL(await page.locator('#roster-approved-message').getAttribute('href'), f.baseUrl);
    assert.equal(messageHref.searchParams.get('status'), 'APPROVED');
    assert.deepEqual(new Set(messageHref.searchParams.get('to').split(',')), new Set(people.slice(0, 2).map(person => person.id)), 'follow-up names only the confirmed original targets');
    assert.equal((await read()).participants.find(item => item.id === people[2].id).status, 'WAITLIST');
    assert.equal(await checkbox(people[2]).isChecked(), true);
    assert.equal(await checkbox(people[3]).isChecked(), true, 'a pending selection is not included in the waitlist approval');
    await page.unroute('**/api/events/*/commands');
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?status=WAITLIST`);
    await checkbox(people[2]).check();
    assert.equal((await request('participant.status', { id: people[2].id, status: 'PENDING', expectedStatus: 'WAITLIST' })).status, 200);
    const [stale] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.payload?.expectedStatus === 'WAITLIST'),
      page.getByRole('button', { name: '대기자 확정 1', exact: true }).click(),
    ]);
    assert.equal(stale.status(), 409);
    assert.equal((await stale.json()).code, 'PARTICIPANT_STATUS_CHANGED');
    assert.equal((await read()).participants.find(item => item.id === people[2].id).status, 'PENDING');
    assert.equal((await request('participant.status', { id: people[2].id, status: 'WAITLIST', expectedStatus: 'PENDING' })).status, 200);
    assert.equal((await request('participant.status', { id: people[3].id, status: 'WAITLIST', expectedStatus: 'PENDING' })).status, 200);
    const event = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    const approvedCount = (await read()).participants.filter(item => item.status === 'APPROVED').length;
    event.capacity = approvedCount + 1;
    await f.harness.database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [f.eventId, JSON.stringify(event)]);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?status=WAITLIST`);
    await checkbox(people[2]).check(); await checkbox(people[3]).check();
    await page.getByRole('button', { name: '대기자 확정 2', exact: true }).click();
    await page.getByText('확정 정원을 초과합니다', { exact: false }).first().waitFor();
    const afterCapacityError = await read();
    assert.deepEqual(people.slice(2, 4).map(p => afterCapacityError.participants.find(item => item.id === p.id).status), ['WAITLIST', 'WAITLIST'], 'insufficient seats roll back the whole selection');
    assert.equal(await checkbox(people[2]).isChecked(), true); assert.equal(await checkbox(people[3]).isChecked(), true);
    event.capacity = approvedCount + 2;
    await f.harness.database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [f.eventId, JSON.stringify(event)]);
    const retryCapacity = page.getByRole('button', { name: '대기자 확정 2', exact: true });
    await retryCapacity.focus(); await page.keyboard.press('Enter');
    await page.getByText(/대기자 2명을 참가 확정했습니다/).waitFor();
    const afterCapacityRepair = await read();
    assert.deepEqual(people.slice(2, 4).map(p => afterCapacityRepair.participants.find(item => item.id === p.id).status), ['APPROVED', 'APPROVED']);
    assert.equal(await page.getByLabel('상태별 보기', { exact: true }).inputValue(), '', 'the waitlist filter is released to show the confirmed participant');
    await page.screenshot({ path: path.join(out, 'confirmed-1280.png'), fullPage: true });
    assert.equal((await request('participant.status', { id: people[5].id, status: 'WAITLIST', expectedStatus: 'APPROVED' })).status, 200);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    const row = page.getByRole('row').filter({ has: checkbox(people[5]) });
    const [single] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.payload?.id === people[5].id),
      row.getByRole('button', { name: '확정', exact: true }).click(),
    ]);
    assert.equal(single.status(), 200);
    assert.equal(single.request().postDataJSON().payload.expectedStatus, 'WAITLIST');
    assert.equal((await read()).participants.find(item => item.id === people[5].id).status, 'APPROVED');
    assert.equal((await request('participant.status', { ids: [people[5].id, people[0].id], status: 'WAITLIST', expectedStatus: 'APPROVED' })).status, 200);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants`);
    await checkbox(people[5]).check();
    const beforeAttempts = []; let dropBefore = true;
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'participant.status' || body.payload?.expectedStatus !== 'WAITLIST') return route.continue();
      beforeAttempts.push(body);
      if (dropBefore) { dropBefore = false; return route.abort('failed'); }
      return route.continue();
    });
    await page.getByRole('button', { name: '대기자 확정 1', exact: true }).click();
    await page.getByText(/이전 대기자 확정 요청 1명/).waitFor();
    assert.equal((await read()).participants.find(item => item.id === people[5].id).status, 'WAITLIST');
    await checkbox(people[0]).check();
    await page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await page.getByText(/대기자 1명을 참가 확정했습니다/).waitFor();
    assert.deepEqual(beforeAttempts[0], beforeAttempts[1], 'a request lost before arrival keeps its original target and ID');
    const afterLostBefore = await read();
    assert.equal(afterLostBefore.participants.find(item => item.id === people[5].id).status, 'APPROVED');
    assert.equal(afterLostBefore.participants.find(item => item.id === people[0].id).status, 'WAITLIST');
    assert.equal(await checkbox(people[0]).isChecked(), true);
    console.log('PASS: single and batch waitlist approval, mixed scope, before/after response loss, stale status, capacity and keyboard');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
