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

// Reopened 2026-11-24 (owner: 시안 A): the recipient state heads the compose form as the first
// pill of one sentence; the picker is an inline panel that opens from that pill. The
// recipientTopBar and its 수신자 다시 확인 / 내용 작성으로 계속 jumps left with the steps.
test('recipient state heads the compose form as the sentence\'s first pill with a folded picker', () => {
  assert.doesNotMatch(SOURCE, /recipientTopBar|수신자 다시 확인|recipient-heading/u);
  assert.match(SOURCE, /id="campaign-who-pill"[^>]*aria-expanded=\{openPanel === "who"\}[^>]*aria-controls="campaign-recipients"/u);
  assert.match(SOURCE, /id="campaign-recipients"/u);
  assert.match(SOURCE, /getElementById\("campaign-recipients"\)\?\.scrollIntoView/u);
  assert.match(SOURCE, /getElementById\("recipient-status-filter"\)\?\.focus/u);
  // The sentence precedes the long form: title, body, and the folded picker's list.
  const head = SOURCE.indexOf('id="campaign-sentence"');
  assert.ok(head !== -1, 'expected the sentence');
  assert.ok(head < SOURCE.indexOf('id="campaign-body"'), 'sentence must precede the message body');
  assert.ok(head < SOURCE.indexOf('id="campaign-body"'), 'sentence must precede the body field');
  assert.ok(SOURCE.indexOf('id="campaign-who-pill"') > head && SOURCE.indexOf('id="campaign-who-pill"') < SOURCE.indexOf('id="campaign-recipients"'), 'the pill leads the panel it opens');
  assert.ok(SOURCE.indexOf('id="campaign-recipients"') < SOURCE.indexOf('id="recipient-list-summary"'), 'the long list lives inside the picker panel');
  // The picker keeps its title and detailed summary, and starts with the audience presets.
  assert.match(SOURCE, /<legend className=\{styles\.panelTitle\}>누구에게 보낼까요<\/legend>/u);
  assert.match(SOURCE, /className=\{styles\.audiencePresets\} role="group" aria-label="받는 사람 묶음"/u);
  assert.match(SOURCE, /id="recipient-summary"/u);
  assert.match(SOURCE, /확정 \{selectedApproved\}명/u);
  assert.match(CSS, /\.sentence \{/u);
  assert.match(CSS, /\.pill \{/u);
});

test('zero-recipient block is stated next to the submit button, UI-only', () => {
  // Existing count + no-undo wording near the button stays.
  assert.match(SOURCE, /id="campaign-submit-warning"/u);
  assert.match(SOURCE, /선택 \{selectedCount\}명/u);
  assert.match(SOURCE, /발송은 되돌릴 수 없습니다/u);
  // Zero state names the block reason right there.
  assert.match(SOURCE, /selectedCount === 0 \? " 수신자를 먼저 고르세요\." : ""/u);
  // The block itself is unchanged: the submit handler returns before any
  // command with the server's own wording. The approved workbench also
  // disables review while zero recipients; its visible reason remains above.
  assert.match(SOURCE, /if \(!selectedIds\.length\)/u);
  assert.match(SOURCE, /발송 대상을 선택하세요\./u);
  assert.match(SOURCE, /id="campaign-submit"/u);
  assert.match(SOURCE, /disabled=\{selectedCount === 0 \|\|/u);
  assert.match(SOURCE, /aria-describedby=\{campaignError && !uncertainCreate \? "campaign-submit-warning campaign-request-error" : "campaign-submit-warning"\}/u);
});

test('send request command and mock-send wording are preserved', () => {
  assert.match(SOURCE, /message\.create/u);
  assert.match(SOURCE, /postCommand\("message\.create-charset-reviewed", pending\.payload, pending\.id\)/u);
  assert.match(SOURCE, /confirmsCharsetReviewedMessageCreate\(pending\.id, pending\.payload, result\)/u);
  assert.match(SOURCE, /발송 요청/u);
  assert.match(SOURCE, /모의 발송/u);
  assert.match(SOURCE, /실행해도 수신자에게 전달되지 않습니다/u);
  assert.match(SOURCE, /선택 \$\{args\.count\}명에게 발송 요청을 진행할까요/u);
  assert.match(SOURCE, /이미 공급사가 접수한 발송은 취소할 수 없습니다/u);
});

test('API surface is unchanged and styling uses tokens only', () => {
  assert.match(SOURCE, /\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/commands/u);
  // Reads go through the shared transport; the event read is the scoped
  // event bootstrap, never the full directory.
  assert.match(SOURCE, /consoleFetch\("\/api\/auth\/me"/u);
  assert.match(SOURCE, /consoleFetch\(`\/api\/events\/\$\{encodeURIComponent\(eventId\)\}\/bootstrap\?messageRecipientReview=1`/u);
  assert.doesNotMatch(SOURCE, /consoleFetch\("\/api\/bootstrap"/u, "no full bootstrap read remains");
  assert.match(SOURCE, /message\.retry/u);
  assert.match(SOURCE, /message\.sync/u);
  assert.match(SOURCE, /message\.cancel/u);
  assert.match(SOURCE, /template\.save/u);
  assert.match(CSS, /scroll-margin-top/u);
  assert.match(CSS, /var\(--surface-muted\)/u);
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u);
});

test('recipient meta wraps Korean status at phrase boundaries, never mid-syllable', () => {
  // The composer meta reads `소속 · 마스킹 번호 · 상태`: anywhere tore the
  // status itself (참가 확/정). keep-all holds whole syllables while
  // break-word still contains long emails and masked numbers.
  const metaAt = CSS.indexOf('.recipientMeta {');
  assert.ok(metaAt !== -1, 'expected the recipient meta style');
  const metaWindow = CSS.slice(metaAt, CSS.indexOf('}', metaAt) + 1);
  assert.match(metaWindow, /word-break:\s*keep-all/u, 'Korean status keeps whole syllables');
  assert.match(metaWindow, /overflow-wrap:\s*break-word/u, 'long tokens still contain without overflowing');
  assert.doesNotMatch(metaWindow, /overflow-wrap:\s*anywhere/u, 'anywhere must not return to the meta');
  assert.match(SOURCE, /data-recipient-meta/u, 'the audit measures the drawn meta lines');
});
