'use strict';

// Keyboard path from confirmed recipients to the send request button: after
// picking recipients the composer still holds N checkbox stops, a
// 6-segment datetime-local and the option row before the submit. An
// in-form move ("발송 검토로 이동") must jump focus straight onto the
// real submit button so the next Tab leaves it and Enter/Space activates
// it — no re-finding the button by Tab. Source-only assertions; rendering
// and browser exercise belong to main.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx'),
  'utf8'
);
const CSS = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.module.css'),
  'utf8'
);

test('in-form move to the send request exists inside the compose form', () => {
  // Named access point with a self-explanatory screen-reader name.
  assert.match(SOURCE, /id="campaign-send-skip"/u);
  assert.match(SOURCE, /발송 검토로 이동/u);
  // It must be a plain button (no submit, no navigation): it only moves
  // focus, it never sends anything itself.
  const skipAt = SOURCE.indexOf('id="campaign-send-skip"');
  assert.ok(skipAt !== -1, 'expected the send skip control');
  const skipWindow = SOURCE.slice(Math.max(0, skipAt - 400), skipAt + 400);
  assert.match(skipWindow, /type="button"/u);
  assert.match(skipWindow, /onClick=\{jumpToCampaignSubmit\}/u);
  assert.doesNotMatch(skipWindow, /type="submit"/u);
  // Placement: with the recipient summary at the top of the form, so the
  // shortcut is reachable before the long recipient list is walked.
  assert.ok(skipAt > SOURCE.indexOf('id="campaign-recipients"') && skipAt < SOURCE.indexOf('id="recipient-list-summary"'), 'skip sits in the recipient section above the long list');
  assert.ok(skipAt < SOURCE.indexOf('id="campaign-submit"'), 'skip must sit before the submit button');
  assert.ok(skipAt < SOURCE.indexOf('id="campaign-scheduled"'), 'skip must sit before the schedule input');
  assert.ok(skipAt < SOURCE.indexOf('id="campaign-submit"'), 'skip must sit before the submit button');
});

test('the move reveals review and focuses its heading without sending', () => {
  // Reopened 2026-11-23: the jump lands on the submit itself, or on the
  // review summary when the submit is disabled.
  const jump = SOURCE.slice(SOURCE.indexOf('function jumpToCampaignSubmit()'), SOURCE.indexOf('function jumpToCampaignTitle()'));
  assert.match(jump, /submit && !submit\.disabled \? submit : document\.getElementById\("campaign-submit-warning"\)/u);
  assert.doesNotMatch(jump, /postCommand|executeCampaignCreate|requestSubmit|\.click\(/u);
  const fn = SOURCE.slice(SOURCE.indexOf('function goComposeStep'), SOURCE.indexOf('const focusComposerOnOpenRef'));
  assert.match(fn, /campaign-review-heading/u);
  assert.match(fn, /target\?\.focus/u);
  assert.match(fn, /scrollIntoView/u);
  // Reopened 2026-11-23: one-screen checklist. Moving between zones never
  // gates; the recipient and body checks live in the submit (발송 검토).
  assert.doesNotMatch(fn, /setCampaignFieldError/u, 'zone moves never raise field errors');
  const submit = SOURCE.slice(SOURCE.indexOf('function requestCampaignCreate'), SOURCE.indexOf('const fingerprint = fingerprintFor("message.create-charset-reviewed"'));
  assert.match(submit, /!selectedIds\.length/u);
  assert.match(submit, /!campaignDraft\.body\.trim\(\)/u);
  assert.doesNotMatch(fn, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(/u);
});

test('submit button id and labelling are preserved', () => {
  assert.match(SOURCE, /id="campaign-submit"/u);
  const submitAt = SOURCE.indexOf('id="campaign-submit"');
  const submitEnd = SOURCE.indexOf('</ProductButton>', submitAt);
  assert.ok(submitEnd > submitAt, 'submit button must close');
  const submitWindow = SOURCE.slice(submitAt, submitEnd);
  assert.match(submitWindow, /type="submit"/u);
  assert.match(submitWindow, /발송 검토/u);
  assert.match(SOURCE, /className=\{styles\.reviewBar\}/u);
  // Scroll target stays reachable for sighted operators.
  assert.match(CSS, /#campaign-submit/u);
  assert.match(CSS, /scroll-margin-top/u);
});

test('existing send, mock and cancel wording plus API surface are intact', () => {
  assert.match(SOURCE, /발송 요청/u);
  assert.match(SOURCE, /모의 발송/u);
  assert.match(SOURCE, /예약 등록/u);
  assert.match(SOURCE, /발송 요청을 취소할까요/u);
  assert.match(SOURCE, /이미 공급사가 접수한 발송은 취소할 수 없습니다/u);
  assert.match(SOURCE, /postCommand\("message\.create-charset-reviewed", pending\.payload, pending\.id\)/u);
  assert.match(SOURCE, /confirmsCharsetReviewedMessageCreate\(pending\.id, pending\.payload, result\)/u);
  assert.match(SOURCE, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/u);
  assert.match(SOURCE, /message\.retry/u);
  assert.match(SOURCE, /message\.sync/u);
  assert.match(SOURCE, /message\.cancel/u);
});

test('touch target and token-only styling hold', () => {
  // The top shortcut and bottom review bar reuse 44px/token-only controls.
  assert.match(CSS, /\.reviewBar/u);
  assert.match(CSS, /\.recipientTopBar/u);
  assert.match(CSS, /\.textButton \{[^}]*min-height: 44px/u);
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u);
  // Phone keeps the send checklist in normal flow: a sticky bar covered the
  // recipient fields at first paint (measured at 390×844).
  assert.match(
    CSS,
    /@media \(max-width: 768px\) \{[\s\S]*?\.reviewBar \{[^}]*position: static;/u,
    'the review bar must not float over the recipient fields on a phone'
  );
});

test("the skip control carries the product-wide hook the audit measures", () => {
  // The usability audit recognises an in-form skip by this hook, so the
  // shortest keyboard path stays measurable instead of being counted as a
  // long tab walk.
  assert.match(SOURCE, /data-skip-to="campaign-submit"/u);
  assert.match(SOURCE, /id="campaign-submit"/u);
});
