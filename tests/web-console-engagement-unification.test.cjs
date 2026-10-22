'use strict';

// Engagement unification contract (console programs/draws/photos/reports +
// attendee page builder): every menu screen renders inside the shared
// ConsolePage frame with one registry title and one compact event context,
// primary body actions live in toolbars or editing-area action rows, and
// page feedback uses ConsoleFeedback. Dialogs use the shared ConsoleDialog
// shell; bespoke focus traps, key listeners and scroll locks are gone.
// Unsaved work is reported through useConsoleDraftGuard, and archived events
// lock writes while reads and exports stay available. Domain commands,
// permissions, copy and record semantics are unchanged (pinned by the older
// slice/engagement/employee contracts, not re-pinned here).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const PROGRAMS = 'app/console/events/[id]/programs/ProgramsWorkspace.tsx';
const DRAWS = 'app/console/events/[id]/draws/DrawsWorkspace.tsx';
const PHOTOS = 'app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx';
const REPORTS = 'app/console/events/[id]/reports/ReportsWorkspace.tsx';
const THEME = 'app/console/events/[id]/page/ThemeWorkspace.tsx';

const ALL = [PROGRAMS, DRAWS, PHOTOS, REPORTS, THEME];

test('unified-frame: every engagement page renders the shared frame, not a bespoke header', () => {
  const pageIds = {
    [PROGRAMS]: 'programs',
    [DRAWS]: 'draws',
    [PHOTOS]: 'photos',
    [REPORTS]: 'reports',
    [THEME]: 'attendeePage',
  };
  for (const file of ALL) {
    const source = read(file);
    assert.match(source, new RegExp(`<ConsolePage pageId="${pageIds[file]}"`), `${file} uses the shared frame`);
    assert.match(source, /eventName=\{state\.eventName\}/, `${file} passes the event name`);
    assert.match(source, /meta=\{state\.eventMeta\}/, `${file} passes the shared meta line`);
    assert.match(source, /kind="loading"/, `${file} keeps the shared loading state`);
    assert.match(source, /kind="failed"/, `${file} keeps the shared failed state`);
    // The unification removes the repeated giant event H1 and back row: the
    // frame owns the compact context link and the rail owns navigation.
    assert.doesNotMatch(source, /label:\s*"← 운영 현황"/, `${file} has no legacy back row`);
    assert.doesNotMatch(source, /<ConsolePageHeader\b/, `${file} does not render a bespoke header`);
  }
});

test('unified-frame: primary actions live in toolbars or editing areas, feedback is shared', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /<ConsoleToolbar/, 'programs create/refresh ride the body toolbar');
  assert.match(programs, />\s*프로그램 만들기\s*</, 'programs keeps the standard create action');
  const reports = read(REPORTS);
  assert.match(reports, /<ConsoleToolbar/, 'reports create rides the body toolbar');
  assert.match(reports, />\s*보고서 만들기\s*</, 'reports keeps the standard create action');
  for (const file of ALL) {
    assert.match(read(file), /<ConsoleFeedback kind=/, `${file} reports through shared feedback`);
  }
  const theme = read(THEME);
  assert.match(theme, /<ConsoleFeedback kind="error">\{failure\.message\}<\/ConsoleFeedback>/, 'theme surfaces failures in the frame');
  assert.match(theme, /<ConsoleFeedback kind="success">\{notice\}<\/ConsoleFeedback>/, 'theme surfaces notices in the frame');
});

test('unified-frame: domain sections keep their identities, duplicate menu titles are gone', () => {
  const draws = read(DRAWS);
  for (const id of ['draws-vote', 'draws-programs', 'draws-roulette', 'draws-lucky']) {
    assert.match(draws, new RegExp(`headingId="${id}"`), `draws retains ${id}`);
  }
  const photos = read(PHOTOS);
  for (const id of ['evidence-photo-sections', 'evidence-photo-archive']) {
    assert.match(photos, new RegExp(`headingId="${id}"`), `photos retains ${id}`);
  }
  const reports = read(REPORTS);
  for (const id of ['reports-analysis', 'reports-list', 'report-detail']) {
    assert.match(reports, new RegExp(`headingId="${id}"`), `reports retains ${id}`);
  }
  const programs = read(PROGRAMS);
  assert.doesNotMatch(programs, /headingId="program-module-list"/, 'programs drops the menu-duplicate body title');
  assert.match(programs, /className=\{styles\.moduleList\}/, 'programs keeps the module collection body');
  const theme = read(THEME);
  for (const legend of ['배경', '배너 이미지', '소개와 노출', '문구와 배치']) {
    assert.match(theme, new RegExp(`<legend>${legend}<\\/legend>`), `theme retains the ${legend} group`);
  }
});

