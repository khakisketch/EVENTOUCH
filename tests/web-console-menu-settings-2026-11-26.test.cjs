const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Reopened 2026-11-26 (console menu and settings audit fixes).
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'apps/web/app/console', file), 'utf8');
const navigation = require('../apps/web/app/console/console-navigation.ts');

const settings = read('events/[id]/settings/SettingsWorkspace.tsx');
const shell = read('ConsoleShell.tsx');
const confirmation = read('console-ui/StageTransitionConfirmation.tsx');

test('the missing-contact warning shows in every verification mode and says who is left without help', () => {
  assert.match(settings, /\{!state\.participantContact && !state\.recoveryContact \? \(\s*<ConsoleFeedback kind="warning">/u,
    'no verification-mode condition hides the warning');
  assert.match(settings, /참가자 문의처가 없습니다\. 티켓을 잃은 참가자가 연락할 곳이 없습니다\./u);
  assert.match(settings, /참가자 문의처가 없습니다\. 문자로 티켓을 다시 연결할 수 없어, 문의처를 저장하기 전까지 티켓을 잃은 참가자는 물어볼 곳이 없습니다\./u);
  assert.equal((settings.match(/<ConsoleFeedback kind="warning">[\s\S]{0,200}?isRecoveryBlocked\(verificationMode\)/gu) ?? []).length, 1,
    'one warning, worded by mode');
  assert.doesNotMatch(settings, /참가자에게 표시되는 문의처도 없습니다/u, 'the second blocked-mode warning is merged into the first');
  assert.match(settings, /장소 안내의 문의 정보/u, 'the venue contact link stays');
  const publishAt = settings.indexOf('onClick={requestFormPublish}');
  assert.doesNotMatch(settings.slice(publishAt - 900, publishAt), /recoveryContact|isRecoveryBlocked/u, 'opening intake is not gated');
});

test('입장 관리 sits in the 당일 group, before 현장 모드', () => {
  const pages = Object.fromEntries(navigation.EVENT_HUBS.map((hub) => [hub.id, [...hub.pageIds]]));
  assert.deepEqual(pages.prepare, ['attendeePage', 'content', 'programs', 'settings']);
  assert.deepEqual(pages.onsite, ['operations', 'live']);
  assert.equal(navigation.consoleHubForPage('operations').label, '당일');
});

test('menu search leads to 기간 분석 although it has no rail item', () => {
  const search = (query) => navigation.eventMenuShortcuts('reports', 'demo event', query).map(({ label, href }) => [label, href]);
  const expected = [['기간 분석', '/console/events/demo%20event/analysis']];
  assert.deepEqual(search('기간 분석'), expected);
  assert.deepEqual(search('통계'), expected);
  assert.deepEqual(search(''), []);
  assert.deepEqual(search('없는 메뉴 예시'), []);
  assert.deepEqual(navigation.eventMenuShortcuts('reports', undefined, '기간 분석'), []);
  assert.ok(navigation.EVENT_HUBS.find((hub) => hub.id === 'results').pageIds.includes('reports'), 'the shell asks the reports row for shortcuts');
});

test('links and titles that name a console destination use its menu name', () => {
  const overview = read('events/[id]/EventOverview.tsx');
  assert.match(overview, /key: "page",\s*label: "참가자 화면"/u);
  assert.match(overview, /action: "경품 지급",/u);
  assert.doesNotMatch(overview, /action: "경품 지급 현황"/u);
  assert.match(settings, /참가자 화면 · 선택 사항/u);
  assert.match(settings, /참가자 화면으로 이동/u);
  assert.doesNotMatch(settings, /참가자 페이지 편집/u);
  const programs = read('events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(programs, />추첨·투표 \(무대 운영·룰렛\)<\/ProductLink>/u);
  assert.match(programs, />추첨·투표<\/ProductLink> 화면에서 관리합니다\./u);
  // 참여 진행 moved to 현장 모드; the way back goes there under its menu name.
  assert.match(programs, /label: fromOverview \? "운영 현황으로" : "현장 모드로"/u);
  assert.match(programs, /: `\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/live` \};/u);
  assert.doesNotMatch(programs, /참여 진행으로/u);
  const close = read('events/[id]/reports/EventCloseFlow.tsx');
  assert.match(close, /label: "참여 이벤트 닫기"/u);
  assert.match(close, />참여 이벤트에서 닫기<\/ProductLink>/u);
  assert.match(close, />참가자 명단에서 승인 처리하기<\/ProductLink>/u);
  assert.match(read('events/[id]/reports/ReportsWorkspace.tsx'), /참가자 명단에서 승인 처리하기/u);
  assert.match(read('console-event-close.ts'), /참여 이벤트에서 닫으세요/u);
  assert.match(read('events/[id]/rewards/RewardsWorkspace.tsx'), /추첨·투표에서 수령자 지정/u);
  assert.match(read('events/[id]/participants/ParticipantList.tsx'), /경품 지급에서 지급 처리하세요/u);
  const wizard = read('events/[id]/participants/import/ImportWizard.tsx');
  assert.equal((wizard.match(/참가자 명단으로/gu) ?? []).length, 4);
  assert.doesNotMatch(wizard, /참가자 목록으로/u);
  const content = read('events/[id]/content/ContentWorkspace.tsx');
  assert.doesNotMatch(content, /참가자 페이지 설정에서/u);
  assert.match(content, /참가자 화면 설정에서/u);
});

test('the dead 서비스 연동 item and its permission mention are gone', () => {
  assert.doesNotMatch(shell, /서비스 연동|canManageIntegrations|integrations\.manage|operator-menu-status/u);
  assert.match(shell, /canManageTeam \? "팀·권한" : null,\s*\]/u);
  assert.match(shell, /\{canManageTeam \? \(\s*<div className="operator-menu-divider"/u);
});

test('the 보관 confirmation says what locks for good', () => {
  const { eventStageLabel } = require('../apps/web/app/event-stage.ts');
  assert.equal(eventStageLabel('ARCHIVED'), '보관');
  assert.match(confirmation, /label === eventStageLabel\("ARCHIVED"\)/u);
  assert.match(confirmation, /보관하면 수정, 메시지 발송, 보고서 정정이 영구히 잠기며 되돌릴 수 없습니다\./u);
  assert.match(confirmation, /aria-describedby=\{\[describedBy, locks \? lockId : undefined\]\.filter\(Boolean\)\.join\(" "\) \|\| undefined\}/u,
    'the focused confirm button announces the warning and keeps the caller reason');
  assert.match(confirmation, /onClick=\{onConfirm\}/u, 'the confirmation flow is unchanged');
});
