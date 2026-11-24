'use strict';
// Real commands and synthetic identities, never production data. The same
// filter values deliberately have different *labelled* scopes on the preset.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axeSource = require('axe-core').source;
const { settleLayout } = require('./ui-journey-helpers.cjs');

const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roster-attendance');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { helpers, harness, manager, staff, eventId } = fixture;
    async function command(cookie, command, payload, assignmentId) {
      const result = await helpers.requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
        method: 'POST', cookie,
        body: { commandId: `roster-label-${crypto.randomUUID()}`, command, payload, ...(assignmentId ? { assignmentId } : {}) },
      });
      assert.ok(result.status >= 200 && result.status < 300, `${command}: ${JSON.stringify(result.json)}`);
      return result.json;
    }
    const people = (await command(manager.cookie, 'participant.import', { rows: [
      { name: '검증 대기', phone: '01099990001', company: '합성 기관' },
      { name: '검증 취소', phone: '01099990002', company: '합성 기관' },
      { name: '검증 퇴장 후 취소', phone: '01099990003', company: '합성 기관' },
      { name: '검증 퇴장 후 재승인', phone: '01099990004', company: '합성 기관' },
      { name: '검증 퇴장 후 대기', phone: '01099990005', company: '합성 기관' },
    ] })).participants;
    const byName = Object.fromEntries(people.map((person) => [person.name, person]));
    const status = (name, value) => command(manager.cookie, 'participant.status', { id: byName[name].id, status: value });
    await status('검증 대기', 'PENDING');
    await status('검증 취소', 'CANCELLED');
    const state = (await helpers.requestJson(harness.baseUrl, '/api/bootstrap', { cookie: manager.cookie })).json.state;
    const tickets = Object.fromEntries(state.workspaces[eventId].participants.map((person) => [person.name, person.ticket]));
    for (const name of ['검증 퇴장 후 취소', '검증 퇴장 후 재승인', '검증 퇴장 후 대기']) {
      await command(staff.cookie, 'check.scan', { deskId: fixture.deskId, ticket: tickets[name] }, `audit-assign-${fixture.suffix}`);
    }
    const outDesk = (await command(manager.cookie, 'desk.save', { name: '검증 퇴장 데스크', action: 'OUT', mode: 'desk', open: true })).desk;
    const assignment = `roster-out-${fixture.suffix}`;
    await helpers.insertAssignment(harness.database, { id: assignment, accountId: staff.id, eventId, type: 'DESK', targetId: outDesk.id });
    for (const name of ['검증 퇴장 후 취소', '검증 퇴장 후 재승인', '검증 퇴장 후 대기']) {
      await command(staff.cookie, 'check.scan', { deskId: outDesk.id, ticket: tickets[name] }, assignment);
    }
    await status('검증 퇴장 후 취소', 'CANCELLED');
    await status('검증 퇴장 후 재승인', 'CANCELLED');
    await status('검증 퇴장 후 재승인', 'APPROVED');
    await status('검증 퇴장 후 대기', 'PENDING');

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/console/events/${eventId}/participants`, { waitUntil: 'networkidle' });
    await page.locator('#participants-list-heading').waitFor();
    const desktopRow = (name) => page.locator('tbody tr').filter({ hasText: name }).first();
    phase = 'history';
    assert.match(await desktopRow('검증 퇴장 후 취소').innerText(), /신청 취소[\s\S]*퇴장/);
    assert.match(await desktopRow('검증 퇴장 후 재승인').innerText(), /참가 확정[\s\S]*퇴장/);
    assert.match(await desktopRow('검증 퇴장 후 대기').innerText(), /승인 대기[\s\S]*퇴장/);
    const awaiting = await desktopRow('검증 대기').innerText();
    const cancelled = await desktopRow('검증 취소').innerText();
    assert.match(awaiting, before ? /미입장/ : /입장 기록 없음/);
    assert.match(cancelled, before ? /미입장/ : /입장 기록 없음/);
    await page.screenshot({ path: path.join(out, 'roster-1280.png'), fullPage: true });

    phase = 'quick preset';
    const quick = page.getByRole('button', { name: before ? /^미입장 ·/ : /^확정자 중 미입장 ·/ });
    await quick.focus();
    await page.keyboard.press('Enter');
    assert.equal(await quick.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('출입 상태별 보기', { exact: true }).inputValue(), 'NOT_ENTERED');
    assert.equal(await desktopRow('검증 대기').count(), 0);
    assert.equal(await desktopRow('검증 취소').count(), 0);
    assert.equal(await desktopRow('검증 퇴장 후 재승인').count(), 0);
    await page.screenshot({ path: path.join(out, 'quick-1280.png'), fullPage: true });

    phase = 'advanced filter';
    await page.getByRole('button', { name: /^전체 ·/ }).click();
    await page.getByRole('button', { name: '필터', exact: true }).click();
    const attendance = page.getByLabel('출입 상태별 보기', { exact: true });
    assert.equal((await attendance.locator('option[value="NOT_ENTERED"]').innerText()).trim(), before ? '미입장' : '입장 기록 없음');
    await attendance.selectOption('NOT_ENTERED');
    assert.equal(await page.getByRole('button', { name: /^전체 ·/ }).getAttribute('aria-pressed'), 'true');
    assert.equal(await desktopRow('검증 대기').count(), 1);
    assert.equal(await desktopRow('검증 취소').count(), 1);
    assert.equal(await desktopRow('검증 퇴장 후 취소').count(), 0);
    // Reopened 2026-11-20: 넓은 폭에서 '필터 결과 전체 N명 선택' 버튼은 이미 선택이 있고 필터 결과가 더 있을 때만 나타난다. 처음 선택은 표 머리의
    // '이 페이지 전체 선택'으로 한다. 이 필터 결과(2명)는 한 페이지에 모두 담기므로 페이지 전체 선택이 곧 필터 결과 전체 선택이다.
    await page.getByRole('checkbox', { name: '이 페이지 전체 선택', exact: true }).check();
    const selection = await page.locator('#roster-selection-count').innerText();
    assert.match(selection, /선택/);
    await page.screenshot({ path: path.join(out, 'advanced-selected-1280.png'), fullPage: true });

    phase = 'message handoff';
    await page.getByRole('link', { name: /메시지 작성/ }).click();
    await page.getByText(/명단에서 .*명.*인계받았습니다/).first().waitFor();
    assert.match(await page.getByText(/명단에서 .*명.*인계받았습니다/).first().innerText(), /제외 1명\(취소·삭제\)/);
    assert.ok((await page.getByText('검증 대기', { exact: false }).count()) > 0, 'pending selection remains for explicit review');
    await page.screenshot({ path: path.join(out, 'message-handoff-1280.png'), fullPage: true });

    phase = 'mobile';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.baseUrl}/console/events/${eventId}/participants`, { waitUntil: 'networkidle' });
    await page.locator('#participants-list-heading').waitFor();
    const mobileRow = (name) => page.getByRole('listitem').filter({ hasText: name }).first();
    assert.match(await mobileRow('검증 퇴장 후 취소').innerText(), /퇴장/);
    assert.match(await mobileRow('검증 퇴장 후 재승인').innerText(), /퇴장/);
    assert.match(await mobileRow('검증 퇴장 후 대기').innerText(), /퇴장/);
    assert.match(await mobileRow('검증 대기').innerText(), before ? /미입장/ : /입장 기록 없음/);
    // Reopened 2026-11-20: 좁은 폭의 빠른 상태 보기도 select가 아니라 개수 탭(스크롤 되는 한 줄, 선택=누름 상태 버튼)이다.
    // 접근 가능한 이름은 데스크톱과 같은 '확정자 중 미입장 · N명'이고, 보이는 글자는 '확정자 중 미입장'이다. 같은 의도를 탭으로 확인한다:
    // 보이는 이름이 확정자 기준을 말하고, 선택하면 미입장 확정자만 남고, 키보드 초점을 받으며, 320px에서 선택된 탭 글자가 잘리지 않는다.
    const preset = page.getByRole('button', { name: before ? /^미입장 ·/ : /^확정자 중 미입장 ·/ });
    assert.match(await preset.locator('[class*="label"]').innerText(), before ? /^미입장/ : /^확정자 중 미입장/);
    await preset.click();
    assert.equal(await preset.getAttribute('aria-pressed'), 'true');
    assert.equal(await mobileRow('검증 대기').count(), 0);
    await page.screenshot({ path: path.join(out, 'quick-390.png'), fullPage: true });
    await preset.focus();
    assert.equal(await preset.evaluate((element) => document.activeElement === element), true, 'the preset receives keyboard focus');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 320, height: 720 });
    await settleLayout(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    if (!before) {
      // 선택이 바뀌면 탭 줄이 선택된 탭을 보이는 자리로 옮기므로, 320px에서 다시 선택해 그 동작까지 확인한다.
      await page.getByRole('button', { name: /^전체 ·/ }).click();
      await preset.click();
      await settleLayout(page);
      const labelFits = await preset.evaluate((tab) => {
        const track = tab.closest('[role="group"]').getBoundingClientRect();
        const box = tab.getBoundingClientRect();
        return box.left >= track.left - 1 && box.right <= track.right + 1;
      });
      assert.equal(labelFits, true, 'selected preset label stays fully visible at 320px');
    }
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.screenshot({ path: path.join(out, 'quick-320.png'), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ historyPreserved: true, quickIsApprovedOnly: true, advancedIncludesAllStatuses: true, cancelledExcludedAndPendingPreservedOnHandoff: true, desktopPresetKeyboard: true, mobileSelectFocus: true, mobile: [320, 390], before }, null, 2));
    console.log(`Roster attendance labels verified: ${out}`);
  } catch (error) {
    throw new Error(`${phase}: ${error.stack || error}`);
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