test('unified-frame: reports navigate analysis and frozen records through the shared nav', () => {
  const reports = read(REPORTS);
  assert.match(reports, /<ConsoleSectionNav/, 'reports use the shared section nav');
  assert.match(reports, /\{ id: "reports-analysis", label: "결과 분석" \}/, 'analysis jump target stays');
  assert.match(reports, /\{ id: "reports-list", label: "보고서" \}/, 'frozen list jump target stays');
  assert.match(reports, /\{ id: "report-detail", label: "보고서 내용" \}/, 'detail jump target appears with the record');
  assert.match(reports, /recordRow/, 'frozen records use the shared record row');
  assert.match(reports, /badgePublished/, 'shared state stays visible on frozen records');
  assert.match(reports, /badgeDraft/, 'draft state stays visible on frozen records');
});

test('unified-frame: dialogs use the shared shell with dismissal gates, not bespoke chrome', () => {
  for (const file of [PROGRAMS, REPORTS]) {
    const source = read(file);
    assert.match(source, /<ConsoleDialog/, `${file} mounts the shared dialog`);
    assert.match(source, /canClose=\{/, `${file} gates dismissal with a sync predicate`);
    assert.match(source, /initialFocusRef=\{/, `${file} keeps input focus without bespoke listeners`);
    assert.doesNotMatch(source, /document\.body\.style\.overflow/, `${file} owns no scroll lock`);
    assert.doesNotMatch(source, /addEventListener\("keydown"/, `${file} owns no key listener`);
  }
  const programs = read(PROGRAMS);
  assert.match(programs, /titleId="program-dialog-title"/, 'program dialog keeps its accessible title');
  assert.match(programs, /id="program-title"/, 'program dialog keeps input ids');
  assert.match(programs, /<ConsoleFormActions>/, 'program dialog closes the editing unit uniformly');
  const reports = read(REPORTS);
  assert.match(reports, /id="report-dialog-error" role="alert"/, 'report dialog keeps field error wiring');
  assert.match(reports, /<ConsoleFormActions>/, 'report detail and dialog close uniformly');
});

test('unified-frame: preview landing keeps one h1 per page', () => {
  const landing = read('app/event/[slug]/home/AttendeeHomeLanding.tsx');
  assert.match(landing, /const Title = preview \? "h3" : "h1";/, 'heading level follows preview semantics');
  assert.match(landing, /<Title className=\{styles\.eventTitle\}>\{title\}<\/Title>/, 'same title class and visual styles in both modes');
  assert.doesNotMatch(landing, /<h1[\s>]/, 'no literal h1 remains in the shared landing');
  assert.doesNotMatch(landing, /<section[^>]*aria-hidden/, 'preview section stays exposed to assistive technology');
  assert.doesNotMatch(landing, /<Title[^>]*aria-hidden/, 'preview title stays exposed to assistive technology');
});

test('unified-frame: unsaved work is reported to the cross-route guard before early returns', () => {
  for (const file of ALL) {
    const source = read(file);
    assert.match(
      source,
      /import \{ useConsoleDraftGuard \} from "\.\.\/\.\.\/\.\.\/console-draft-guard";/,
      `${file} imports the guard from its specified home`
    );
    assert.match(source, /useConsoleDraftGuard\(/, `${file} wires the guard`);
  }
  const programs = read(PROGRAMS);
  assert.match(programs, /dialogDirty/, 'programs watch the create/edit draft');
  assert.match(programs, /answerDirty/, 'programs watch per-question answer drafts');
  assert.match(programs, /pendingRetry = pendingCommandsRef\.current\.size > 0/, 'programs watch retained idempotent keys');
  assert.match(programs, /delete next\[question\.id\]/, 'saved answers release their draft entries');
  const draws = read(DRAWS);
  assert.match(draws, /drawsDirty/, 'draws watch every editing draft');
  assert.match(draws, /normalizedPrizes/, 'draws compare server-trimmed prize labels');
  assert.match(draws, /pendingCommands\.current\.size > 0/, 'draws watch retained idempotent keys');
  const photos = read(PHOTOS);
  assert.match(photos, /job\.status !== "recorded"/, 'photos watch unsettled upload jobs');
  const reports = read(REPORTS);
  assert.match(reports, /!pristine/, 'reports watch the create/edit dialog against its baseline');
  const theme = read(THEME);
  assert.match(theme, /pendingSaveRef\.current !== null/, 'theme watches a pending save intent');
  assert.match(theme, /pendingPublishRef\.current !== null/, 'theme watches a pending publish intent');
});

test('unified-frame: archived events lock writes while reads and exports stay available', () => {
  for (const file of [PROGRAMS, DRAWS, PHOTOS, REPORTS]) {
    const source = read(file);
    assert.match(source, /archived: text\(event\.stage\)\.toUpperCase\(\) === "ARCHIVED"/, `${file} derives the lock from the server stage`);
    assert.match(source, /writeLocked/, `${file} gates write affordances`);
    assert.match(source, /읽기 전용입니다/, `${file} explains the lock inline`);
  }
  const theme = read(THEME);
  assert.match(theme, /archived: text\(event\.stage\)\.toUpperCase\(\) === "ARCHIVED"/, 'theme derives the lock from the server stage');
  assert.match(theme, /보관된 행사는 읽기 전용입니다/, 'theme explains the lock inline');
  // Reads and exports keep working: downloads, JSON snapshots, print, views.
  assert.match(read(PROGRAMS), /attendee-photos\.zip/, 'program photo export stays available');
  assert.match(read(PHOTOS), /evidence-photos\.zip/, 'evidence archive export stays available');
  assert.match(read(PHOTOS), /원본 다운로드/, 'original downloads stay available');
  assert.match(read(REPORTS), /exportJson\(detail\)/, 'report JSON export stays available');
  assert.match(read(REPORTS), /window\.print\(\)/, 'report printing stays available');
  assert.match(read(REPORTS), /내용 보기/, 'frozen record reading stays available');
});

test('unified-frame: theme binds one payload to one command id and never replays stale edits', () => {
  const theme = read(THEME);
  assert.match(theme, /stableStringify/, 'payloads fingerprint deterministically');
  assert.match(theme, /type PendingIntent = \{ commandId: string; fingerprint: string \}/, 'intents bind id and payload');
  assert.match(theme, /pendingSaveRef = useRef<PendingIntent \| null>/, 'save intents persist across retries');
  assert.match(theme, /pendingPublishRef = useRef<PendingIntent \| null>/, 'publish intents persist across retries');
  assert.match(theme, /pending\.fingerprint === fingerprint \? pending\.commandId : randomCommandId\(\)/, 'unchanged retries reuse the id, edits mint a new one');
  assert.match(theme, /submittedForm = state\.form/, 'save captures the submitted design');
  assert.match(theme, /submittedPageFields = state\.pageFields/, 'save captures the submitted fields');
  assert.match(theme, /formSettled/, 'success adopts server values only where local input is settled');
  assert.match(theme, /fieldsSettled/, 'success preserves newer local fields against the advanced baseline');
  assert.match(theme, /response\.status !== 408 && response\.status < 500/, 'ambiguous 408/5xx keep the bound id');
  assert.match(theme, /expectedDraftVersion: state\.draftVersion/, 'save still guards on the draft version');
  assert.match(theme, /payload = \{ expectedDraftVersion: state\.draftVersion \}/, 'publish still guards on the draft version');
  assert.match(theme, /publishedPageFields,/, 'publish refreshes the published field baseline from the receipt');
});

test('unified-frame: ambiguous draw responses keep their receipts for safe retry', () => {
  const draws = read(DRAWS);
  assert.match(draws, /response\.status < 500 && response\.status !== 408/, 'draw 408 stays ambiguous like 5xx');
  assert.match(draws, /drawIntent\(program, count, toStage\)/, 'repeated runs bind winner-count intent');
});

test('unified-frame: draws jumps its four long sections through the shared nav', () => {
  const draws = read(DRAWS);
  assert.match(draws, /<ConsoleSectionNav/, 'draws use the shared section nav');
  assert.match(draws, /\{ id: "draws-vote", label: "순위 투표" \}/, 'vote jump target stays');
  assert.match(draws, /\{ id: "draws-programs", label: "무대 추첨" \}/, 'stage-draw jump target stays');
  assert.match(draws, /\{ id: "draws-roulette", label: "모바일 룰렛" \}/, 'roulette jump target stays');
  assert.match(draws, /\{ id: "draws-lucky", label: "럭키번호" \}/, 'lucky-number jump target stays');
});

test('unified-frame: theme status lives in header badges and save closes the editing column', () => {
  const theme = read(THEME);
  assert.match(theme, /badges=\{/, 'version summary rides the shared badges slot');
  assert.match(theme, /className=\{styles\.versionSummary\}/, 'domain pill styles stay');
  assert.match(theme, /className=\{styles\.statePill\}/, 'state pill stays');
  assert.match(theme, /<ConsoleSectionNav/, 'theme uses the shared section nav');
  assert.match(theme, /\{ id: "theme-edit", label: "편집" \}/, 'editing jump target stays');
  assert.match(theme, /\{ id: "theme-save", label: "저장·게시" \}/, 'save jump target closes the editing column');
  assert.match(theme, /\{ id: "home-preview-heading", label: "미리보기" \}/, 'preview jump target stays');
  assert.match(theme, /id="theme-edit"/, 'editing anchor wraps the controls column');
  assert.match(theme, /id="theme-save"/, 'save anchor wraps the relocated actions');
  assert.match(theme, /<ConsoleFormActions>/, 'save/publish close the editing unit uniformly');
  assert.match(theme, /onClick=\{\(\) => void saveDraft\(\)\}/, 'save selector and handler unchanged');
  assert.match(theme, /setPublishPending\(true\)/, 'publish asks before it runs');
  assert.match(theme, /confirmLabel="게시하기"/, 'publish confirms in place');
  assert.match(theme, /초안 저장/, 'save label unchanged');
  assert.doesNotMatch(theme, /styles\.actionRow/, 'bespoke top action row is gone');
  assert.doesNotMatch(theme, /styles\.actions[^A-Z]/, 'bespoke top action chrome is gone');
  const css = read('app/console/events/[id]/page/page.module.css');
  assert.doesNotMatch(css, /\.actionRow/, 'dead action-row chrome removed');
  assert.doesNotMatch(css, /\.actions[\s,{]/, 'dead action chrome removed');
  assert.match(css, /\.statePill/, 'pill styles retained');
});

test('unified-frame: theme keeps only locally changed leaves on newer drafts', () => {
  const theme = read(THEME);
  assert.match(theme, /HOME_STYLE_LABELS/, 'design leaves share one label source');
  assert.match(theme, /PAGE_FIELD_LABELS/, 'page leaves share one label source');
  assert.match(theme, /mergedHomeStyle/, 'latest draft carries only changed design leaves');
  assert.match(theme, /mergedPageFields/, 'latest draft carries only changed page leaves');
  assert.match(theme, /유지할 내 변경/, 'confirm names the kept leaves');
  assert.match(theme, /둘 다 바꾼 항목/, 'confirm and notice name same-leaf conflicts');
  assert.match(theme, /홈 디자인 미리보기/, 'preview names only what it shows');
  assert.match(theme, /행사 소개와 항목 노출은 게시 후 참가자 화면에서 확인하세요/, 'preview defers intro and visibility to publish');
});

test('unified-frame: programs pre-block writes for switched-off types', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /isTypeEnabled/, 'type gate mirrors the server 409');
  assert.match(programs, /!props\.featureOn/, 'card writes disable with the type off');
  assert.match(programs, /typeEnabled=\{isTypeEnabled\(draft\.type\)\}/, 'dialog tracks the selected type');
  assert.match(programs, /꺼져 있는 기능의 프로그램은 저장할 수 없습니다/, 'dialog submit rejects without a round trip');
  assert.match(programs, /이 유형은 꺼져 있습니다/, 'dialog names the reason with a settings link');
  assert.match(programs, /disabled=\{busy \|\| locked \|\| !typeEnabled\}/, 'dialog submit affordance locks with the type off');
});

test('unified-frame: draws stay clean on pristine views and explain run readiness', () => {
  const draws = read(DRAWS);
  assert.match(draws, /prize\.label\.trim\(\) !== "" \|\| prize\.quantity/, 'default empty prize rows are not edits');
  assert.match(draws, /className=\{styles\.programList\}/, 'run list exists');
  assert.ok(
    draws.indexOf('className={styles.programList}') < draws.indexOf('추첨 프로그램 만들기'),
    'run affordances precede the long create form'
  );
  assert.match(draws, /programFormRef\.current\?\.scrollIntoView/, 'editing scrolls to the relocated form');
  assert.match(draws, /runCountValid/, 'count validity derives once from the server range');
  assert.match(draws, /실행 전제: \{runBlockers\.join\(" · "\)\}/u, 'one line states every missing precondition');
  assert.match(draws, /!program\.published \? "결과 공개 필요"/u, 'unpublished programs name the missing precondition');
  assert.match(draws, /실행 인원 1~/, 'out-of-range counts name the valid range inline');
});

test('unified-frame: frozen reports render their own snapshot, never live data', () => {
  const reports = read(REPORTS);
  assert.match(reports, /capturedLabel/, 'snapshot stamps render compactly');
  assert.match(reports, /집계 기준/, 'captured time reads as the basis, apart from share stamps');
  assert.match(reports, /num\(group\.count\)/, 'frozen groups carry their counts');
  assert.match(reports, /snapshotPhotos/, 'frozen photos render as images');
  assert.match(reports, /\/files\/\$\{encodeURIComponent\(fileId\)\}/, 'frozen photos reuse the existing file route');
  assert.match(reports, /원본 파일을 확인할 수 없습니다/, 'missing frozen files read as unavailable');
  assert.match(reports, /조회 기준 시각/, 'live analysis stamps its own basis');
  assert.match(reports, /setLoadedAt\(new Date\(\)\.toISOString\(\)\)/, 'every successful load restamps the analysis');
  assert.match(reports, />\s*새로고침\s*</, 'analysis offers an explicit refresh');
});

test('unified-frame: dialogs keep dirty and unresolved dismissal gates', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /dialogUnresolvedRef = useRef\(false\)/);
  assert.match(programs, /if \(sendingRef\.current \|\| dialogBusy\) return false;/);
  assert.match(programs, /이미 저장되었을 수 있습니다\. 결과를 확인하지 않고 닫을까요\?/);
  assert.match(programs, /pendingBefore = pendingCommandsRef\.current\.size/);
  assert.match(programs, /dialogUnresolvedRef\.current = pendingCommandsRef\.current\.size > pendingBefore/);
  assert.match(programs, /if \(!dialogDirty\) return true;/);
  const reports = read(REPORTS);
  assert.match(reports, /submitGateRef: \{ current: boolean \}/);
  assert.match(reports, /unresolvedRef: \{ current: boolean \}/);
  assert.match(reports, /if \(submitGateRef\.current \|\| busy\) return false;/);
  assert.match(reports, /이미 저장되었을 수 있습니다\. 결과를 확인하지 않고 닫을까요\?/);
  assert.match(reports, /submitGateRef=\{sendingRef\}/);
  assert.match(reports, /unresolvedRef=\{dialogUnresolvedRef\}/);
  assert.match(reports, /if \(pristine\) return true;/);
});

test('unified-frame: printing emits only the chosen saved snapshot', () => {
  const reports = read(REPORTS);
  assert.match(reports, /articleRef = useRef<HTMLElement>\(null\)/);
  assert.match(reports, /<article ref=\{articleRef\} className=\{styles\.reportDoc\}>/);
  assert.match(reports, /cloneNode\(true\)/);
  assert.match(reports, /clone\.id = "eventouch-report-print"/);
  assert.match(reports, /classList\.add\("report-printing"\)/);
  assert.match(reports, /addEventListener\("afterprint"/);
  assert.match(reports, /removeEventListener\("afterprint"/);
  assert.match(reports, /getElementById\("eventouch-report-print"\)\?\.remove\(\)/);
  assert.match(reports, /classList\.remove\("report-printing"\)/);
  assert.match(reports, /onClick=\{printReport\}/);
  assert.doesNotMatch(reports, /onClick=\{\(\) => window\.print\(\)\}/);
});

test('unified-frame: engagement writes keep their command contracts', () => {
  const programs = read(PROGRAMS);
  for (const command of ['module.save', 'module.status', 'module.reveal', 'question.manage', 'photo.moderate', 'post.moderate', 'draw.run', 'draw.publish']) {
    assert.match(programs, new RegExp(command.replace('.', '\\.')), `programs keep ${command}`);
  }
  assert.match(programs, /"question\.manage", \{ id: question\.id, answer, approved \}/, 'Q&A saves preserve publication state');
  const draws = read(DRAWS);
  for (const command of ['team.save', 'draw.program.save', 'draw.program.run', 'vote.config.save', 'roulette.config.save', 'lucky.preassign', 'reward.assign']) {
    assert.match(draws, new RegExp(command.replace('.', '\\.')), `draws keep ${command}`);
  }
  const photos = read(PHOTOS);
  for (const command of ['evidence.photo.add', 'evidence.photo.move', 'evidence.photo.remove']) {
    assert.match(photos, new RegExp(command.replace('.', '\\.')), `photos keep ${command}`);
  }
  const reports = read(REPORTS);
  for (const command of ['report.create', 'report.update', 'report.publish', 'report.successor']) {
    assert.match(reports, new RegExp(command.replace('.', '\\.')), `reports keep ${command}`);
  }
  const theme = read(THEME);
  assert.match(theme, /attendee\.page\.save/, 'theme keeps the guarded save');
  assert.match(theme, /attendee\.page\.publish/, 'theme keeps the guarded publish');
});

test('engagement-growth: program cards aggregate results without new APIs or identities', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /<details className=\{styles\.resultDisclosure\}>/, 'result disclosure mounts collapsed by default');
  assert.match(programs, /<summary>결과 보기<\/summary>/, 'every card offers the result disclosure');
  assert.match(programs, /response\.answer === option/, 'poll/quiz tallies derive from loaded answers');
  assert.match(programs, /averageLabel\(ratings\)/, 'survey averages reuse the reports snapshot math');
  assert.match(programs, /미답변/, 'qa splits answered/unanswered counts');
  assert.match(programs, /승인 \{props\.photos\.filter/, 'photo disclosure counts approved/pending');
  assert.match(programs, /승인 \{props\.posts\.filter/, 'board disclosure counts approved/pending');
  assert.match(programs, /moduleResponses/, 'disclosure feeds from already-loaded workspace responses');
  assert.doesNotMatch(programs, /participantId/, 'no per-person identity leaks into the disclosure');
  assert.match(programs, /editLockReason\(module, props\.responses, props\.questions\)/, 'edit lock rules stay untouched');
});

test('engagement-growth: attendee preview switches between draft and published read-only', () => {
  const theme = read(THEME);
  assert.match(theme, /previewSource/, 'preview source state exists');
  assert.match(theme, /미리보기 기준/, 'switch is a labelled segmented group');
  assert.match(theme, /편집 중/, 'draft view stays available');
  assert.match(theme, /게시본/, 'published view is offered');
  assert.match(theme, /state\.publishedDesign\.homeStyle/, 'published view feeds the real landing from publishedDesign');
  assert.match(theme, /state\.publishedPageFields/, 'published view reads publishedPageFields without touching editor fields');
  assert.match(theme, /아직 게시된 화면이 없습니다/, 'empty published state is explained');
  assert.match(theme, /id="home-preview-heading"/, 'preview heading anchor stays');
  assert.match(theme, /390×700/, 'existing viewport sizes stay');
  assert.match(theme, /\n\s+preview\n/, 'landing stays in preview mode with menus disabled');
  assert.match(theme, /onClick=\{\(\) => void saveDraft\(\)\}/, 'save semantics stay');
  assert.match(theme, /onConfirm=\{\(\) => void confirmPublishDraft\(\)\}/, 'publish semantics stay');
  assert.match(theme, /expectedDraftVersion/, 'conflict semantics stay');
});

test('engagement-growth: long program and photo lists page incrementally', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /MODULE_PAGE_SIZE = 12/, 'programs reveal the first 12');
  assert.match(programs, /slice\(0, moduleLimit\)/, 'programs window the rendered list');
  // The remainder must count what the list actually shows (the list can be
  // filtered), so the button never promises rows that are not there.
  assert.match(programs, /더 보기 \(\{visibleModules\.length - moduleLimit\}\)/, 'programs grow with a remainder count');
  assert.match(programs, /등록된 프로그램이 없습니다/, 'programs empty state stays');
  const photos = read(PHOTOS);
  assert.match(photos, /PHOTO_PAGE_SIZE = 12/, 'photos reveal the first 12 of the section');
  assert.match(photos, /slice\(0, photoLimit\)/, 'photos window the current-section grid');
  assert.match(photos, /더 보기 \(\{selectedPhotos\.length - photoLimit\}\)/, 'photos grow with a remainder count');
  assert.match(photos, /이 구간에는 아직 등록된 사진이 없습니다/, 'photos empty state stays');
  assert.match(photos, /evidenceZipHref\(eventId, selectedSection\)/, 'section ZIP semantics stay');
  assert.doesNotMatch(programs, /virtual/, 'no virtualization library in programs');
  assert.doesNotMatch(photos, /virtual/, 'no virtualization library in photos');
});

test('engagement-growth: quiz results grade free-text answers against the stored answer', () => {
  const programs = read(PROGRAMS);
  // Poll branch is untouched: option tallies over loaded answers.
  assert.match(programs, /module\.type === "poll" \?/, 'poll keeps its own branch');
  assert.match(programs, /response\.answer === option/, 'poll tallies derive from loaded answers');
  // Quiz creation sends only the correct `answer` and the server accepts any
  // non-empty free-text response, so quizzes must not reuse the poll option
  // tally (which rendered 선택지가 없습니다).
  assert.match(programs, /module\.type === "quiz" \?/, 'quiz keeps its own branch');
  assert.match(programs, /quizGradeSummary\(module\.answer/, 'quiz grades against the stored correct answer');
  assert.match(programs, /quizAnswerGroups\(/, 'quiz aggregates identical text answers with counts');
  assert.match(programs, /정답 \$\{/, 'correct count renders as 정답 N');
  assert.match(programs, /오답 \$\{/, 'wrong count renders as 오답 M');
  assert.match(programs, /미채점 \$\{/, 'ungraded count renders as 미채점 K');
  assert.match(programs, /무응답/, 'blank quiz answers collapse to one 무응답 bucket');
  assert.match(programs, /moduleResponses\.map\(\(response\) => response\.answer\)/, 'quiz feeds from already-loaded responses only');
  assert.doesNotMatch(programs, /participantId/, 'no per-person identity leaks into the disclosure');
});

test('engagement-growth: creating a program reveals and focuses the new card', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /wasCreate = !draft\.id/, 'reveal applies to creates, not edits');
  assert.match(programs, /setModuleLimit\(Number\.MAX_SAFE_INTEGER\)/, 'create reveals the full list past the 12-row window');
  assert.match(programs, /receipt = await postCommand\("module\.save"/, 'create reads the new id from the save receipt');
  assert.match(programs, /createdFocusRef\.current =/, 'create parks a focus request for the new module');
  assert.match(programs, /__latest__/, 'a receipt without an id still lands on the appended last module');
  assert.match(programs, /id=\{`module-title-\$\{module\.id\}`\}/, 'card headings carry a stable focus target');
  assert.match(programs, /<h3 id=\{`module-title-/, 'heading focus target selector stays');
  assert.match(programs, /scrollIntoView\(\{ block: "nearest" \}\)/, 'create scrolls the new card into view');
  assert.match(programs, /slice\(0, moduleLimit\)/, 'server ordering stays windowed, never re-sorted');
  assert.match(programs, /onEdit=\{\(\) => openEdit\(module\)\}/, 'edit behavior stays wired per card');
});

test('engagement-growth: reveal buttons move focus to the first newly revealed record', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /revealMoreModules/, 'programs reveal through a named handler');
  assert.match(programs, /programRevealRef\.current = moduleLimit/, 'programs park the first newly revealed index before growing');
  assert.match(programs, /limit \+ MODULE_PAGE_SIZE/, 'programs keep the 12-row reveal count');
  assert.match(programs, /document\.getElementById\(`module-title-\$\{target\.id\}`\)/, 'programs focus the first newly revealed card heading');
  const photos = read(PHOTOS);
  assert.match(photos, /revealMorePhotos/, 'photos reveal through a named handler');
  assert.match(photos, /photoRevealRef\.current = photoLimit/, 'photos park the first newly revealed index before growing');
  assert.match(photos, /limit \+ PHOTO_PAGE_SIZE/, 'photos keep the 12-row reveal count');
  assert.match(photos, /id=\{`evidence-photo-\$\{photo\.id\}`\} tabIndex=\{-1\}/, 'photo rows are focusable targets themselves');
  assert.match(photos, /document\.getElementById\(`evidence-photo-\$\{target\.id\}`\)/, 'photos focus the first newly revealed row');
  for (const [file, source] of [[PROGRAMS, programs], [PHOTOS, photos]]) {
    assert.match(source, /\.focus\(\{ preventScroll: true \}\)/, `${file} focuses after scrolling without an extra announcement`);
  }
});
