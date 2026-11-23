'use strict';

// Message compose skip: the sentence panels (받는 사람 list, 보내는 방법, 시점)
// are folded by default, but the recipient list can still be opened ahead of
// the draft. A focus-only skip link at the form front bypasses everything
// straight into the message body without adding visible guidance.
// Source-only assertions; rendered keyboard behavior belongs to main's
// browser audit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx'),
  'utf8'
);

test('a focus-only skip leads into the draft before the recipient list', () => {
  assert.match(SOURCE, /className="skip-link"/u, 'skip uses the shared focus-only pattern');
  // Reopened 2026-11-23: the record title is optional (auto-filled), so the
  // skip lands in the message body, the first thing the operator writes.
  assert.match(SOURCE, /data-skip-to="campaign-body"/u, 'skip carries the audit hook');
  assert.match(SOURCE, /메시지 작성으로 건너뛰기/u, 'skip names the draft');
  assert.match(SOURCE, /href="#campaign-body"/u, 'skip targets the message body');
  const skipAt = SOURCE.indexOf('data-skip-to="campaign-body"');
  assert.ok(skipAt !== -1, 'expected the compose skip');
  const skipWindow = SOURCE.slice(Math.max(0, skipAt - 600), skipAt + 600);
  // Reopened 2026-11-24 (owner: 시안 A): there are no steps to reveal any more; the body is always
  // mounted, so the skip only has to move focus onto it.
  assert.doesNotMatch(SOURCE, /goComposeStep|composeStep/u, 'no step navigation remains');
  assert.match(skipWindow, /document\.getElementById\("campaign-body"\)\?\.focus\(\)/u, 'skip focuses the always-mounted body');
  assert.match(skipWindow, /event\.preventDefault\(\)/u, 'no navigation side effects');
  assert.doesNotMatch(skipWindow, /postCommand|message\.create|requestSubmit/u, 'the skip never sends');
  // Order: form front, ahead of the sentence pills and the recipient picker,
  // so one Tab from the form start reaches the bypass before any panel.
  const formAt = SOURCE.indexOf('<ValidatedForm className={uiStyles.formStack} onSubmit=');
  assert.ok(formAt >= 0 && formAt < skipAt, 'skip sits at the form front');
  assert.ok(skipAt < SOURCE.indexOf('id="campaign-sentence"'), 'skip precedes the sentence pills');
  assert.ok(skipAt < SOURCE.indexOf('id="campaign-recipients"'), 'skip precedes the recipient picker');
  // The body it targets exists and sits after the folded panels.
  assert.ok(SOURCE.indexOf('id="campaign-body"') > SOURCE.indexOf('id="campaign-schedule"'), 'the body follows the panels');
});

// Reopened 2026-11-24 (owner: 시안 A): the visible 내용 작성으로 계속 / 발송 검토로 이동 / 수신자 다시 확인
// buttons left with the steps. The sentence pills are the return path to the pickers.
test('the sentence pills are the return paths while selected-only avoids a duplicate count', () => {
  assert.doesNotMatch(SOURCE, /내용 작성으로 계속|수신자 다시 확인|발송 검토로 이동|campaign-send-skip|recipientTopBar/u, 'no step-only jump buttons remain');
  assert.match(SOURCE, /id="campaign-who-pill"[^>]*aria-controls="campaign-recipients"/u, 'the who pill opens the picker');
  assert.match(SOURCE, /onClick=\{jumpToRecipientFilter\}|jumpToRecipientFilter\(\)/u, 'the 이름 확인 return still opens and focuses the picker');
  assert.match(SOURCE, /id="recipient-selected-only"/u, 'selected-only toggle stays');
  assert.match(SOURCE, /선택 대상만 보기/u);
  assert.doesNotMatch(SOURCE, /선택 대상만 보기\(/u, 'no duplicated count on the toggle');
  // Counts concentrate in the representative summary and the final review.
  assert.match(SOURCE, /id="recipient-summary"/u);
  assert.match(SOURCE, /선택 \{selectedCount\}명/u);
  assert.match(SOURCE, /id="campaign-submit-warning"/u);
});
