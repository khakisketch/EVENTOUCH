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

test('no step jump remains: the four zones are always mounted and the submit is reachable without a jump control', () => {
  assert.doesNotMatch(SOURCE, /campaign-send-skip|jumpToCampaignSubmit|jumpToCampaignTitle|goComposeStep|발송 검토로 이동/u, 'the step-era jumps are gone');
  // Reopened 2026-11-26: nothing is folded away from the tab order any more; the only mounted-on-demand part is the list dialog.
  for (const zone of ['campaign-recipients', 'campaign-how-panel', 'campaign-schedule']) assert.doesNotMatch(SOURCE, new RegExp(`id="${zone}"[^>]*hidden=`, 'u'), `${zone} is never hidden`);
  assert.doesNotMatch(CSS, /\.panel\[hidden\]/u, 'the folded-panel rule is gone');
  // The recipient list dialog is closed by default; it opens from 직접 고르기 or a flow that needs review.
  assert.match(SOURCE, /const \[recipientListOpen, setRecipientListOpen\] = useState\(false\)/u, 'the long list starts closed');
  // The submit follows every panel, the body and the photo field in DOM order.
  const submitAt = SOURCE.indexOf('id="campaign-submit"');
  for (const id of ['id="campaign-recipients"', 'id="campaign-schedule"', 'id="campaign-body"', 'id="campaign-image"', 'id="campaign-title"']) {
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
  // Field errors focus the field that owns them; every zone is visible, so nothing has to be unfolded first.
  const reveal = SOURCE.slice(SOURCE.indexOf('if (!campaignFieldError) return;'), SOURCE.indexOf('if (recipientReviewRequired) return;'));
  assert.match(reveal, /field === "title"\) setTitleOpen\(true\)/u);
  assert.doesNotMatch(reveal, /setOpenPanel/u);
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
  // The submit lives in the send dock beside the preview opener, under the preview in the rail.
  assert.match(SOURCE, /<div className=\{styles\.sendDock\}[^>]*>[\s\S]*?id="message-preview-open"[\s\S]*?id="campaign-submit"/u);
  assert.match(CSS, /@media \(max-width: 1024px\) \{[\s\S]*?\.sendDock \{ position: sticky; bottom: 0;/u, 'on small screens the dock sticks to the bottom');
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
    /@media \(max-width: 1024px\) \{[\s\S]*?\.sendDock \{[^}]*border-top: 1px solid var\(--line\)/u,
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
