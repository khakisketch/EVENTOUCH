'use strict';
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

test('보낼 때 states that event-relative times do not follow later date changes', () => {
  assert.match(SOURCE, /나중에 행사 일정이 바뀌어도 이 예약은 자동으로 옮겨지지 않습니다\./u);
  const choose = SOURCE.slice(SOURCE.indexOf('function chooseSchedule('), SOURCE.indexOf('function changeEventOffset('));
  assert.match(choose, /choice === "NOW"\) setCampaignDraft\(current => \(\{ \.\.\.current, scheduled: "", scheduleMode: "MANUAL" \}\)\)/u);
  assert.match(SOURCE, /id="campaign-scheduled"/u, 'the exact date input and its validation stay');
  assert.match(SOURCE, /예약 시각은 현재 이후로 설정하세요\./u);
});

test('one screen: every zone is mounted and the review is always visible', () => {
  assert.doesNotMatch(SOURCE, /hidden=\{composeStep !== 3\}/u);
  for (const id of ['recipient-heading', 'campaign-content', 'campaign-schedule-heading', 'campaign-review-heading']) {
    assert.match(SOURCE, new RegExp(`id="${id}" tabIndex=\\{-1\\}`, 'u'), `${id} is a focus landing`);
  }
  const order = ['id="campaign-recipients"', 'id="campaign-content"', 'id="campaign-schedule"', 'id="campaign-review-heading"', 'id="campaign-submit"'].map(id => SOURCE.indexOf(id));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'zones follow the checklist order');
  assert.equal((SOURCE.match(/id="campaign-submit"/gu) ?? []).length, 1);
});
