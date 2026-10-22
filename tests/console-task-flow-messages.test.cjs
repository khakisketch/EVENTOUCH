'use strict';

// FAILED campaign reload contracts: a failed send must be reusable without
// retyping or reselecting, while never auto-sending, never replaying a stale
// reservation, and never silently overwriting operator input.
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

test('campaign parser keeps the persisted compose snapshot for reload', () => {
  assert.match(SOURCE, /body: string;/u);
  assert.match(SOURCE, /templateId: string;/u);
  assert.match(SOURCE, /imageFileId: string;/u);
  assert.match(SOURCE, /body: text\(item\.body\)/u);
  assert.match(SOURCE, /templateId: text\(item\.templateId\)/u);
  assert.match(SOURCE, /asRecord\(item\.image\)\?\.fileId/u);
  assert.match(SOURCE, /asRecord\(item\.image\)\?\.name/u);
});

test('reload resolves recipients against the live roster, excluding cancelled and missing', () => {
  assert.match(SOURCE, /function applyFailedReload\(campaign: Campaign\)/u);
  assert.match(SOURCE, /person\.status === "CANCELLED"/u);
  assert.match(SOURCE, /!person \|\| person\.status === "CANCELLED"/u);
  assert.match(SOURCE, /제외 \$\{excluded\}명\(취소·삭제\)/u);
  assert.match(SOURCE, /setSelectedIds\(eligible\)/u);
});

test('reload clears the old reservation and never auto-sends or reuses the old command id', () => {
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  assert.ok(applyStart !== -1, 'expected applyFailedReload');
  const applyEnd = SOURCE.indexOf('function requestFailedReload', applyStart);
  assert.ok(applyEnd > applyStart, 'expected requestFailedReload after applyFailedReload');
  const applyBody = SOURCE.slice(applyStart, applyEnd);
  assert.match(applyBody, /scheduled: ""/u);
  assert.doesNotMatch(applyBody, /message\.create/u);
  assert.doesNotMatch(applyBody, /executeCampaignCreate/u);
  assert.doesNotMatch(applyBody, /postCommand/u);
  assert.doesNotMatch(applyBody, /campaignCreateRef/u);
  assert.doesNotMatch(applyBody, /commandId\(\)/u);
  // No stale reservation copy anywhere in the reload path.
  assert.doesNotMatch(applyBody, /scheduled: campaign\.scheduled/u);
});

test('nonempty composer input requires an in-place overwrite confirm first', () => {
  assert.match(SOURCE, /const \[reloadPending, setReloadPending\]/u);
  assert.match(SOURCE, /if \(composeDirty \|\| sendPending !== null\)/u);
  assert.match(SOURCE, /setReloadPending\(\{ id: campaign\.id \}\)/u);
  assert.match(SOURCE, /작성 중인 발송 내용·선택이 교체됩니다/u);
  assert.match(SOURCE, /바로 발송되지 않습니다/u);
  assert.match(SOURCE, /confirmLabel="불러온다"/u);
  assert.match(SOURCE, /<ConsoleConfirm/u);
  assert.match(SOURCE, /onConfirm=\{\(\) => applyFailedReload\(campaign\)\}/u);
  assert.match(SOURCE, /onCancel=\{\(\) => setReloadPending\(null\)\}/u);
});

test('unconfirmed receipts block the reload until they resolve', () => {
  assert.match(SOURCE, /function failedReloadBlocked\(\): boolean/u);
  // The create slot blocks only after a real transmission: the guard keys
  // on the attempted marker, never on mere slot presence, so an unsent
  // staged id or a cancelled confirmation does not read as ambiguous.
  const blockedStart = SOURCE.indexOf('function failedReloadBlocked(): boolean');
  assert.ok(blockedStart !== -1, 'expected failedReloadBlocked');
  const blockedEnd = SOURCE.indexOf('function applyFailedReload', blockedStart);
  const blockedBody = SOURCE.slice(blockedStart, blockedEnd);
  assert.match(blockedBody, /campaignCreateRef\.current\?\.attempted === true/u);
  assert.doesNotMatch(blockedBody, /campaignCreateRef\.current !== null/u);
  assert.match(blockedBody, /retryRefs\.current\.size > 0/u);
  assert.match(SOURCE, /syncRefs\.current\.size > 0/u);
  assert.match(SOURCE, /cancelRefs\.current\.size > 0/u);
  assert.match(SOURCE, /ambiguousRetryIds\.length > 0/u);
  assert.match(SOURCE, /ambiguousSyncIds\.length > 0/u);
  assert.match(SOURCE, /ambiguousCancelIds\.length > 0/u);
  assert.match(SOURCE, /응답을 확인하지 못한 발송 요청이 있습니다\. 결과를 먼저 확인한 뒤 내용을 불러오세요\./u);
  // The template draft is independent: the reload path never touches it.
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  const applyEnd = SOURCE.indexOf('function requestFailedReload', applyStart);
  const applyBody = SOURCE.slice(applyStart, applyEnd);
  assert.doesNotMatch(applyBody, /setTemplateDraft/u);
  assert.doesNotMatch(applyBody, /templateSaveRef/u);
});

