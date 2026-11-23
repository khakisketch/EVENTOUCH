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
// Reopened 2026-11-20: 기본 정보 드로어는 뒤쪽 화면을 막는 모달이다. 작성 중인 값은 닫아도 남고('저장 안 됨'), 같은 드로어를 다시 열어 저장한다.
// 뒤쪽 구역(참가 접수·운영 기능)을 조작하려면 먼저 닫아야 한다.
async function closeSettingsBasics(page, timeout = 15000) {
  await page.getByRole('dialog', { name: '기본 정보', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#set-name').waitFor({ state: 'hidden', timeout });
}
async function chooseRadio(root, id, value) {
  const choices = await root.locator(`#${id} input[type="radio"]`).all();
  for (const choice of choices) {
    if (await choice.getAttribute('value') === value) { await choice.check(); return; }
  }
  throw new Error(`Unavailable single choice: ${id}/${value}`);
}
// Reopened 2026-11-24 (owner: 시안 A): the composer is ONE sentence with three pill buttons
// (#campaign-who-pill 받는 사람 / #campaign-how-pill 보내는 방법 / #campaign-when-pill 시점), each
// opening one inline panel (one at a time; folded panels stay mounted with `hidden`). The body,
// purpose chips and 더 보기 sit below, the send review button in a dock. Nothing is validated or
// blocked by moving between them; validation lives in the 발송 검토 submit, so these helpers never
// manufacture recipients or bypass it.
const MESSAGE_PANEL = {
  who: { pill: '#campaign-who-pill', panel: '#campaign-recipients' },
  how: { pill: '#campaign-how-pill', panel: '#campaign-how-panel' },
  when: { pill: '#campaign-when-pill', panel: '#campaign-schedule' },
};
// Opens one sentence panel (idempotent) and waits until it is visible.
async function openMessagePanel(page, which) {
  const { pill, panel } = MESSAGE_PANEL[which];
  if (!(await page.locator(panel).isVisible())) await page.locator(pill).click();
  await page.locator(panel).waitFor({ state: 'visible' });
}
// Closes the open panel through its pill (idempotent).
async function closeMessagePanel(page, which) {
  const { pill, panel } = MESSAGE_PANEL[which];
  if (await page.locator(panel).isVisible()) await page.locator(pill).click();
  await page.locator(panel).waitFor({ state: 'hidden' });
}
// 더 보기 (저장한 템플릿 · 사진 · 기록 제목): idempotent open.
async function openMessageMore(page) {
  const more = page.locator('details:has(> summary[data-disclosure-indicator]):has(#campaign-title)');
  if (!(await more.evaluate(element => element.open))) await more.locator(':scope > summary').click();
  await page.locator('#campaign-title').waitFor({ state: 'visible' });
}
// The phone preview sits beside the writing on desktop; at <=1024px it is a bottom sheet opened by
// #message-preview-open ("미리보기") and closed by #message-preview-close or Esc. Opens it only when
// the opener is shown (idempotent) and waits for the bubble.
async function openMessagePreview(page) {
  const opener = page.locator('#message-preview-open');
  if (await opener.isVisible() && (await opener.getAttribute('aria-expanded')) !== 'true') await opener.click();
  await page.locator('#message-draft-preview').waitFor({ state: 'visible' });
}
async function closeMessagePreview(page) {
  if ((await page.locator('#message-preview-open').getAttribute('aria-expanded')) === 'true') await page.locator('#message-preview-close').click();
}
// The saved-template picker lives under 더 보기 for 문자 and inside the 보내는 방법 panel for 알림톡;
// open whichever one holds it right now and return its locator.
async function openTemplatePicker(page) {
  const select = page.locator('#campaign-template');
  if (await select.isVisible()) return select;
  if (await select.evaluate(element => Boolean(element.closest('#campaign-how-panel')))) await openMessagePanel(page, 'how');
  else await openMessageMore(page);
  await select.waitFor({ state: 'visible' });
  return select;
}
// Step 1 = 받는 사람 (opens the who panel), 2 = 내용 (the message body), 3 = 검토·발송 (the dock).
async function messageStep(page, step) {
  if (step === 1) await openMessagePanel(page, 'who');
  else if (step === 2) {
    await page.locator('#campaign-body').scrollIntoViewIfNeeded();
    await page.locator('#campaign-body').waitFor({ state: 'visible' });
  } else {
    await page.locator('#campaign-submit').scrollIntoViewIfNeeded();
    await page.locator('#campaign-submit').waitFor({ state: 'visible' });
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 30))));
}
// The "직접 고르기" recipient list is folded by default inside the 받는 사람 panel; open the panel
// and then the list (never close either) before touching its filters or checkboxes.
async function openRecipientList(page) {
  await openMessagePanel(page, 'who');
  if (!(await page.locator('#recipient-status-filter').isVisible())) await page.locator('#recipient-list-summary').click();
  await page.locator('#recipient-status-filter').waitFor({ state: 'visible' });
}
// "시점" panel: the datetime-local only exists once 날짜·시각 지정 is chosen.
// Opens the panel, picks DATE (idempotent) and returns the #campaign-scheduled locator.
async function chooseScheduleDate(page) {
  await openMessagePanel(page, 'when');
  const scheduled = page.locator('#campaign-scheduled');
  if (!(await scheduled.count())) await chooseRadio(page, 'campaign-schedule-choice', 'DATE');
  await scheduled.waitFor({ state: 'visible' });
  return scheduled;
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

// Reopened 2026-11-20: 입장·스태프의 데스크·부스 행은 상세 시트를 여는 버튼 하나만 가진다(행 안의 '편집' 버튼과 '부스' 탭이 사라짐).
// 편집은 상세 시트의 '<종류> 편집'에서 연다. kind는 '데스크' 또는 '부스'.
async function openLocationEditor(page, kind, hasText) {
  await page.locator('li').filter({ hasText }).locator('button[class*="locationOpen"]').first().click();
  await page.getByRole('button', { name: `${kind} 편집`, exact: true }).click();
}

module.exports = { closeSettingsBasics, openLocationEditor, settleLayout, openStudioPanel, selectDrawStage, openProgram, programSection, selectTask, openCreateSettings, openSettingsBasics, chooseRadio, messageStep, openMessagePanel, closeMessagePanel, openMessageMore, openMessagePreview, closeMessagePreview, openTemplatePicker, chooseScheduleDate, openRecipientList, waitForDialogExitFocus };
