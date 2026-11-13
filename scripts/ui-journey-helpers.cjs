'use strict';

// User-visible transitions for the persistent task and program panels.
async function openProgram(page, title) {
  const section = page.locator(':is(section,[role=region])[aria-labelledby^="engage-"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await section.waitFor();
  const details = section.locator(':scope > details');
  if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
  return section;
}

async function selectTask(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  await page.waitForFunction(id => document.getElementById(id)?.getAttribute('aria-selected') === 'true', await tab.getAttribute('id'));
}
async function openCreateSettings(page) {
  const details = page.locator('details[data-create-settings]');
  await details.waitFor({ state: 'visible' });
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
}
async function chooseRadio(root, id, value) {
  const choices = await root.locator(`#${id} input[type="radio"]`).all();
  for (const choice of choices) {
    if (await choice.getAttribute('value') === value) { await choice.check(); return; }
  }
  throw new Error(`Unavailable single choice: ${id}/${value}`);
}
// Traverse the same visible step controls as an operator. Never manufacture
// recipients or bypass validation; a blocked transition fails the audit.
async function messageStep(page, step) {
  const nav = page.getByRole('navigation', { name: '메시지 작성 단계', exact: true });
  const current = Number.parseInt(await nav.locator('[aria-current="step"]').innerText(), 10);
  if (step < current) await nav.getByRole('button', { name: new RegExp(`^${step}\\s*`) }).click();
  else {
    if (current === 1 && step > 1) await page.getByRole('button', { name: '내용 작성', exact: true }).click();
    if (current < 3 && step === 3) await page.getByRole('button', { name: '발송 검토로', exact: true }).click();
  }
  await nav.getByRole('button', { name: new RegExp(`^${step}\\s*`) }).and(nav.locator('[aria-current="step"]')).waitFor();
}
// Dismissal and exact trigger focus are separate asynchronous transitions.
async function waitForDialogExitFocus(page, trigger, timeout = 5000) {
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout });
  await page.waitForFunction(element => element === document.activeElement, await trigger.elementHandle(), { polling: 'raf', timeout });
}
module.exports = { openProgram, selectTask, openCreateSettings, chooseRadio, messageStep, waitForDialogExitFocus };
