'use strict';

// The shared console layout primitives own page hierarchy and initial-state
// composition. Keep screen copy, permissions and task actions in workspaces.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const targets = [
  'app/console/events/[id]/EventOverview.tsx',
  'app/console/events/[id]/participants/ParticipantList.tsx',
  'app/console/events/[id]/participants/import/ImportWizard.tsx',
  'app/console/events/[id]/content/ContentWorkspace.tsx',
  'app/console/events/[id]/messages/MessagingWorkspace.tsx',
];

const eventPhaseTwoTargets = [
  'app/console/events/[id]/operations/OperationsWorkspace.tsx',
  'app/console/events/[id]/programs/ProgramsWorkspace.tsx',
  'app/console/events/[id]/rewards/RewardsWorkspace.tsx',
  'app/console/events/[id]/reports/ReportsWorkspace.tsx',
  'app/console/events/[id]/settings/SettingsWorkspace.tsx',
  'app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx',
];

const rootTargets = [
  'app/console/ConsoleHome.tsx',
  'app/console/clients/ClientsList.tsx',
  'app/console/team/TeamWorkspace.tsx',
];

const allPageTargets = [...targets, ...eventPhaseTwoTargets, ...rootTargets];
const menuPages = [
  ['app/console/ConsoleHome.tsx', 'events'],
  ['app/console/clients/ClientsList.tsx', 'clients'],
  ['app/console/team/TeamWorkspace.tsx', 'team'],
  ['app/console/events/[id]/EventOverview.tsx', 'overview'],
  ['app/console/events/[id]/participants/ParticipantList.tsx', 'participants'],
  ['app/console/events/[id]/participants/import/ImportWizard.tsx', 'participantImport'],
  ['app/console/events/[id]/messages/MessagingWorkspace.tsx', 'messages'],
  ['app/console/events/[id]/operations/OperationsWorkspace.tsx', 'operations'],
  ['app/console/events/[id]/programs/ProgramsWorkspace.tsx', 'programs'],
  ['app/console/events/[id]/draws/DrawsWorkspace.tsx', 'draws'],
  ['app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx', 'photos'],
  ['app/console/events/[id]/content/ContentWorkspace.tsx', 'content'],
  ['app/console/events/[id]/page/ThemeWorkspace.tsx', 'attendeePage'],
  ['app/console/events/[id]/rewards/RewardsWorkspace.tsx', 'rewards'],
  ['app/console/events/[id]/settings/SettingsWorkspace.tsx', 'settings'],
  ['app/console/events/[id]/reports/ReportsWorkspace.tsx', 'reports'],
];

