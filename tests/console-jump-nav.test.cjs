'use strict';

// The long console screens mix several kinds of work in one page: the field
// operations screen carries desks, booths, map, display and staffing, and the
// draw/vote screen carries stage draws, ranking votes, roulette and lucky
// numbers. All three keep the shared jump nav and mark the section in view
// once, on the matching link itself (aria-current + visual emphasis) — the
// old separate "현재 위치:" readout is gone, so the position reads exactly
// once instead of twice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const operations = read('apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx');
const operationsCss = read('apps/web/app/console/events/[id]/operations/operations.module.css');
const draws = read('apps/web/app/console/events/[id]/draws/DrawsWorkspace.tsx');
const drawsCss = read('apps/web/app/console/events/[id]/draws/draws.module.css');
const theme = read('apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx');
const themeCss = read('apps/web/app/console/events/[id]/page/page.module.css');
const nav = read('apps/web/app/console/console-ui/ConsoleSectionNav.tsx');
const navCss = read('apps/web/app/console/console-ui/console-ui.module.css');

test('the long console screens mark the section in view on the nav link itself', () => {
  for (const [name, source, css] of [
    ['field operations', operations, operationsCss],
    ['draws and votes', draws, drawsCss],
    ['attendee page editor', theme, themeCss],
  ]) {
    assert.match(source, /<ConsoleSectionNav/u, `${name} keeps the shared jump nav`);
    assert.match(source, /className=\{styles\.navSticky\}/u, `${name} wraps the nav`);
    assert.match(source, /activeId=\{activeSection\}/u, `${name} passes the tracked section to the nav`);
    assert.match(source, /IntersectionObserver/u, `${name} follows the section in view`);
    assert.match(source, /getElementById\(id\)/u, `${name} observes the existing anchors`);
    assert.doesNotMatch(source, /현재 위치:/u, `${name} has no separate position readout`);
    assert.doesNotMatch(source, /navNow/u, `${name} drops the readout hook`);
    assert.match(css, /\.navSticky \{/u, `${name} styles the nav wrapper`);
    assert.doesNotMatch(css, /\.navNow \{/u, `${name} drops the readout style`);
  }
});

test('the active nav link carries one accessible current marker with a non-color signal', () => {
  assert.match(nav, /activeId\?: string/u, 'the current section is an optional prop');
  assert.match(nav, /aria-current=\{isActive \? "location" : undefined\}/u, 'only the matching link is current');
  // The active style keys off the link's own aria-current, so the shared
  // anchor markup (className + href adjacency the composition contract pins)
  // stays untouched.
  assert.match(nav, /<a\s+className=\{styles\.sectionNavLink\}\s+href=\{`#\$\{item\.id\}`\}/su, 'the shared anchor shape stays');
  const start = navCss.indexOf('.sectionNavLink[aria-current="location"]');
  assert.ok(start >= 0, 'the active link style exists');
  const block = navCss.slice(start, navCss.indexOf('}', navCss.indexOf('{', start)) + 1);
  assert.match(block, /border-bottom-color: var\(--brand\)/u, 'the current section owns the approved orange underline');
  assert.ok(
    /font-weight: 800/u.test(block) || /border-bottom-color: var\(--/u.test(block),
    'a non-color signal joins the surface'
  );
  assert.doesNotMatch(block, /text-decoration: underline/u, 'standalone actions do not use underline as the affordance');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/u, 'no color literals in the active style');
  const linkStart = navCss.indexOf('.sectionNavLink {');
  assert.ok(linkStart >= 0, 'the base link style exists');
  assert.match(navCss.slice(linkStart), /min-height: 44px/u, 'the 44px touch floor stays on the shared link');
});

test('an explicit jump names its section at once and pins it past the scroll spy', () => {
  // Real-browser finding: the spy watches tiny h2 headings crossing a narrow
  // central band, so a bottom-of-page section (e.g. ops-staff) can never
  // scroll its heading into the band — after focus+Enter the focus sat on
  // ops-staff while aria-current stayed on ops-booths. The jump now reports
  // itself and the spy stands down until the operator really scrolls.
  assert.match(nav, /onNavigate\?: \(id: string\) => void/u, 'the nav reports explicit jumps');
  assert.match(nav, /onNavigate\?\.\(item\.id\)/u, 'every link activation reports its section');
  // The report fires only for a resolved target, before the focus handoff,
  // so a dead link never claims the position and keyboard flow is unchanged.
  const clickAt = nav.indexOf('onClick={() =>');
  const reportAt = nav.indexOf('onNavigate?.(item.id)');
  const guardAt = nav.indexOf('if (!target) return;');
  const focusAt = nav.indexOf('target.focus({ preventScroll: true })');
  assert.ok(clickAt >= 0 && guardAt > clickAt && reportAt > guardAt && focusAt > reportAt, 'guard, then report, then focus handoff');
  for (const [name, source] of [['field operations', operations], ['draws and votes', draws]]) {
    assert.match(source, /onNavigate=\{followJumpedSection\}/u, `${name} follows explicit jumps`);
    assert.match(source, /navPinRef\.current = id;/u, `${name} pins the jumped-to section`);
    assert.match(source, /if \(navPinRef\.current\) return;/u, `${name} spy stands down while pinned`);
  }
});

test('the jump pin releases only on genuine user scrolling, never on a timer', () => {
  // The shared nav stays hook-free (foundation contract): each long screen
  // owns its tiny pin next to the spy it guards.
  assert.doesNotMatch(nav, /useJumpNavPin/u, 'no hook leaks into the shared nav');
  for (const [name, source] of [['field operations', operations], ['draws and votes', draws]]) {
    assert.match(source, /const navPinRef = useRef<string \| null>\(null\);/u, `${name} owns its pin`);
    assert.match(source, /addEventListener\("wheel", releaseJumpPin, \{ passive: true \}\)/u, `${name} wheel scrolling releases`);
    assert.match(source, /addEventListener\("touchmove", releaseJumpPin, \{ passive: true \}\)/u, `${name} touch scrolling releases`);
    // Keystrokes inside a field drive that control, not the document: an
    // arrow moving through an input/select must not release the pin.
    assert.match(source, /target\.closest\("input, select, textarea, \[contenteditable\]"\)/u, `${name} ignores editable targets`);
    for (const key of ['"ArrowUp"', '"ArrowDown"', '"PageUp"', '"PageDown"', '"Home"', '"End"', '" "']) {
      assert.ok(source.includes(key), `${name} scroll key ${key} releases`);
    }
    // No arbitrary hold duration and no release on the programmatic scroll
    // itself (scroll events fire for scrollIntoView too, so they must not).
    assert.doesNotMatch(source, /setTimeout/u, `${name} holds nothing on a timer`);
    assert.doesNotMatch(source, /setInterval/u, `${name} polls nothing on an interval`);
    assert.doesNotMatch(source, /addEventListener\("scroll"/u, `${name} programmatic scrolls never release`);
    assert.doesNotMatch(source, /addEventListener\('scroll'/u, `${name} programmatic scrolls never release`);
  }
});

test('deep links name their section where the scroll spy cannot see it arrive', () => {
  // Same bottom-of-page cause over a fresh load or a pasted fragment: the
  // heading may never cross the band, so the hash names the section too.
  // Operations validates against the actually rendered (gated) list: a
  // gated-off or unknown anchor pins nothing and the marker keeps the
  // default section instead of pointing at no rendered link.
  assert.match(operations, /const trackedIds: string\[\] = useMemo\(\(\) => \(state\.kind === "ready"/u, 'operations tracks only rendered sections');
  assert.match(operations, /\.\.\.\(state\.stampEnabled \? \["ops-booth-mode", "ops-booth-map"\] : \[\]\)/u, 'stamp-gated sections join only when on');
  assert.match(operations, /\.\.\.\(state\.screenEnabled \? \["ops-display"\] : \[\]\)/u, 'the display section joins only when on');
  assert.match(operations, /if \(id && trackedIds\.includes\(id\)\) followJumpedSection\(id\)/u, 'unrendered hashes pin nothing');
  assert.match(operations, /useState\("ops-desks"\)/u, 'the default section stays desks');
  assert.match(draws, /const DRAW_SECTION_IDS = Object\.keys\(DRAW_SECTION_LABELS\)/u, 'draws resolve the same list the spy iterates');
  for (const [name, source] of [['field operations', operations], ['draws and votes', draws]]) {
    assert.match(source, /hash\.slice\(1\)/u, `${name} reads the fragment`);
    assert.match(source, /followJumpedSection\(id\)/u, `${name} pins the deep-linked section`);
    assert.match(source, /window\.addEventListener\("hashchange", applyHash\)/u, `${name} follows later fragment changes`);
  }
  // The preset-unfold behavior the hash effect already owned stays intact.
  assert.match(operations, /if \(hash === "#ops-booth-mode"\)/u, 'mode deep links still unfold their preset');
  assert.ok(operations.includes('} else if (hash === "#ops-booth-map")'), 'map deep links still unfold their preset');
});
test('without a tracked section the nav stays a regular nav', () => {
  // Content/reports and any future consumer pass no activeId: no link may
  // claim to be current and the nav keeps its plain anchors + focus handoff.
  assert.match(nav, /activeId !== undefined && item\.id === activeId/u, 'current requires an explicit tracked id');
  assert.doesNotMatch(nav, /\saria-current="location"[\s>]/u, 'no link is unconditionally current');
});

test('a section jump moves focus into the section, not only the viewport', () => {
  // A keyboard operator who jumps to a section must continue tabbing inside
  // that section, so the jump hands focus over as well as scrolling.
  const nav = read('apps/web/app/console/console-ui/ConsoleSectionNav.tsx');
  assert.match(nav, /onClick=\{\(\) =>/u);
  assert.match(nav, /document\.getElementById\(item\.id\)/u);
  assert.match(nav, /setAttribute\("tabindex", "-1"\)/u);
  assert.match(nav, /target\.focus\(\{ preventScroll: true \}\)/u, 'focus moves directly, matching the messaging skip grammar');
  assert.match(nav, /target\.scrollIntoView\(\{ block: "start" \}\)/u, 'the viewport follows explicitly, not by browser accident');
  assert.match(nav, /instanceof HTMLElement/u, 'focus is guarded to focusable nodes');
  // The fragment must still change: a section stays copyable and reopenable.
  assert.doesNotMatch(nav, /event\.preventDefault\(\)/u);
});

test('the draw and vote screen keeps its four jobs addressable', () => {
  for (const id of ['draws-programs', 'draws-vote', 'draws-roulette', 'draws-lucky']) {
    assert.match(draws, new RegExp(`\\{ id: "${id}", label:`), `${id} stays in the nav`);
  }
  // Each section still carries its own state, so the nav is a summary too.
  assert.match(draws, /무대 추첨 · \$\{state\.drawPrograms\.length\}개/u);
  assert.match(draws, /순위 투표 · \$\{state\.voteTotal\}표/u);
});
