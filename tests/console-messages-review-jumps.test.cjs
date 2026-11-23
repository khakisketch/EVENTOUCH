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
  // Each field error opens its folded panel first, then focuses the field.
  assert.match(SOURCE, /campaignFieldError\.field === "ids"\) setOpenPanel\("who"\)/u);
  assert.match(SOURCE, /field === "channel" \|\| campaignFieldError\.field === "smsFallback"\) setOpenPanel\("how"\)/u);
  assert.match(SOURCE, /campaignFieldError\.field === "scheduled"\) setOpenPanel\("when"\)/u);
  assert.match(SOURCE, /field === "templateId"\) \{ if \(campaignDraft\.channel === "ALIMTALK"\) setOpenPanel\("how"\); else setMoreOpen\(true\); \}/u);
  assert.match(SOURCE, /field === "imageFileId" \|\| campaignFieldError\.field === "title"\) setMoreOpen\(true\)/u);
  assert.match(SOURCE, /ids: "recipient-status-filter", title: "campaign-title", body: "campaign-body", smsFallback: "campaign-sms-fallback", templateId: "campaign-template", imageFileId: "campaign-image", scheduled: "campaign-scheduled"/u);
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
  // Replaces the forward/back jump brackets: the pill toggles the panel; the name-review link
  // opens the panel and list, then focuses the status filter.
  assert.match(SOURCE, /function togglePanel\(panel: "who" \| "how" \| "when"\) \{ setOpenPanel\(current => current === panel \? null : panel\); \}/u);
  const fnAt = SOURCE.indexOf('function jumpToRecipientFilter()');
  assert.ok(fnAt !== -1, 'expected the picker jump handler');
  const fnWindow = SOURCE.slice(fnAt, fnAt + 600);
  assert.match(fnWindow, /setOpenPanel\("who"\)/u, 'the jump opens the folded panel before focusing');
  assert.match(fnWindow, /setRecipientListOpen\(true\)/u, 'the jump opens the list');
  assert.match(fnWindow, /getElementById\("recipient-status-filter"\)/u, 'landing returns to the picker');
  assert.match(fnWindow, /\.focus\(/u, 'the jump moves focus');
  assert.match(fnWindow, /scrollIntoView/u, 'sighted operators follow the return');
  assert.doesNotMatch(fnWindow, /postCommand|executeCampaignCreate|requestSubmit|\.submit\(|message\.create/u, 'the return never sends');
  // 완료 closes a panel and returns focus to its pill; no panel button submits.
  assert.match(SOURCE, /function closePanel\(returnFocusId: string\) \{\s*setOpenPanel\(null\);/u);
  for (const pill of ['campaign-who-pill', 'campaign-how-pill', 'campaign-when-pill']) assert.match(SOURCE, new RegExp(`closePanel\\("${pill}"\\)`, 'u'));
  assert.match(SOURCE, /id="campaign-who-pill" className=\{styles\.pill\}/u);
  assert.equal((SOURCE.match(/<button type="button" id="campaign-(?:who|how|when)-pill"/gu) ?? []).length, 3, 'pills are plain buttons');
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
