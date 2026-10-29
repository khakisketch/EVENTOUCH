'use strict';

// Console-unification outcome audit contract: scripts/web-console-audit.cjs
// must drive all 16 console menus through the owned isolated fixture against
// the real API, with the registry H1s, the shared frame assertions and every
// representative interaction pinned. Static source assertions plus registry
// cross-checks on purpose: they pin the seam without booting databases,
// browsers, or servers (main runs the audit serially).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('console audit reports missing ffmpeg before creating evidence or starting a fixture', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'console-audit-ffmpeg-test-'));
  try {
    const captureRoot = path.join(parent, 'captures');
    fs.mkdirSync(captureRoot, { mode: 0o700 });
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/web-console-audit.cjs')], {
      cwd: ROOT,
      env: { ...process.env, PATH: parent, TMPDIR: parent, EVENTOUCH_CAPTURE_ROOT: captureRoot },
      encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(run.status, 0, 'a missing camera-audit dependency must fail');
    assert.match(run.stderr, /ffmpeg.*필요/, 'the error must identify the missing dependency');
    assert.equal(fs.existsSync(path.join(captureRoot, 'console')), false, 'do not create evidence or start a fixture before preflight');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

const EXPECTED_TITLES = {
  events: '행사',
  clients: '고객사',
  team: '팀·권한',
  overview: '운영 현황',
  participants: '참가자 명단',
  import: '명단 가져오기',
  messages: '메시지 발송',
  operations: '현장 운영',
  programs: '참여 프로그램',
  draws: '추첨·투표',
  photos: '현장 사진',
  content: '콘텐츠',
  attendeePage: '참가자 페이지',
  rewards: '경품',
  settings: '행사 설정',
  reports: '결과 보고서',
};

test('console-audit-covers-all-16-menus-with-registry-titles', () => {
  const audit = require('../scripts/web-console-audit.cjs');
  assert.ok(Array.isArray(audit.SCREENS));
  assert.equal(audit.SCREENS.length, 16);
  const navigation = read('apps/web/app/console/console-navigation.ts');
  for (const [key, title] of Object.entries(EXPECTED_TITLES)) {
    const screen = audit.SCREENS.find((item) => item.key === key);
    assert.ok(screen, `audit covers ${key}`);
    assert.equal(screen.title, title, `${key} pins the registry H1 literally`);
    assert.match(navigation, new RegExp(`title: "${title}"`), `registry still ships ${JSON.stringify(title)}`);
  }
  const paths = audit.SCREENS.map((screen) => screen.path);
  for (const suffix of ['/participants/import', '/participants', '/messages', '/reports', '/settings', '/page']) {
    assert.ok(paths.some((path) => path.endsWith(suffix)), `audit covers *${suffix}`);
  }
});

test('console-audit-drives-the-owned-isolated-fixture-and-nothing-else', () => {
  const source = read('scripts/web-console-audit.cjs');
  assert.match(source, /startAuditFixture\(\)/, 'boots the owned fixture with no external base');
  assert.doesNotMatch(source, /WEB_BASE/, 'never targets an external running build');
  assert.match(source, /fixture\.close\(\)/, 'unwinds gateway, owned Next and harness');
  assert.match(source, /launchBrowser/, 'uses the portable browser launcher');
  assert.doesNotMatch(source, /addScriptTag/, 'no script injection through the page pipeline');
  assert.doesNotMatch(source, /bypassCSP/, 'no CSP weakening');
});

test('console-audit-cannot-really-send', () => {
  const source = read('scripts/web-console-audit.cjs');
  assert.match(source, /delete process\.env\[key\]/, 'provider keys are deleted');
  assert.match(source, /SOLAPI_API_KEY/, 'solapi key is in the deleted set');
  assert.match(source, /EVENTOUCH_SMS_MOCK.*=.*'1'/, 'sms mock is forced');
  assert.match(source, /simulate: true/, 'every campaign is simulated');
  assert.doesNotMatch(source, /simulate: false/, 'no real-send campaign');
});

test('console-audit-checks-phone-composition-and-real-two-tab-recovery', () => {
  const source = read('scripts/web-console-audit.cjs');
  for (const phase of ['phone/home-composition', 'phone/roster-disclosure', 'phone/section-destinations', 'phone/preview-status', 'theme/two-tab-field-merge']) {
    assert.ok(source.includes(phase), `${phase} is a browser outcome`);
  }
  for (const phase of ['phone/global-navigation', 'roles/mobile-global-navigation']) {
    assert.ok(source.includes(phase), `${phase} is exercised in the real browser`);
  }
  assert.match(source, /cancelled leave discarded input or menu/, 'top menu cancellation preserves the editing context');
  assert.match(source, /outside pointer stole input focus/, 'pointer dismissal preserves the actual target');
  assert.match(source, /for \(const width of \[360, 412\]\)/);
  assert.match(source, /first\.y > 440/, 'first task content has an independent visibility target');
  assert.match(source, /stage filter regained card styling or lost its touch height/, 'flat query controls retain their rendered style and touch target');
  assert.match(source, /filter reset discarded selection/);
  assert.match(source, /anchor heading covered by sticky rail/);
  assert.match(source, /preview status squeezed into vertical Korean/);
  assert.match(source, /const second = await context\.newPage\(\)/, 'actual second tab, not a fake conflict response');
  assert.match(source, /merged fields not persisted/, 'merge is checked against real API state');
  const css = read('apps/web/app/globals.css');
  assert.match(css, /html:has\(\.console-shell\)\s*\{[^}]*scroll-padding-top:[^}]*scroll-padding-bottom:/s, 'anchors and focus account for the sticky rail and content edge');
});

