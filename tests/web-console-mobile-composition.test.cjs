'use strict';

// Mobile composition: deliberate control rows on narrow screens. The old
// layout passed its overflow checks while still shipping a squeezed search
// beside an unrelated checkbox and a view switch competing with the primary
// create action, so these tests pin the structure itself: search-first full
// rows, a section-header view switch, a full-width primary, and shared
// primitives with no position-based heuristics.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('shared toolbar has no first-child-is-search heuristic', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  assert.doesNotMatch(css, /\.toolbarFilters\s*>\s*:first-child/u);
  // Equal-weight wrapping plus an explicit opt-in row span.
  assert.match(css, /\.toolbarFilters\s*>\s*\*\s*\{[^}]*flex:\s*1\s+1\s+200px/su);
  assert.match(css, /\[data-toolbar-span="full"\]\s*\{[^}]*flex-basis:\s*100%/su);
  const toolbar = read('app/console/console-ui/ConsoleToolbar.tsx');
  assert.match(toolbar, /data-toolbar-span="full"/u);
  assert.match(toolbar, /data-toolbar-inline/u);
});

test('shared toolbar actions share one baseline and stack full-width on phones', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  assert.match(css, /\.toolbarActions\s*>\s*\*\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.toolbarActions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.doesNotMatch(css, /\.toolbarActions\s*>\s*:global\(\.button\)\s*\{[^}]*flex:\s*1\s+1\s+140px/su);
});

