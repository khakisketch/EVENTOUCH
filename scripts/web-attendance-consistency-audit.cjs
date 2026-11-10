'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'attendance-before' : 'attendance-after');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  try {
    const { rows } = await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId]);
    const workspace = rows[0].payload;
    workspace.participants.forEach((person, index) => {
      person.status = index === 0 ? 'APPROVED' : 'CANCELLED';
      if (index === 0) { person.inside = null; person.everIn = false; }
    });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
    const link = page.getByRole('link', { name: /확정자 중 미입장/ }).first();
    await link.waitFor();
    await page.screenshot({ path: path.join(out, 'overview-1280.png'), fullPage: true });
    if (before) {
      assert.match(await link.innerText(), /1명/);
      await link.click();
      await page.getByText('검색어·상태·그룹·출입 조건에 맞는 사람이 없습니다. 조건을 하나씩 지워보세요.').waitFor();
      await page.screenshot({ path: path.join(out, 'roster-1280.png'), fullPage: true });
      console.log('Reproduced: overview count 1 but linked roster has no matching participants.');
    } else {
      assert.match(await link.innerText(), /0명/);
      const reviewLink = page.getByRole('link', { name: '출입 기록 확인 필요 1명' });
      await reviewLink.waitFor();
      await page.setViewportSize({ width: 390, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, 'overview-390.png'), fullPage: true });
      await reviewLink.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: `${workspace.participants[0].name} 참가자 상세`, exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: '출입 상태별 보기' }).inputValue(), 'REVIEW');
      await page.screenshot({ path: path.join(out, 'roster-390.png'), fullPage: true });
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);

      const command = async (payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: 'report.create', payload },
      });
      const attendance = { total: 1, approved: 1, checked: 0, inside: 0, attendanceReview: 1 };
      const rejected = await command({ title: '오래된 검토', expectedAttendance: { ...attendance, attendanceReview: 0 } });
      assert.equal(rejected.status, 409);
      const created = await command({ title: '출입 검토 보고서', expectedAttendance: attendance });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      assert.equal(created.json.report.snapshot.metrics.attendanceReview, 1);
      const oldClient = await command({ title: '이전 클라이언트 보고서' });
      assert.equal(oldClient.status, 201);
      const priorVersion = await command({ title: '이전 집계 기준 보고서' });
      assert.equal(priorVersion.status, 201);
      const latest = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
      delete latest.reports.find(report => report.id === oldClient.json.report.id).snapshot.metrics.attendanceReview;
      delete latest.reports.find(report => report.id === priorVersion.json.report.id).snapshot.metrics.attendanceReviewVersion;
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(latest)]);
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports`);
      await page.getByRole('button', { name: '보고서 만들기', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: '결과 보고서 만들기' });
      const reviewed = dialog.getByRole('group', { name: '보고서에 반영할 참가 집계' });
      assert.match(await reviewed.innerText(), /출입 기록 확인 필요\s*1명/);
      await dialog.locator('#report-title').fill('화면에서 만든 출입 검토 보고서');
      const [response] = await Promise.all([
        page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().endsWith(`/api/events/${f.eventId}/commands`)),
        dialog.getByRole('button', { name: '보고서 만들기', exact: true }).click(),
      ]);
      assert.equal(response.status(), 201);
      assert.equal(response.request().postDataJSON().payload.expectedAttendance.attendanceReview, 1);
      assert.equal((await response.json()).report.snapshot.metrics.attendanceReview, 1);
      await page.getByRole('tab', { name: '결과 분석', exact: true }).click();
      await page.getByRole('link', { name: '출입 기록 확인 필요 1명' }).waitFor();
      await page.screenshot({ path: path.join(out, 'report-analysis-390.png'), fullPage: true });
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports?closeReport=${created.json.report.id}#report-${created.json.report.id}`);
      await page.getByText('출입 기록 확인 필요 1명 · 입장 수와 입장률이 실제와 다를 수 있습니다.').waitFor();
      await page.screenshot({ path: path.join(out, 'frozen-report-390.png'), fullPage: true });
      await page.evaluate(() => {
        window.__attendancePrinted = '';
        window.print = () => { window.__attendancePrinted = document.getElementById('eventouch-report-print')?.textContent || ''; };
      });
      await page.getByRole('button', { name: '인쇄하기', exact: true }).click();
      await page.waitForFunction(() => window.__attendancePrinted !== '');
      assert.match(await page.evaluate(() => window.__attendancePrinted), /출입 기록 확인 필요 1명/);
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports?closeReport=${oldClient.json.report.id}#report-${oldClient.json.report.id}`);
      await page.getByText('저장 당시 출입 기록의 확인 필요 여부는 이 보고서에서 확인할 수 없습니다.').waitFor();
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/reports?closeReport=${priorVersion.json.report.id}#report-${priorVersion.json.report.id}`);
      await page.getByText('저장 당시 최근 출입 이력과의 일치 여부는 확인할 수 없습니다.').waitFor();
      const matrix = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
      const cases = [
        { status: 'APPROVED', inside: null, everIn: false },
        { status: 'APPROVED', inside: true, everIn: false },
        { status: 'APPROVED', inside: false, everIn: false },
        { status: 'APPROVED', inside: false, everIn: true },
        { status: 'APPROVED', inside: true, everIn: true },
        { status: 'PENDING', inside: false, everIn: null },
        { status: 'CANCELLED', inside: null, everIn: false },
      ];
      cases.forEach((value, index) => Object.assign(matrix.participants[index], value));
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(matrix)]);
      for (const url of ['/api/bootstrap', `/api/events/${f.eventId}/bootstrap`]) {
        const staffRead = await f.helpers.requestJson(f.harness.baseUrl, url, { cookie: f.staff.cookie });
        assert.equal(staffRead.status, 200);
        const staffPeople = staffRead.json.state.workspaces[f.eventId].participants;
        assert.equal(staffPeople.find(person => person.id === matrix.participants[0].id).attendanceReview, true);
        assert.equal(staffPeople.find(person => person.id === matrix.participants[2].id).attendanceReview, false);
        assert.equal(Object.hasOwn(staffPeople[0], 'phone'), false);
      }
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}`);
      await page.getByRole('link', { name: '출입 기록 확인 필요 3명' }).waitFor();
      assert.match(await page.getByRole('link', { name: /확정자 중 미입장/ }).first().innerText(), /1명/);
      await page.getByRole('link', { name: /확정자 중 미입장/ }).first().click();
      await page.getByRole('button', { name: `${matrix.participants[2].name} 참가자 상세`, exact: true }).waitFor();
      for (const index of [0, 1, 3, 4, 5, 6]) assert.equal(await page.getByRole('button', { name: `${matrix.participants[index].name} 참가자 상세`, exact: true }).count(), 0);
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants?attendance=REVIEW`);
      for (const index of [0, 1, 5]) await page.getByRole('button', { name: `${matrix.participants[index].name} 참가자 상세`, exact: true }).waitFor();
      for (const index of [2, 3, 4, 6]) assert.equal(await page.getByRole('button', { name: `${matrix.participants[index].name} 참가자 상세`, exact: true }).count(), 0);
      await page.getByRole('button', { name: `${matrix.participants[1].name} 참가자 상세`, exact: true }).click();
      await page.getByText('현재 입장 상태와 누적 입장 기록을 함께 확인해 주세요.').waitFor();
      await page.screenshot({ path: path.join(out, 'contradictory-record-390.png'), fullPage: true });
      console.log('Overview, roster, live and frozen reports, legacy snapshots and stale review guard passed.');
    }
    await context.close();
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
