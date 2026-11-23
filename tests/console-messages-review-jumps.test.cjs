'use strict';

// Message review jumps: forward/back navigation between the recipient
// picker, the draft and the review bar must stay operable by keyboard with
// many recipients, including the empty/disabled case. A jump onto a
// disabled submit is a silent no-op that strands focus, so the jump lands
// on the review summary where the blocker reason reads. Source-only
// assertions; rendered keyboard behavior belongs to main's browser audit.

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

// Reopened 2026-11-23: one-screen checklist. The jump only moves; the
// submit (발송 검토) names a missing prerequisite and focuses its field. An
// empty record title is filled automatically instead of being asked for.
test('review navigation shows the relevant input stage when prerequisites are missing', () => {
  const fn = SOURCE.slice(SOURCE.indexOf('function requestCampaignCreate'), SOURCE.indexOf('const fingerprint = fingerprintFor("message.create-charset-reviewed"'));
  assert.match(fn, /!selectedIds\.length/u);
  assert.match(fn, /field: "ids"/u);
  assert.match(fn, /autoCampaignTitle\(/u);
  assert.match(fn, /field: campaignDraft\.channel === "ALIMTALK" \? "templateId" : "body"/u);
  assert.match(fn, /messageContentIssue\(campaignDraft, boundTemplate\)/u);
  assert.match(SOURCE, /campaignFieldError\.field === "ids" \? 1/u);
  assert.match(SOURCE, /document\.getElementById\(ids\[campaignFieldError\.field\]/u);
  assert.doesNotMatch(fn, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(/u);
});

test('the review jump announces its requirement before activation', () => {
  const skipAt = SOURCE.indexOf('id="campaign-send-skip"');
  assert.ok(skipAt !== -1, 'expected the review jump control');
  const skipWindow = SOURCE.slice(Math.max(0, skipAt - 200), skipAt + 400);
  assert.match(skipWindow, /aria-describedby="campaign-submit-warning"/u, 'jump describes the blocking reason');
});

test('review summary is a focusable reason surface, never a tab stop', () => {
  const summaryAt = SOURCE.indexOf('id="campaign-submit-warning"');
  assert.ok(summaryAt !== -1, 'expected the review summary');
  const summaryWindow = SOURCE.slice(Math.max(0, summaryAt - 200), summaryAt + 900);
  assert.match(summaryWindow, /tabIndex=\{-1\}/u, 'summary accepts jump focus without joining the tab order');
  assert.match(summaryWindow, /selectedCount === 0 \? " 수신자를 먼저 고르세요\." : ""/u, 'zero-recipient reason stays');
  assert.match(summaryWindow, /messagesLocked \? ` \$\{messagesLockReason\}` : ""/u, 'locked reason reads next to the control');
  assert.match(CSS, /#campaign-submit-warning\)?:focus/u, 'programmatic landing draws visible focus');
});

test('a forward exit brackets the recipient list into the draft', () => {
  assert.match(SOURCE, /내용 작성으로 계속/u, 'exit names the forward action');
  const exitAt = SOURCE.indexOf('내용 작성으로 계속');
  assert.ok(exitAt > SOURCE.indexOf('id="recipient-summary"'), 'exit sits after the selection summary');
  assert.ok(exitAt < SOURCE.indexOf('className={styles.recipientDetails}'), 'exit precedes the long checkbox list');
  const exitWindow = SOURCE.slice(Math.max(0, exitAt - 500), exitAt + 200);
  assert.match(exitWindow, /type="button"/u, 'exit is a plain button, never a submit');
  assert.match(exitWindow, /onClick=\{jumpToCampaignTitle\}/u, 'exit runs the title jump');
  const fnAt = SOURCE.indexOf('function jumpToCampaignTitle()');
  assert.ok(fnAt !== -1, 'expected the title jump handler');
  const fnWindow = SOURCE.slice(fnAt, fnAt + 400);
  assert.match(fnWindow, /goComposeStep\(2\)/u, 'exit reveals the content step before focusing');
  assert.match(SOURCE, /target\?\.focus/u, 'step changes move focus');
  assert.match(SOURCE, /scrollIntoView/u, 'sighted operators follow the exit');
  assert.doesNotMatch(fnWindow, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(|message\.create/u, 'the exit never sends');
});

test('a back link brackets the review bar to the picker', () => {
  assert.match(SOURCE, /수신자 다시 확인/u, 'back link names the return action');
  const backAt = SOURCE.indexOf('수신자 다시 확인');
  assert.ok(backAt > SOURCE.indexOf('id="campaign-submit-warning"'), 'back link sits with the review summary');
  assert.ok(backAt < SOURCE.indexOf('id="campaign-submit"'), 'back link precedes the submit, one Shift+Tab away');
  const backWindow = SOURCE.slice(Math.max(0, backAt - 500), backAt + 200);
  assert.match(backWindow, /type="button"/u, 'back link is a plain button, never a submit');
  assert.match(backWindow, /onClick=\{jumpToRecipientFilter\}/u, 'back link runs the picker jump');
  const fnAt = SOURCE.indexOf('function jumpToRecipientFilter()');
  assert.ok(fnAt !== -1, 'expected the picker jump handler');
  const fnWindow = SOURCE.slice(fnAt, fnAt + 400);
  assert.match(fnWindow, /getElementById\("recipient-status-filter"\)/u, 'back landing returns to the picker');
  assert.match(fnWindow, /\.focus\(/u, 'back landing moves focus');
  assert.match(fnWindow, /scrollIntoView/u, 'sighted operators follow the return');
  assert.doesNotMatch(fnWindow, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(|message\.create/u, 'the return never sends');
});

test('new jump controls keep native semantics and the 44px floor', () => {
  assert.doesNotMatch(SOURCE, /role="(button|link|checkbox|listbox|option)"/u, 'no invented widget roles in the workspace');
  assert.match(CSS, /\.textButton \{[^}]*min-height: 44px/u, 'jump controls keep the 44px floor');
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u, 'tokens only, no hex colors');
});

test('the open recipient list explains and supports keyboard escape without changing selection', () => {
  const detailsAt = SOURCE.indexOf('className={styles.recipientDetails}');
  const details = SOURCE.slice(detailsAt, detailsAt + 2000);
  assert.match(details, /onKeyDown=/u, 'the open native disclosure handles Escape');
  assert.match(details, /event\.key === "Escape"/u);
  assert.match(details, /setRecipientListOpen\(false\)/u);
  assert.match(details, /querySelector<HTML.*Element>\("summary"\)[\s\S]*?summary\?\.focus\(\)/u, 'focus returns to the disclosure summary');
  assert.match(details, /requestAnimationFrame[\s\S]*?document\.activeElement === summary[\s\S]*?summary\.scrollIntoView/u, 'after closing, the focused summary remains visible without stealing moved focus');
  assert.match(details, /Esc.*선택.*유지/u, 'the shortcut and preservation are explained where they are used');
  assert.doesNotMatch(details.slice(0, details.indexOf('<summary')), /setSelectedIds|clearAllRecipients/u, 'closing the list cannot alter recipients');
});

test('a staged message cannot be confirmed after its recipients or draft change', () => {
  assert.match(SOURCE, /reviewedDraft: campaignDraft/u, 'the review binds the draft it described');
  assert.match(SOURCE, /reviewedIds: selectedIds/u, 'the review binds the exact selected recipients');
  assert.match(SOURCE, /reviewedTemplateId: selectedTemplateId/u, 'the review binds the selected template');
  assert.match(SOURCE, /reviewedAttachmentRevision: attachmentRevision/u, 'a later file selection invalidates the review');
  assert.match(SOURCE, /sendPending\.reviewedDraft === campaignDraft/u);
  assert.match(SOURCE, /sendPending\.reviewedIds === selectedIds/u);
  assert.match(SOURCE, /sendPending\.reviewedTemplateId === selectedTemplateId/u);
  assert.match(SOURCE, /sendPending\.reviewedAttachmentRevision === attachmentRevision/u);
  assert.match(SOURCE, /sendPending && reviewIsCurrent \? \([\s\S]*?<ConsoleConfirm/u, 'only the current review offers confirmation');
  assert.match(SOURCE, /발송 검토를 다시 눌러 주세요/u, 'a changed review names the recovery action');
});
