'use strict';

// User-visible transitions for the persistent task and program panels.
// Programs sit under kind tabs on the attendee screen: switch to the tab that
// holds the program before looking for it.
async function revealProgram(page, section) {
  if (await section.first().isVisible().catch(() => false)) return;
  const tabs = page.getByRole('navigation', { name: '참여 종류' }).getByRole('button');
  const count = await tabs.count();
  for (let index = 0; index < count && !(await section.first().isVisible().catch(() => false)); index += 1) await tabs.nth(index).click();
}

async function programSection(page, title) {
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await revealProgram(page, section);
  return section;
}

async function openProgram(page, title) {
  const section = page.locator(':is(section,[role=region])[aria-labelledby^="engage-"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await revealProgram(page, section);
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
// Settings basics editing lives in a drawer: open it before touching the
// basics form. Idempotent when the drawer is already open.
async function openSettingsBasics(page, timeout = 15000) {
  if (!await page.locator('#set-name:visible').count()) {
    await page.getByRole('button', { name: '수정', exact: true }).click();
  }
  await page.locator('#set-name').waitFor({ state: 'visible', timeout });
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
// The page studio keeps its fields behind four rows; a field's id only exists
// once its panel is open. Opens the panel from the list (or from another panel
// via the "설정" crumb) and waits for its heading.
const STUDIO_PANEL = {
  banner: { row: /^배너/u, title: '배너' },
  text: { row: /^제목과 문구/u, title: '제목과 문구' },
  menus: { row: /^홈 메뉴/u, title: '홈 메뉴' },
  exposure: { row: /^소개와 공개 범위/u, title: '소개와 공개 범위' },
};
async function openStudioPanel(page, key) {
  const { row, title } = STUDIO_PANEL[key];
  const heading = page.locator('#theme-panel-title');
  if (await heading.isVisible().catch(() => false)) {
    if ((await heading.innerText()).trim() === title) return;
    await page.locator('#theme-edit').getByRole('button', { name: '설정', exact: true }).click();
  }
  await page.locator('#theme-edit').getByRole('button', { name: row }).click();
  await page.locator('#theme-panel-title', { hasText: title }).waitFor();
}

// Draws is master-detail: the stage list ("무대 선택") rows replaced the old 순위 투표 / 럭키번호 /
// 모바일 룰렛 tabs. Pressing a row selects it; its detail card holds the same settings.
const DRAW_STAGE_ROW = { '순위 투표': /^순위 투표/, '럭키번호': /^럭키번호 사전 배정/, '모바일 룰렛': /^모바일 룰렛/ };
async function selectDrawStage(page, name) {
  const row = page.getByRole('button', { name: DRAW_STAGE_ROW[name] });
  await row.click();
  await page.waitForFunction((el) => el.getAttribute('aria-pressed') === 'true', await row.elementHandle());
}

// Reopened 2026-11-20: the console previews (DeviceFrame) now scale their device with a ResizeObserver, so the
// frame right after a viewport change still carries the previous scale. Measuring overflow or running axe at that
// instant reports a width nobody ever sees. Wait for the layout to settle (three frames, running transitions
// finished) before measuring; the assertions themselves are unchanged.
async function settleLayout(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const tick = () => (++frames >= 3 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
}

module.exports = { settleLayout, openStudioPanel, selectDrawStage, openProgram, programSection, selectTask, openCreateSettings, openSettingsBasics, chooseRadio, messageStep, waitForDialogExitFocus };
