'use strict';
// Reopened 2026-11-24 (owner: 시안 A): the checklist below became one sentence with panels (see the
// last two tests); the pure-function and handler tests still describe the same behaviour.
// Reopened 2026-11-23 (owner decision): the message composer is a one-screen
// checklist. Audience presets come first, purpose templates load starting
// text, 보낼 때 offers 지금 / 행사 기준 / 날짜·시각, and an empty record title
// is filled automatically. Nothing here may send: the existing review and
// confirmation remain the only path to message.create.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx'), 'utf8');

function extract(name) {
  const start = SOURCE.indexOf(`export function ${name}(`);
  assert.ok(start !== -1, `expected ${name}`);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 3).replace(/^export /u, '');
}
function load() {
  const code = `${extract('eventRelativeSchedule')}\n${extract('autoCampaignTitle')}\nmodule.exports = { eventRelativeSchedule, autoCampaignTitle };`;
  const js = stripTypeScriptTypes(code);
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

test('event-relative schedule computes one Korea-time value from the event date', () => {
  const { eventRelativeSchedule } = load();
  assert.equal(eventRelativeSchedule('2026-12-12', { days: 1, time: '18:00' }), '2026-12-11T18:00');
  assert.equal(eventRelativeSchedule('2026-12-12', { days: 0, time: '09:30' }), '2026-12-12T09:30');
  assert.equal(eventRelativeSchedule('2026-12-31', { days: -1, time: '10:00' }), '2027-01-01T10:00', 'next day crosses the year');
  assert.equal(eventRelativeSchedule('2026-03-01', { days: 3, time: '18:00' }), '2026-02-26T18:00', 'month boundary');
  assert.equal(eventRelativeSchedule('', { days: 1, time: '18:00' }), '', 'no event date, no reservation');
  assert.equal(eventRelativeSchedule('2026-12-12', { days: 1, time: '25:00' }), '', 'invalid time is refused');
});

test('an empty record title becomes purpose · M/D, never asked for', () => {
  const { autoCampaignTitle } = load();
  assert.equal(autoCampaignTitle('전날 리마인드', '2026-12-11T18:00', '2026-11-23'), '전날 리마인드 · 12/11');
  assert.equal(autoCampaignTitle('', '', '2026-11-23'), '안내 메시지 · 11/23');
  const submit = SOURCE.slice(SOURCE.indexOf('function requestCampaignCreate'), SOURCE.indexOf('const fingerprint = fingerprintFor("message.create-charset-reviewed"'));
  assert.match(submit, /const campaignTitle = campaignDraft\.title\.trim\(\) \? campaignDraft\.title : autoCampaignTitle\(/u);
  assert.match(submit, /title: campaignTitle,/u);
  assert.doesNotMatch(submit, /발송 제목을 입력하세요/u);
});

test('audience presets select whole groups and count only known non-entry', () => {
  assert.match(SOURCE, /notEntered: item\.inside === false && item\.everIn !== true && item\.attendanceReview !== true/u);
  const ids = SOURCE.slice(SOURCE.indexOf('function audienceIds('), SOURCE.indexOf('function selectAudience('));
  assert.match(ids, /recipientEligible\(person\)/u, 'cancelled people are never in a preset');
  assert.match(ids, /preset === "pending" \? person\.status === "PENDING"/u);
  const select = SOURCE.slice(SOURCE.indexOf('function selectAudience('), SOURCE.indexOf('function applyPurpose('));
  assert.match(select, /setSelectedIds\(ids\)/u);
  assert.doesNotMatch(select, /postCommand|executeCampaignCreate|requestCampaignCreate/u);
  assert.match(SOURCE, /disabled=\{preset\.count === 0 \|\| messagesLocked\}/u, 'empty or locked presets cannot be chosen');
});

test('purpose templates replace text only after confirmation and never send', () => {
  const request = SOURCE.slice(SOURCE.indexOf('function requestPurpose('), SOURCE.indexOf('function chooseSchedule('));
  assert.match(request, /campaignDraft\.body\.trim\(\) && campaignDraft\.body !== purpose\.body\) \{ setPendingPurpose\(purpose\)/u);
  const apply = SOURCE.slice(SOURCE.indexOf('function applyPurpose('), SOURCE.indexOf('function requestPurpose('));
  assert.match(apply, /if \(!selectedIds\.length && purpose\.audience\)/u, 'an existing selection is kept');
  assert.match(apply, /if \(!campaignDraft\.scheduled && purpose\.schedule/u, 'an existing reservation is kept');
  assert.match(apply, /Date\.parse\(instant\) > messageNow\(\)/u, 'a past suggested time is not applied');
  assert.match(apply, /setSelectedTemplateId\(""\)/u, 'no server template is bound');
  assert.doesNotMatch(apply + request, /postCommand|executeCampaignCreate|requestCampaignCreate/u);
  const tokens = [...SOURCE.slice(SOURCE.indexOf('const PURPOSE_TEMPLATES'), SOURCE.indexOf('const EVENT_OFFSET_CHOICES')).matchAll(/\{\{([^{}]+)\}\}/gu)].map(match => match[1]);
  assert.ok(tokens.length > 0);
  for (const token of tokens) assert.ok(['이름', '행사명', '행사일', '티켓링크', '럭키번호'].includes(token), `${token} is a supported personalization`);
});

// Reopened 2026-11-24 (owner: "그렇게 다 해줘"): 행사 기준 예약은 규칙(scheduleAnchor)을 함께 보내
// 서버가 행사 날짜 변경을 따라가므로, 예전의 "옮겨지지 않습니다" 문구는 반대 계약으로 바뀐다.
test('보낼 때 sends the event-relative rule and states that it follows later date changes', () => {
  assert.doesNotMatch(SOURCE, /자동으로 옮겨지지 않습니다/u);
  assert.match(SOURCE, /행사 날짜가 바뀌면 이 예약도 같은 기준으로 함께 옮겨집니다\. 옮긴 시각이 이미 지났다면 발송하지 않고 예약을 취소합니다\./u);
  assert.match(SOURCE, /effectiveScheduleChoice === "EVENT"\) payload\.scheduleAnchor = \{ kind: "EVENT_DATE", days: eventOffset\.days, time: eventOffset\.time \}/u);
  const choose = SOURCE.slice(SOURCE.indexOf('function chooseSchedule('), SOURCE.indexOf('function changeEventOffset('));
  assert.match(choose, /choice === "NOW"\) \{ scheduleModeTouchedRef\.current = false; setCampaignDraft\(current => \(\{ \.\.\.current, scheduled: "", scheduleMode: "MANUAL" \}\)\); \}/u);
  assert.match(SOURCE, /id="campaign-scheduled"/u, 'the exact date input and its validation stay');
  assert.match(SOURCE, /예약 시각은 현재 이후로 설정하세요\./u);
});

// Reopened 2026-11-26 (owner: 한 화면 네 구역): the three pills no longer open folded panels. 누구에게 · 어떻게 ·
// 언제 · 무엇을 are four always-mounted zones; the pills scroll to the first three, the sentence stays in view on
// wide screens, 직접 고르기 is a dialog, and the send dock sits under the preview.
test('one sentence: three pills scroll to four always-mounted zones', () => {
  assert.doesNotMatch(SOURCE, /hidden=\{composeStep !== 3\}|composeStep|goComposeStep|composeChecklist|data-layout="checklist"|data-step=/u, 'no step state or checklist remains');
  assert.doesNotMatch(SOURCE, /aria-label="메시지 작성 항목"|aria-label="메시지 작성 단계"/u);
  assert.doesNotMatch(SOURCE, /openPanel|setOpenPanel|togglePanel|closePanel/u, 'no folded panels remain');
  assert.match(SOURCE, /function jumpToSection\(sectionId: string\)/u);
  for (const [pill, zone] of [['campaign-who-pill', 'campaign-recipients'], ['campaign-how-pill', 'campaign-how-panel'], ['campaign-when-pill', 'campaign-schedule']]) {
    assert.match(SOURCE, new RegExp(`<button type="button" id="${pill}"[^>]*aria-controls="${zone}"[^>]*onClick=\\{\\(\\) => jumpToSection\\("${zone}"\\)\\}`, 'u'), `${pill} scrolls to ${zone}`);
    assert.doesNotMatch(SOURCE, new RegExp(`id="${zone}"[^>]*hidden=`, 'u'), `${zone} is always visible`);
  }
  // The zones hold their fields: who → audience cards and summary (the 직접 고르기 list is a dialog after the
  // composer's fieldset, so a locked composer can still be read); how → channel cards, fallback and the photo drop
  // zone; when → the choice cards, offsets, the exact date and the execution line; what → the purpose chips or the
  // approved alimtalk template cards.
  const who = SOURCE.slice(SOURCE.indexOf('id="campaign-recipients"'), SOURCE.indexOf('id="campaign-how-panel"'));
  for (const id of ['recipient-preset-', 'recipient-direct-open', 'recipient-summary']) assert.ok(who.includes(id), `who zone holds ${id}`);
  const pick = SOURCE.slice(SOURCE.indexOf('title="직접 고르기"'), SOURCE.indexOf('</ValidatedForm>'));
  for (const id of ['recipient-status-filter', 'recipient-group-filter', 'recipient-search', 'recipient-selected-only', 'recipient-clear-all']) assert.ok(pick.includes(id), `the list dialog holds ${id}`);
  assert.ok(SOURCE.indexOf('title="직접 고르기"') > SOURCE.indexOf('</fieldset>', SOURCE.indexOf('className={styles.composeLock}')), 'the dialog follows the composer fieldset');
  const how = SOURCE.slice(SOURCE.indexOf('id="campaign-how-panel"'), SOURCE.indexOf('id="campaign-schedule"'));
  for (const id of ['campaign-channel', 'campaign-sms-fallback', 'campaign-image']) assert.ok(how.includes(id), `how zone holds ${id}`);
  assert.doesNotMatch(how, /templatePickerNode/u, 'the alimtalk template is chosen in zone 4, not in zone 2');
  const when = SOURCE.slice(SOURCE.indexOf('id="campaign-schedule"'), SOURCE.indexOf('id="campaign-content"'));
  for (const id of ['campaign-schedule-choice', 'campaign-event-offset', 'campaign-event-time', 'campaign-scheduled', 'campaign-schedule-mode']) assert.ok(when.includes(id), `when zone holds ${id}`);
  assert.match(when, /effectiveScheduleChoice === "DATE" \? <div className=\{styles\.dateField\}>[\s\S]*?id="campaign-scheduled"/u, 'the exact date input appears only when 날짜·시각 지정 is chosen');
  const what = SOURCE.slice(SOURCE.indexOf('id="campaign-content"'), SOURCE.indexOf('className={styles.recordName}'));
  assert.match(what, /id="campaign-template-cards"/u, 'alimtalk shows the approved templates as cards');
  assert.match(what, /campaignDraft\.channel !== "ALIMTALK" \? templatePickerNode : null/u, 'the saved-template picker belongs to the text channels');
  assert.match(what, /hidden=\{campaignDraft\.channel === "ALIMTALK"\}/u, 'approved text is never edited');
  // Order: sentence, zones, content, preview rail with the dock, send area.
  const order = ['id="campaign-sentence"', 'id="campaign-recipients"', 'id="campaign-how-panel"', 'id="campaign-schedule"', 'id="campaign-content"', 'id="campaign-body"', 'className={styles.previewPane}', 'className={styles.sendDock}', 'id="campaign-submit"', 'className={styles.sendArea}', 'id="campaign-review-heading"'].map(id => SOURCE.indexOf(id));
  assert.ok(order.every(at => at !== -1), 'every landmark exists');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'zones follow the sentence order, the dock follows the preview');
  assert.equal((SOURCE.match(/id="campaign-submit"/gu) ?? []).length, 1);
  // The heading landings that survive keep their focus-landing contract.
  assert.match(SOURCE, /id="campaign-content" tabIndex=\{-1\}/u);
  assert.match(SOURCE, /id="campaign-review-heading" tabIndex=\{-1\}/u);
  assert.match(SOURCE, /id="campaign-submit-warning" tabIndex=\{-1\}/u);
});