test('console-audit-asserts-the-shared-frame-not-just-headings', () => {
  const source = read('scripts/web-console-audit.cjs');
  assert.match(source, /single H1|h1Count !== 1/, 'exactly one H1 per menu');
  assert.match(source, /행사 \/ \${eventName}/, 'compact event context carries the real event name');
  assert.match(source, /organization.*must not render an event context|scope === 'organization'/, 'org pages stay context-free');
  assert.match(source, /← 운영 현황/, 'the legacy back row fails the run');
  for (const marker of [
    '#console-event-directory', '#client-list-heading', '#team-members',
    '#event-metrics-heading', '#participant-import-file-heading', '#history-heading',
    '#ops-desks', '#draws-vote', '#evidence-photo-sections', '#content-notices',
    '#home-intro', '#rewards-list', '#set-name', '#reports-list',
  ]) {
    assert.ok(source.includes(marker), `loaded marker kept: ${marker}`);
  }
  // Markers resolve in product source, not only in the audit.
  const web = (rel) => read(`apps/web/${rel}`);
  assert.match(web('app/console/ConsoleHome.tsx'), /console-event-directory/);
  assert.match(web('app/console/events/[id]/settings/SettingsWorkspace.tsx'), /id="set-name"/);
  assert.match(web('app/console/events/[id]/page/ThemeWorkspace.tsx'), /id="home-intro"/);
  assert.match(web('app/console/events/[id]/reports/ReportsWorkspace.tsx'), /clone\.id = "eventouch-report-print"/);
});

