'use strict';

// Mobile composition: deliberate control rows on narrow screens. The old
// layout passed its overflow checks while still shipping a squeezed search
// beside an unrelated checkbox and a view switch competing with the primary
// create action, so these tests pin the structure itself: search-first phone
// rows, a section-header view switch, one title-level create action, and
// shared primitives with no position-based heuristics.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../apps/web/package.json'));
const ts = webRequire('typescript');
const postcss = webRequire('postcss');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

// Match exact selectors in their actual media scope, never the first media block.
function cssDeclarations(css, selector, media = null) {
  const matches = [];
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const scopes = [];
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule') scopes.unshift(parent.name + ' ' + parent.params);
    }
    if (JSON.stringify(scopes) === JSON.stringify(media ? ['media ' + media] : [])) matches.push(rule);
  });
  assert.equal(matches.length, 1, selector + ' has one rule in ' + (media ?? 'the base scope'));
  return Object.fromEntries(matches[0].nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
}

function findNodes(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  ts.forEachChild(node, (child) => { findNodes(child, predicate, found); });
  return found;
}

function jsxAttribute(opening, name) {
  return opening.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === name);
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

test('shared page header aligns title and action while retaining context, metadata and mobile wrapping', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  assert.equal(cssDeclarations(css, '.pageIdentity h1')['font-size'], '30px');
  assert.equal(cssDeclarations(css, '.pageIdentity h1', '(max-width: 768px)')['font-size'], '26px');
  assert.equal(cssDeclarations(css, '.pageTitleRow').display, 'contents');
  assert.equal(cssDeclarations(css, '.pageHeader')['grid-template-areas'], '"back back" "context context" "title actions" "meta meta" "badges badges"');
  assert.equal(cssDeclarations(css, '.pageContext')['grid-area'], 'context');
  assert.equal(cssDeclarations(css, '.pageSubline')['grid-area'], 'meta');
  assert.equal(cssDeclarations(css, '.pageBadges')['grid-area'], 'badges');
  assert.equal(cssDeclarations(css, '.pageMeta')['overflow-wrap'], 'anywhere');
  assert.equal(cssDeclarations(css, '.pageBadges')['flex-wrap'], 'wrap');
  assert.equal(cssDeclarations(css, '.pageActions')['flex-wrap'], 'wrap');
  assert.match(css, /\.pageIdentity\s*\{[^}]*display:\s*contents/su);
  assert.match(css, /\.pageIdentity h1\s*\{[^}]*grid-area:\s*title/su);
  assert.match(css, /\.pageActions\s*\{[^}]*grid-area:\s*actions/su);
  assert.match(css, /\.pageActions\s*>\s*\*\s*\{[^}]*flex:\s*0\s+1\s+auto/su);
  assert.doesNotMatch(css, /\.pageActions\s*>\s*\*\s*\{[^}]*flex:\s*1\s+1\s+140px/su);
  // Two or more actions keep the full-width pair row instead of cramping H1.
  for (const selector of ['.pageHeader:has(.pageActions > :nth-child(2))', '.pageHeader:has(.pageActions > :global(.console-header-group))']) {
    assert.equal(cssDeclarations(css, selector, '(max-width: 768px)')['grid-template-areas'], '"back" "context" "title" "meta" "badges" "actions"');
    assert.equal(cssDeclarations(css, selector + ' .pageActions', '(max-width: 768px)')['justify-content'], 'flex-start');
  }
  // The new title-row wrapper preserves the existing shared actions API.
  const header = read('app/console/console-ui/ConsolePageHeader.tsx');
  assert.match(header, /actions\?: ReactNode/u);
});