test('create marker lifecycle: staged unsent, marked on post, cleared on settlement', () => {
  // Staging mints an unattempted id; the same fingerprint reuses it.
  assert.match(SOURCE, /const next = \{ fingerprint, commandId: commandId\(\), attempted: false \};/u);
  // The marker flips only when the executor actually posts, keyed on our
  // own commandId identity, after the in-flight gate passes.
  const execStart = SOURCE.indexOf('async function executeCampaignCreate(pending: SendPending)');
  assert.ok(execStart !== -1, 'expected executeCampaignCreate');
  const execHead = SOURCE.slice(execStart, SOURCE.indexOf('try {', execStart));
  assert.match(execHead, /if \(!beginAction\("campaign"\)\) return;/u);
  assert.match(execHead, /if \(campaignCreateRef\.current\?\.commandId === pending\.id\)/u);
  assert.match(execHead, /campaignCreateRef\.current\.attempted = true;/u);
  // Proven success and settled 4xx clear the whole slot (marker with it);
  // ambiguous outcomes keep the attempted slot for a same-request retry.
  assert.match(SOURCE, /created\.id !== pending\.id/u);
  const execBody = SOURCE.slice(execStart, SOURCE.indexOf('async function executeRetry', execStart));
  const clears = execBody.match(/campaignCreateRef\.current = null;/gu) || [];
  assert.equal(clears.length, 2, 'expected slot cleared on success and on settled 4xx only');
});

