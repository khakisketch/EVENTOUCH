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
  assert.match(programs, /headerActions=\{/, 'programs create/refresh ride the page header actions');
  // Reopened 2026-11-20: 이벤트 만들기 opens the template chooser; the type tile then opens the existing create dialog.
  assert.match(programs, /variant="primary" aria-haspopup="dialog" onClick=\{\(\) => setTemplateOpen\(true\)\}/, "programs create is the single orange action");
  assert.match(programs, />\s*이벤트 만들기\s*</, "programs keeps the standard create action");
  const reports = read(REPORTS);
  // The task-first redesign puts create alongside its report list instead of
  // in a separate toolbar, while retaining its real permission gate.
  const reportList = reports.slice(reports.indexOf('headingId="reports-list"'), reports.indexOf('</ConsoleSection>', reports.indexOf('headingId="reports-list"')));
  assert.match(reportList, /action=\{\(/, 'reports create rides the list header action');
  assert.match(reportList, /disabled=\{writeLocked \|\| !reportSourcesAvailable\}/, 'reports create keeps the write gate and requires available sources');
  assert.match(reportList, /onClick=\{openReportCreate\}/, 'reports create opens the existing form');
  assert.match(reportList, />\s*보고서 만들기\s*</, 'reports keeps the standard create action');
  for (const file of ALL) {
    assert.match(read(file), /<ConsoleFeedback kind=/, `${file} reports through shared feedback`);
  }
  const theme = read(THEME);
  assert.match(theme, /<ConsoleFeedback kind="error">\{failure\.message\}<\/ConsoleFeedback>/, 'theme surfaces failures in the frame');
  assert.match(theme, /<ConsoleFeedback kind="success">\{notice\}<\/ConsoleFeedback>/, 'theme surfaces notices in the frame');
});

test('unified-frame: domain sections keep their identities, duplicate menu titles are gone', () => {
  const draws = read(DRAWS);
  for (const key of ['vote', 'roulette', 'lucky']) {
    assert.match(draws, new RegExp(`\`draws-\\$\\{kind\\}\``), `draws retains the ${key} anchor`);
  }
  assert.match(draws, /`draw-program-\$\{program\.id\}`/, 'every draw program keeps its anchor');
  const photos = read(PHOTOS);
  for (const id of ['evidence-photo-sections', 'evidence-photo-archive']) {
    assert.match(photos, new RegExp(`id="${id}"`), `photos retains ${id}`);
  }
  const reports = read(REPORTS);
  // 2026-11-15 redesign: 결과 분석·보고서 내용 are no longer their own
  // ConsoleSection/tab — both render inside the always-visible 보고서 panel
  // (headingId="reports-list"), so their identity now lives on a plain id
  // (the rail analysis box, the frozen article) instead of a second heading.
  assert.match(reports, /headingId="reports-list"/, 'reports retains reports-list');
  assert.match(reports, /id="reports-analysis" data-workspace-section="reports-analysis"/, 'reports retains reports-analysis');
  assert.match(reports, /<article ref=\{articleRef\} id="report-detail"/, 'reports retains report-detail');
  const programs = read(PROGRAMS);
  assert.doesNotMatch(programs, /headingId="program-module-list"/, 'programs drops the menu-duplicate body title');
  assert.match(programs, /className=\{styles\.moduleList\}/, 'programs keeps the module collection body');
  const theme = read(THEME);
  for (const heading of ['레이아웃', '배경']) {
    assert.match(theme, new RegExp(`<h2 id="studio-[a-z]+" className=\\{studio\\.sectionTitle\\}>${heading}`), `theme names the ${heading} group`);
  }
  for (const legend of ['배너', '제목과 문구', '소개와 공개 범위']) {
    assert.match(theme, new RegExp(`<legend className="sr-only">${legend}</legend>`), `theme retains the ${legend} panel group`);
  }
});

test('unified-frame: reports navigate through the shared nav, selected report stays addressable', () => {
  const reports = read(REPORTS);
  assert.match(reports, /<ConsoleSectionNav/, 'reports use the shared section nav');
  // 2026-11-15 redesign: 결과 분석 and 보고서 내용 are no longer separate
  // tabs an operator must click through — both render inside the one
  // always-visible 보고서 panel, so the shared nav keeps only the two real
  // destinations. The selected report keeps its own address via
  // reportFragment/#report-<id> (pinned by web-reports-archive-checklist).
  assert.match(reports, /items=\{\[\s*\{ id: "event-close", label: "행사 마감" \},\s*\{ id: "reports-list", label: "보고서", fragment: detail \? reportFragment\(detail\.id\) : "reports-list" \},\s*\]\}/, 'section nav keeps exactly the two destinations, the open report still addressable through the 보고서 tab fragment');
  assert.match(reports, /reportFragment\(id\)/, 'a selected report still gets its own fragment');
  // The saved-report switcher (ink-underline tabs) carries the same shared
  // published/draft state the old record row did.
  assert.match(reports, /role="tablist" aria-label="보고서 선택"/, 'reports pick a saved version through a tab switcher');
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
  // The title lives in HomeHero (shared by the landing and the event guide).
  const landing = read('app/event/[slug]/home/AttendeeHomeLanding.tsx');
  const hero = read('app/event/[slug]/home/HomeHero.tsx');
  assert.match(hero, /const Title = preview \? "h3" : "h1";/, 'heading level follows preview semantics');
  assert.match(hero, /<Title className=\{L\.title\}>\{title\}<\/Title>/, 'same title class and visual styles in both modes');
  assert.match(landing, /<HomeHero\b[^>]*preview=\{preview\}/u, 'the landing passes its preview mode to the banner');
  assert.doesNotMatch(landing + hero, /<h1[\s>]/, 'no literal h1 remains in the shared landing');
  assert.doesNotMatch(landing + hero, /<section[^>]*aria-hidden/, 'preview section stays exposed to assistive technology');
  assert.doesNotMatch(landing + hero, /<Title[^>]*aria-hidden/, 'preview title stays exposed to assistive technology');
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
  assert.match(programs, /delete next\[payload\.id\]/, 'saved answers release their draft entries');
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
  assert.match(theme, /type PendingIntent = \{ commandId: string; fingerprint: string; uncertain: boolean \}/, 'intents bind id, payload and uncertainty');
  assert.match(theme, /pendingSaveRef = useRef<PendingIntent \| null>/, 'save intents persist across retries');
  assert.match(theme, /pendingPublishRef = useRef<PendingIntent \| null>/, 'publish intents persist across retries');
  assert.match(theme, /pending\.fingerprint === fingerprint \? pending\.commandId : randomCommandId\(\)/, 'unchanged retries reuse the id, edits mint a new one');
  assert.match(theme, /submittedForm = state\.form/, 'save captures the submitted design');
  assert.match(theme, /submittedPageFields = state\.pageFields/, 'save captures the submitted fields');
  assert.match(theme, /formSettled/, 'success adopts server values only where local input is settled');
  assert.match(theme, /fieldsSettled/, 'success preserves newer local fields against the advanced baseline');
  assert.match(theme, /attempt\.uncertain \|\| isUncertainStatus\(response\.status\)/, 'a later rejection cannot discard an earlier uncertain request');
  assert.match(theme, /status >= 500 \|\| \[408, 425, 429\]\.includes\(status\)/, 'timeouts and temporary limits remain uncertain');
  assert.match(theme, /confirmsAttendeePageCommand\("attendee\.page\.save", payload, body\)/, 'the saved draft is checked against its original payload');
  assert.match(theme, /expectedDraftVersion: state\.draftVersion/, 'save still guards on the draft version');
  assert.match(theme, /payload = \{ expectedDraftVersion: state\.draftVersion, expectedDestinations: \{ slug: state\.slug, public: isPublicEventStage\(state\.eventStage\) \} \}/, 'publish binds both the draft version and reviewed destination');
  assert.match(theme, /body\?\.code === "PAGE_PUBLICATION_CONTEXT_CHANGED"/, 'a proven destination conflict requires a fresh review');
  assert.match(theme, /attempt\.uncertain && !reviewedConflict/, 'only a proven locked guard can resolve a previously uncertain publish');
  assert.match(theme, /publishedPageFields,/, 'publish refreshes the published field baseline from the receipt');
});

test('unified-frame: ambiguous draw responses keep their receipts for safe retry', () => {
  const draws = read(DRAWS);
  assert.match(draws, /pending\.uncertain \|\| response\.status >= 500 \|\| \[408, 425, 429\]\.includes\(response\.status\)/, '408, 5xx and a prior uncertain response keep the bound id');
  assert.match(draws, /if \(!ambiguous\) pendingCommands\.current\.delete\(attempt\)/, 'only a definitive response can discard the id');
  assert.match(draws, /drawIntent\(program, count, toStage\)/, 'repeated runs bind winner-count intent');
});

test('unified-frame: draws jumps its four long sections through the shared nav', () => {
  const draws = read(DRAWS);
  assert.doesNotMatch(draws, /<ConsoleSectionNav/, 'draws left the jump nav for a stage picker');
  for (const key of ['"vote"', '"roulette"', '"lucky"']) {
    assert.ok(draws.includes(`key: ${key}`), `${key} stays selectable in the picker`);
  }
  assert.match(draws, /key: `program:\$\{item\.id\}`/, 'every stage draw is selectable');
});

test('unified-frame: theme status lives in header badges and save closes the editing column', () => {
  const theme = read(THEME);
  assert.match(theme, /badges=\{/, 'version summary rides the shared badges slot');
  assert.match(theme, /className=\{styles\.versionSummary\}/, 'domain pill styles stay');
  assert.match(theme, /className=\{styles\.statePill\}/, 'state pill stays');
  assert.doesNotMatch(theme, /<ConsoleSectionNav/, 'the studio left the section nav for settings rows');
  assert.match(theme, /id="theme-edit"/, 'editing anchor wraps the controls column');
  assert.match(theme, /id="theme-save"/, 'save anchor wraps the relocated actions');
  assert.match(theme, /<ConsoleFormActions>/, 'save/publish close the editing unit uniformly');
  assert.match(theme, /onClick=\{\(\) => void saveDraft\(\)\}/, 'save selector and handler unchanged');
  assert.match(theme, /setPublishPending\(true\)/, 'publish asks before it runs');
  assert.match(theme, /<PublicationReview/, 'publish uses the shared explicit review');
  assert.match(theme, /onConfirm=\{\(\) => void confirmPublishDraft\(\)\}/, 'confirmation keeps the guarded publish handler');
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
  assert.match(theme, /행사 안내의 소개·강조색·일정·장소·프로그램은 안내 화면에서 확인하세요/, 'preview names the event-page fields it does not render');
  assert.match(theme, /showingPublished \? state\.publishedPageFields\.showAnnouncements : state\.pageFields\.showAnnouncements/, 'preview uses selected draft or published announcement visibility');
});

test('unified-frame: programs pre-block writes for switched-off types', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /isTypeEnabled/, 'type gate mirrors the server 409');
  assert.match(programs, /!props\.featureOn/, 'card writes disable with the type off');
  assert.match(programs, /typeEnabled=\{isTypeEnabled\(draft\.type\)\}/, 'dialog tracks the selected type');
  assert.match(programs, /꺼져 있는 기능의 콘텐츠는 저장할 수 없습니다/, 'dialog submit rejects without a round trip');
  assert.match(programs, /이 유형은 꺼져 있습니다/, 'dialog names the reason with a settings link');
  assert.match(programs, /disabled=\{busy \|\| locked \|\| !typeEnabled\}/, 'dialog submit affordance locks with the type off');
});

