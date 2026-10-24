'use strict';

// List/record unification contract for the console records pass: every
// menu page in scope shares the ConsolePage frame (registry menu-ID title,
// context, header, toolbar, feedback rhythm), shared toolbars/sections/
// dialogs, workspace-owned draft guards, and actor+stage write gates that
// mirror the current server enforcement. Static source assertions on
// purpose: they pin the seam without booting Next.js. Rendered verification
// (including the shared frame visuals) happens outside the suite — main
// owns DB/browser/servers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const PAGES = {
  home: 'app/console/ConsoleHome.tsx',
  clients: 'app/console/clients/ClientsList.tsx',
  team: 'app/console/team/TeamWorkspace.tsx',
  participants: 'app/console/events/[id]/participants/ParticipantList.tsx',
  participantImport: 'app/console/events/[id]/participants/import/ImportWizard.tsx',
  rewards: 'app/console/events/[id]/rewards/RewardsWorkspace.tsx',
};

const PAGE_IDS = {
  home: 'events',
  clients: 'clients',
  team: 'team',
  participants: 'participants',
  participantImport: 'participantImport',
  rewards: 'rewards',
};

test('records pages share the ConsolePage frame with registry menu ids', () => {
  for (const [key, rel] of Object.entries(PAGES)) {
    const source = read(rel);
    assert.match(source, /from ".*console-ui\/ConsolePage";/u, `${key} imports the shared frame`);
    assert.match(source, new RegExp(`pageId="${PAGE_IDS[key]}"`, 'u'), `${key} resolves its menu title from the registry`);
    assert.match(source, /kind="loading"/u, `${key} keeps the shared loading state`);
    assert.match(source, /kind="failed"/u, `${key} keeps the shared failed state`);
    // The bespoke outer headers are retired: title/context/meta come from
    // the frame, and the rail owns the removed back rows.
    assert.doesNotMatch(source, /import ConsolePageHeader\b/u, `${key} no longer owns its header`);
    assert.doesNotMatch(source, /<ConsolePageHeader\b/u, `${key} renders no bespoke header`);
    assert.doesNotMatch(source, /← 운영 현황/u, `${key} keeps no local back row`);
  }
  // Event pages still project their bootstrap meta through the frame.
  for (const key of ['participants', 'participantImport', 'rewards']) {
    assert.match(read(PAGES[key]), /formatConsoleEventMeta/u, `${key} formats bootstrap meta for the frame`);
  }
});

