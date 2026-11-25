'use strict';

// Scanning a ticket that is already inside: the desk shows the same blue
// "이미 입장했어요" notice as before, now with who it is and when they got in
// (so a borrowed or shared ticket is noticed at the door). Real browser, real
// build, real API. The extra line is optional: without server details the plain
// notice stays.
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { confirmInitialStaffDesk, typeTicket } = require('./audit-staff-direction.cjs');

const REFUSAL = '이미 입장한 참가자입니다. 중복 처리하지 않았습니다.';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-already-in'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  try {
    const state = await read();
    const person = state.participants.find((item) => item.status === 'APPROVED');
    assert.ok(person);
    Object.assign(person, { inside: false, everIn: false });
    state.checks = [];
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(state)]);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const staff = await context.newPage();
    const errors = [];
    staff.on('pageerror', (error) => errors.push(error.message));
    // Mode 'strip' proves the page copes with a server that sends no details.
    let mode = 'real';
    let stripped = 0;
    await staff.route('**/api/events/*/commands', async (route) => {
      let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
      if (body?.command !== 'check.scan' || mode !== 'strip') return route.continue();
      const response = await route.fetch();
      const json = await response.json();
      assert.ok(json.details, 'the real server did send details to strip');
      delete json.details;
      stripped += 1;
      return route.fulfill({ response, json });
    });

    await staff.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await confirmInitialStaffDesk(staff);

    // 1) first scan lets the person in.
    await typeTicket(staff, person.ticket);
    await staff.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staff.getByRole('region', { name: '스캔 결과', exact: false }).first().waitFor();
    const [entry] = (await read()).checks.filter((check) => check.participantId === person.id && check.action === 'IN');
    assert.ok(entry, 'the first scan was recorded');

    // 2) the same ticket again: the notice names the person and the entry time.
    const when = await staff.evaluate((at) => new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(new Date(at)), entry.at);
    await typeTicket(staff, person.ticket);
    await staff.getByRole('button', { name: '입장 처리', exact: true }).click();
    const refused = staff.getByRole('region', { name: '스캔 실패', exact: true });
    await refused.getByText(REFUSAL, { exact: true }).waitFor();
    /* Reopened 2026-11-25: the name stands large and the quiet line carries affiliation and time. */ await refused.getByText(person.name, { exact: true }).waitFor(); await refused.getByText(new RegExp(`${when} 입장$`, 'u')).waitFor();
    assert.equal(await staff.getByRole('region', { name: '스캔 실패와 복구', exact: true }).getAttribute('data-tone'), 'info', 'still the blue, non-error notice');
    assert.equal((await read()).checks.filter((check) => check.participantId === person.id).length, 1, 'the refused scan wrote nothing');
    for (const width of [320, 390, 1280]) {
      await staff.setViewportSize({ width, height: 900 });
      assert.equal(await staff.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no horizontal overflow at ${width}`);
      await staff.evaluate(axeSource);
      assert.deepEqual(await staff.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), [], `no serious accessibility findings at ${width}`);
      await staff.screenshot({ path: path.join(out, `already-in-${width}.png`), fullPage: true });
    }
    await staff.setViewportSize({ width: 390, height: 900 });
    await refused.getByRole('button', { name: '다음 참가자', exact: true }).click();

    // 3) without details the plain notice stays, with no name line.
    mode = 'strip';
    await typeTicket(staff, person.ticket);
    await staff.getByRole('button', { name: '입장 처리', exact: true }).click();
    const plain = staff.getByRole('region', { name: '스캔 실패', exact: true });
    await plain.getByText(REFUSAL, { exact: true }).waitFor();
    assert.equal(stripped, 1, 'the stripped response was the one on screen');
    // The line that starts with the person's name; "처리 위치: … · 입장" is a different, existing line.
    assert.equal(await plain.getByText(new RegExp(`^${person.name} · `)).count(), 0, 'no name and time line without server details');
    await plain.getByText('처리 위치:', { exact: false }).waitFor();
    await staff.screenshot({ path: path.join(out, 'already-in-plain-390.png'), fullPage: true });

    assert.deepEqual(errors, []);
    await context.close();
    console.log('Staff 이미 입장 notice: names the person and entry time, stays blue, falls back to the plain notice');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
