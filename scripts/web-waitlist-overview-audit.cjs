'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axe } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'waitlist-overview'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const write = value => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(value)]);
    const readEvent = async () => (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    const writeEvent = value => f.harness.database.query('UPDATE events SET payload=$2::jsonb, revision=revision+1 WHERE id=$1', [f.eventId, JSON.stringify(value)]);
    const command = (name, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
    });
    const w = await read(); const people = w.participants.slice(0, 5);
    w.participants.forEach((person, i) => { person.status = i < 3 ? 'APPROVED' : i < 5 ? 'WAITLIST' : 'CANCELLED'; person.inside = false; person.everIn = false; });
    w.checks = []; await write(w);
    const event = await readEvent(); event.stage = 'LIVE'; event.capacity = 3; await writeEvent(event);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await page.locator('[data-task="waitlist-review"]').count(), 0, 'a full event has no claim of a vacant seat');
    assert.equal((await command('participant.status', { id: people[0].id, status: 'CANCELLED', expectedStatus: 'APPROVED' })).status, 200);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/bootstrap') && response.ok()),
      page.getByRole('button', { name: '새로고침', exact: true }).click(),
    ]);
    if (process.argv.includes('--before')) {
      assert.equal(await page.locator('[data-task="waitlist-review"]').count(), 0);
      assert.doesNotMatch(await page.locator('[aria-labelledby="event-now-heading"]').innerText(), /대기 명단|대기자/);
      await page.screenshot({ path: path.join(out, 'before-live-1280.png'), fullPage: true });
      console.log('REPRODUCED: a vacancy and waiting participants produce no overview task');
      return;
    }
    const task = page.locator('[data-task="waitlist-review"]');
    await task.getByText('2명', { exact: true }).waitFor();
    assert.match(await task.innerText(), /확정 2명 기준 1자리/);
    assert.match(await task.innerText(), /자동 확정되지 않습니다/);
    await page.addScriptTag({ content: axe });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `vacancy-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await task.getByRole('link', { name: '대기 명단 보기' }).click();
    await page.waitForURL(/participants\?status=WAITLIST/);
    const firstRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${people[3].name} 선택`, exact: true }) });
    const [confirmed] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.command === 'participant.status'),
      firstRow.getByRole('button', { name: '확정', exact: true }).click(),
    ]);
    assert.equal(confirmed.status(), 200);
    assert.equal((await read()).participants.find(person => person.id === people[3].id).status, 'APPROVED');
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await task.count(), 0, 'the offer disappears when the final place is used');
    const changed = await readEvent(); changed.capacity = 0; await writeEvent(changed);
    await page.reload(); await task.getByText('1명', { exact: true }).waitFor();
    assert.match(await task.innerText(), /정원 제한 없음/);
    changed.stage = 'READY'; await writeEvent(changed);
    await page.reload(); await task.getByText('1명', { exact: true }).waitFor();
    assert.match(await task.innerText(), /정원 제한 없음/);
    assert.ok(await page.locator('[aria-labelledby="event-metrics-heading"]').getByRole('link', { name: '대기 명단', exact: true }).isVisible(), 'unlimited capacity keeps a direct roster link');
    changed.capacity = 'unavailable'; await writeEvent(changed);
    await page.reload(); await task.getByText('1명 이상', { exact: true }).waitFor();
    assert.match(await task.innerText(), /정원 또는 참가 상태를 확인/);
    assert.doesNotMatch(await task.innerText(), /자리|정원 제한 없음/);
    await page.getByText('정원을 확인할 수 없습니다.', { exact: false }).waitFor();
    assert.doesNotMatch(await page.locator('[aria-labelledby="event-metrics-heading"]').innerText(), /정원 제한 없음/);
    changed.stage = 'LIVE'; changed.capacity = 10; await writeEvent(changed);
    const uncertain = await read(); uncertain.participants[5].status = 'UNKNOWN'; await write(uncertain);
    await page.reload(); await task.getByText('1명 이상', { exact: true }).waitFor();
    assert.match(await task.innerText(), /정원 또는 참가 상태를 확인/);
    assert.doesNotMatch(await task.innerText(), /자리/);
    uncertain.participants[5].status = 'CANCELLED';
    const unidentified = uncertain.participants.find(person => person.id === people[4].id);
    delete unidentified.id; await write(uncertain);
    await page.reload(); await task.getByText(/정원 또는 참가 상태를 확인/).waitFor();
    assert.doesNotMatch(await task.innerText(), /\d+명|자리/, 'an unidentifiable waitlist record is not counted as a person');
    unidentified.id = people[4].id; await write(uncertain);
    changed.capacity = 3; await writeEvent(changed);
    await page.reload(); await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await task.count(), 0);
    const autoRead = page.waitForResponse(response => response.url().includes('/bootstrap?ifVersion=') && response.ok(), { timeout: 25000 });
    assert.equal((await command('participant.status', { id: people[1].id, status: 'CANCELLED', expectedStatus: 'APPROVED' })).status, 200);
    await autoRead; await task.getByText('1명', { exact: true }).waitFor({ timeout: 6000 });
    assert.match(await task.innerText(), /확정 2명 기준 1자리/);
    const pending = await read(); pending.participants[6].status = 'PENDING'; await write(pending);
    await page.reload(); await task.getByText('1명', { exact: true }).waitFor();
    assert.match(await task.innerText(), /승인 대기는 별도입니다/);
    assert.equal(await page.locator('[data-task="approval"]').count(), 1, 'pending applications remain a separate task');
    const readerId = `waitlist-reader-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { id: readerId, role: 'MANAGER', name: '합성 읽기 담당자', email: `${readerId}@example.test`, orgId: f.helpers.LEGACY_ORG });
    await f.helpers.insertMembership(f.harness.database, readerId, f.eventId, ['onsite']);
    const readerCookie = await f.helpers.sessionCookie(f.harness, readerId);
    const readerContext = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR' });
    await readerContext.addCookies([{ name: 'etko_session', value: decodeURIComponent(readerCookie.slice('etko_session='.length)), url: f.baseUrl }]);
    const reader = await readerContext.newPage();
    await reader.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await reader.locator('[data-task="waitlist-review"]').getByRole('link', { name: '대기 명단 보기' }).click();
    await reader.waitForURL(/participants\?status=WAITLIST/);
    assert.equal(await reader.getByRole('button', { name: '확정', exact: true }).count(), 0, 'read-only managers can inspect the list without a write action');
    const denied = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: readerCookie, body: { commandId: crypto.randomUUID(), command: 'participant.status', payload: { id: people[4].id, status: 'APPROVED', expectedStatus: 'WAITLIST' } },
    });
    assert.equal(denied.status, 403);
    assert.equal((await read()).participants.find(person => person.id === people[4].id).status, 'WAITLIST');
    await readerContext.close();
    pending.participants[6].status = 'CANCELLED'; await write(pending);
    const mixed = await read(); const excluded = mixed.participants.find(person => person.id === people[3].id);
    excluded.status = 'WAITLIST'; excluded.cancelled = true; await write(mixed);
    await page.reload(); await task.getByText('1명', { exact: true }).waitFor();
    assert.match(await task.innerText(), /취소 기록 확인 1명은 제외했습니다/, 'actionable count explains the excluded waitlisted person');
    excluded.status = 'APPROVED'; excluded.cancelled = false; await write(mixed);
    const conflict = await read(); conflict.participants.find(person => person.id === people[2].id).cancelled = true; await write(conflict);
    await page.reload(); await task.getByText('1명', { exact: true }).waitFor();
    assert.match(await task.innerText(), /승인 상태 2명 기준 1자리/, 'a conflicting approved record is not presented as an undisputed confirmation');
    assert.equal(await page.locator('[data-task="cancellation-review"]').count(), 1);
    conflict.participants.find(person => person.id === people[2].id).cancelled = false;
    conflict.participants.find(person => person.id === people[4].id).cancelled = true; await write(conflict);
    await page.reload(); await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await task.count(), 0, 'a waitlist person with a cancellation conflict is not presented as actionable');
    assert.equal(await page.locator('[data-task="cancellation-review"]').count(), 1);
    conflict.participants.find(person => person.id === people[4].id).cancelled = false; await write(conflict);
    const damaged = structuredClone(conflict); damaged.participants = { original: '합성 명단 원본' }; await write(damaged);
    await page.reload(); await page.getByText(/참가자 자료를 확인할 수 없어/).waitFor();
    assert.equal(await task.count(), 0, 'unavailable roster is not treated as an actionable empty roster');
    await write(conflict);
    changed.stage = 'UNKNOWN'; await writeEvent(changed);
    await page.reload(); await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await task.count(), 0, 'an unknown stage cannot present a live approval task');
    changed.stage = 'ENDED'; await writeEvent(changed);
    await page.reload(); await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await task.count(), 0, 'closed events do not offer confirmations');
    console.log('PASS: vacancy, roster confirmation, pending, read-only, unlimited/unknown capacity, automatic refresh, unavailable source, conflict and ended event');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
