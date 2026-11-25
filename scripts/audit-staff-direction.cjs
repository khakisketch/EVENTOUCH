'use strict';
// Shared helpers for audits that drive the staff field screen
// (apps/web/app/staff/StaffEventWork.tsx). The scan screen carries only the
// camera and three buttons; the typed code, the name search, the recent list
// and the correction are sheets opened on demand.

// An auto-selected desk must be confirmed once on entry. A desk explicitly
// chosen from multiple options is already selected and needs no extra step.
// Results hand themselves back to the camera after a moment; an audit that
// reads a result turns that off (hold: true, the default) so it stays put.
async function confirmInitialStaffDesk(page, { hold = true } = {}) {
  await page.locator('#staff-desk').waitFor();
  const review = page.getByRole('region', { name: '데스크 업무 방향을 확인해 주세요' });
  let confirmed = false;
  if (await review.isVisible()) {
    // After a reload the tab may remember an earlier answer, so a changed direction is named as a change.
    await review.getByText(/시작하기 전에 업무 방향을 확인해 주세요|이전에 확인한 방향은/).first().waitFor();
    await review.getByRole('button', { name: /^(입장|퇴장) 업무 확인$/ }).click();
    await review.waitFor({ state: 'hidden' });
    confirmed = true;
  }
  if (hold) await holdResults(page);
  return confirmed;
}

// ⋯ menu: 결과 자동 넘김 off (or on). The menu is left closed.
async function holdResults(page, hold = true) {
  const summary = page.getByLabel('계정·조직·키오스크');
  await summary.waitFor({ state: 'visible', timeout: 15000 });
  await summary.click();
  const toggle = page.getByRole('switch', { name: '결과 자동 넘김' });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-checked')) === String(hold)) await toggle.click();
  await summary.click();
}

// ⋯ menu: 카메라 끄기.
async function turnCameraOff(page) {
  await page.evaluate(() => {
    document.querySelector('details')?.setAttribute('open', '');
    [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '카메라 끄기')?.click();
  });
}

async function openCamera(page) {
  await page.getByRole('button', { name: '카메라 켜기', exact: true }).click();
}

// The typed ticket code lives in the 코드 입력 sheet.
async function codeField(page) {
  const field = page.locator('#staff-ticket');
  if (!(await field.isVisible())) {
    const open = page.getByRole('button', { name: '코드 입력', exact: true });
    // A shown result covers the scan buttons: hand it back first (a result that
    // waits for a decision, such as an unconfirmed scan, is never dismissed here).
    if (!(await open.isVisible())) await dismissResult(page);
    await open.click();
  }
  await field.waitFor();
  return field;
}

async function dismissResult(page) {
  const handBack = page.getByRole('region', { name: /^스캔 (결과|실패)/ }).getByRole('button', { name: /^(확인|다음 참가자)$/ }).first();
  if (await handBack.count()) await handBack.click();
}

// Opens the sheet, reads the typed code and closes the sheet again.
async function readCode(page) {
  const value = await (await codeField(page)).inputValue();
  await closeSheet(page);
  return value;
}

async function typeTicket(page, ticket) {
  const field = await codeField(page);
  await field.fill(ticket);
  return field;
}

// The recent list (and the correction of the last scan) opens from 최근 처리.
async function openRecent(page) {
  const list = page.getByRole('region', { name: '최근 처리 기록', exact: true });
  if (!(await list.isVisible())) await page.getByRole('button', { name: '최근 처리', exact: true }).click();
  await list.waitFor();
  return list;
}

async function closeSheet(page) {
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) await dialog.getByRole('button', { name: '닫기', exact: true }).first().click();
}

module.exports = { dismissResult, confirmInitialStaffDesk, holdResults, turnCameraOff, openCamera, codeField, typeTicket, readCode, openRecent, closeSheet };