test('toolbars separate filters, actions and conditional selection', () => {
  for (const key of ['home', 'clients', 'team', 'participants', 'participantImport', 'rewards']) {
    assert.match(read(PAGES[key]), /ConsoleToolbar/u, `${key} uses the shared toolbar`);
  }
  // Rewards filters its loaded list locally (search + status bucket): no
  // second fetch, no selection row, actions stay per-row.
  const rewards = read(PAGES.rewards);
  assert.match(rewards, /filters=\{/u, 'rewards filters the loaded list');
  assert.doesNotMatch(rewards, /selection=\{/u, 'rewards has no selection row');
  const participants = read(PAGES.participants);
  assert.match(participants, /filters=\{/u);
  assert.match(participants, /actions=\{/u);
  // Bulk selection owns a second row only while something is selected; the
  // compact select-all stays discoverable next to the count when none is.
  assert.match(participants, /selection=\{\s*anySelected/u);
  assert.match(participants, /검색·필터 결과 \{visiblePeople\.length\}명 전체 선택/u);
  const home = read(PAGES.home);
  assert.match(home, /filters=\{/u);
  assert.match(home, /actions=\{/u);
  assert.doesNotMatch(home, /selection=\{/u, 'home has no selection row');
  const clients = read(PAGES.clients);
  assert.match(clients, /filters=\{/u, 'clients filters by name/contact/email');
  assert.match(clients, /actions=\{/u);
  assert.match(clients, /고객사명·담당자·이메일 검색/u);
  assert.doesNotMatch(clients, /selection=\{/u, 'clients has no selection row');
  const wizard = read(PAGES.participantImport);
  assert.match(wizard, /filters=\{/u, 'import column mapping filters in the toolbar');
  assert.match(wizard, /actions=\{/u);
});

test('dialogs use the shared shell with busy gating and dirty dismissal', () => {
  for (const [rel, titles] of [
    [PAGES.participants, ['그룹 지정', '경품 등록']],
    [PAGES.clients, ['고객사 정보 수정', '고객사 등록']],
    [PAGES.team, ['비밀번호 재설정', '구성원 초대']],
  ]) {
    const source = read(rel);
    assert.match(source, /from ".*console-ui\/ConsoleDialog";/u);
    assert.match(source, /from ".*console-ui\/ConsoleFormActions";/u);
    for (const title of titles) {
      assert.match(source, new RegExp(title), `${rel} keeps the ${title} dialog`);
    }
    assert.match(source, /busy=\{/u, `${rel} gates dismissal while submitting`);
    assert.match(source, /canClose=\{/u, `${rel} confirms dirty dismissal`);
    assert.match(source, /<ConsoleFormActions>/u);
  }
  // Submits live in the dialog footer, associated back to their forms.
  for (const formId of ['group-assign-form', 'reward-create-form', 'client-form', 'reset-form', 'invite-form']) {
    const owners = [PAGES.participants, PAGES.participants, PAGES.clients, PAGES.team, PAGES.team];
    const rel = owners[['group-assign-form', 'reward-create-form', 'client-form', 'reset-form', 'invite-form'].indexOf(formId)];
    const source = read(rel);
    assert.match(source, new RegExp(`id="${formId}"`, 'u'));
    assert.match(source, new RegExp(`form="${formId}"`, 'u'), `${formId} submits from the footer`);
  }
  // No bespoke document focus/Escape/scroll owners survive the migration.
  for (const rel of [PAGES.participants, PAGES.clients, PAGES.team]) {
    const source = read(rel);
    assert.doesNotMatch(source, /dialog-backdrop/u, `${rel} uses the shared dialog chrome`);
    assert.doesNotMatch(source, /document\.addEventListener\("keydown"/u, `${rel} owns no key trap`);
    assert.doesNotMatch(source, /document\.body\.style\.overflow/u, `${rel} owns no scroll lock`);
  }
});

test('feedback separates success, error and denial states', () => {
  for (const key of Object.keys(PAGES)) {
    if (key === 'home') continue;
    assert.match(read(PAGES[key]), /ConsoleFeedback kind="success"/u, `${key} reports success politely`);
  }
  for (const key of ['clients', 'team', 'participants', 'participantImport', 'rewards']) {
    assert.match(read(PAGES[key]), /ConsoleFeedback kind="error"/u, `${key} asserts errors`);
  }
  // Denials read as warnings, never as errors or empty lists.
  for (const key of ['clients', 'team', 'participants', 'rewards', 'participantImport']) {
    assert.match(read(PAGES[key]), /ConsoleFeedback kind="warning"/u, `${key} distinguishes denial from failure`);
  }
  const team = read(PAGES.team);
  assert.match(team, /팀 관리 권한이 없습니다/u);
  const wizard = read(PAGES.participantImport);
  assert.match(wizard, /가져오기 권한이 없습니다/u);
});

test('write gates mirror server role, membership and stage', () => {
  // Rewards previously defaulted mutations on (`canManage !== false`, which
  // bootstrap never provides): now actor + membership like every operator
  // screen, plus the domain ARCHIVED block. Reads stay on every stage.
  const rewards = read(PAGES.rewards);
  assert.match(rewards, /\/api\/auth\/me/u);
  assert.match(rewards, /memberships\.some/u);
  assert.match(rewards, /role === "AGENCY"/u);
  assert.match(rewards, /ARCHIVED/);
  assert.match(rewards, /보관된 행사는 변경할 수 없습니다/u);
  assert.doesNotMatch(rewards, /canManage !== false/u);
  // Participants: participant.* writes stop at ENDED/ARCHIVED, domain
  // writes (group.assign, reward.create) at ARCHIVED. No granular write
  // permission policy is invented.
  const participants = read(PAGES.participants);
  assert.match(participants, /participantsLocked/);
  assert.match(participants, /canMutateStatus/);
  assert.match(participants, /canAssignGroup/);
  assert.match(participants, /종료된 행사는 참가자를 변경할 수 없습니다/u);
  assert.doesNotMatch(participants, /write_permissions|WRITE_PERMISSIONS/u);
  // Import commit mirrors the participant ENDED/ARCHIVED block; preview
  // reads stay available.
  const wizard = read(PAGES.participantImport);
  assert.match(wizard, /stageBlocked/);
  assert.match(wizard, /종료된 행사에는 명단을 가져올 수 없습니다/u);
});

test('draft guards register before early returns with workspace-owned dirty', () => {
  const guarded = {
    clients: '작성 중인 고객사 내용',
    team: '발급된 초대 링크는 한 번만',
    participants: '작성 중인 그룹·경품 내용',
    participantImport: '가져오기 위해 정리한 명단',
  };
  for (const [key, reason] of Object.entries(guarded)) {
    const source = read(PAGES[key]);
    assert.match(source, /from ".*console-draft-guard";/u, `${key} imports the guard`);
    const at = source.indexOf('useConsoleDraftGuard(');
    assert.ok(at >= 0, `${key} registers the guard`);
    // Type unions mention "loading" first; the early return is the first
    // strict comparison, and the guard must precede it.
    assert.ok(at < source.indexOf('=== "loading"'), `${key} registers before early returns`);
    assert.match(source, new RegExp(reason), `${key} names what would be lost`);
  }
  // Read-only desks never go dirty; filters and query changes are not dirt.
  assert.doesNotMatch(read(PAGES.rewards), /useConsoleDraftGuard\(/u);
  assert.doesNotMatch(read('app/console/team/OperationsPanels.tsx'), /useConsoleDraftGuard\(/u);
  const create = read('app/console/CreateEventDialog.tsx');
  assert.match(create, /useConsoleDraftGuard\(dirty \|\| submitting \|\| Boolean\(commandIdRef\.current\)/u);
  assert.match(create, /!== initialFields\.current/u, 'create/duplicate guard compares entered fields to their opening values');
  assert.doesNotMatch(read(PAGES.home), /useConsoleDraftGuard\(/u, 'the directory does not also mark a pristine open dialog dirty');
});

test('records use shared body patterns and keep domain specifics', () => {
  for (const rel of [PAGES.clients, PAGES.team, PAGES.rewards, PAGES.participantImport]) {
    assert.match(read(rel), /recordRow/u, `${rel} renders shared record rows`);
  }
  assert.match(read(PAGES.clients), /<h3>\{client\.name\}<\/h3>/u, 'client names keep their heading level');
  assert.match(read(PAGES.team), /headingId="pending-invites" title="대기 중인 초대"/u);
  assert.match(read(PAGES.team), /headingId="team-members" title="구성원"/u);
  assert.match(read(PAGES.participantImport), /surface="panel"/u, 'import steps read as panels');
  assert.match(read(PAGES.participants), /surface="plain"[\s\S]{0,120}width="full"/u, 'roster stays a full-width plain list');
  // Row-action columns stay consistent: full tracks when actions can show,
  // a narrower shared 3-track grid when only selection applies, the viewer
  // grid when read-only — never an empty action column.
  const roster = read(PAGES.participants);
  const rosterCss = read('app/console/events/[id]/participants/participants.module.css');
  assert.match(roster, /showRowActions/u);
  assert.match(roster, /headClass/u);
  assert.match(roster, /rowClass/u);
  assert.match(rosterCss, /\.rosterHeadNoActions\s*\{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 136px 112px;/su);
  assert.match(rosterCss, /\.participantRowNoActions\s*\{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 136px 112px;/su);
  // Form layouts use the shared stack/field patterns inside dialogs.
  for (const rel of [PAGES.clients, PAGES.team]) {
    assert.match(read(rel), /formStack/u, `${rel} stacks dialog forms on the shared pattern`);
    assert.match(read(rel), /consoleUiStyles\.field/u, `${rel} spaces dialog fields on the shared pattern`);
  }
});

test('csv export guards formulas and matches the visible filter', () => {
  const list = read(PAGES.participants);
  assert.match(list, /function csvCell/u);
  assert.match(list, /'\$\{cell\}/u, 'formula-leading cells get the text marker');
  assert.match(list, /목록 CSV · \{visiblePeople\.length\}명/u, 'export names the visible count it writes');
  assert.match(list, /EVENTOUCH_participants\.csv/u);
});

test('roster controls have concise unique names rather than including every option', () => {
  const list = read(PAGES.participants);
  for (const name of ['search', 'status', 'group', 'attendance']) {
    assert.match(list, new RegExp(`id="roster-${name}-label"`, 'u'));
    assert.match(list, new RegExp(`aria-labelledby="roster-${name}-label"`, 'u'));
  }
});

test('dialog dismissal consults one predicate; closers stay pure', () => {
  const participants = read(PAGES.participants);
  const clients = read(PAGES.clients);
  const team = read(PAGES.team);
  // Exactly one dirty confirm per dialog, owned by its single predicate:
  // the shell calls canClose once, so Escape/backdrop can never confirm
  // twice. (Other confirms below are domain destructions, not dismissal.)
  // Each predicate is the shell predicate and is consulted once by Cancel.
  for (const [source, name] of [
    [participants, 'canCloseGroupDialog'],
    [participants, 'canCloseRewardDialog'],
    [clients, 'canCloseClientDialog'],
    [team, 'canCloseResetDialog'],
    [team, 'canCloseInviteDialog'],
  ]) {
    const predicate = source.match(new RegExp(`function ${name}\\(\\): boolean \\{[^}]*\\}`, 'u'));
    assert.ok(predicate, `${name} is explicit`);
    assert.equal((predicate[0].match(/window\.confirm\(/gu) ?? []).length, 1, `${name} has a single discard prompt`);
    assert.match(predicate[0], /UNCONFIRMED_WRITE_CLOSE_MESSAGE/u, `${name} distinguishes pending server work from unsaved input`);
    assert.match(source, new RegExp(`canClose=\\{${name}\\}`, 'u'), `${name} is the shell predicate`);
    assert.equal((source.match(new RegExp(`if \\(${name}\\(\\)\\)`, 'gu')) ?? []).length, 1, `${name} is consulted once by Cancel`);
  }
  // Pure closers perform only state closes — no confirm of their own.
  for (const [source, name] of [
    [participants, 'closeGroupDialog'],
    [participants, 'closeRewardDialog'],
    [clients, 'closeDraft'],
  ]) {
    const body = source.match(new RegExp(`function ${name}\\(\\): void \\{[^}]*\\}`, 'u'));
    assert.ok(body, `${name} is a small pure closer`);
    assert.doesNotMatch(body[0], /window\.confirm|busy/, `${name} never confirms or gates`);
  }
  // Team children delegate dismissal to the pure onClose prop (a bare state
  // setter from the parent) after their own predicate passes.
  assert.equal((team.match(/onClose=\{onClose\}/gu) ?? []).length, 2);
});

test('draft dirt is a true field diff, never a pristine open form', () => {
  const clients = read(PAGES.clients);
  assert.match(clients, /draftBaselineRef/u, 'client dirt compares against its opening snapshot');
  assert.match(clients, /draft\.name !== baseline\.name/u);
  assert.match(clients, /pendingClientRef\.current !== null \|\| clientWriteRef\.current/u, 'unsettled client writes guard too');
  const participants = read(PAGES.participants);
  assert.match(participants, /groupBaselineRef/u, 'group dirt compares against its opening snapshot');
  assert.match(participants, /const groupBaseline = groupBaselineRef\.current \?\? ""/u);
  assert.match(participants, /groupDialogOpen && groupDraft !== groupBaseline/u);
  const team = read(PAGES.team);
  assert.match(team, /const resetDirty = password !== "" \|\| confirm !== ""/u);
  assert.match(team, /useConsoleDraftGuard\(\s*resetDirty \|\|/u, 'reset registers its own guard in the child');
  assert.match(team, /role !== "MANAGER" \|\| eventId !== ""/u, 'invite dirt includes role/eventId, not just name/email');
  assert.match(team, /useConsoleDraftGuard\(\s*issuedInvite !== null/u, 'parent guards only the once-shown bearer link');
});

test('roster quick approval keeps the gated status menu in row details', () => {
  const list = read(PAGES.participants);
  // Approval stays direct. The full status-change menu and reward entry are
  // retained in row details with the existing command/cancel/stage gates.
  assert.match(list, /"승인"/u);
  assert.match(list, /경품 등록/u);
  assert.match(list, /canMutateStatus \? \(\s*<select/u, 'status menu renders under the same gate');
  assert.match(list, /aria-label=\{`?\$\{person\.name\} 상태 변경`?\}/u, 'menu names its row for keyboard users');
  // Revealed controls keep the same touch floor.
  assert.match(
    read('app/console/events/[id]/participants/participants.module.css'),
    /\.detailActions select\s*\{[^}]*min-height:\s*44px/su
  );
  assert.match(list, /showRowActions && detailsOpen/u);
});

test('roster hands its selection to messages through ?to=', () => {
  const list = read(PAGES.participants);
  // Secondary selection action keeps 그룹 지정/선택 해제 order: group assign,
  // then the handoff, then deselect. Full known selection (including hidden)
  // travels as ?to=<comma-separated ids>, capped at 200 with mobile 44px.
  assert.match(list, /handoffIds/u, 'handoff uses the full known selection including hidden rows');
  assert.match(list, /id="roster-send-message"/u, 'handoff action has a stable selector');
  assert.match(list, /메시지 보내기/u);
  assert.match(list, /\/messages\?to=/u, 'handoff links to the messages workspace with ?to=');
  assert.match(list, /handoffOverLimit/u);
  assert.match(list, /> 200/u, 'handoff caps at 200 ids');
  assert.match(list, /대상이 너무 많습니다\. 필터로 대상을 좁혀 주세요/u, 'over-limit handoff explains how to narrow');
  assert.match(list, /selectionButton/u, 'handoff keeps the 44px selection target');
  const groupAt = list.indexOf('그룹 지정');
  const handoffAt = list.indexOf('메시지 보내기');
  const clearAt = list.indexOf('선택 해제');
  assert.ok(groupAt >= 0 && handoffAt > groupAt && clearAt > handoffAt, 'order stays group, handoff, deselect');
});

test('import flags over-limit fields instead of cutting them', () => {
  const wizard = read(PAGES.participantImport);
  // Server limits stay, but nothing is cut before validation.
  assert.doesNotMatch(wizard, /\.slice\(0, 60\)/u, 'names are not cut to 60');
  assert.doesNotMatch(wizard, /\.slice\(0, 120\)/u, 'emails are not cut to 120');
  assert.doesNotMatch(wizard, /\.slice\(0, 200\)/u, 'companies are not cut to 200');
  for (const message of ['이름이 60자를 초과합니다', '이메일이 120자를 초과합니다', '소속이 200자를 초과합니다']) {
    assert.match(wizard, new RegExp(message), `row-numbered error: ${message}`);
  }
  // Review shows what will actually apply: a 5-row sample of final values
  // (name/normalized phone/email/company), never all 1000 rows, plus the
  // real apply count on the commit button.
  assert.match(wizard, /적용될 값 미리보기/u);
  assert.match(wizard, /preview\.valid\.slice\(0, 5\)/u);
  assert.match(wizard, /유효 \$\{preview\.valid\.length\}행 반영/u);
});

test('team activity maps raw command keys to concise Korean labels', () => {
  const panels = read('app/console/team/OperationsPanels.tsx');
  const labels = read('app/console/team/activity-labels.ts');
  assert.match(panels, /function activityActionLabel/u, 'mapping owns one function');
  // A single resolution path: the panel holds no command switch of its own,
  // so a new server command can only change the shared map.
  assert.doesNotMatch(panels, /switch \(type\)/u, 'no second command switch in the panel');
  assert.doesNotMatch(panels, /case "report\.publish":/u, 'pinned cases live in the map, not the panel');
  assert.match(panels, /getActivityLabel\(type\)/u, 'labels resolve through the shared map');
  for (const [key, label] of [
    ['report.publish', '결과 보고서 공유 완료'],
    ['report.create', '보고서 만들기'],
    ['reward.create', '경품 등록'],
    ['message.create', '메시지 발송 요청'],
    ['template.save', '템플릿 저장'],
    ['module.save', '참여 프로그램 저장'],
    ['module.status', '참여 프로그램 상태 변경'],
    ['question.submit', 'Q&A 질문'],
    ['question.manage', 'Q&A 답변'],
    ['notice.save', '공지 저장'],
    ['check.scan', '입퇴장 스캔'],
    ['desk.save', '데스크 저장'],
    ['booth.save', '부스 저장'],
    ['event.features', '기능 설정'],
    ['form.publish', '참가 신청 게시'],
  ]) {
    assert.match(labels, new RegExp(`"${key.replace('.', '\\.')}": "${label}"`, 'u'), `${key} maps to ${label} in the single map`);
  }
  assert.match(panels, /startsWith\("participant\."\)/u, 'participant.* maps together');
  assert.match(panels, /참가자 변경/u);
  // Unknown keys keep the raw key; the row still shows entry meta.
  assert.match(panels, /return type;/u, 'unknown keys fall back to the raw key');
  assert.match(panels, /\{activityActionLabel\(entry\.type\)\}/u, 'rows render the label, not the raw key');
  assert.match(panels, /\{entry\.actor\} · \{formatTime\(entry\.at\)\}/u, 'entry meta (account·time) stays');
  assert.match(panels, /\{entry\.eventName\}/u, 'entry meta (event) stays');
});

test('team activity shows 8 rows with incremental more up to 20', () => {
  const panels = read('app/console/team/OperationsPanels.tsx');
  assert.match(panels, /ACTIVITY_INITIAL_ROWS = 8/u, 'first page is 8 rows');
  assert.match(panels, /ACTIVITY_MAX_ROWS = 20/u, 'at most 20 rows load');
  assert.match(panels, /audit\.slice\(0, visibleActivityCount\)/u, 'only the visible window renders');
  assert.match(panels, /더 보기 \(\{/u, 'more button names its remaining count');
  assert.match(panels, /audit\.length - visibleActivityCount/u, 'remaining count derives from loaded rows');
  assert.match(panels, /audit\.length > visibleActivityCount/u, 'more hides on the last page');
});

test('team activity loads past a denied security panel', () => {
  const panels = read('app/console/team/OperationsPanels.tsx');
  // A normal MANAGER gets 403 from /api/auth/security: denial must end only
  // the security-panel branch (attempts hidden), never the whole loader, so
  // the bootstrap-scoped activity still resolves instead of spinning on
  // "활동 기록을 불러오고 있습니다" forever with no 더 보기.
  assert.match(panels, /\/api\/auth\/security/u);
  assert.match(panels, /\/api\/bootstrap/u, 'activity loads from the existing scoped bootstrap');
  assert.doesNotMatch(panels, /setAttempts\(\[\]\);\s*return;/u, 'denial does not return out of the loader');
  assert.match(panels, /else if \(!cancelled\) \{[\s\S]*?setAudit\(\[\]\);/u, 'unexpected bootstrap shape resolves to explicit empty, not perpetual loading');
  assert.match(panels, /표시할 활동 기록이 없습니다/u, 'empty activity reads explicitly');
  // AGENCY security panel behavior stays: attempts render only when present.
  assert.match(panels, /\{attempts && attempts\.length \? \(/u);
});

test('team activity reveal moves focus to the first new row', () => {
  const panels = read('app/console/team/OperationsPanels.tsx');
  assert.match(panels, /pendingActivityFocusRef/u, 'reveal records the first new row index');
  assert.match(panels, /pendingActivityFocusRef\.current = visibleActivityCount/u, 'pending index is the pre-reveal window end');
  assert.match(panels, /tabIndex=\{-1\}/u, 'rows are programmatically focusable');
  assert.match(panels, /activityListRef\.current\?\.children\[target\]/u, 'focus lands on the first newly revealed row');
  assert.match(panels, /id="team-activity-more"/u, 'activity overflow has a stable selector');
});

test('roster over-limit handoff shows counts and a visible recovery', () => {
  const list = read(PAGES.participants);
  // The disabled 메시지 보내기 title alone cannot unblock: hidden selections
  // keep counting, so "필터로 대상을 좁혀 주세요" must also read as visible
  // text with the selected/hidden counts and the 200 limit.
  assert.match(list, /id="roster-handoff-limit"/u, 'over-limit guidance is visible text, not just a title');
  assert.match(list, /최대 200명까지 전송 가능/u, 'visible text names the 200 limit');
  assert.match(list, /전체 선택 \{handoffIds\.length\}명/u, 'selection row names the full handoff count');
  assert.match(list, /id="roster-exclude-hidden"/u, 'visible recovery action exists');
  assert.match(list, /숨김 제외/u);
  assert.match(list, /current\.filter\(\(id\) => visibleIds\.has\(id\)\)/u, 'recovery clears selections outside the visible list');
});

test('rewards desk filters its loaded list with search and status buckets', () => {
  const desk = read(PAGES.rewards);
  // Local search covers participant/company/경품명/추첨명; status covers
  // 전체 / 지급 대기·실패 / 수령자 지정 대기 / 수령 완료.
  assert.match(desk, /id="reward-search-label"/u);
  assert.match(desk, /aria-labelledby="reward-search-label"/u);
  assert.match(desk, /참가자·소속·경품명·추첨명 검색/u);
  assert.match(desk, /id="reward-status-label"/u);
  assert.match(desk, /aria-labelledby="reward-status-label"/u);
  for (const label of ['전체', '지급 대기·실패', '수령자 지정 대기', '수령 완료']) {
    assert.match(desk, new RegExp(label, 'u'), `status bucket: ${label}`);
  }
  assert.match(desk, /reward\.status !== "READY" && reward\.status !== "FAILED"/u, 'action bucket is READY/FAILED');
  assert.match(desk, /reward\.status !== "PENDING"/u, 'assignee bucket is PENDING');
  assert.match(desk, /reward\.status !== "RECEIVED"/u, 'received bucket is RECEIVED');
  assert.match(desk, /participantName\} \$\{reward\.company\} \$\{reward\.name\} \$\{reward\.programTitle\}/u, 'search spans participant/company/name/draw');
  // Filtering is local: the visible list derives from the loaded rewards,
  // with no extra fetch.
  assert.match(desk, /state\.rewards\.filter/u, 'visible rows derive from loaded data');
  assert.match(desk, /\$\{visibleRewards\.length\}개 \/ 전체 \$\{state\.rewards\.length\}개/u, 'count reads N개 / 전체 M개');
  assert.match(desk, /조건에 맞는 경품이 없습니다/u, 'filtered empty state stays distinct');
  assert.match(desk, /등록된 경품이 없습니다/u, 'unfiltered empty state stays');
  assert.equal((desk.match(/검색·필터 지우기/gu) ?? []).length, 2, 'count row and empty state both reset');
  // Domain semantics survive the toolbar: company PENDING display/link,
  // feature-off gates, fulfill/cancel receipts, ARCHIVED/permission gates.
  assert.match(desk, /업체 당첨/u);
  assert.match(desk, /추첨에서 수령자 지정/u);
  assert.match(desk, /경품 기능이 꺼져 있습니다/u);
  assert.match(desk, /rewardRecordMatches/u, 'fulfill/cancel receipts stay');
  assert.match(desk, /보관된 행사는 변경할 수 없습니다/u);
});