test('shared section nav wraps to fully reachable rows on mobile', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  // No horizontal scroll hiding destinations at phone widths.
  assert.doesNotMatch(css, /\.sectionNavList\s*\{[^}]*overflow-x:\s*auto/su);
  assert.doesNotMatch(css, /\.sectionNavList\s*\{[^}]*flex-wrap:\s*nowrap/su);
  // 표현 고정 갱신(동작 불변): 2열 중앙 그리드(repeat(auto-fit,minmax(140px)))
  // 는 앵커임에도 분할 탭처럼 보여 3개 항목 화면에서 3번째가 단독 행에
  // 고립됐다. 좌정렬 플로우 목차로 바꿔 모든 목적지를 스크롤 발견 없이
  // 노출하고 고아 행·버튼 모방을 없앤다. 44px·앵커·현재 표시 유지.
  assert.match(
    css,
    /\.sectionNavList\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/su
  );
  assert.match(css, /\.sectionNavList\s*\{[^}]*justify-content:\s*flex-start/su);
  assert.doesNotMatch(
    css,
    /@media\s*\(max-width:\s*768px\)[\s\S]*?\.sectionNavList\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/su
  );
  // Links read as TOC entries, not segmented buttons: intrinsic width,
  // left aligned, wrap inside instead of cutting phrases. Idle links stay
  // ink — only the current section takes brand color + rule (주황 탭 무리
  // 해소, 선택 1곳 원칙). Weight joins the current marker, never color alone.
  assert.match(css, /\.sectionNavLink\s*\{[^}]*min-height:\s*44px/su);
  // 320px 실측 계열: 짧은 목차(공지·부스)가 40px로 목표 미달이었으므로
  // 너비 하한도 44px로 고정한다. 좌정렬·래핑·앵커 동작은 그대로.
  assert.match(css, /\.sectionNavLink\s*\{[^}]*min-width:\s*44px/su);
  assert.match(css, /\.sectionNavLink\s*\{[^}]*color:\s*var\(--ink\)/su);
  assert.match(css, /\.sectionNavLink\[aria-current="location"\]\s*\{[^}]*color:\s*var\(--brand-text\)/su);
  assert.match(css, /\.sectionNavLink\[aria-current="location"\]\s*\{[^}]*border-bottom-color:\s*var\(--brand\)/su);
  const current = cssDeclarations(css, '.sectionNavLink[aria-current="location"]');
  assert.equal(current['font-weight'], '650', 'current marker uses the shared medium emphasis, not an oversized 800 weight');
  assert.ok(Number(current['font-weight']) > Number(cssDeclarations(css, '.sectionNavLink')['font-weight']), 'current state retains a non-color weight difference');
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.sectionNavLink\s*\{[^}]*text-align:\s*left/su);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.sectionNavLink\s*\{[^}]*width:\s*auto/su);
  assert.match(css, /\.sectionNavLink\s*\{[^}]*white-space:\s*normal/su);
  // Visible index context: content/reports name their scope above the row
  // (operations keeps its own move guide); SR naming stays on the nav's
  // aria-label alone via aria-hidden, so nothing is announced twice.
  const content = read('app/console/events/[id]/content/ContentWorkspace.tsx');
  assert.doesNotMatch(content, /ConsoleSectionNav|navIndexLabel/u, 'content authoring left the jump nav for ink tabs beside an always-on phone');
  assert.match(content, /<CountTabs\s+mode="tablist"\s+ariaLabel="콘텐츠 종류"/u);
  const reports = read('app/console/events/[id]/reports/ReportsWorkspace.tsx');
  assert.match(reports, /navIndexLabel[^>]*aria-hidden="true">보고서 작업/u);
  assert.match(reports, /label="결과 보고서 구역"/u);
  // Draws and the attendee page editor get the same quiet index signal in
  // their own scope words (no new buttons, no behavior change): the shared
  // ink/current-ink grammar already covers all consumers via CSS.
  const draws = read('app/console/events/[id]/draws/DrawsWorkspace.tsx');
  assert.doesNotMatch(draws, /ConsoleSectionNav|navIndexLabel/u, 'the draw screen left the jump nav for a stage picker');
  const theme = read('app/console/events/[id]/page/ThemeWorkspace.tsx');
  assert.doesNotMatch(theme, /ConsoleSectionNav|navIndexLabel/u, 'the attendee page studio left the jump nav for settings rows');
  // API and semantics are untouched: native anchors, list markup, label.
  const nav = read('app/console/console-ui/ConsoleSectionNav.tsx');
  assert.match(nav, /<nav className=\{`\$\{styles\.sectionNav\} \$\{styles\.anchorNav\}`\} aria-label=\{label \?\? "섹션 바로가기"\}>/u);
  assert.match(nav, /<a\s+className=\{styles\.sectionNavLink\}\s+href=\{`#\$\{item\.id\}`\}/su);
});

test('shared form actions and feedback survive long Korean labels', () => {
  const css = read('app/console/console-ui/console-ui.module.css');
  // The row must widen both the legacy .button and the Astryx button the product renders; the
  // .button-only rule never matched a ProductButton, leaving a short "등록" at 48px on a phone.
  const phoneRow = /\.formActionsButtons\s*>\s*:global\(\.button\),\s*\.formActionsButtons\s+:global\(\.astryx-button\)\s*\{[^}]*\}/su.exec(css)?.[0] ?? '';
  assert.match(phoneRow, /flex:\s*1\s+1\s+240px/u);
  assert.match(phoneRow, /word-break:\s*keep-all/u);
  assert.match(css, /\.feedback\s*\{[^}]*word-break:\s*keep-all/su);
});
