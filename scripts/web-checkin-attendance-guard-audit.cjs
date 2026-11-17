'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { typeTicket, holdResults, codeField, closeSheet } = require('./audit-staff-direction.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'checkin-attendance-guard');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async workspace => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const command = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
    method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
  });
  try {
    const state = await read(), person = state.participants[0];
    person.inside = null; person.everIn = false; state.allowReentry = false; await write(state);
    browser = await launchBrowser();
    const staffContext = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await staffContext.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const staff = await staffContext.newPage();
    const attempts = []; let fault = 'denial';
    await staff.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command !== 'check.scan') return route.continue();
      attempts.push(body.commandId);
      if (fault === 'denial') { fault = 'pass'; const response = await route.fetch(); assert.equal(response.status(), 409); return route.abort('failed'); }
      if (fault === 'committed') {
        fault = 'pass'; const response = await route.fetch(); assert.equal(response.status(), 200);
        const latest = await read(); latest.participants[1].inside = false; await write(latest);
        return route.abort('failed');
      }
      return route.continue();
    });
    await staff.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    const deskReview = staff.getByRole('region', { name: '데스크 업무 방향을 확인해 주세요' });
    await deskReview.getByRole('button', { name: '입장 업무 확인', exact: true }).click();
    await holdResults(staff);
    await typeTicket(staff, person.ticket);
    await staff.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staff.getByRole('region', { name: '스캔 결과 미확인', exact: true }).getByRole('button', { name: '같은 요청 재확인' }).click();
    const failed = staff.getByRole('region', { name: '스캔 실패', exact: true });
    await failed.getByText('출입 기록을 확인할 수 없어 처리하지 않았습니다. 현장 책임자에게 확인을 요청하세요.').waitFor();
    assert.equal(attempts.length, 2); assert.equal(new Set(attempts).size, 1);
    assert.equal(await failed.getByRole('button', { name: '다시 시도', exact: true }).count(), 0);
    await failed.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
    for (const width of [320, 390, 1280]) {
      await staff.setViewportSize({ width, height: 900 });
      assert.equal(await staff.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await staff.evaluate(axeSource);
      assert.deepEqual(await staff.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await staff.screenshot({ path: path.join(out, `staff-review-${width}.png`), fullPage: true });
    }
    assert.equal((await read()).checks.length, 0);
    await failed.getByRole('button', { name: '다음 참가자' }).click();
    assert.equal(await (await codeField(staff)).inputValue(), '');
    await closeSheet(staff);

    // A committed response can also be lost before the aggregate becomes
    // damaged. Replaying its receipt proves the past scan, but must not
    // claim the participant's present state is known.
    await staff.setViewportSize({ width: 390, height: 900 });
    fault = 'committed';
    await typeTicket(staff, state.participants[1].ticket);
    await staff.getByRole('button', { name: '입장 처리', exact: true }).click();
    await staff.getByRole('region', { name: '스캔 결과 미확인', exact: true }).getByRole('button', { name: '같은 요청 재확인' }).click();
    await staff.getByText('이 기록이 현재 출입 상태에 해당하는지 확인할 수 없습니다.').waitFor();
    await staff.getByText('현장 책임자에게 참가자와 최근 출입 기록 확인을 요청한 뒤 다음 참가자를 처리하세요.').waitFor();
    assert.equal((await read()).checks.filter(item => item.participantId === state.participants[1].id).length, 1);
    await staff.screenshot({ path: path.join(out, 'replay-current-unknown-390.png'), fullPage: true });

    // A previously recorded entry supports a reviewed exit even when its
    // aggregate attendance flag is inconsistent. This is not guessed from a
    // damaged value: the manager explicitly confirms an actual departure.
    const repairedFixture = await read(); repairedFixture.participants[0].inside = false; await write(repairedFixture);
    assert.equal((await command('check.scan', { deskId: f.deskId, ticket: person.ticket, expectedAction: 'IN' })).status, 200);
    const inconsistent = await read(); inconsistent.participants[0].everIn = false; await write(inconsistent);
    const managerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await managerContext.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const manager = await managerContext.newPage();
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    await manager.getByRole('link', { name: '출입 기록 확인 필요 2명' }).click();
    await manager.getByRole('button', { name: `${state.participants[1].name} 참가자 상세`, exact: true }).waitFor();
    await manager.screenshot({ path: path.join(out, 'manager-review-roster-1280.png'), fullPage: true });
    await manager.getByRole('button', { name: `${person.name} 참가자 상세`, exact: true }).click();
    await manager.getByRole('dialog', { name: person.name }).getByRole('button', { name: '확인 후 퇴장 기록', exact: true }).click();
    const review = manager.getByRole('dialog', { name: '확인 후 퇴장 기록' });
    await review.getByRole('heading', { name: '확인할 참가자' }).waitFor();
    await manager.screenshot({ path: path.join(out, 'manager-reviewed-exit-1280.png'), fullPage: true });
    await review.getByLabel('확인 사유').fill('현장에서 실제 퇴장 확인');
    await review.getByLabel('이 참가자가 실제로 퇴장한 것을 확인했습니다.').check();
    await review.getByRole('button', { name: '퇴장 기록', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    const result = await read();
    assert.equal(result.participants[0].inside, false); assert.equal(result.participants[0].everIn, true);
    assert.equal(result.checks.filter(item => item.participantId === person.id && item.source === 'REVIEWED_EXIT').length, 1);
    assert.equal((await command('check.scan', { deskId: f.deskId, ticket: person.ticket, expectedAction: 'IN' })).status, 409, 're-entry remains prohibited');
    await staffContext.close(); await managerContext.close();
    console.log('Unknown scan denial, lost-response recovery and reviewed exit passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
