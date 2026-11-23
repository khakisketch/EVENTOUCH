'use strict';

// Keyboard path from confirmed recipients to the send request button.
// Reopened 2026-11-24 (owner: 시안 A): the recipient list, schedule inputs and
// channel options now live in folded panels under the sentence pills, so the
// composer holds only the three pills, the purpose chips, the body, the
// personalization chips and 더 보기 ahead of the submit. The old in-form
// "발송 검토로 이동" move (and its step heading focus) left with the steps;
// the submit itself is a few Tab stops away and sits in a sticky dock. Source-only
// assertions; rendering and browser exercise belong to main.

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

test('no step jump remains: panels are folded and the submit is reachable without a jump control', () => {
  assert.doesNotMatch(SOURCE, /campaign-send-skip|jumpToCampaignSubmit|jumpToCampaignTitle|goComposeStep|발송 검토로 이동/u, 'the step-era jumps are gone');
  // Folded panels use the hidden attribute so their controls leave the tab order and the a11y tree.
  assert.match(SOURCE, /id="campaign-recipients"[^>]*hidden=\{openPanel !== "who"\}/u);
  assert.match(SOURCE, /id="campaign-how-panel"[^>]*hidden=\{openPanel !== "how"\}/u);
  assert.match(SOURCE, /id="campaign-schedule"[^>]*hidden=\{openPanel !== "when"\}/u);
  assert.match(CSS, /\.panel\[hidden\] \{ display: none; \}/u, 'a hidden panel is never drawn or tabbed');
  // The recipient list is closed by default; it opens from 직접 고르기 or a flow that needs review.
  assert.match(SOURCE, /const \[recipientListOpen, setRecipientListOpen\] = useState\(false\)/u, 'the long list starts folded');
  // The submit follows every panel, the body and the 더 보기 block in DOM order.
  const submitAt = SOURCE.indexOf('id="campaign-submit"');
  for (const id of ['id="campaign-recipients"', 'id="campaign-schedule"', 'id="campaign-body"', 'id="campaign-title"']) {
    assert.ok(SOURCE.indexOf(id) < submitAt, `${id} precedes the submit`);
  }
  assert.equal((SOURCE.match(/id="campaign-submit"/gu) ?? []).length, 1, 'one submit remains');
});

test('the dock lands on the review summary or the submit without sending', () => {
  // The review summary stays a programmatic focus landing (tabIndex -1) for flows that must
  // surface the blocking reason; the submit validates only when pressed.
  assert.match(SOURCE, /<h3 className="sr-only" id="campaign-review-heading" tabIndex=\{-1\}>/u);
  assert.match(SOURCE, /id="campaign-submit-warning" tabIndex=\{-1\}/u);
  const submit = SOURCE.slice(SOURCE.indexOf('function requestCampaignCreate'), SOURCE.indexOf('const fingerprint = fingerprintFor("message.create-charset-reviewed"'));
  assert.match(submit, /!selectedIds\.length/u);
  assert.match(submit, /!campaignDraft\.body\.trim\(\)/u);
  assert.match(submit, /event\.preventDefault\(\)/u);
  // Field errors open the folded panel that owns the field, then focus it.
  const reveal = SOURCE.slice(SOURCE.indexOf('The field lives in a folded panel'), SOURCE.indexOf('if (recipientReviewRequired) return;'));
  assert.match(reveal, /field === "ids"\) setOpenPanel\("who"\)/u);
  assert.match(reveal, /field === "scheduled"\) setOpenPanel\("when"\)/u);
  assert.match(reveal, /setMoreOpen\(true\)/u);
  assert.doesNotMatch(reveal, /postCommand|executeCampaignCreate|requestSubmit|\.click\(/u);
});

test('submit button id and labelling are preserved', () => {
  assert.match(SOURCE, /id="campaign-submit"/u);
  const submitAt = SOURCE.indexOf('id="campaign-submit"');
  const submitEnd = SOURCE.indexOf('</ProductButton>', submitAt);
  assert.ok(submitEnd > submitAt, 'submit button must close');
  const submitWindow = SOURCE.slice(submitAt, submitEnd);
  assert.match(submitWindow, /type="submit"/u);
  assert.match(submitWindow, /발송 검토/u);
  // The submit lives in a sticky dock beside the preview opener (시안 A).
  assert.match(SOURCE, /<div className=\{styles\.sendDock\}>[\s\S]*?id="message-preview-open"[\s\S]*?id="campaign-submit"/u);
  assert.match(CSS, /\.sendDock \{[^}]*position: sticky;[^}]*bottom: 0/u);
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
  // The sentence pills, the preview opener and the text buttons reuse 44px/token-only controls.
  assert.match(CSS, /\.pill \{[^}]*min-height: var\(--control-min-size\)/u);
  assert.match(CSS, /\.previewOpen \{[^}]*min-height: var\(--control-min-size\)/u);
  assert.match(CSS, /\.textButton \{[^}]*min-height: 44px/u);
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u);
  // Reopened 2026-11-24 (시안 A): the send dock is deliberately sticky so 발송 검토 stays in reach;
  // on a phone it clears the home indicator and keeps a top rule instead of covering fields blindly.
  assert.match(CSS, /\.sendDock \{[^}]*env\(safe-area-inset-bottom/u, 'the dock clears the device inset');
  assert.match(
    CSS,
    /@media \(max-width: 1024px\) \{[\s\S]*?\.sendDock \{ border-top: 1px solid var\(--line\); \}/u,
    'the phone dock is separated from the fields it floats over'
  );
});

test("the skip control carries the product-wide hook the audit measures", () => {
  // The usability audit recognises an in-form skip by this hook, so the
  // shortest keyboard path stays measurable instead of being counted as a
  // long tab walk. Reopened 2026-11-24: the skip lands on the message body
  // (the review button is a few Tab stops later, no jump to it is needed).
  assert.match(SOURCE, /data-skip-to="campaign-body"/u);
  assert.match(SOURCE, /id="campaign-submit"/u);
});
