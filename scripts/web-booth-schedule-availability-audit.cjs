'use strict';
// Isolated synthetic fixture. Confirms that legacy schedules never make a
// browser and the authoritative server disagree about booth availability.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'booth-schedule-availability'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await read();
    const attendee = workspace.participants.find(person => person.status === 'APPROVED' && person.ticket);
    assert.ok(attendee);
    Object.assign(attendee, { inside: true, everIn: true, paymentStatus: 'FREE', revoked: false,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    workspace.stampMode = 'STAFF'; workspace.visits = [];
    const now = Date.now(), start = new Date(now - 3600000).toISOString(), end = new Date(now + 3600000).toISOString();
    const local = millis => new Date(millis + 9 * 3600000).toISOString().slice(0, 23) + '+09:00';
    const rows = [
      ['naive', '합성 모호한 시간', 'OPEN', '2026-11-06T09:00', ''],
      ['invalid', '합성 잘못된 시간', 'OPEN', '2026-02-31T09:00:00+09:00', ''],
      ['offset', '합성 잘못된 시간대', 'OPEN', '2026-11-06T09:00:00+15:00', ''],
      ['reverse', '합성 역순 시간', 'OPEN', '2027-01-02T00:00:00Z', '2027-01-01T00:00:00Z'],
      ['nonstring', '합성 형식 오류', 'OPEN', { bad: '합성' }, ''],
      ['utc', '합성 UTC 부스', 'OPEN', start, end],
      ['seoul', '합성 한국 부스', 'OPEN', local(now - 3600000), local(now + 3600000)],
      ['unlimited', '합성 무제한 시간', 'OPEN', '', ''],
      ['waiting', '합성 대기 부스', 'WAITING', '2026-11-06T09:00', ''],
      ['closed', '합성 종료 부스', 'CLOSED', 'invalid', ''],
    ];
    workspace.booths = rows.map(([id, name, status, startsAt, endsAt]) => ({ id, name, zone: '동관', status, startsAt, endsAt, capacity: 0, limit: 1, used: 0 }));
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    const commandUrl = `${fixture.baseUrl}/api/events/${fixture.eventId}/commands`;
    const change = async (command, payload) => {
      const response = await fetch(commandUrl, { method: 'POST', headers: { cookie: fixture.manager.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID(), command, payload }) });
      assert.ok(response.ok, `${command} ${response.status}`); return response.json();
    };
    await change('event.features', { features: ['stamp'] });
    for (const [id] of rows) await fixture.helpers.insertAssignment(database, {
      id: `schedule-${id}`, accountId: fixture.staff.id, eventId: fixture.eventId, type: 'BOOTH', targetId: id,
    });
    browser = await launchBrowser();
    const timezones = ['UTC', 'Asia/Seoul'];
    const observations = {};
    for (const timezoneId of timezones) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId });
      await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
      await page.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
      const option = id => page.locator(`#staff-booth option[value="${id}"]`);
      await option('naive').waitFor({ state: 'attached' });
      for (const id of ['naive', 'invalid', 'offset', 'reverse', 'nonstring']) {
        assert.equal(await option(id).isDisabled(), true, `${timezoneId} ${id}`);
        assert.match(await option(id).textContent(), /운영 시간 확인 필요/, id);
      }
      assert.equal(await page.getByText('운영 시간을 확인해야 하는 부스는 행사 운영자에게 문의하세요.', { exact: true }).isVisible(), true);
      assert.equal(await page.locator('#staff-booth').getAttribute('aria-describedby'), 'staff-booth-schedule-help');
      for (const id of ['utc', 'seoul', 'unlimited']) assert.equal(await option(id).isDisabled(), false, `${timezoneId} ${id}`);
      assert.match(await option('waiting').textContent(), /운영 대기/);
      assert.match(await option('closed').textContent(), /운영 종료/);
      const invalidVisit = await fetch(commandUrl, { method: 'POST', headers: { cookie: fixture.staff.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID(), command: 'booth.visit', assignmentId: 'schedule-naive',
          payload: { boothId: 'naive', ticket: attendee.ticket } }) });
      assert.equal(invalidVisit.status, 409); assert.equal((await invalidVisit.json()).code, 'BOOTH_UNAVAILABLE');
      observations[timezoneId] = '스태프의 모호한 시간 선택 차단, 정상 시간 선택 가능';
      if (timezoneId === 'Asia/Seoul') {
        await page.screenshot({ path: path.join(out, 'staff-390.png'), fullPage: true });
        await page.evaluate(axeSource);
        for (const width of [320, 390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
        }
      }
      await context.close();
    }
    await change('booth.mode', { mode: 'SELF', acknowledge: true });
    let formatted;
    for (const timezoneId of timezones) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId });
      await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: fixture.slug, ticket: attendee.ticket });
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/home?view=stamp`);
      const row = id => page.getByRole('listitem').filter({ has: page.getByText(rows.find(item => item[0] === id)[1], { exact: true }) });
      for (const id of ['naive', 'invalid', 'offset', 'reverse', 'nonstring']) {
        await row(id).getByText('운영 시간 확인 필요', { exact: true }).waitFor();
      }
      await row('naive').getByText(/시작 시간 확인 필요/).waitFor();
      assert.equal(await row('naive').getByText('운영 시간은 현장 스태프에게 문의하세요.', { exact: true }).isVisible(), true);
      await row('invalid').getByText(/시작 시간 확인 필요/).waitFor();
      const korean = await row('seoul').locator('p').filter({ hasText: '한국 시간' }).textContent();
      const utc = await row('utc').locator('p').filter({ hasText: '한국 시간' }).textContent();
      assert.equal(korean, utc, 'equivalent Z and +09 instants display identically');
      if (formatted !== undefined) assert.equal(korean, formatted, 'format is independent of the browser timezone');
      formatted = korean;
      const guest = await fetch(commandUrl, { method: 'POST', headers: { authorization: `Bearer ${attendee.ticket}`, 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID(), command: 'booth.visit', payload: { code: `ET:BOOTH:${fixture.eventId}:invalid` } }) });
      assert.equal(guest.status, 409); assert.equal((await guest.json()).code, 'BOOTH_UNAVAILABLE');
      if (timezoneId === 'Asia/Seoul') {
        await page.screenshot({ path: path.join(out, 'attendee-390.png'), fullPage: true });
        await page.evaluate(axeSource);
        for (const width of [320, 390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
        }
      }
      await context.close();
    }
    const final = await read();
    assert.equal(final.visits.length, 0);
    assert.deepEqual(final.booths.find(booth => booth.id === 'nonstring').startsAt, { bad: '합성' });
    require('node:fs').writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
      synthetic: true, timezones, invalidStatusesAndServerRejections: true, explicitOffsetEquivalent: true,
      noNewVisitsAndRawPreserved: true, responsiveAndAxe: [320, 390, 1280], physicalDevices: false,
    }, null, 2));
    console.log('부스 시간 확인: UTC/서울 브라우저, 스태프·참가자·서버·원본 보존 및 접근성 확인');
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
