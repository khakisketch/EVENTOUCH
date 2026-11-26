'use strict';

// Message review: the field-level prerequisites, the review reason surface and the
// recipient-list keyboard escape must stay operable by keyboard with many recipients,
// including the empty/disabled case. Source-only assertions; rendered keyboard behavior
// belongs to main's browser audit.
// Reopened 2026-11-24 (owner: 시안 A): the step-era forward/back/review jump buttons
// (내용 작성으로 계속, 수신자 다시 확인, 발송 검토로 이동) are gone with the steps. What
// they guaranteed is now carried by 발송 검토 itself: it names the missing prerequisite,
// opens the folded panel that owns the field and focuses the field.

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

// The submit (발송 검토) names a missing prerequisite and focuses its field. An
// empty record title is filled automatically instead of being asked for.
test('review navigation shows the relevant input panel when prerequisites are missing', () => {
  const fn = SOURCE.slice(SOURCE.indexOf('function requestCampaignCreate'), SOURCE.indexOf('const fingerprint = fingerprintFor("message.create-charset-reviewed"'));
  assert.match(fn, /!selectedIds\.length/u);
  assert.match(fn, /field: "ids"/u);
  assert.match(fn, /autoCampaignTitle\(/u);
  assert.match(fn, /field: campaignDraft\.channel === "ALIMTALK" \? "templateId" : "body"/u);
  assert.match(fn, /messageContentIssue\(campaignDraft, boundTemplate\)/u);
  assert.doesNotMatch(fn, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(/u);
  // Reopened 2026-11-26: every zone is always visible, so a field error only focuses its field (nothing to unfold).
  assert.doesNotMatch(SOURCE, /setOpenPanel/u);
  assert.match(SOURCE, /campaignFieldError\.field === "title"\) setTitleOpen\(true\)/u);
  assert.match(SOURCE, /ids: "recipient-status-filter", title: "campaign-title", body: "campaign-body", channel: "campaign-channel", smsFallback: "campaign-sms-fallback", templateId: campaignDraft\.channel === "ALIMTALK" \? "campaign-template-cards" : "campaign-template", imageFileId: "campaign-image", scheduled: "campaign-scheduled"/u);
  assert.match(SOURCE, /#campaign-recipients button:not\(:disabled\)/u, 'no list open: land on the first audience card');
  assert.match(SOURCE, /document\.getElementById\(ids\[campaignFieldError\.field\]/u);
});

test('the disabled submit still describes its blocking reason before activation', () => {
  const submitAt = SOURCE.indexOf('id="campaign-submit"');
  assert.ok(submitAt !== -1, 'expected the submit control');
  const submitWindow = SOURCE.slice(submitAt, submitAt + 700);
  assert.match(submitWindow, /aria-describedby=\{[^}]*"campaign-submit-warning/u, 'the submit describes the blocking reason');
  assert.match(submitWindow, /disabled=\{selectedCount === 0 \|\|/u);
  assert.match(submitWindow, /title=\{messagesLocked \? messagesLockReason : selectedCount === 0 \? "수신자를 먼저 고르세요\." : undefined\}/u);
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

test('the who pill and the 이름 확인 link reach the picker, never send', () => {
  // Replaces the forward/back jump brackets: the pill scrolls to its zone; the name-review link
  // opens the list dialog, then focuses the status filter.
  assert.match(SOURCE, /function jumpToSection\(sectionId: string\) \{/u);
  const fnAt = SOURCE.indexOf('function jumpToRecipientFilter()');
  assert.ok(fnAt !== -1, 'expected the picker jump handler');
  const fnWindow = SOURCE.slice(fnAt, fnAt + 600);
  assert.match(fnWindow, /setRecipientListOpen\(true\)/u, 'the jump opens the list');
  assert.match(fnWindow, /getElementById\("recipient-status-filter"\)/u, 'landing returns to the picker');
  assert.match(fnWindow, /\.focus\(/u, 'the jump moves focus');
  assert.match(fnWindow, /scrollIntoView/u, 'sighted operators follow the return');
  assert.doesNotMatch(fnWindow, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(|message\.create/u, 'the return never sends');
  // 완료 closes the list dialog; nothing in it submits.
  assert.match(SOURCE, /onClick=\{\(\) => setRecipientListOpen\(false\)\}>\{selectedCount > 0 \? `선택 \$\{selectedCount\}명 완료` : "완료"\}/u);
  assert.match(SOURCE, /id="campaign-who-pill" className=\{styles\.pill\}/u);
  assert.equal((SOURCE.match(/<button type="button" id="campaign-(?:who|how|when)-pill"/gu) ?? []).length, 3, 'pills are plain buttons');
});

test('new jump controls keep native semantics and the 44px floor', () => {
  assert.doesNotMatch(SOURCE, /role="(button|link|checkbox|listbox|option)"/u, 'no invented widget roles in the workspace');
  assert.match(CSS, /\.textButton \{[^}]*min-height: 44px/u, 'jump controls keep the 44px floor');
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/u, 'tokens only, no hex colors');
});

// Reopened 2026-11-26: the list is the shared dialog, so Escape, the scrim, focus return and the trap are its job.
test('the open recipient list is a dialog that closes without changing the selection', () => {
  const dialogAt = SOURCE.indexOf('title="직접 고르기"');
  assert.ok(dialogAt !== -1, 'expected the direct-pick dialog');
  const dialog = SOURCE.slice(dialogAt - 80, dialogAt + 1200);
  assert.match(dialog, /<ConsoleDialog\s+title="직접 고르기"\s+presentation="drawer"\s+onClose=\{\(\) => setRecipientListOpen\(false\)\}/u, 'the shared dialog closes the list');
  assert.doesNotMatch(dialog.slice(0, dialog.indexOf('footer=')), /setSelectedIds|clearAllRecipients/u, 'closing the list cannot alter recipients');
  assert.match(SOURCE, /recipientListOpen \? \(\s*<ConsoleDialog/u, 'the dialog is mounted only while open');
  assert.match(SOURCE, /if \(event\.key === "Enter"\) event\.preventDefault\(\)/u, 'Enter in the search never submits the send review');
  assert.doesNotMatch(SOURCE, /recipient-list-summary|className=\{styles\.recipientDetails\}/u, 'the folded disclosure is gone');
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