test('the preview stays beside the writing and becomes a dismissible bottom sheet on small screens', () => {
  const preview = SOURCE.slice(SOURCE.indexOf('<aside className={styles.previewPane}'), SOURCE.indexOf('</aside>', SOURCE.indexOf('<aside className={styles.previewPane}')));
  assert.match(preview, /data-open=\{previewOpen \? "true" : undefined\}/u);
  assert.match(preview, /id="message-preview-heading"/u);
  assert.match(preview, /id="message-preview-close"[^>]*onClick=\{closePreview\}/u);
  assert.match(preview, /id="message-draft-preview"/u);
  assert.match(SOURCE, /id="message-preview-open"[^>]*aria-expanded=\{previewOpen\}[^>]*onClick=\{openPreview\}/u);
  // Esc closes the sheet and focus returns to the opener.
  const effect = SOURCE.slice(SOURCE.indexOf('if (!previewOpen) return;'), SOURCE.indexOf('}, [previewOpen]);'));
  assert.match(effect, /message-preview-close/u);
  assert.match(effect, /event\.key === "Escape"\) closePreview\(\)/u);
  assert.match(SOURCE, /function closePreview\(\) \{\s*setPreviewOpen\(false\);\s*window\.requestAnimationFrame\(\(\) => document\.getElementById\("message-preview-open"\)\?\.focus/u);
  // Open/close only toggles visibility; it never sends and never touches the draft.
  assert.doesNotMatch(SOURCE.slice(SOURCE.indexOf('function openPreview()'), SOURCE.indexOf('useEffect(() => {\n    if (!previewOpen) return;')), /postCommand|executeCampaignCreate|setCampaignDraft|setSelectedIds/u);
  // Desktop shows the pane; ≤1024px it is hidden until opened as a fixed bottom sheet.
  const CSS = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.module.css'), 'utf8');
  // Reopened 2026-11-26: the preview and the send dock share one sticky rail.
  assert.match(CSS, /\.rail \{ position: sticky;/u);
  assert.match(CSS, /@media \(max-width: 1024px\) \{[\s\S]*?\.previewPane \{ display: none; position: static; \}[\s\S]*?\.previewPane\[data-open="true"\] \{ display: grid; position: fixed; inset: auto 0 0 0;/u);
  assert.match(CSS, /\.previewClose, \.previewOpen \{ display: inline-flex;/u, 'the opener and closer only exist where the sheet does');
});