test('console layout primitives expose stable, hook-free composition', () => {
  const header = read('app/console/console-ui/ConsolePageHeader.tsx');
  const section = read('app/console/console-ui/ConsoleSection.tsx');
  const state = read('app/console/console-ui/ConsoleStatePanel.tsx');

  for (const source of [header, section, state]) {
    assert.doesNotMatch(source, /\buse(?:State|Effect|Memo|Callback|Ref|Id)\s*\(/);
  }

  const headerOrder = [
    header.indexOf('className={styles.backLink}'),
    header.indexOf('<h1>{title}</h1>'),
    header.indexOf('className={styles.pageMeta}'),
    header.indexOf('className={styles.pageBadges}'),
    header.indexOf('className={styles.pageActions}'),
  ];
  assert.ok(headerOrder.every((position) => position >= 0));
  assert.deepEqual(headerOrder, [...headerOrder].sort((a, b) => a - b));

  assert.match(section, /<section className=\{classNames\} aria-labelledby=\{headingId\}>/);
  assert.match(section, /<h2 className=\{styles\.sectionTitle\} id=\{headingId\}>\{title\}<\/h2>/);
  assert.match(header, /formatConsoleEventMeta/);
  assert.match(header, /actions\?: ReactNode/);
  assert.match(section, /action\?: ReactNode/);
});

test('state panel unifies loading, alert and shell-aware retry', () => {
  const state = read('app/console/console-ui/ConsoleStatePanel.tsx');
  assert.match(state, /role=\{loading \? "status" : "alert"\}/);
  assert.match(state, /window\.dispatchEvent\(new CustomEvent\("eventouch:shell-reload"\)\)/);
  assert.match(state, /onRetry\(\)/);
  assert.match(state, />\s*다시 불러오기\s*</);
  assert.match(state, /actions\?: ReactNode/);
});

test('all sixteen menus use the registry-owned page frame, not individual title chrome', () => {
  for (const [target, pageId] of menuPages) {
    const source = read(target);
    for (const component of ['ConsolePage', 'ConsoleStatePanel']) {
      assert.match(source, new RegExp(`import ${component}\\b`), `${target} imports ${component}`);
      assert.match(source, new RegExp(`<${component}\\b`), `${target} renders ${component}`);
    }
    assert.match(source, new RegExp(`<ConsolePage\\b[^>]*pageId="${pageId}"`, 'su'), `${target} identifies its real menu`);
    assert.doesNotMatch(source, /<ConsolePageHeader\b|<h1\b/u, `${target} does not redraw the shared title`);
    assert.match(source, /kind="loading"/u, `${target} uses the shared loading state`);
    assert.match(source, /kind="failed"/u, `${target} uses the shared failed state`);
    if (target.endsWith('/reports/ReportsWorkspace.tsx')) {
      assert.equal((source.match(/className="eyebrow"/gu) ?? []).length, 1);
      assert.match(source, /<p className="eyebrow">EVENTOUCH · 결과 보고서<\/p>/u, 'printed report cover eyebrow remains product content');
    } else {
      assert.doesNotMatch(source, /className="eyebrow"|className=\{[^}]*eyebrow/);
    }
  }
});

test('event context is centralized while domain actions retain their meaning and hierarchy', () => {
  const frame = read('app/console/console-ui/ConsolePage.tsx');
  assert.match(frame, /consolePageHref\("overview", eventId\)/u);
  assert.match(frame, /`행사 \/ \$\{trimmedName\}`/u);
  assert.match(frame, /title=\{page\.title\}/u);
  assert.doesNotMatch(frame, /\bback=\{/u);

  const content = read(targets[3]);
  // Write affordances gate on the page/programs grants but keep their exact
  // shape; reads (lists, links) never gate.
  assert.match(content, /action=\{canWritePage \? \(\s*<button\b[^>]*className="button button-secondary"[^>]*onClick=\{openNoticeCreate\}[^>]*>\s*공지 작성/su);
  assert.match(content, /title="프로그램 일정"[\s\S]*?action=\{canWritePrograms \? \([\s\S]*?className="button button-secondary"[\s\S]*?일정 추가/u);
  assert.match(content, /canWritePage = canWriteEvent\(capabilities, "notice\.save"\)/u);
  assert.match(content, /canWritePrograms = canWriteEvent\(capabilities, "program\.save"\)/u);

  const participants = read(targets[1]);
  assert.match(participants, /className="button button-secondary"[\s\S]*?changeStatus\(person, "APPROVED"\)/u);
  assert.doesNotMatch(participants, /changeStatus\(person, "APPROVED"\)[\s\S]{0,100}button-primary/u);
  assert.doesNotMatch(read(targets[0]), /button-primary/u, 'operations overview keeps zero primary actions');

  const messages = read(targets[4]);
  assert.equal((messages.match(/className="button button-primary"/gu) ?? []).length, 1);
  assert.doesNotMatch(content, />\s*운영 현황\s*<\/Link>/u);
  assert.doesNotMatch(participants, />\s*운영 현황으로\s*<\/Link>/u);
  assert.doesNotMatch(messages, />\s*운영 현황\s*<\/Link>/u);
});

test('event workspaces keep factual meta and action-specific sections inside the common frame', () => {
  for (const target of eventPhaseTwoTargets) {
    const source = read(target);
    assert.match(source, /<ConsolePage\b/u, `${target} uses the common frame`);
    assert.doesNotMatch(source, /label:\s*"← 운영 현황"/u, `${target} does not duplicate the event context`);
    assert.match(source, /formatConsoleEventMeta/u, `${target} formats only available event meta`);
  }
  const overview = read(targets[0]);
  assert.doesNotMatch(overview, /label:\s*"← 운영 현황"/u);

  const settings = read(eventPhaseTwoTargets[4]);
  for (const id of ['settings-basics', 'settings-stage', 'settings-features', 'settings-intake']) {
    assert.ok(settings.includes(id), `settings retains deep-link anchor ${id}`);
  }
  assert.match(settings, /role="tablist"/u);
  assert.doesNotMatch(settings, /label: "참가자 페이지"/u);
  assert.ok(settings.includes('id="settings-page"'), 'optional disclosure keeps its deep-link id');
  assert.doesNotMatch(settings, /headingId="settings-page"/u);

  const operations = read(eventPhaseTwoTargets[0]);
  // The section may carry a description (its own status line); the contract
  // is that the primary action stays inside the section.
  assert.match(operations, /<ConsoleSection headingId="ops-staff" title="스태프 배정"[^>]*>\s*<div className=\{styles\.primarySectionAction\}>\s*<button[\s\S]*?className="button button-primary"/u);
  assert.match(operations, /className="button button-primary"[^>]*>[\s\S]*?초안 저장/u, 'map draft save remains a primary body action');
});

test('root pages keep title-only identity and preserve primary task actions', () => {
  const home = read(rootTargets[0]);
  assert.match(home, /<ConsolePage\b[^>]*pageId="events"/su);
  assert.match(home, /<ConsoleToolbar\b/u);
  assert.match(home, /button-primary/u);
  assert.match(home, /새 행사 만들기/u);
  assert.doesNotMatch(home, /<ConsolePageHeader/u);
  assert.match(home, /console-event-directory/u);

  const clients = read(rootTargets[1]);
  const clientsRoute = read('app/console/clients/page.tsx');
  assert.match(clients, /<ConsolePage\b[^>]*pageId="clients"/su);
  assert.match(clients, /<ConsoleToolbar\b/u);
  assert.match(clients, /state\.canManage \? \([\s\S]*?className="button button-primary"[\s\S]*?고객사 등록/u);
  assert.match(clients, /<h3>\{client\.name\}<\/h3>/u);
  assert.doesNotMatch(clientsRoute, /<h1>|console-page-header/u, 'the route does not duplicate the workspace title');

  const team = read(rootTargets[2]);
  assert.match(team, /<ConsolePage\b[^>]*pageId="team"/su);
  assert.match(team, /headingId="pending-invites" title="대기 중인 초대"/u);
  assert.match(team, /headingId="team-members" title="구성원"/u);
  assert.match(team, /등록된 구성원이 없습니다/u);
  assert.match(team, /!bootstrapResponse\.ok \|\| !bootstrapPayload\?\.state/u, 'bootstrap failure cannot masquerade as an empty team');
  assert.doesNotMatch(team, /label:\s*"← 운영 현황"|meta=\{/u);

  const panels = read('app/console/team/OperationsPanels.tsx');
  for (const id of ['operations-integrations', 'operations-activity', 'operations-security']) {
    assert.match(panels, new RegExp(`headingId="${id}"`));
  }
});

test('report tables remain complete and keyboard-scrollable on narrow screens', () => {
  const reports = read(eventPhaseTwoTargets[3]);
  assert.equal((reports.match(/className=\{styles\.tableScroll\}/gu) ?? []).length, 4);
  assert.equal((reports.match(/className=\{styles\.dataTable\}/gu) ?? []).length, 4);
  assert.match(reports, /role="region" tabIndex=\{0\} aria-label="등록 그룹별 인원 표"/u);
  assert.match(reports, /role="region" tabIndex=\{0\} aria-label="부스별 인증 수 표"/u);
  assert.match(reports, /role="region" tabIndex=\{0\} aria-label="프로그램별 응답 표"/u);
  assert.match(read('app/console/events/[id]/reports/reports.module.css'), /\.tableScroll\s*\{[^}]*overflow-x:\s*auto/s);
});

test('evidence photos stay separate, section-scoped and retry-safe', () => {
  const photos = read('app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx');
  const shell = read('app/console/ConsoleShell.tsx');
  const programs = read('app/console/events/[id]/programs/ProgramsWorkspace.tsx');

  for (const key of ['SPACE', 'STAGE', 'PARTICIPANT_BOOTH', 'ONSITE_DIRECTION', 'PRE_SETUP', 'ARRIVAL_REGISTRATION', 'PROGRAM', 'AWARDS']) {
    assert.match(photos, new RegExp(`key: "${key}"`), `${key} section is available`);
  }
  assert.match(shell, /canManageEvidencePhotos:\s*role\s*===\s*"AGENCY"\s*\|\|\s*\(role\s*===\s*"MANAGER"\s*&&\s*hasCurrentMembership\)/u);
  assert.match(shell, /pageId === "photos" && !shellData\?\.canManageEvidencePhotos\) return false/u, 'photo navigation stays hidden outside agency/event-member manager roles');
  // The shell advertises its own degraded state instead of silently hiding
  // navigation: a visible alert with retry, never a fake empty shell.
  assert.match(shell, /const \[shellError, setShellError\] = useState\(false\)/u);
  assert.match(shell, /setShellError\(true\)/u);
  assert.match(shell, /className="console-shell-error" role="alert"/u);
  assert.match(shell, /setShellTick\(\(tick\) => tick \+ 1\)/u, 'shell retry reloads its data');
  assert.match(photos, /command:\s*"evidence\.photo\.add"/u);
  assert.match(photos, /uploadCommandId:\s*randomCommandId\(\)/u);
  assert.match(photos, /recordCommandId:\s*randomCommandId\(\)/u);
  assert.match(photos, /status:\s*bytesUploaded\s*\?\s*"failed-record"\s*:\s*"failed-upload"/u);
  assert.match(photos, /evidence\.photo\.move/u);
  assert.match(photos, /evidence\.photo\.remove/u);
  assert.match(photos, /id="evidence-photo-section"/u, 'mobile section picker stays a native labeled select');
  assert.match(photos, /URL\.createObjectURL\(file\)/u, 'selected images have a local preview before upload');
  assert.match(photos, /사진을 끌어 놓거나 파일을 선택하세요/u, 'upload area explains both drop and browse actions');
  assert.match(photos, /onDrop=\{/u, 'files can be dropped onto the upload area');
  assert.match(photos, /onClick=\{uploadSelectedJobs\}/u, 'uploads start only after explicit confirmation');
  assert.match(photos, /<details className=\{styles\.jobDisclosure\}/u, 'successful upload history is disclosed on demand');
  assert.match(photos, /<details className=\{styles\.photoManage\}/u, 'per-photo maintenance actions are disclosed on demand');
  assert.match(photos, /보관함 참조만 제거합니다\. 원본 파일은 삭제되지 않고 기존 행사 파일 읽기 권한은 그대로 적용됩니다/u);
  assert.match(photos, /evidence-photos\.zip\?\$\{params\.toString\(\)\}/u);
  assert.match(programs, /status\s*===\s*"APPROVED"/u);
  assert.match(programs, /attendee-photos\.zip/u);
  assert.match(programs, /href=\{`\/api\/events\/\$\{encodeURIComponent\(props\.eventId\)\}\/attendee-photos\.zip`\}/u);
  assert.match(programs, />\s*원본 저장\s*</u);
});

test('slug pattern attributes stay valid under the HTML v-flag rules', () => {
  const files = [
    'app/console/CreateEventDialog.tsx',
    'app/console/events/[id]/settings/SettingsWorkspace.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/pattern="([^"]+)"/gu)) {
      // Modern browsers compile pattern attributes with the v flag; an
      // unescaped dash inside a class throws there and the constraint
      // silently stops applying.
      new RegExp(`^(?:${match[1]})$`, 'v');
    }
    assert.match(source, /pattern="\[a-z0-9\]\[a-z0-9\\-\]\{0,49\}"/u, `${file} keeps a v-flag-safe slug pattern`);
  }
});

test('thin participant route wrappers and overview do not add legacy eyebrows', () => {
  const paths = [
    'app/console/events/[id]/page.tsx',
    'app/console/events/[id]/participants/page.tsx',
    'app/console/events/[id]/participants/import/page.tsx',
    'app/console/events/[id]/photos/page.tsx',
  ];
  for (const target of paths) {
    assert.doesNotMatch(read(target), /eyebrow/u, `${target} has no eyebrow`);
  }
  assert.match(read(paths[0]), /<EventOverview eventId=\{id\} \/>/u);
  assert.match(read(paths[1]), /<ParticipantList eventId=\{id\} \/>/u);
  assert.match(read(paths[2]), /<ImportWizard eventId=\{id\} \/>/u);
  assert.match(read(paths[3]), /<EvidencePhotosWorkspace key=\{id\} eventId=\{id\} \/>/u);
});
