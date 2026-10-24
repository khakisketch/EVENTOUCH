'use strict';

// Message compose skip: recipients lead the compose DOM on every viewport,
// so desktop's default-open list puts ~100 checkboxes ahead of the draft. A
// focus-only skip link at the form front bypasses the list straight into the
// draft without adding visible guidance. Source-only assertions; rendered
// keyboard behavior belongs to main's browser audit.

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
  assert.match(SOURCE, /data-skip-to="campaign-title"/u, 'skip carries the audit hook');
  assert.match(SOURCE, /메시지 작성으로 건너뛰기/u, 'skip names the draft');
  assert.match(SOURCE, /href="#campaign-title"/u, 'skip targets the title field');
  const skipAt = SOURCE.indexOf('data-skip-to="campaign-title"');
  assert.ok(skipAt !== -1, 'expected the compose skip');
  const skipWindow = SOURCE.slice(Math.max(0, skipAt - 600), skipAt + 600);
  assert.match(skipWindow, /getElementById\("campaign-title"\)/u, 'skip resolves the real title field');
  assert.match(skipWindow, /\.focus\(/u, 'focus lands in the draft');
  assert.match(skipWindow, /scrollIntoView/u, 'the viewport follows');
  assert.match(skipWindow, /event\.preventDefault\(\)/u, 'no navigation side effects');
  assert.doesNotMatch(skipWindow, /postCommand|message\.create/u, 'the skip never sends');
  // Order: form front, ahead of the jumps and the recipient block, so one
  // Tab from the form start reaches the bypass before the long list.
  const formAt = SOURCE.indexOf('<form className={uiStyles.formStack} onSubmit={requestCampaignCreate}>');
  assert.ok(formAt >= 0 && formAt < skipAt, 'skip sits at the form front');
  assert.ok(skipAt < SOURCE.indexOf('recipientTopBar'), 'skip precedes the two visible jumps');
  assert.ok(skipAt < SOURCE.indexOf('id="campaign-recipients"'), 'skip precedes the recipient picker');
});

test('the two visible jumps stay while the selected-only label drops its duplicated count', () => {
  assert.match(SOURCE, /수신자 선택으로 이동/u, 'recipient jump stays');
  assert.match(SOURCE, /발송 검토로 이동/u, 'review jump stays');
  assert.match(SOURCE, /id="recipient-selected-only"/u, 'selected-only toggle stays');
  assert.match(SOURCE, /선택 대상만 보기/u);
  assert.doesNotMatch(SOURCE, /선택 대상만 보기\(/u, 'no duplicated count on the toggle');
  // Counts concentrate in the representative summary and the final review.
  assert.match(SOURCE, /id="recipient-summary"/u);
  assert.match(SOURCE, /선택 \{selectedCount\}명/u);
  assert.match(SOURCE, /id="campaign-submit-warning"/u);
});
