'use strict';

// Reopened 2026-11-26 (owner: 한 화면 네 구역). The composer is one sentence over four always-mounted zones
// (누구에게 · 어떻게 · 언제 · 무엇을), each a set of cards. This pins what is new in that composition:
// the choice cards, 사진 문자 and its drop zone, 알림톡 approved-template cards chosen in zone 4, the
// reservation that goes out by itself only where the server can run it, and the sticky sentence + send rail.
// Source and pure-function assertions; the rendered behavior was exercised in Chromium by main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'apps/web/app/console/events/[id]/messages');
const SOURCE = fs.readFileSync(path.join(DIR, 'MessagingWorkspace.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(DIR, 'MessagingWorkspace.module.css'), 'utf8');
const CARDS = fs.readFileSync(path.join(DIR, 'OptionCards.tsx'), 'utf8');
const CARDS_CSS = fs.readFileSync(path.join(DIR, 'OptionCards.module.css'), 'utf8');

function extract(name) {
  const start = SOURCE.indexOf(`export function ${name}(`);
  assert.ok(start !== -1, `expected ${name}`);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 3).replace(/^export /u, '');
}
function load(...names) {
  const code = `${names.map(extract).join('\n')}\nmodule.exports = { ${names.join(', ')} };`;
  const mod = { exports: {} };
  new Function('module', 'exports', stripTypeScriptTypes(code))(mod, mod.exports);
  return mod.exports;
}

test('a reservation is automatic only where this server can really run it', () => {
  const { scheduleModeDefault } = load('scheduleModeDefault');
  const ready = { observedAt: '', autoConfigured: true, eligibleForAuto: true, workerStarted: true, lastAttemptAt: '', lastResult: '', blocked: [] };
  assert.equal(scheduleModeDefault(ready, true), 'AUTO');
  assert.equal(scheduleModeDefault(ready, false), 'MANUAL', 'no provider connection, nothing goes out by itself');
  assert.equal(scheduleModeDefault({ ...ready, autoConfigured: false }, true), 'MANUAL', 'automatic runs are switched off on this server');
  assert.equal(scheduleModeDefault({ ...ready, workerStarted: false }, true), 'MANUAL', 'the worker has not started');
  assert.equal(scheduleModeDefault({ ...ready, eligibleForAuto: false }, true), 'MANUAL', 'this organization is not eligible');
  assert.equal(scheduleModeDefault(null, true), 'MANUAL', 'an unknown server state is never assumed automatic');
});

test('the execution line states what will really happen and offers the other mode', () => {
  const zone = SOURCE.slice(SOURCE.indexOf('id="campaign-schedule"'), SOURCE.indexOf('id="campaign-content"'));
  assert.match(zone, /에 자동으로 나갑니다/u);
  assert.match(zone, /이 서버는 지금 자동 발송이 꺼져 있어, 켜지기 전에는 나가지 않습니다/u, 'AUTO on a server that cannot run it says so instead of promising');
  assert.match(zone, /발송 기록에서 ‘발송 실행’을 눌러야 나갑니다/u, 'MANUAL names what to press');
  assert.match(zone, /serverCanAuto/u, 'the promise follows the server state');
  assert.match(zone, /직접 실행으로 바꾸기/u);
  assert.match(zone, /자동 발송으로 바꾸기/u);
  assert.match(zone, /!simulateDraft/u, 'a mock reservation is never described as automatic');
  assert.match(SOURCE, /scheduleModeTouchedRef/u, 'a chosen mode is not overwritten by the default');
  // The default is applied where a reservation is first created, never to a past choice.
  assert.match(SOURCE, /scheduleMode: current\.scheduled \|\| scheduleModeTouchedRef\.current \? current\.scheduleMode : defaultScheduleMode\(\)/u);
  assert.doesNotMatch(SOURCE, /scheduleMode: "AUTO",\n/u, 'the stored default is still MANUAL; AUTO is only ever chosen from the server state');
});

test('사진 문자 survives text loads, and 문자 means no photo', () => {
  const { keepTextFamily } = load('keepTextFamily');
  assert.equal(keepTextFamily({ channel: 'MMS', imageFileId: '' }, 'SMS'), 'MMS', 'choosing 사진 문자 before a photo exists is kept');
  assert.equal(keepTextFamily({ channel: 'SMS', imageFileId: 'f-1' }, 'SMS'), 'MMS', 'an attached photo keeps it a photo message');
  assert.equal(keepTextFamily({ channel: 'SMS', imageFileId: '' }, 'SMS'), 'SMS');
  assert.equal(keepTextFamily({ channel: 'MMS', imageFileId: 'f-1' }, 'ALIMTALK'), 'ALIMTALK');
  const choose = SOURCE.slice(SOURCE.indexOf('function chooseChannel('), SOURCE.indexOf('function attachPhoto('));
  assert.match(choose, /next === "SMS" && campaignDraft\.imageFileId/u, 'switching to 문자 drops the photo');
  assert.match(choose, /imageFileId: "", imageName: ""/u);
  assert.match(choose, /uncertainMmsUpload/u, 'an unconfirmed upload blocks switching');
  const remove = SOURCE.slice(SOURCE.indexOf('function removePhoto('), SOURCE.indexOf('// 알림톡 card:'));
  assert.doesNotMatch(remove, /channel:/u, 'deleting the photo keeps 사진 문자 chosen so the drop zone returns');
  assert.match(SOURCE, /사진 문자는 사진을 첨부해야 합니다\./u, 'a photo message without a photo is still refused at review');
});

test('the photo is one file in a drop zone; the real upload path is unchanged', () => {
  const attach = SOURCE.slice(SOURCE.indexOf('function attachPhoto('), SOURCE.indexOf('function removePhoto('));
  assert.match(attach, /\["image\/jpeg", "image\/png", "image\/webp"\]\.includes\(file\.type\)/u, 'a dropped file is type-checked like the picker');
  assert.match(attach, /void uploadMmsImage\(file\)/u, 'fit, upload, receipts and recovery stay in uploadMmsImage');
  assert.match(SOURCE, /onDrop=\{\(event\) => \{ event\.preventDefault\(\); setPhotoDrag\(false\); attachPhoto\(event\.dataTransfer\.files\?\.\[0\]\); \}\}/u, 'only the first dropped file is used');
  assert.match(SOURCE, /<label\s+className=\{styles\.drop\}\s+htmlFor="campaign-image"/u, 'the drop zone is the label of the real file input');
  assert.match(SOURCE, /id="campaign-image"\s+className=\{styles\.photoInput\}/u);
  assert.match(CSS, /\.photoInput \{[^}]*clip-path: inset\(50%\)/u, 'the input stays focusable but is not drawn twice');
  assert.match(CSS, /\.photo:has\(\.photoInput:focus-visible\)/u, 'keyboard focus on the hidden input is visible on the drop zone');
});

test('알림톡 chooses an approved template in zone 4 and shows its note, never its text', () => {
  const what = SOURCE.slice(SOURCE.indexOf('id="campaign-content"'), SOURCE.indexOf('className={styles.recordName}'));
  assert.match(what, /approvedAlimtalkTemplates\.map\(\(template\): OptionCard => \(\{ value: template\.id, label: template\.name, hint: template\.description \|\| undefined/u);
  assert.doesNotMatch(what, /hint: template\.body/u, 'the card never repeats the message text');
  const pick = SOURCE.slice(SOURCE.indexOf('function pickAlimtalkTemplate('), SOURCE.indexOf('function changeEventOffset('));
  assert.match(pick, /campaignDraft\.body\.trim\(\) && !bodyIsApprovedText && campaignDraft\.body !== template\.body\) \{ useTemplate\(template\); return; \}/u, 'typed text is replaced only after the existing confirm');
  assert.match(pick, /channel: "ALIMTALK", body: template\.body/u, 'the approved text is the message');
  assert.doesNotMatch(pick, /revealComposer|focusComposerOnOpenRef/u, 'an inline pick never jumps the page');
  assert.match(SOURCE, /승인된 알림톡 템플릿이 없습니다\./u);
  assert.match(SOURCE, /const ALIMTALK_CARD_LIMIT = 6;/u);
  assert.match(what, /approvedAlimtalkTemplates\.length > ALIMTALK_CARD_LIMIT \? templatePickerNode/u, 'a long, data-driven list stays the native select');
  assert.match(SOURCE, /field === "templateId" \? document\.getElementById\("campaign-template"\) : null/u, 'an error still lands on the select when it replaces the cards');
  // The use-confirm dialog is shared by both channels, so a typed text is never replaced silently.
  assert.equal((SOURCE.match(/\{templateUseDialogNode\}/gu) ?? []).length, 2, 'rendered once per channel branch');
  assert.match(SOURCE, /hidden=\{campaignDraft\.channel === "ALIMTALK"\}/u, 'the approved text is not editable');
  // Server and form: the note is optional, 80 characters, and not sent to recipients.
  assert.match(SOURCE, /id="template-description"[\s\S]{0,200}maxLength=\{80\}/u);
  assert.match(SOURCE, /description: templateDraft\.description,/u);
});

test('the choice cards are native radios inside a named group', () => {
  assert.match(CARDS, /<fieldset id=\{id\}/u);
  assert.match(CARDS, /<legend className="sr-only">\{legend\}<\/legend>/u);
  assert.match(CARDS, /type="radio" name=\{id\}/u, 'native radios own selection and arrow-key movement');
  assert.match(CARDS, /input:checked:not\(:disabled\)/u, 'field-error focus on the group lands on the chosen radio');
  assert.doesNotMatch(CARDS, /role="(radio|radiogroup|button)"/u, 'no invented widget roles');
  assert.match(CARDS_CSS, /\.card:has\(\.input:checked\)/u);
  assert.match(CARDS_CSS, /\.card:has\(\.input:focus-visible\) \{ outline: 2px solid var\(--focus\)/u);
  assert.match(CARDS_CSS, /\.card\[data-tone="kakao"\] \.tile[^{]*\{ background: var\(--message-kakao-header\)/u, 'only 알림톡 wears the Kakao yellow');
  assert.doesNotMatch(CARDS_CSS, /#[0-9a-fA-F]{3,8}\b/u, 'tokens only');
  assert.doesNotMatch(CARDS_CSS, /--brand/u, 'a chosen card is ink, never orange');
  for (const value of ['SMS', 'MMS', 'ALIMTALK']) assert.match(SOURCE, new RegExp(`value: "${value}", label:`, 'u'), `${value} is a channel card`);
  for (const value of ['NOW', 'EVENT', 'DATE']) assert.match(SOURCE, new RegExp(`value: "${value}", label:`, 'u'), `${value} is a schedule card`);
});

test('the event-relative card names the day in words and keeps every offset', () => {
  assert.match(SOURCE, /\{ days: 1, label: "행사 하루 전" \}/u);
  assert.match(SOURCE, /const eventDayLabel = \(days: number\) =>/u);
  assert.match(SOURCE, /label: `\$\{eventDayLabel\(eventOffset\.days\)\}`/u, 'the card reads 행사 하루 전 for one day, the chosen offset otherwise');
  for (const label of ['행사 3일 전', '행사 2일 전', '행사 당일', '행사 다음 날']) assert.ok(SOURCE.includes(`label: "${label}"`), `${label} stays available`);
  assert.match(SOURCE, /disabled: !eventDateKnown/u, 'without an event date the card is off, never faked');
});

test('the audience cards: 직접 고르기 is the fourth card and the summary is one number with pills', () => {
  const who = SOURCE.slice(SOURCE.indexOf('id="campaign-recipients"'), SOURCE.indexOf('id="campaign-how-panel"'));
  assert.match(who, /id="recipient-direct-open"[^>]*aria-haspopup="dialog"[^>]*aria-expanded=\{recipientListOpen\}/u);
  assert.match(who, /\{directPicked \? `\$\{selectedCount\}명 선택 중` : "열기"\}/u, 'the card shows an open arrow, not a count that reads as a preset');
  assert.match(who, /<strong className=\{styles\.selectionCount\}>선택 \{selectedCount\}명<\/strong>/u);
  assert.doesNotMatch(who, /발송 가능/u, 'the same number is not written twice');
  assert.match(SOURCE, /const everyoneAlreadyIn = /u);
  assert.match(SOURCE, /아직 입장 안 한 분 · 지금은 전원과 같음/u, 'identical audiences are explained on the card, not in a banner');
  assert.match(SOURCE, /입장 기록이 확인된 사람만 셉니다/u, 'the exact counting rule stays reachable as the card title');
});

test('the sentence stays in view on wide screens and the send rail sits under the preview', () => {
  assert.match(CSS, /@media \(min-width: 1025px\) \{\s*\.sentenceBlock \{ position: sticky; top: 0;/u);
  assert.match(CSS, /\.composeMain :is\(input, select, textarea, button, label, summary, \[tabindex\]\) \{ scroll-margin-top: 140px; \}/u, 'keyboard focus never lands under the sticky sentence');
  assert.match(CSS, /\.rail \{ position: sticky;/u);
  assert.match(SOURCE, /<div className=\{styles\.rail\}>\s*<aside className=\{styles\.previewPane\}/u);
  assert.match(CSS, /\.composeGrid\[data-layout="simple"\], \.rail \{ display: contents; \}/u, 'on small screens the rail flattens so the dock sticks to the bottom');
  assert.match(SOURCE, /<p className=\{styles\.dockFollow\} aria-hidden="true">\{followText\}<\/p>/u, 'the phone dock repeats the sentence for sighted users only');
  assert.match(SOURCE, /data-follow=\{sentenceOut && selectedCount > 0 \? "true" : undefined\}/u, 'and only once the sentence has scrolled away with someone chosen');
  assert.match(SOURCE, /new IntersectionObserver\(/u);
});

test('the 직접 고르기 list is a dialog: Enter never sends and the clean reload does not interrupt', () => {
  assert.match(SOURCE, /setRecipientListOpen\(nextStep === 1\)/u, 'a reloaded set opens the dialog only when something needs a decision');
  assert.match(SOURCE, /if \(event\.key === "Enter"\) event\.preventDefault\(\)/u);
  assert.match(SOURCE, /id="recipient-list-close"/u, 'a stable hook closes it');
  assert.match(SOURCE, /onClose=\{\(\) => setRecipientListOpen\(false\)\}\s+stickyChrome\s+footer=/u, 'the title row and 완료 stay in reach however long the list is, on phones too');
  assert.match(SOURCE, /\{recipientListOpen \? null : recipientReviewNode\}/u, 'the review banner shows once: in the zone, or in the open dialog');
});

test('a locked composer can still be read: the list dialog opens by itself and every control in it is locked', () => {
  const reveal = SOURCE.slice(SOURCE.indexOf('function revealComposer()'), SOURCE.indexOf('return (\n    <ConsolePage'));
  assert.match(reveal, /if \(messagesLocked\) \{\s*setShowSelectedOnly\(true\); setRecipientListOpen\(true\);/u, 'archived or read-only drafts show their selected people by themselves');
  const pick = SOURCE.slice(SOURCE.indexOf('title="직접 고르기"'), SOURCE.indexOf('</ValidatedForm>'));
  // The dialog is outside the composer's disabled fieldset (so its own close buttons keep working), hence each control locks itself.
  for (const id of ['recipient-status-filter', 'recipient-group-filter', 'recipient-search', 'recipient-selected-only', 'recipient-clear-all']) {
    const at = pick.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `${id} exists`);
    assert.match(pick.slice(at, at + 420), /disabled=\{[^}]*messagesLocked/u, `${id} is locked with the composer`);
  }
  assert.match(pick, /type="checkbox"\s+disabled=\{messagesLocked \|\| compositionPending\}\s+checked=\{selectedSet\.has\(person\.id\)\}/u, 'the rows cannot change recipients');
});