test('unsent staged confirmation allows the reload overwrite confirm', () => {
  // requestFailedReload reaches the dirty check without an ambiguous
  // block when only a staged id exists: failedReloadBlocked ignores
  // unattempted slots, and the overwrite confirm path stays intact.
  assert.match(SOURCE, /if \(composeDirty \|\| sendPending !== null\)/u);
  assert.match(SOURCE, /setReloadPending\(\{ id: campaign\.id \}\)/u);
  // The navigation draft guard still treats a staged id as pending intent
  // (leaving the page warns); only the reload block distinguishes unsent.
  assert.match(SOURCE, /campaignCreateRef\.current !== null \|\|/u);
});
test('reload is offered on FAILED only, behind busy/uploading/archived/permission gates', () => {
  assert.match(SOURCE, /내용·대상 불러오기/u);
  assert.match(SOURCE, /campaign\.status === "FAILED" \? \(/u);
  assert.match(SOURCE, /disabled=\{busyAction !== null \|\| uploadingImage \|\| archived \|\| !state\.canManage\}/u);
  assert.match(SOURCE, /if \(state\.kind !== "ready" \|\| !state\.canManage \|\| archived\) return;/u);
  assert.match(SOURCE, /if \(inFlightRef\.current \|\| uploadingImage\) return;/u);
  // Existing FAILED explanation stays verbatim; only a next-action sentence is added.
  assert.match(SOURCE, /발송이 실패했습니다\. 같은 내용으로 다시 보내려면 위에서 새 캠페인을 만드세요\./u);
  // No reload affordance leaks onto other terminal/transient rows.
  const failedBlockStart = SOURCE.indexOf('campaign.status === "FAILED" ? (');
  assert.ok(failedBlockStart !== -1, 'expected the FAILED block');
  const failedBlock = SOURCE.slice(failedBlockStart, failedBlockStart + 2000);
  assert.match(failedBlock, /내용·대상 불러오기/u);
});

test('reload preloads content, reveals selected-only review, and lands on the composer title', () => {
  assert.match(SOURCE, /setCampaignDraft\(\{/u);
  assert.match(SOURCE, /body: source\.body/u);
  assert.match(SOURCE, /simulate: source\.simulate === true/u);
  assert.match(SOURCE, /setSelectedTemplateId\(templateUsable/u);
  assert.match(SOURCE, /승인된 알림톡 템플릿을 다시 선택하세요\./u);
  assert.match(SOURCE, /setRecipientQuery\(""\)/u);
  assert.match(SOURCE, /setRecipientStatus\("ALL"\)/u);
  assert.match(SOURCE, /setShowSelectedOnly\(true\)/u);
  assert.match(SOURCE, /새 발송 전 내용·대상을 확인하세요\. 예약 시각은 다시 지정하세요\./u);
  // Context lands on the in-form summary, then focuses the title without
  // moving the viewport again (title focus contract preserved).
  assert.match(SOURCE, /getElementById\("campaign-reload-summary"\)\?\.scrollIntoView/u);
  assert.match(SOURCE, /getElementById\("campaign-title"\)\?\.focus/u);
  assert.doesNotMatch(SOURCE, /getElementById\("campaign-title"\)\?\.scrollIntoView/u);
  // Image references survive only for MMS; other channels drop them.
  assert.match(SOURCE, /imageFileId: isMms \? source\.imageFileId : ""/u);
  assert.match(SOURCE, /imageName: isMms \? source\.imageName : ""/u);
});

test('empty live roster stays explicit and unsendable until the operator picks again', () => {
  assert.match(SOURCE, /선택 가능한 대상이 없습니다/u);
  assert.match(SOURCE, /수신자를 새로 선택하세요\./u);
  // The existing submit guard still owns the block: empty selection returns
  // before any command with the server's own wording.
  assert.match(SOURCE, /if \(!selectedIds\.length\)/u);
  assert.match(SOURCE, /발송 대상을 선택하세요\./u);
});

test('overwrite confirm re-validates at confirm time because it is nonmodal', () => {
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  assert.ok(applyStart !== -1, 'expected applyFailedReload');
  const applyEnd = SOURCE.indexOf('function requestFailedReload', applyStart);
  assert.ok(applyEnd > applyStart, 'expected requestFailedReload after applyFailedReload');
  const applyBody = SOURCE.slice(applyStart, applyEnd);
  // Role/stage, in-flight/uploading, and ambiguous receipts are rechecked
  // inside apply: the request-time guard cannot cover edits, submits, or
  // uploads made while the confirm stayed open.
  assert.match(applyBody, /if \(!state\.canManage \|\| archived\) return;/u);
  assert.match(applyBody, /if \(inFlightRef\.current \|\| uploadingImage\) return;/u);
  assert.match(applyBody, /if \(failedReloadBlocked\(\)\)/u);
  // A background refresh may have changed the row under the open confirm,
  // so the reload resolves the live row and requires FAILED still.
  assert.match(applyBody, /state\.campaigns\.find\(\(item\) => item\.id === campaign\.id\)/u);
  assert.match(applyBody, /source\.status !== "FAILED"/u);
  assert.match(applyBody, /발송 기록이 바뀌었습니다\. 상태를 새로고침한 뒤 다시 시도하세요\./u);
});

test('overwrite confirm stays disabled while any action or upload runs', () => {
  const failedBlockStart = SOURCE.indexOf('campaign.status === "FAILED" ? (');
  assert.ok(failedBlockStart !== -1, 'expected the FAILED block');
  const failedBlock = SOURCE.slice(failedBlockStart, failedBlockStart + 2400);
  assert.match(failedBlock, /confirmLabel="불러온다"/u);
  assert.match(failedBlock, /busy=\{busyAction !== null \|\| uploadingImage\}/u);
  assert.doesNotMatch(failedBlock, /busy=\{false\}/u);
});

test('reloaded-source summary renders as info before the title, never as global success', () => {
  assert.match(SOURCE, /const \[reloadSummary, setReloadSummary\]/u);
  // In-form placement immediately before the title field.
  const summaryRender = SOURCE.indexOf('id="campaign-reload-summary"');
  const titleField = SOURCE.indexOf('id="campaign-title"');
  assert.ok(summaryRender !== -1, 'expected the reload summary element');
  assert.ok(titleField !== -1, 'expected the campaign title field');
  assert.ok(summaryRender < titleField, 'summary must precede the title field');
  assert.match(SOURCE, /<ConsoleFeedback kind="info" id="campaign-reload-summary">\{reloadSummary\}<\/ConsoleFeedback>/u);
  // Title exposes the summary to assistive tech alongside any field error.
  assert.match(SOURCE, /"campaign-reload-summary campaign-title-error"/u);
  assert.match(SOURCE, /: \(reloadSummary \? "campaign-reload-summary" : undefined\)/u);
  // No duplicate global notice: reload clears it and sets the summary.
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  const applyEnd = SOURCE.indexOf('function requestFailedReload', applyStart);
  const applyBody = SOURCE.slice(applyStart, applyEnd);
  assert.match(applyBody, /setCampaignNotice\(null\)/u);
  assert.match(applyBody, /setReloadSummary\(/u);
  assert.doesNotMatch(applyBody, /setCampaignNotice\(\s*`/u);
});

test('reload summary wording keeps source, counts, no-autosend, and reservation copy', () => {
  assert.match(SOURCE, /내용을 불러왔습니다 · 선택 \$\{eligible\.length\}명 · 제외 \$\{excluded\}명\(취소·삭제\)\. 바로 발송되지 않습니다\. 새 발송 전 내용·대상을 확인하세요\. 예약 시각은 다시 지정하세요\./u);
  assert.match(SOURCE, /내용을 불러왔습니다 · 선택 가능한 대상이 없습니다 · 제외 \$\{excluded\}명\(취소·삭제\)\. 수신자를 새로 선택하세요\. 바로 발송되지 않습니다\. 새 발송 전 내용·대상을 확인하세요\. 예약 시각은 다시 지정하세요\./u);
});

test('reload summary clears on proven send and on event change only', () => {
  // Proven create consumes the source; the next blank composer shows no summary.
  const successAt = SOURCE.indexOf('setCampaignDraft(EMPTY_CAMPAIGN)');
  assert.ok(successAt !== -1, 'expected the proven-create reset');
  assert.match(SOURCE.slice(successAt, successAt + 400), /setReloadSummary\(null\)/u);
  // Event switch resets the workspace slice including the summary.
  const eventReset = SOURCE.slice(SOURCE.indexOf('handoffAppliedRef.current = null;'), SOURCE.indexOf('setHistoryLimit(10);'));
  assert.match(eventReset, /setReloadSummary\(null\)/u);
  // The template draft stays independent throughout the reload path.
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  const applyEnd = SOURCE.indexOf('function requestFailedReload', applyStart);
  assert.doesNotMatch(SOURCE.slice(applyStart, applyEnd), /setTemplateDraft/u);
});

test('summary scroll is instant to the summary with nav-honoring margin, then title focus', () => {
  assert.match(SOURCE, /getElementById\("campaign-reload-summary"\)\?\.scrollIntoView\(\{ behavior: "instant" as ScrollBehavior, block: "start" \}\)/u);
  assert.match(SOURCE, /getElementById\("campaign-title"\)\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(CSS, /#campaign-reload-summary/u);
  // New spacing is tokens-only: s8 + s7 + s5 = 120, no px literal.
  assert.match(CSS, /scroll-margin-top: calc\(var\(--s8\) \+ var\(--s7\) \+ var\(--s5\)\)/u);
});
test('duplicate ids never inflate the 취소·삭제 exclusion count', () => {
  // Parser dedupes by contract so strays cannot reach the counter.
  assert.match(SOURCE, /\[\.\.\.new Set\(item\.recipientIds\.filter\(\(id\): id is string => typeof id === "string"\)\)\]/u);
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  const applyEnd = SOURCE.indexOf('function requestFailedReload', applyStart);
  const applyBody = SOURCE.slice(applyStart, applyEnd);
  // The seen guard only skips; only missing/cancelled count as excluded.
  assert.match(applyBody, /if \(seen\.has\(id\)\) continue;/u);
  assert.doesNotMatch(applyBody, /seen\.has\(id\)\) \{\s*\n?\s*excluded \+= 1/u);
});

test('blocked reload recovers focus onto the real submit next to the inline error', () => {
  const helperStart = SOURCE.indexOf('function reportBlockedReload()');
  assert.ok(helperStart !== -1, 'expected reportBlockedReload');
  const helperEnd = SOURCE.indexOf('function applyFailedReload', helperStart);
  const helperBody = SOURCE.slice(helperStart, helperEnd);
  // Same existing error copy, overwrite confirm dropped, then the existing
  // recovery action: instant scroll onto the submit plus focus, no submit.
  assert.match(helperBody, /setReloadPending\(null\)/u);
  assert.match(helperBody, /응답을 확인하지 못한 발송 요청이 있습니다\. 결과를 먼저 확인한 뒤 내용을 불러오세요\./u);
  assert.match(helperBody, /getElementById\("campaign-submit"\)\?\.scrollIntoView\(\{ behavior: "instant" as ScrollBehavior, block: "center" \}\)/u);
  assert.match(helperBody, /getElementById\("campaign-submit"\)\?\.focus\(\{ preventScroll: true \}\)/u);
  // No new send action: no post, no executor, no smooth global motion.
  assert.doesNotMatch(helperBody, /postCommand|executeCampaignCreate|requestCampaignCreate/u);
  assert.doesNotMatch(helperBody, /behavior: "smooth"/u);
  // Both blocked paths (request-time and confirm-time) share the helper.
  const applyStart = SOURCE.indexOf('function applyFailedReload(campaign: Campaign)');
  const requestStart = SOURCE.indexOf('function requestFailedReload', applyStart);
  const applyBody = SOURCE.slice(applyStart, requestStart);
  assert.match(applyBody, /reportBlockedReload\(\);/u);
  const requestBody = SOURCE.slice(requestStart, SOURCE.indexOf('if (state.kind === "loading")', requestStart));
  assert.match(requestBody, /reportBlockedReload\(\);/u);
});