test('home filters read search first, then stage, then approval', () => {
  const home = read('app/console/ConsoleHome.tsx');
  const order = ['styles.homeSearch', 'styles.homeStage', 'styles.homeWork'].map((token) => {
    const position = home.indexOf(token);
    assert.ok(position >= 0, `${token} is rendered`);
    return position;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'search owns the first filter row');
  assert.match(home, /className=\{styles\.homeFilters\}\s+data-toolbar-span="full"/u);
  // Concise visible placeholder with the full query scope kept accessible.
  assert.match(home, /placeholder="행사 검색"/u);
  assert.match(home, /aria-label="행사명·고객사·장소 검색"/u);
  // Filter capabilities survive: per-stage counts stay in the options and
  // the approval toggle keeps its live queue count.
  assert.match(home, /\{item\.label\} \(\{[^{}]*counts\[item\.id\][^{}]*\}\)/u);
  assert.match(home, /aria-label=\{`승인 대기 있는 행사만 보기 \(\$\{pendingQueueCount\}건\)`\}/u);
  assert.match(home, /승인 대기만 \(\{[^{}]*pendingQueueCount[^{}]*\}\)/u);
});

test('home view switch is a section supplement, create is the lone toolbar action', () => {
  const home = read('app/console/ConsoleHome.tsx');
  assert.match(home, /action=\{viewSwitch\}/u);
  assert.match(home, /description=\{directoryDescription\}/u);
  const actionsStart = home.indexOf('actions={', home.indexOf('<ConsoleToolbar'));
  const toolbarEnd = home.indexOf('/>', actionsStart);
  assert.ok(actionsStart >= 0 && toolbarEnd > actionsStart, 'toolbar actions block is found');
  const toolbarActions = home.slice(actionsStart, toolbarEnd);
  assert.doesNotMatch(toolbarActions, /viewSwitch|viewButton/u);
  assert.match(toolbarActions, /button-primary/u);
  assert.match(toolbarActions, /새 행사 만들기/u);
  const homeCss = read('app/console/console-home.module.css');
  assert.doesNotMatch(homeCss, /\.createTrigger\s*\{[^}]*align-self:\s*end/su);
});

test('home keeps its heading contract while the count row only appears when narrowing', () => {
  const home = read('app/console/ConsoleHome.tsx');
  assert.match(home, /headingId="console-event-directory" title="행사 목록"/u);
  assert.match(home, /검색 결과 \$\{visibleEvents\.length\}개 \/ 전체 \$\{state\.events\.length\}개/u);
  assert.match(home, /\{hasNarrowing && visibleEvents\.length > 0 \? \(\s*<div className=\{styles\.resultsMeta\}>/su);
  // Approval triage keeps its direct queue link, never nested in the card link.
  assert.match(home, /participants\?status=PENDING/u);
  assert.match(home, /aria-label=\{`\$\{event\.name\} 승인 대기 \$\{event\.pending\}명 처리`\}/u);
  // URL filter semantics are untouched: same params, same replaceState sync.
  for (const param of ['"q"', '"stage"', '"needsWork"', '"view"', '"date"', '"month"']) {
    assert.ok(home.includes(`params.set(${param}`) || home.includes(`params.get(${param}`), `${param} sync stays`);
  }
});

test('event directory cards show identity, not permanent participant KPIs', () => {
  const home = read('app/console/ConsoleHome.tsx');
  const card = home.slice(home.indexOf('function EventCard('), home.indexOf('export default function ConsoleHome'));
  assert.doesNotMatch(card, /등록 인원|현재 입장|<dl|eventMetrics|metricNumber/u);
  assert.match(card, /\{event\.pending > 0 \? \(\s*<div className=\{styles\.eventCardActions\}>/su);
  assert.match(card, /<Link\s*className=\{styles\.approvalLink\}/su);
  assert.match(card, /승인 대기 \{event\.pending\}명 처리/u);
  assert.match(card, /participants\?status=PENDING/u);
  assert.ok(card.indexOf('</Link>') < card.indexOf('className={styles.approvalLink}'), 'queue is not nested in overview link');
  // A2: no per-card duplicate and no always-empty footer. Duplication lives
  // in the create dialog's source select; the actions row only renders for
  // a real pending queue.
  assert.doesNotMatch(card, /onDuplicate|복제/u, 'no per-card duplicate control');
  assert.doesNotMatch(card, /styles\.eventCardAction[^s]/u, 'duplicate styling does not linger');
  assert.match(card, /\{event\.pending > 0 \? \(\s*<div className=\{styles\.eventCardActions\}>/su);
  // A2 structure: title + grouped date·time in the tinted zone, client/venue
  // + stage + recency + decorative arrow in the paper body. Whole card is one
  // entry link whose name comes from its contents; the pending link stays
  // outside it.
  // (The entry affordance is pinned in console-event-card-a2.test.cjs.)
  assert.match(card, /styles\.eventCardZone/u);
  assert.match(card, /styles\.eventDateTime/u);
  assert.match(card, /styles\.eventCardBody/u);
  assert.match(card, /styles\.eventCardFoot/u);
  assert.match(card, /일정 미정/u, 'unknown dates stay explicit, never blank or inferred');
  assert.match(card, /cardHeaderTheme\(event\.themeColor\)/u, 'published-only header theme');
  const css = read('app/console/console-home.module.css');
  assert.doesNotMatch(css, /\.eventMetrics|\.metricAttention|\.metricNumber|\.eventCardAction[^s]/u, 'removed metric/duplicate styling does not linger');
  assert.match(css, /\.approvalLink\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /\.eventCardZone\s*\{[^}]*background:\s*var\(--card-zone,\s*var\(--soft\)\)/su);
  assert.match(css, /\.eventDateTime\s*\{[^}]*color:\s*var\(--card-zone-ink,\s*var\(--brand-text\)\)/su);
});

test('home filter lattice shares one stage-plus-approval row at phone widths', () => {
  const css = read('app/console/console-home.module.css');
  assert.match(css, /\.homeFilters\s*\{[^}]*grid-template-areas:[^}]*"search search"[^}]*"stage work"/su);
  assert.match(css, /@media\s*\(max-width:\s*480px\)\s*\{[^}]*\.homeFilters\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0,\s*1fr\)/su);
  // The stage caption hides visually but stays positioned in the label, so
  // the select keeps its accessible name on the shared row.
  assert.match(css, /\.homeStage\s*>\s*span\s*\{[^}]*position:\s*absolute[^}]*clip:\s*rect\(0 0 0 0\)/su);
  assert.doesNotMatch(css, /\.homeStage\s*>\s*span\s*\{[^}]*display:\s*none/su);
  assert.doesNotMatch(css, /\.workFilter\s*\{[^}]*white-space:\s*nowrap/su);
  assert.doesNotMatch(css, /^\.toolbar\s*\{/mu, 'dead local toolbar grid is gone');
  // A2 cards size from their zone/body padding, not an oversized floor: the
  // tinted zone and the paper body own the rhythm, with a 220px minimum.
  assert.doesNotMatch(css, /\.eventCard\s*\{[^}]*min-height:\s*280px/su);
  assert.match(css, /\.eventCard\s*\{[^}]*min-height:\s*220px/su);
  assert.match(css, /\.eventCardZone\s*\{[^}]*padding:\s*var\(--s4\) var\(--s4\) var\(--s3\)/su);
  assert.match(css, /\.eventCardBody\s*\{[^}]*padding:\s*var\(--s3\) var\(--s4\) var\(--s2\)/su);
});

test('home stage filtering is a compact flat control, not a card-like form box', () => {
  const css = read('app/console/console-home.module.css');
  const rule = css.match(/\.stageFilter select\s*\{([^}]+)\}/u)?.[1];
  assert.ok(rule, 'stage select has a locally scoped presentation rule');
  assert.match(rule, /width:\s*auto/u);
  assert.match(rule, /field-sizing:\s*content/u, 'arrow follows the selected label, not the longest option');
  assert.match(rule, /min-height:\s*44px/u, 'flattening must not shrink the touch target');
  assert.match(rule, /border:\s*0/u);
  assert.match(rule, /border-radius:\s*0/u);
  assert.match(rule, /background-color:\s*transparent/u);
  assert.match(rule, /box-shadow:\s*none/u);
  assert.doesNotMatch(rule, /appearance:\s*none/u, 'native arrow and picker remain available');
});

test('home supporting filters stay together without stretching the stage selector', () => {
  const css = read('app/console/console-home.module.css');
  assert.match(css, /\.homeFilters\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0,\s*1fr\)/su);
  assert.match(css, /\.stageFilter\s*\{[^}]*justify-self:\s*start[^}]*width:\s*fit-content/su);
});

test('home directory title and count form one summary beside the view switch', () => {
  const css = read('app/console/console-home.module.css');
  assert.match(css, /\.directorySection\s*>\s*:has\(:global\(#console-event-directory\)\)\s*\{[^}]*"title action"[^}]*"desc action"/su);
});

test('shared section header pairs title and action on one grid row', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  assert.match(css, /\.sectionHead\s*\{[^}]*display:\s*grid[^}]*grid-template-areas:[^}]*"title action"[^}]*"desc desc"/su);
  assert.match(css, /\.sectionCopy\s*\{[^}]*display:\s*contents/su);
  assert.match(css, /\.sectionTitle\s*\{[^}]*grid-area:\s*title/su);
  assert.match(css, /\.sectionDescription\s*\{[^}]*grid-area:\s*desc/su);
  assert.match(css, /\.sectionAction\s*\{[^}]*grid-area:\s*action/su);
  // Absent nodes cost zero: single-row maps, no surviving empty-row gap.
  assert.match(css, /\.sectionHead:not\(:has\(\.sectionDescription\)\)\s*\{[^}]*grid-template-areas:\s*"title action"/su);
  assert.match(css, /\.sectionHead:not\(:has\(\.sectionAction\)\)[^}]*grid-template-areas:[^}]*"title"[^}]*"desc"/su);
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*420px\)\s*\{\s*\.sectionHead/su);
});