test('unified-frame: draws stay clean on pristine views and explain run readiness', () => {
  const draws = read(DRAWS);
  assert.match(draws, /prize\.label\.trim\(\) !== "" \|\| prize\.quantity/, 'default empty prize rows are not edits');
  assert.match(draws, /className=\{styles\.picker\}/, 'the stage picker exists');
  assert.ok(
    draws.indexOf('className={styles.runRow}') < draws.indexOf('<ConsoleDialog title={editingProgramId'),
    'run affordances precede the create/edit dialog'
  );
  assert.match(draws, /titleId="draws-program-dialog-title"/, 'program settings open in a dialog');
  assert.match(draws, /runCountValid/, 'count validity derives once from the server range');
  assert.match(draws, /실행 전제: \{runBlockers\.join\(" · "\)\}/u, 'one line states every missing precondition');
  assert.match(draws, /!program\.published \? "결과 공개 필요"/u, 'unpublished programs name the missing precondition');
  assert.match(draws, /실행 인원 1~/, 'out-of-range counts name the valid range inline');
});

test('unified-frame: frozen reports render their own snapshot, never live data', () => {
  const reports = read(REPORTS);
  assert.match(reports, /capturedLabel/, 'snapshot stamps render compactly');
  assert.match(reports, /집계 기준/, 'captured time reads as the basis, apart from share stamps');
  assert.match(reports, /savedGroups = snapshotRecords\(detail\?\.snapshot\?\.groups\)/, 'groups come from the frozen report');
  assert.match(reports, /snapshotValue\(group\.count, "명"\)/, 'saved counts remain visible without inventing zero for invalid data');
  assert.match(reports, /snapshotPhotos/, 'frozen photos render as images');
  assert.match(reports, /\/files\/\$\{encodeURIComponent\(fileId\)\}/, 'frozen photos reuse the existing file route');
  assert.match(reports, /원본 파일을 확인할 수 없습니다/, 'missing frozen files read as unavailable');
  assert.match(reports, /조회 기준 시각/, 'live analysis stamps its own basis');
  assert.match(reports, /setLoadedAt\(new Date\(\)\.toISOString\(\)\)/, 'every successful load restamps the analysis');
  // 2026-11-10: 동일한 새로고침 버튼의 접근 이름을 화면에 맞게 구체화했다(시각 변화 없음).
  assert.match(reports, /<ConsoleRefreshButton label="결과 분석 새로고침"/, 'analysis offers an explicit refresh');
});

