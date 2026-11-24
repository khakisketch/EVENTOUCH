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
  assert.match(choose, /choice === "NOW"\) setCampaignDraft\(current => \(\{ \.\.\.current, scheduled: "", scheduleMode: "MANUAL" \}\)\)/u);
  assert.match(SOURCE, /id="campaign-scheduled"/u, 'the exact date input and its validation stay');
  assert.match(SOURCE, /예약 시각은 현재 이후로 설정하세요\./u);
});

// Reopened 2026-11-24 (owner: 시안 A): the four-zone checklist became one sentence with three pill
// buttons, each opening one inline panel; the old "every zone is mounted" test is replaced by the
// sentence / panels / preview contract below. Folded panels stay mounted and use `hidden`.
test('one sentence: three pills open three mounted panels, one at a time', () => {
  assert.doesNotMatch(SOURCE, /hidden=\{composeStep !== 3\}|composeStep|goComposeStep|composeChecklist|data-layout="checklist"|data-step=/u, 'no step state or checklist remains');
  assert.doesNotMatch(SOURCE, /aria-label="메시지 작성 항목"|aria-label="메시지 작성 단계"/u);
  assert.match(SOURCE, /const \[openPanel, setOpenPanel\] = useState<"who" \| "how" \| "when" \| null>\(null\)/u, 'at most one panel is open');
  assert.match(SOURCE, /function togglePanel\(panel: "who" \| "how" \| "when"\) \{ setOpenPanel\(current => current === panel \? null : panel\); \}/u);
  for (const [pill, panel, key] of [['campaign-who-pill', 'campaign-recipients', 'who'], ['campaign-how-pill', 'campaign-how-panel', 'how'], ['campaign-when-pill', 'campaign-schedule', 'when']]) {
    assert.match(SOURCE, new RegExp(`<button type="button" id="${pill}"[^>]*aria-expanded=\\{openPanel === "${key}"\\}[^>]*aria-controls="${panel}"[^>]*onClick=\\{\\(\\) => togglePanel\\("${key}"\\)\\}`, 'u'), `${pill} toggles ${panel}`);
    assert.match(SOURCE, new RegExp(`id="${panel}"[^>]*hidden=\\{openPanel !== "${key}"\\}`, 'u'), `${panel} is mounted and folded with hidden`);
  }
  // The panels hold their fields: who → presets, summary and the (closed) list; how → channel,
  // fallback and the 알림톡 template picker; when → the choice, offsets and the exact date.
  const who = SOURCE.slice(SOURCE.indexOf('id="campaign-recipients"'), SOURCE.indexOf('id="campaign-how-panel"'));
  for (const id of ['recipient-preset-', 'recipient-summary', 'recipient-list-summary', 'recipient-status-filter']) assert.ok(who.includes(id), `who panel holds ${id}`);
  const how = SOURCE.slice(SOURCE.indexOf('id="campaign-how-panel"'), SOURCE.indexOf('id="campaign-schedule"'));
  for (const id of ['campaign-channel', 'campaign-sms-fallback']) assert.ok(how.includes(id), `how panel holds ${id}`);
  assert.match(how, /campaignDraft\.channel === "ALIMTALK" \? templatePickerNode : null/u, 'alimtalk template picker lives in the how panel');
  const when = SOURCE.slice(SOURCE.indexOf('id="campaign-schedule"'), SOURCE.indexOf('id="campaign-content"'));
  for (const id of ['campaign-schedule-choice', 'campaign-event-offset', 'campaign-event-time', 'campaign-scheduled', 'campaign-schedule-mode']) assert.ok(when.includes(id), `when panel holds ${id}`);
  assert.match(when, /effectiveScheduleChoice === "DATE" \? <div>[\s\S]*?id="campaign-scheduled"/u, 'the exact date input appears only when 날짜·시각 지정 is chosen');
  // Order: sentence, panels, content, preview, send area, dock with the one submit.
  const order = ['id="campaign-sentence"', 'id="campaign-recipients"', 'id="campaign-how-panel"', 'id="campaign-schedule"', 'id="campaign-content"', 'id="campaign-body"', 'className={styles.previewPane}', 'className={styles.sendArea}', 'id="campaign-review-heading"', 'className={styles.sendDock}', 'id="campaign-submit"'].map(id => SOURCE.indexOf(id));
  assert.ok(order.every(at => at !== -1), 'every landmark exists');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'zones follow the sentence order');
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
  assert.match(CSS, /\.previewPane \{ position: sticky;/u);
  assert.match(CSS, /@media \(max-width: 1024px\) \{[\s\S]*?\.previewPane \{ display: none; position: static; \}[\s\S]*?\.previewPane\[data-open="true"\] \{ display: grid; position: fixed; inset: auto 0 0 0;/u);
  assert.match(CSS, /\.previewClose, \.previewOpen \{ display: inline-flex;/u, 'the opener and closer only exist where the sheet does');
});
