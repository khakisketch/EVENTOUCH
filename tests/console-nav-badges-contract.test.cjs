'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('event navigation badges count only operator follow-up and link pending approvals directly', () => {
  const shell = read('apps/web/app/console/ConsoleShell.tsx');
  // Hub rail: hrefs resolve in pageHref and badges render in
  // renderPageBadges, while the badge booleans stay hoisted display gates.
  const subnav = between(shell, 'function pageHref(', 'function renderEventHubs(');
  // The attention badge also covers manually-due sends; the deep link still
  // lands on the attention history, never a bare list.
  assert.match(subnav, /showMessageAttentionBadge \|\| showManualDueBadge/u);

  // Badge counts come from the directory event summaries (server-counted
  // pending approvals and attention campaigns), never from a client-side
  // participant scan: the shell holds no roster.
  assert.match(shell, /const pendingOf = \(eventId: string\): number =>/);
  assert.match(shell, /typeof event\?\.pending === "number" \? event\.pending : 0/);
  assert.doesNotMatch(shell, /person\.status === "PENDING"/, "no client-side roster scan for badges");
  assert.match(shell, /const messageAttentionOf = \(eventId: string\): number =>/);
  // The attention statuses are defined where campaigns are read (the
  // messages screen); the shell only consumes the server-counted directory
  // summary, so no client re-derives the set in two places.
  assert.match(shell, /typeof event\?\.messageAttention === "number" \? event\.messageAttention : 0/);
  assert.doesNotMatch(shell, /\["FAILED", "PARTIAL", "NEEDS_CONNECTION"\]/, "shell holds no status list");
  assert.match(shell, /function isApprovalQueueRelevant\(stage: string\)/);
  const triage = between(shell, 'const triage = events', 'const roleLabel');
  assert.match(triage, /item\.stage === "LIVE"/);
  assert.match(triage, /item\.pending > 0 && isApprovalQueueRelevant\(item\.stage\)/);
  assert.match(triage, /b\.pending - a\.pending/);
  assert.match(triage, /\.slice\(0, 5\)/);
  assert.match(shell, /\["AGENCY", "MANAGER"\]\.includes\(shellData\.role\)/);
  assert.match(shell, /This is a display gate only; server reads and command authorization remain authoritative/);
  assert.match(shell, /isApprovalQueueRelevant\(eventMeta\.stage\)/);
  assert.match(shell, /eventMeta && eventMeta\.messageAttention > 0/);
  assert.match(subnav, /messages\?attention=1/);
  assert.match(subnav, /showPendingApprovalBadge/);
  assert.match(subnav, /participants\?status=PENDING/);
  assert.match(subnav, /nav-badge" role="img" aria-label=\{`승인 대기/);
  assert.match(subnav, /nav-badge" role="img" aria-label=\{`발송 확인/);
  assert.match(shell, /showOperatorNavBadges && item\.pending > 0/);
  assert.match(shell, /shellData && shellData\.triage\.length/);
});

test('message badge opens the attention campaign history with a clear path back to all campaigns', () => {
  const messages = read('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx');

  assert.match(messages, /useSearchParams/);
  assert.match(messages, /const ATTENTION_STATUSES = \["FAILED", "PARTIAL", "NEEDS_CONNECTION"\]/);
  assert.match(messages, /setAttentionOnly\(attentionParam === "1"\)/);
  assert.match(messages, /const attentionCampaigns = state\.campaigns\.filter/);
  assert.match(messages, /historyScope = attentionOnly \? attentionCampaigns : state\.campaigns/);
  assert.match(messages, /visibleCampaigns = historyScope\.filter/);
  assert.match(messages, /history-heading[\s\S]*scrollIntoView/);
  assert.match(messages, /발송 확인이 필요한 발송만 보고 있습니다/);
  assert.match(messages, /전체 발송 기록 보기/);
});

