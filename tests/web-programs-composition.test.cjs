'use strict';

// Reopened 2026-11-20 (디자인 시스템 적용): the filter row is the shared CountTabs, the row pill is the shared StatusPill,
// rows are hairline-divided, the review drawer uses CountTabs and ConsoleAvatar, empty results use ConsoleEmptyState and
// the stylesheet is tokens only (no px font sizes, hex or raw radii).
// Reopened 2026-11-20 (참여 이벤트): the programs screen is the home of every participation event. One list holds the
// modules (투표·퀴즈·Q&A·설문·참여 사진·게시판 and 간단 추첨) and the stage draws, 순위 투표, 룰렛 and 럭키번호 that used to
// live only on 추첨·투표. Each row carries a 4-segment life cycle (준비·진행·결과·경품) and a status pill; the four
// status cards became count tabs; the amber review queue is a slim row; 이벤트 만들기 opens a template chooser; an
// opened event shows a 5-step header. Reopened 2026-11-19: a four-card status strip (진행 중·준비 중·종료·받은 응답, big counts) tops the
// list, the review doorway is an amber card, group titles carry counts and the status tabs are a segmented
// control. The ledger itself and the single orange action are unchanged.
// Approved programs composition (2026-11-14): a flat ledger grouped by run
// state with type tiles, one amber doorway to a modal review drawer, and the
// merged answer card. Change it only on a new owner decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/programs');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('ProgramsWorkspace.tsx');
const drawer = read('ReviewDrawer.tsx');
const icons = read('ProgramIcons.tsx');
const css = read('programs.module.css');
const dialog = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/console-ui/ConsoleDialog.tsx'), 'utf8');

test('approved programs design stays locked: ledger rows grouped by run state, one orange action', () => {
  assert.match(workspace, /\{ key: "OPEN", label: "진행 중" \},\s*\{ key: "DRAFT", label: "준비 중" \},\s*\{ key: "CLOSED", label: "종료" \}/u, 'rows group as 진행 중 / 준비 중 / 종료');
  assert.match(workspace, /<ProgramTypeIcon type=\{module\.type\} state=\{state\} \/>/u, 'each row opens with its type tile and state dot');
  assert.match(workspace, /className=\{styles\.moduleSummary\}/u);
  assert.ok((workspace.slice(0, workspace.indexOf('function ModuleDialog')).match(/variant="primary"/gu) || []).length === 1, 'the page has exactly one orange action: 이벤트 만들기 (the create dialog keeps its own submit)');
  assert.match(workspace, /이벤트 만들기/u);
  assert.doesNotMatch(workspace, /styles\.typeBadge|styles\.status\b|statusOpen|statusDraft|workspacePurpose/u, 'type and state pills and the purpose paragraph stay gone');
  assert.match(workspace, /className=\{styles\.rowAction\}/u, '시작 / 다시 열기 sit at the row end, 종료 inside the expanded row');
  assert.match(workspace, /onClick=\{\(\) => props\.onRequestStatus\("CLOSED"\)\}>종료</u);
  assert.match(css, /\.moduleCard \+ \.moduleCard\s*\{[^}]*border-top:\s*1px solid var\(--line\)/su, 'Reopened 2026-11-20: C1 rows are divided by a hairline');
});

test('reopened 2026-11-20: count tabs replace the status cards, the review queue is a slim amber row', () => {
  assert.match(workspace, /<CountTabs\s+ariaLabel="진행 상태별 보기"/u, 'the shared count tabs top the list');
  assert.ok(!fs.existsSync(path.join(DIR, 'StatusTabs.tsx')), 'the local StatusTabs is replaced by console-ui CountTabs');
  assert.doesNotMatch(workspace, /styles\.statStrip|styles\.statCard|콘텐츠 현황/u, 'the four big status cards are gone');
  assert.doesNotMatch(css, /\.statStrip|\.statCard/u);
  const countTabs = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/console-ui/CountTabs.tsx'), 'utf8');
  // Reopened 2026-11-20 (shared gaps): the pressed state is `aria-pressed` in the (default) filter mode.
  assert.match(countTabs, /: \{ "aria-pressed": selected \}/u);
  assert.match(countTabs, /item\.count/u, 'every tab carries its count badge');
  assert.match(workspace, /styles\.groupCount/u);
  assert.match(css, /\.reviewLine\s*\{[^}]*min-height:\s*48px/su, 'the review doorway is a slim row, not a card');
  assert.match(css, /\.reviewLine\s*\{[^}]*background:\s*var\(--warning-soft\)/su);
  assert.match(workspace, /<span>검토할 것 \{reviewTotal\}<small>/u);
});