test('unified-frame: dialogs keep dirty and unresolved dismissal gates', () => {
  const programs = read(PROGRAMS);
  assert.match(programs, /dialogUnresolvedRef = useRef\(false\)/);
  assert.match(programs, /if \(sendingRef\.current \|\| dialogBusy\) return false;/);
  assert.match(programs, /이미 저장되었을 수 있습니다\. 결과를 확인하지 않고 닫을까요\?/);
  assert.match(programs, /pendingCommandsRef\.current\.get\(JSON\.stringify\(\[eventId, "module\.save", payload\]\)\)/, 'the original save key remains addressable');
  assert.match(programs, /moduleSaveRetryRef\.current = pending/);
  assert.match(programs, /dialogUnresolvedRef\.current = true/);
  assert.match(programs, /confirmsModuleSave\(payload, data\)/);
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
  assert.match(reports, /<article ref=\{articleRef\} id="report-detail"\s*\n\s*className=\{`\$\{styles\.reportDoc\}/);
  assert.match(reports, /data-layout=\{printLayout\}/);
  assert.match(reports, /cloneNode\(true\)/);
  assert.match(reports, /clone\.id = "eventouch-report-print"/);
  assert.match(reports, /classList\.add\("report-printing"\)/);
  assert.match(reports, /addEventListener\("afterprint"/);
  assert.match(reports, /removeEventListener\("afterprint"/);
  assert.match(reports, /getElementById\("eventouch-report-print"\)\?\.remove\(\)/);
  assert.match(reports, /classList\.remove\("report-printing"\)/);
  assert.match(reports, /onClick=\{\(\) => void printReport\(detail\)\}/);
  assert.doesNotMatch(reports, /onClick=\{\(\) => window\.print\(\)\}/);
});

test('unified-frame: engagement writes keep their command contracts', () => {
  const programs = read(PROGRAMS);
  for (const command of ['module.save', 'module.status', 'module.reveal', 'question.manage', 'photo.moderate', 'post.moderate', 'draw.run', 'draw.publish']) {
    assert.match(programs, new RegExp(command.replace('.', '\\.')), `programs keep ${command}`);
  }
  assert.match(programs, /answerBaselines\[question\.id\] \?\? questionBaseline\(question\)/, 'Q&A uses the original draft baseline');
  assert.match(programs, /payload: \{ id: question\.id, answer, approved, expectedText: baseline\.text, expectedQuestion: baseline \}/, 'Q&A freezes the reviewed question, answer and publication state');
  assert.match(programs, /postCommand\("question\.manage", payload, Boolean\(held\)\)/, 'Q&A recovery reuses the frozen request');
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
  assert.match(programs, /<details className=\{styles\.moduleDetails\}>/, 'each row mounts collapsed by default');
  assert.match(programs, /<section className=\{styles\.resultSection\} aria-label="결과">/, 'results show inline in the expanded row, with no second fold');
  assert.doesNotMatch(programs, /resultDisclosure/, 'the nested 결과 보기 fold stays gone');
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
  assert.match(programs, /첫 이벤트를 만들어 보세요/, "programs empty state stays (template tiles inline)");
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
  assert.match(programs, /<h3 id=\{`module-title-/, 'module headings sit under the group h2 without skipping a level; focus target stays');
  assert.match(programs, /scrollIntoView\(\{ block: "nearest" \}\)/, 'create scrolls the new card into view');
  assert.match(programs, /ordered\.slice\(0, moduleLimit\)/, 'rows read in running order (진행 중, 준비 중, 종료), stable inside each group, then windowed');
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
  const gallery = read(PHOTOS.replace('EvidencePhotosWorkspace.tsx', 'EvidenceGallery.tsx'));
  assert.match(gallery, /id=\{`evidence-photo-\$\{cell\.id\}`\} tabIndex=\{-1\}/, 'photo cells are focusable targets themselves');
  assert.match(photos, /document\.getElementById\(`evidence-photo-\$\{target\.id\}`\)/, 'photos focus the first newly revealed row');
  for (const [file, source] of [[PROGRAMS, programs], [PHOTOS, photos]]) {
    assert.match(source, /\.focus\(\{ preventScroll: true \}\)/, `${file} focuses after scrolling without an extra announcement`);
  }
});
