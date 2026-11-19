'use strict';

// Reopened 2026-11-19: the tabs are an ink-filled segmented control with count chips and
// ledger rows carry a tinted state circle plus a status pill. Everything else below still holds.
// Approved 공지·안내 composition (2026-11-14, option C): ink tabs over one flat
// ledger per type, editors that open in place beside an always-on attendee
// phone, and a phone that reads the published 참가자 페이지 design. Behavior
// (save, publish review, unpublish, 전광판 출력, delete, recovery, permission
// gates) is pinned by the content contract tests; this file locks the
// composition and the phone's links to the real attendee pages.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/content');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('ContentWorkspace.tsx');
const preview = read('ContentPhonePreview.tsx');
const css = read('content.module.css');
const previewCss = read('content-preview.module.css');

test('content screen is ink tabs over flat ledgers with one orange add action', () => {
  assert.match(workspace, /role="tablist" aria-label="콘텐츠 종류"/u);
  assert.match(workspace, /role="tabpanel"/u);
  assert.match(workspace, /\{ id: "program", label: "일정"/u, 'the schedule tab no longer collides with 참여 콘텐츠 프로그램');
  assert.doesNotMatch(workspace, /프로그램 일정<\/|label: "프로그램 일정"/u);
  assert.doesNotMatch(workspace, /ConsoleSection\b|ConsoleSectionNav/u, 'no section panels or jump nav');
  assert.match(workspace, /function LedgerRow\(/u);
  assert.match(workspace, /<span className=\{styles\.dot\} data-status=\{status\} aria-hidden="true" \/>/u, 'state is a dot; the text carries the meaning');
  assert.match(workspace, /<span className=\{styles\.rowStatus\} data-status=\{status\}>\{statusLabel\}<\/span>/u);
  assert.doesNotMatch(workspace, /styles\.badge\b/u, 'no state chips');
  assert.match(css, /\.tab\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--ink\)/su);
  // One orange action at a time: the header add action hides while an editor
  // is open, and the editor's primary moves between 저장 and 게시 검토.
  assert.equal((workspace.match(/variant="primary"/gu) ?? []).length, 3, 'two header add buttons and the venue form save; nothing else is fixed orange');
  assert.match(workspace, /variant=\{noticeDirty \|\| !noticeDraft\.id \? "primary" : "secondary"\}/u);
  assert.match(workspace, /variant=\{!noticeDirty && hasChanges\(noticeChanges\(editingNotice\)\) \? "primary" : "secondary"\}/u);
});

test('editors open in place, publish review needs a saved draft, and the editor follows the saved record', () => {
  assert.match(workspace, /noticeDialogOpen \? \(\s*<div className=\{styles\.editor\}>/u);
  assert.match(workspace, /programDialogOpen \? \(\s*<div className=\{styles\.editor\}>/u);
  assert.match(workspace, /disabled=\{gated \|\| noticeDirty \|\| noticeDialogBusy\}/u, 'an unsaved draft cannot be sent to review');
  assert.match(workspace, /초안을 먼저 저장하세요/u);
  // Saving keeps the editor on the saved item at its new version.
  assert.match(workspace, /const saved = parseNotice\(data\.notice\);/u);
  assert.match(workspace, /const saved = parseProgram\(data\.program\);/u);
  assert.match(workspace, /A clean open editor follows the saved record/u);
  // Deleting the edited item closes its editor; focus returns to the tab.
  assert.match(workspace, /if \(noticeDraft\.id === item\.id\) setNoticeDialogOpen\(false\)/u);
  assert.match(workspace, /if \(programDraft\.id === item\.id\) setProgramDialogOpen\(false\)/u);
  assert.match(workspace, /document\.getElementById\("content-notice-title"\)\?\.focus\(\)/u);
  assert.match(workspace, /"content-tab-notice" : "content-tab-program"/u);
  // Old section anchors keep working as tab deep links.
  assert.match(workspace, /"#content-notices": "notice", "#content-program": "program", "#content-venue": "venue"/u);
});

test('the phone shows published items plus the edited draft, outlined, with no copy of attendee rules', () => {
  assert.match(workspace, /previewNotices: PreviewNotice\[\]/u);
  assert.match(workspace, /noticeDialogOpen && noticeDraft\.id === item\.id/u);
  assert.match(workspace, /return item\.published \?/u, 'unpublished items stay off the phone unless being edited');
  assert.match(workspace, /eventDate=\{state\.eventMeta\.date \?\? ""\}/u, 'the event date supplies dates missing from program entries');
  assert.match(workspace, /showSchedule: publishedDesign\.showSchedule !== false/u, 'the preview follows published event date visibility');
  assert.match(workspace, /date: programDraft\.date, start: programDraft\.start, end: programDraft\.end, place: programDraft\.place/u, 'the preview receives timeline fields rather than a flattened meta string');
  assert.match(workspace, /const venueEditing = venueDraft !== null && \(venueDirty \|\| Boolean\(venueFile\)\)/u);
  assert.match(preview, /data-editing=\{item\.editing \|\| undefined\}/u);
  assert.match(preview, /scrollIntoView\(\{ block: "nearest" \}\)/u, 'the edited item scrolls into view');
  assert.match(preview, /게시 전 · 초안 미리보기/u, 'an unpublished edit says it is not live yet');
  // The 홈 screen is the real attendee landing; 공지·일정·장소 reuse public attendee components and classes.
  assert.match(preview, /<AttendeeHomeLanding/u);
  assert.match(preview, /publicStyles\.noticeList/u);
  assert.match(preview, /<PublicProgramSchedule key=\{editingKey\} program=\{programs\}/u, 'opening another draft clears the previous preview date selection');
  assert.match(preview, /eventDate=\{design\.showSchedule \? eventDate : ""\} preview/u);
  assert.match(preview, /publicStyles\.venueText/u);
  // Theme link: the published 참가자 페이지 design feeds the phone.
  assert.match(workspace, /normalizeHomeStyle\(publishedDesign\.homeStyle\)/u);
  assert.match(workspace, /normalizeHomeMenus\(publishedDesign\.homeMenus\)/u);
  assert.match(workspace, /showVenue: publishedDesign\.showVenue !== false && features\.includes\("venue"\)/u);
  assert.match(workspace, /designHref = `\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/page`/u);
  assert.match(preview, /참가자 페이지 디자인을 그대로 반영합니다/u);
  // Hidden sections say so instead of looking empty.
  assert.match(preview, /참가자 페이지에서 숨겨져 있어/u);
});

test('the phone is sticky on wide screens and a full view elsewhere, at real phone width', () => {
  assert.match(css, /\.railHost\s*\{[^}]*position:\s*sticky/su);
  assert.match(css, /@media \(max-width: 1080px\)[\s\S]*?\.railHost\s*\{\s*display:\s*none/su);
  assert.match(css, /\.phoneToggle\s*\{\s*display:\s*none/su);
  // No bottom sheet: "크게 보기" / "폰으로 보기" open one full-view stage; on a
  // real phone the screen fills the viewport edge to edge with no frame.
  assert.match(workspace, /<ConsoleDialog titleId="content-phone-title" title="참가자 폰 미리보기" presentation="stage"/u);
  assert.doesNotMatch(workspace, /presentation="drawer"/u);
  assert.match(workspace, /onExpand=\{mode === "rail" \? \(\) => setPreviewStageOpen\(true\) : undefined\}/u);
  assert.match(preview, /크게 보기/u);
  assert.match(preview, /window\.innerWidth <= 768/u);
  assert.match(preview, /new ResizeObserver\(measure\)/u, 'the stage fits the phone to the room it has');
  assert.match(previewCss, /\.stageBare \.phone\s*\{[^}]*padding:\s*0/su);
  assert.match(previewCss, /--phone-width:\s*390px/u, 'laid out at a real phone width and scaled as a whole');
  assert.match(previewCss, /transform:\s*scale\(var\(--phone-scale\)\)/u);
  assert.match(previewCss, /\.screenTab\s*\{[^}]*min-height:\s*44px/su);
  assert.match(preview, /role="group" aria-label="미리볼 화면"/u);
  assert.match(preview, /aria-pressed=\{screen === item\.id\}/u);
});

test('the way back from an editor is a quiet crumb or the open tab, never a stray button', () => {
  assert.match(workspace, /<button type="button" className=\{styles\.crumb\}[^>]*onClick=\{closeNoticeEditor\}><CrumbChevron \/>공지<\/button>/u);
  assert.match(workspace, /<button type="button" className=\{styles\.crumb\}[^>]*onClick=\{closeProgramEditor\}><CrumbChevron \/>일정<\/button>/u);
  assert.match(workspace, /Pressing the open tab again is the way back from its editor/u);
  assert.match(css, /\.crumb\s*\{[^}]*min-height:\s*44px/su);
  // The editor names the item it edits as a heading; the state is a dot plus text.
  assert.match(workspace, /className=\{styles\.editorTitle\}><span className="sr-only">/u);
  assert.match(workspace, /className=\{styles\.editorState\}><span className=\{styles\.dot\} data-status=\{status\} aria-hidden="true" \/>/u);
});

test('the notice body is a rich editor on a small schema, stored as Markdown with pictures as event files', () => {
  const editor = read('RichEditor.tsx');
  assert.match(workspace, /<RichEditor[\s\S]{0,400}value=\{noticeDraft\.body\}/u);
  assert.doesNotMatch(workspace, /<textarea[^>]*content-notice-body/u, 'the plain textarea is gone');
  assert.match(editor, /heading: false, blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false, underline: false/u, 'only the stored subset can be typed or pasted');
  assert.match(editor, /Markdown\.configure\(\{ markedOptions: \{ gfm: true, breaks: true \} \}\)/u, 'old plain-text line breaks survive');
  assert.match(editor, /!\[\$\{[^`]*\}\]\(file:\$\{String\(node\.attrs\?\.fileId \?\? ""\)\}\)/u, 'a picture is written as ![alt](file:id)');
  assert.match(editor, /isAllowedUri: \(url: string\) => Boolean\(safeHref\(url\)\)/u);
  assert.match(editor, /handlePaste[\s\S]*handleDrop/u, 'pasted and dropped pictures upload instead of embedding');
  assert.match(editor, /role: "textbox"[\s\S]*"aria-multiline": "true"[\s\S]*"aria-labelledby": labelledBy/u);
  assert.match(editor, /aria-label=\{label\} title=\{label\} aria-pressed=\{active\}/u);
  assert.match(read('rich-editor.module.css'), /\.tool\s*\{[^}]*min-height:\s*44px/su);
  // Pictures shrink in the browser to the server limit before upload.
  assert.match(editor, /fitImage\(original\)/u);
  assert.match(workspace, /uploadImage=\{uploadNoticeImage\}/u);
  assert.match(workspace, /\/files\?name=\$\{encodeURIComponent\(file\.name\)\}&commandId=/u);
  // The editor is not a native field: its limits are checked before posting.
  assert.match(workspace, /noticeDraft\.body\.length > NOTICE_BODY_MAX/u);
  // Ledger rows and the phone read the same Markdown the attendees do.
  assert.match(workspace, /summary=\{richSummary\(item\.draft\.body\)\}/u);
  assert.match(preview, /<RichText source=\{item\.body\} imageSrc=\{imageSrc\} \/>/u);
});

test("content tabs follow the tab keyboard pattern: arrows wrap, Home and End jump", () => {
  assert.match(workspace, /event\.key === "Home" \? tabs\[0\] : event\.key === "End" \? tabs\[tabs\.length - 1\]/u);
  assert.match(workspace, /event\.key === "ArrowRight" \? tabs\[\(index \+ 1\) % tabs\.length\]/u);
});

// Reopened 2026-11-20 (owner: previews should be device simulators)
test('Reopened 2026-11-20: the phone is the shared DeviceFrame and the guide screens wear the real page structure', () => {
  assert.match(preview, /<DeviceFrame\s+variant="phone"/u);
  assert.match(preview, /scrollLabel=\{screenLabel\}/u, 'the scrolling screen keeps its labelled region');
  assert.match(preview, /<HomeHero/u, 'notice, schedule and venue screens start with the real banner');
  assert.match(preview, /publicStyles\.card/u, 'sections are the guide page cards');
});
