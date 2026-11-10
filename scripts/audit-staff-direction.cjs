'use strict';
// An auto-selected desk must be confirmed once on entry. A desk explicitly
// chosen from multiple options is already selected and needs no extra step.
async function confirmInitialStaffDesk(page) {
  await page.locator('#staff-desk').waitFor();
  const review = page.getByRole('region', { name: '데스크 업무 방향을 확인해 주세요' });
  if (!(await review.isVisible())) return false;
  await review.getByText('시작하기 전에 업무 방향을 확인해 주세요.', { exact: false }).waitFor();
  await review.getByRole('button', { name: /^(입장|퇴장) 업무 확인$/ }).click();
  await review.waitFor({ state: 'hidden' });
  return true;
}
module.exports = { confirmInitialStaffDesk };