test('shared page header inlines one action, drops pairs below the copy', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  assert.match(css, /\.pageIdentity h1\s*\{[^}]*font-size:\s*var\(--h1\)/su);
  assert.match(css, /\.pageIdentity\s*\{[^}]*display:\s*contents/su);
  assert.match(css, /\.pageIdentity h1\s*\{[^}]*grid-area:\s*title/su);
  assert.match(css, /\.pageActions\s*\{[^}]*grid-area:\s*actions/su);
  assert.match(css, /\.pageActions\s*>\s*\*\s*\{[^}]*flex:\s*0\s+1\s+auto/su);
  assert.doesNotMatch(css, /\.pageActions\s*>\s*\*\s*\{[^}]*flex:\s*1\s+1\s+140px/su);
  // Two or more actions keep the full-width pair row instead of cramping H1.
  assert.match(css, /\.pageHeader:has\(\.pageActions > :nth-child\(2\)\)\s*\{[^}]*grid-template-areas:[^}]*"actions"/su);
  // Header source is untouched: CSS only, no markup or API change.
  const header = read('app/console/console-ui/ConsolePageHeader.tsx');
  assert.match(header, /actions\?: ReactNode/u);
});

test('shared section nav wraps to fully reachable rows on mobile', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  // No horizontal scroll hiding destinations at phone widths.
  assert.doesNotMatch(css, /\.sectionNavList\s*\{[^}]*overflow-x:\s*auto/su);
  assert.doesNotMatch(css, /\.sectionNavList\s*\{[^}]*flex-wrap:\s*nowrap/su);
  assert.match(
    css,
    /\.sectionNavList\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/su
  );
  // Links fill their cell as purposeful segmented buttons, keep the 44px
  // floor, and wrap inside the cell instead of cutting phrases.
  assert.match(css, /\.sectionNavLink\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /\.sectionNavLink\s*\{[^}]*width:\s*100%/su);
  assert.match(css, /\.sectionNavLink\s*\{[^}]*box-sizing:\s*border-box/su);
  assert.match(css, /\.sectionNavLink\s*\{[^}]*white-space:\s*normal/su);
  // API and semantics are untouched: native anchors, list markup, label.
  const nav = read('app/console/console-ui/ConsoleSectionNav.tsx');
  assert.match(nav, /<nav className=\{styles\.sectionNav\} aria-label=\{label \?\? "섹션 바로가기"\}>/u);
  assert.match(nav, /<a\s+className=\{styles\.sectionNavLink\}\s+href=\{`#\$\{item\.id\}`\}/su);
});

test('shared form actions and feedback survive long Korean labels', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  assert.match(css, /\.formActionsButtons\s*>\s*:global\(\.button\)\s*\{[^}]*flex:\s*1\s+1\s+240px/su);
  assert.match(css, /\.formActionsButtons\s*>\s*:global\(\.button\)\s*\{[^}]*word-break:\s*keep-all/su);
  assert.match(css, /\.feedback\s*\{[^}]*word-break:\s*keep-all/su);
});