test('reopened 2026-11-20: one list for modules and draw events, each row a life cycle and a status pill', () => {
  const lifecycle = read('EventLifecycle.tsx');
  const drawRow = read('DrawEventRow.tsx');
  assert.match(workspace, /import \{ drawEventsSnapshot, eventPill, lifecycleSegments, lifecycleSteps/u, 'rows derive their life cycle from lib/participation-events');
  assert.match(workspace, /drawEvents: drawEventsSnapshot\(workspace\)/u, 'draw items come from the same bootstrap read, no new request');
  assert.match(workspace, /<LifecycleMeter segments=\{lifecycleSegments\(facts\)\} \/>/u, 'a module row shows the 4-segment meter');
  assert.match(workspace, /<StatusPill tone=\{eventPillTone\(pill\.tone\)\}/u, 'the row pill is the shared StatusPill');
  assert.match(workspace, /<DrawEventRow/u, 'stage draws, 순위 투표, 룰렛 and 럭키번호 are rows of the same list');
  assert.match(drawRow, /<LifecycleMeter/u);
  assert.match(drawRow, /<EventStepper/u, 'an opened draw item shows the same 5-step header');
  assert.match(drawRow, /무대에서 진행·당첨 보기/u, 'running and winners stay on the draws stage, one click from the event');
  assert.match(drawRow, /\/draws\$\{event\.hash\}/u, 'the stage keeps its #draw-program-<id> / #draws-vote hash handoff');
  assert.match(lifecycle, /aria-label="이벤트 진행 단계"/u);
  assert.match(lifecycle, /aria-label="이벤트 5단계"/u);
  assert.match(lifecycle, /aria-current=\{step\.state === "current" \? "step" : undefined\}/u, 'the current step is announced');
  assert.match(lifecycle, /rewardsHref/u, 'the reward step links to 경품 지급');
  assert.match(workspace, /<EventStepper steps=\{lifecycleSteps\(facts\)\}/u, 'an opened module shows the 5-step header above its existing editors and results');
  assert.match(css, /\.lifeMeter li\[data-state="na"\] i/u, 'a type with no reward path is drawn as not applicable, never an empty reward step');
  assert.match(lifecycle, /review: "wait"/u, '검토 N is the amber (wait) pill');
  assert.match(lifecycle, /live: "ok"/u, '진행 중 is the green pill');
});

test('reopened 2026-11-20: 이벤트 만들기 is a template chooser over the existing create flows', () => {
  const chooser = read('TemplateChooser.tsx');
  assert.match(workspace, /<TemplateChooser/u);
  assert.match(workspace, /function openCreateOfType\(type: string\)[\s\S]*?setDraft\(\{ \.\.\.EMPTY_DRAFT, type \}\)/u, 'a module tile opens the existing create dialog with the type preselected');
  assert.match(chooser, /TEMPLATE_GROUPS\.map/u);
  assert.match(chooser, /closeHref\(`\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/draws/u, 'draw tiles open the draws screen settings (룰렛·럭키번호·순위 투표·무대 추첨)');
  assert.match(chooser, /기획안 게임은 템플릿으로 추가됩니다/u);
  assert.doesNotMatch(chooser, /스탬프|빙고/u, 'unbuilt game types get no tile');
  assert.match(css, /\.templateGroup ul\s*\{[^}]*grid-template-columns/su);
});

test('review drawer: one doorway, modal presentation, same handlers as the lists', () => {
  assert.match(workspace, /aria-haspopup="dialog"/u);
  assert.match(workspace, /<ReviewDrawer/u);
  assert.match(drawer, /presentation="drawer"/u);
  assert.match(dialog, /presentation\?: "modal" \| "inspector" \| "drawer"/u);
  assert.match(drawer, /onManage\(question, true\)/u, 'answer-and-publish reuses manageQuestion');
  assert.match(drawer, /onManage\(question, false\)/u, '답변만 저장 reuses manageQuestion');
  assert.match(drawer, /onRequestPhoto\(photo, "APPROVED"\)/u);
  assert.match(drawer, /<ConsoleConfirm/u, 'photo and post decisions keep their confirmation');
  assert.match(drawer, /onOpenEdit\(question\)/u, 'a pending question edit is decided in the content list, where conflict recovery lives');
  assert.match(workspace, /if \(recoveryActive\) setDrawerOpen\(false\)/u, 'recovery banners are never left behind the scrim');
  assert.match(drawer, /id=\{`review-(question|photo|post)-\$\{/u, 'drawer ids never duplicate the list ids');
});

test('answer card: asker, bubble, one reply field, one send, quiet save, no nested borders', () => {
  assert.match(drawer, /styles\.asker/u);
  assert.match(drawer, /styles\.bubble/u);
  assert.match(drawer, /styles\.replyField/u);
  assert.match(drawer, /aria-label=\{question\.approved \? "답변 저장" : "답변하고 공개"\}/u, 'the icon-only send is named for what it does');
  assert.match(drawer, /답변만 저장/u);
  assert.match(drawer, /document\.getElementById\(`review-answer-\$\{openId\}`\)\?\.focus\(\)/u, 'opening lands the cursor in the reply field');
  assert.match(css, /\.sendButton\.sendButton\s*\{[^}]*background:\s*var\(--ink\)/su, 'the send circle is ink, not orange');
  assert.doesNotMatch(drawer, /반려<\/ProductButton>[\s\S]{0,120}onManage/u, 'questions have no reject action; only edits do');
});

test('type tiles use tokens, a stroke family and an accessible text label elsewhere', () => {
  for (const type of ['poll', 'quiz', 'qa', 'survey', 'draw', 'photo', 'board']) {
    assert.match(icons, new RegExp(`case "${type}"`, 'u'), `${type} has its own glyph`);
    assert.match(css, new RegExp(`typeTile\\[data-type="${type}"\\]`, 'u'), `${type} has its own tint`);
  }
  assert.match(icons, /aria-hidden="true"/u, 'tiles are decorative; the row text names type and state');
  assert.doesNotMatch(css, /#[0-9A-Fa-f]{3,8}\b/u, 'programs CSS uses tokens, never hex');
  assert.doesNotMatch(css, /font-size:\s*[\d.]+px|font-weight:\s*(?:5|6|7)\d\d/u, 'Reopened 2026-11-20: sizes and weights come from the type tokens (400/600/800)');
  assert.match(workspace, /<span className="sr-only"> · \{statusLabel\(module\)\}<\/span>/u, 'state is also read aloud');
});

test('targets stay 44px and phone rows keep one line each', () => {
  assert.match(css, /\.moduleSummary\s*\{[^}]*min-height:\s*72px/su);
  // Reopened 2026-11-20 (shared gaps): the 44px action floor is the one shared `.product-action` rule (product-ui.css);
  // per-screen `min-height: 44px` repeats were no-ops and are gone.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'product-ui.css'), 'utf8'), /\.product-action \{[^}]*min-block-size: var\(--control-min-size\)/su, 'every action keeps a 44px target');
  assert.doesNotMatch(css, /\.drawerItem :global\(\.product-action\)/u, 'no local repeat of the 44px floor');
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.moduleSummary > :nth-child\(4\)\s*\{\s*display:\s*none/u, 'the count column folds away on phones; the pill and the meter keep their own rows');
  assert.match(css, /\.templateTile\.templateTile\s*\{[^}]*min-height:\s*72px/su, 'template tiles are large touch targets');
});

test('the manual-grading fold keeps a 44px touch target like the other disclosures', () => {
  assert.match(css, /\.resultDisclosure > summary,\s*\.rejectDisclosure > summary \{[^}]*min-height:\s*44px/su);
});

test('reopened 2026-11-20: the 경품 지급 link is plain because closeHref only accepts event-close destinations', () => {
  const drawRow = read('DrawEventRow.tsx');
  assert.doesNotMatch(workspace + drawRow, /closeHref\([^)]*\/rewards/u, 'closeHref throws on /rewards while a close handoff is active (the whole screen would fail)');
  assert.match(drawRow, /const rewardsHref = `\$\{base\}\/rewards`/u);
});