test('settings owns forward-only stage confirmation and reuses the command id after an uncertain response', () => {
  const settings = read('apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx');
  // Stage lives in the fourth tab panel: bound the stage zone by its panel
  // without pinning the exact tabpanel markup the UI worker chooses.
  const panelAt = settings.indexOf('panel-settings-stage');
  assert.notEqual(panelAt, -1, 'stage tabpanel must exist');
  const stage = settings.slice(panelAt, panelAt + 12000);

  assert.match(settings, /stage: text\(event\.stage\)\.toUpperCase\(\)/);
  assert.match(stage, /진행 단계/);
  const confirmation = read('apps/web/app/console/console-ui/StageTransitionConfirmation.tsx');
  assert.match(stage, /<StageTransitionConfirmation[^>]+label=\{eventStageLabel\(nextStage\)\}/);
  assert.match(stage, /retry=\{Boolean\(stageCommandIdRef\.current && stageError\)\}/);
  assert.match(confirmation, /정말 \{label\} 단계로 전환합니다\?/);
  assert.match(confirmation, /aria-label=\{`\$\{actionText\} · \$\{label\} 단계로`\}/, 'accessible name includes the complete visible action plus its stage target');
  assert.match(confirmation, /같은 요청 다시 시도/);
  assert.match(confirmation, />\s*취소\s*</);
  assert.match(settings, /stageCommandIdRef = useRef<string \| null>\(null\)/);
  assert.match(settings, /if \(!stageCommandIdRef\.current\) stageCommandIdRef\.current = randomCommandId\(\)/);
  assert.match(settings, /commandId: stageCommandIdRef\.current/);
  assert.match(settings, /command: "event\.stage"/);
  assert.match(settings, /Preserve the id so a retry can replay the server receipt after a lost response/);
  assert.match(settings, /진행 중 전환에는 등록 데스크와 데스크 배정이 필요/);
  assert.match(settings, /보관하려면 접수를 닫고 진행 중인 참여 프로그램을 모두 닫아야/);
  assert.match(settings, /currentStage === "ARCHIVED"\s*\?\s*"보관된 행사는 읽기 전용입니다\."/);
  assert.match(settings, /"단계 정보가 확인되지 않아 전환할 수 없습니다\."/);
  assert.match(settings, /nextStage && !stageConfirm/);
});

test('overview uses a labeled entry progress visualization and removes action/problem/readiness blocks', () => {
  const overview = read('apps/web/app/console/events/[id]/EventOverview.tsx');

  assert.match(overview, /role="progressbar"/);
  assert.match(overview, /aria-label=\{`입장 진행/);
  assert.match(overview, /취소 제외 등록 대비 입장률 · 결과 보고서와 같은 정의/);
  assert.match(overview, /확정자 중 미입장/);
  assert.match(overview, /surveyResponseCount !== null/);
  assert.match(overview, /getReportStatus\(overview\)/);
  assert.match(overview, /const registered = participantRows\.length/);
  assert.match(overview, /overview\.canManageEvent \? \(/);
  assert.match(overview, /행사 지표는 행사 운영자에게 표시됩니다/);
  // Exactly three pre-event metric cards; capacity/waitlist stay as metadata.
  assert.equal((overview.match(/label: "신청"|label: "참가 확정"|label: "승인 대기"/g) || []).length, 3);
  assert.doesNotMatch(overview, /label: "대기 명단 \/ 정원"/u);
  assert.match(overview, /정원/u);
  assert.doesNotMatch(overview, /event-problems-heading|problemsForStage|problemList/);
  assert.doesNotMatch(overview, /event-operations-heading|운영 준비·가동|operationsGrid/);
  assert.doesNotMatch(overview, /event-stage-heading|submitStageTransition|stageCommandIdRef/);
});

test('recent activity refresh stays icon-only, accessible and reduced-motion aware', () => {
  const overview = read('apps/web/app/console/events/[id]/EventOverview.tsx');
  const css = read('apps/web/app/console/events/[id]/event-overview.module.css');

  assert.match(overview, /aria-label="새로고침"/);
  assert.match(overview, /title="새로고침"/);
  assert.match(overview, /aria-busy=\{refreshing\}/);
  assert.match(overview, /<time dateTime=\{overview\.updatedAt\}>마지막 갱신/);
  assert.match(overview, /<time className=\{styles\.timestamp\} dateTime=\{check\.at \|\| undefined\}>/);
  assert.match(overview, /formatCheckTime\(check\.at\)/);
  assert.match(css, /\.refreshButton:global\(\.button-secondary\)[\s\S]*?width: 44px/);
  assert.match(css, /\.refreshButton svg[\s\S]*?width: 20px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.checkAction::before/);
});