test('console-audit-keeps-every-representative-interaction', () => {
  const source = read('scripts/web-console-audit.cjs');
  assert.match(source, /status=APPROVED&attendance=NOT_ENTERED/, 'overview deep link is exact');
  assert.match(source, /숨김/, 'cross-filter selection survival is asserted');
  assert.match(source, /저장하지 않은 변경/, 'draft-guard confirm is asserted');
  assert.match(source, /program-dialog|#program-title/, 'create-dialog focus target is stable');
  assert.match(source, /route\.fulfill\(\{ status: 502/, 'labeled 502 injection, never a fake 200');
  assert.match(source, /saveIds\[0\] !== saveIds\[1\]/, 'unchanged retries must replay the receipt id');
  assert.match(source, /최신 초안이 달라졌습니다/, 'optimistic 409 conflict is asserted');
  assert.match(source, /내 변경을 최신 초안에 적용/, 'apply-latest keeps the local edit');
  assert.match(source, /eventouch-report-print/, 'print clone identity is asserted');
  assert.match(source, /afterprint/, 'print cleanup is asserted');
  assert.match(source, /published snapshot moved/, 'frozen counts survive a real check-in');
  assert.match(source, /participant\.status.*CANCELLED|ENDED participant\.status/, 'ENDED enforcement is asserted');
  assert.match(source, /notice\.save.*ARCHIVED|ARCHIVED notice\.save/, 'ARCHIVED enforcement is asserted');
  assert.match(source, /보관된 행사는 읽기 전용입니다/, 'archived read-only copy is asserted');
  assert.match(source, /\/login/, 'anonymous access bounces to login');
  assert.match(source, /행사를 찾을 수 없거나 접근 권한이 없습니다/, 'unassigned staff cannot read an event outside their projection');
  assert.match(source, /const real = await route\.fetch\(\)/, 'response loss happens after an actual server commit');
  assert.match(source, /saveIds\[2\] === saveIds\[3\]/, 'a changed payload must bind a new receipt id');
});

test('console-audit-covers-centralized-writes-under-response-loss', () => {
  const source = read('scripts/web-console-audit.cjs');
  // One shared writer, per-dialog real selectors and commands — no fakes.
  assert.match(source, /assertResponseLossRetry/, 'shared lost-response writer');
  for (const phase of ['writes/response-loss-client', 'writes/response-loss-notice', 'writes/response-loss-desk']) {
    assert.match(source, new RegExp(phase.replace(/\//g, '\\/')), `${phase} runs`);
  }
  for (const selector of ['#client-name', '#client-contact', '#client-email', '#content-notice-title', '#content-notice-body', '#desk-name']) {
    assert.ok(source.includes(selector), `real field kept: ${selector}`);
  }
  assert.match(source, /고객사 등록/);
  assert.match(source, /공지 작성/);
  assert.match(source, /데스크 추가/);
  assert.match(source, /데스크 저장/);
  assert.match(source, /\*\*\/api\/clients/);
  assert.match(source, /command === 'notice\.save'/);
  assert.match(source, /command === 'desk\.save'/);
  // The first mutation really commits (route.fetch asserted 2xx); only the
  // browser's copy is replaced, and never with a fake 200.
  assert.match(source, /const live = await route\.fetch\(\)/);
  assert.match(source, /live commit failed with/);
  assert.match(source, /응답 유실 검증/);
  assert.doesNotMatch(source, /fulfill\(\{ status: 200/);
  // Unchanged retry replays the receipt id, lands exactly one record, and
  // detaches the shared dialog with inputs intact until then.
  assert.match(source, /seenIds\[0\] !== seenIds\[1\]/);
  assert.match(source, /expected exactly one new record/);
  assert.match(source, /lost response overwrote/);
  assert.match(source, /dialog closed on the lost response/);
  assert.match(source, /unexpected draft confirm after settled write/, 'settled writes guard nothing');
  for (const shot of ['writes-client-dialog-error.png', 'writes-notice-dialog-error.png', 'writes-desk-dialog-error.png']) {
    assert.ok(source.includes(shot), `error-state dialog captured: ${shot}`);
  }
});

test('console-audit-pins-assigned-staff-read-only-and-outsider-denial', () => {
  const source = read('scripts/web-console-audit.cjs');
  assert.match(source, /상태 변경 권한이 없습니다\./, 'assigned staff reads with the warning');
  assert.match(source, /was offered the import action/, 'staff gets no import action');
  assert.match(source, /was offered the group write/, 'staff gets no group write');
  assert.match(source, /was offered write-only bulk selection/, 'read-only staff does not get mutation-only row selectors');
  assert.match(source, /현장 운영을 변경할 운영 권한이 없습니다/, 'operations console stays read-only for staff');
  assert.match(source, /mutation button enabled for staff/, 'no enabled mutation button for staff');
  assert.match(source, /disabled reason/, 'disabled controls keep the server reason');
  assert.match(source, /assigned manager lost the import action/, 'manager import workflow retained');
});

test('console-audit-guards-settings-dirty-navigation-as-the-criterion', () => {
  // The settings draft guard is product contract: dirty sections register
  // before any early return, and the audit exercises #set-name end to end.
  const settings = read('apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx');
  assert.match(
    settings,
    /import \{ useConsoleDraftGuard \} from "\.\.\/\.\.\/\.\.\/console-draft-guard";/,
    'settings imports the guard from its specified home',
  );
  assert.match(settings, /sectionsDirty/, 'settings diffs dirty sections against server baselines');
  assert.match(
    settings,
    /useConsoleDraftGuard\(\s*sectionsDirty \|\| pendingIntent,/,
    'settings registers dirty sections and pending intent',
  );
  const audit = read('scripts/web-console-audit.cjs');
  assert.match(audit, /guard\/settings-dirty-navigate/, 'settings dirty-navigate is its own phase');
  assert.match(audit, /#set-name/, 'settings scenario dirties the event-name input');
  assert.match(audit, /저장하지 않은 행사 설정/, 'settings scenario asserts the settings confirm copy');
  assert.match(audit, /guard\/theme-dirty-navigate/, 'theme keeps its own guard check alongside');
});

test('console-audit-fails-loud-and-keeps-evidence-out-of-the-repo', () => {
  const source = read('scripts/web-console-audit.cjs');
  assert.match(source, /defaultCaptureDir\(`console-unification-\$\{runStamp\(\)\}`\)/, 'captures default to a fresh private per-user leaf outside the repo');
  assert.doesNotMatch(source, /apps\/web\/public/, 'no committed images');
  assert.match(source, /BLOCKING\.has\(violation\.impact\)/, 'serious/critical axe fails the run');
  assert.match(source, /horizontal overflow/, 'overflow fails the run');
  assert.match(source, /process\.exitCode = 1/, 'collected failures fail the run');
  assert.match(source, /scrollTo\(0, 0\)/, 'captures reset scroll to avoid sticky artifacts');
});
