'use strict';

// Recipient-flow placement contracts: on a long mobile compose form the
// operator must see who the message goes to before writing, reach the picker
// in one move, and read the zero-recipient block next to the submit button.
// Source-only assertions; rendering and browser exercise belong to main.

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

test('recipient state heads the compose form with a jump path to the picker', () => {
  assert.match(SOURCE, /recipientTopBar/u);
  assert.match(SOURCE, /수신자 선택으로 이동/u);
  assert.match(SOURCE, /id="campaign-recipients"/u);
  assert.match(SOURCE, /getElementById\("campaign-recipients"\)\?\.scrollIntoView/u);
  assert.match(SOURCE, /getElementById\("recipient-status-filter"\)\?\.focus/u);
  // Head bar precedes the long form: title, body, and the folded picker.
  const head = SOURCE.indexOf('recipientTopBar');
  assert.ok(head !== -1, 'expected the recipient head bar');
  assert.ok(head < SOURCE.indexOf('id="campaign-title"'), 'head bar must precede the title field');
  assert.ok(head < SOURCE.indexOf('id="campaign-body"'), 'head bar must precede the body field');
  assert.ok(head < SOURCE.indexOf('id="campaign-recipients"'), 'head bar must precede the recipient picker');
  // The picker section keeps its title and detailed summary.
  assert.match(SOURCE, /<legend>발송 대상<\/legend>/u);
  assert.match(SOURCE, /id="recipient-summary"/u);
  assert.match(SOURCE, /확정 \{selectedApproved\}명/u);
  assert.match(CSS, /\.recipientTopBar/u);
});

test('zero-recipient block is stated next to the submit button, UI-only', () => {
  // Existing count + no-undo wording near the button stays.
  assert.match(SOURCE, /id="campaign-submit-warning"/u);
  assert.match(SOURCE, /선택 \{selectedCount\}명/u);
  assert.match(SOURCE, /발송은 되돌릴 수 없습니다/u);
  // Zero state names the block reason right there.
  assert.match(SOURCE, /수신자 0명 선택 · 수신자를 먼저 고르세요/u);
  assert.match(SOURCE, /selectedCount === 0 \? " 수신자를 먼저 고르세요\." : ""/u);
  // The block itself is unchanged: the submit handler returns before any
  // command with the server's own wording; the button is not disabled so the
  // reason stays readable and keyboard-reachable.
  assert.match(SOURCE, /if \(!selectedIds\.length\)/u);
  assert.match(SOURCE, /발송 대상을 선택하세요\./u);
  assert.match(SOURCE, /id="campaign-submit"/u);
  assert.doesNotMatch(SOURCE, /selectedCount.{0,80}disabled|disabled.{0,80}selectedCount/u);
});

test('send request command and mock-send wording are preserved', () => {
  assert.match(SOURCE, /message\.create/u);
  assert.match(SOURCE, /postCommand\("message\.create", pending\.payload, pending\.id\)/u);
  assert.match(SOURCE, /발송 요청/u);
  assert.match(SOURCE, /모의 발송/u);
  assert.match(SOURCE, /실행해도 수신자에게 전달되지 않습니다/u);
  assert.match(SOURCE, /선택 \$\{args\.count\}명에게 발송 요청을 진행할까요/u);
  assert.match(SOURCE, /이미 공급사가 접수한 발송은 취소할 수 없습니다/u);
});

test('API surface is unchanged and styling uses tokens only', () => {
  assert.match(SOURCE, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/u);
  assert.match(SOURCE, /fetch\("\/api\/auth\/me"/u);
  assert.match(SOURCE, /fetch\("\/api\/bootstrap"/u);
  assert.match(SOURCE, /message\.retry/u);
  assert.match(SOURCE, /message\.sync/u);
  assert.match(SOURCE, /message\.cancel/u);
  assert.match(SOURCE, /template\.save/u);
  assert.match(CSS, /scroll-margin-top/u);
  assert.match(CSS, /var\(--surface-muted\)/u);
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u);
});
