'use strict';

// The long console screens mix several kinds of work in one page: the draw/
// vote screen carries stage draws, ranking votes, roulette and lucky numbers,
// and the attendee page editor carries its own groups. Both keep the shared
// jump nav and mark the section in view once. Field operations left the jump
// nav: it reads as one screen (desks, side column), and only its preset
// anchors still unfold on a deep link, on the matching link itself (aria-current + visual emphasis) — the
// old separate "현재 위치:" readout is gone, so the position reads exactly
// once instead of twice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const operations = read('apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx');
const draws = read('apps/web/app/console/events/[id]/draws/DrawsWorkspace.tsx');
const drawsCss = read('apps/web/app/console/events/[id]/draws/draws.module.css');
const theme = read('apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx');
const themeCss = read('apps/web/app/console/events/[id]/page/page.module.css');
const nav = read('apps/web/app/console/console-ui/ConsoleSectionNav.tsx');
const navCss = read('apps/web/app/console/console-ui/console-ui.module.css');

test('the attendee page studio left the jump nav for a short settings list', () => {
  assert.doesNotMatch(theme, /ConsoleSectionNav|navSticky|activeSection|IntersectionObserver/u, 'no jump nav, tracked section or observer');
  assert.match(theme, /<div className=\{studio\.studio\}/u, 'the studio layout replaced the long form');
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
});

test('the shared nav stays hook-free; the draw screen no longer owns a scroll-spy pin', () => {
  // The shared nav stays hook-free (foundation contract). The draw and vote
  // screen left the jump nav for a stage picker, so it owns no pin or spy.
  assert.doesNotMatch(nav, /useJumpNavPin/u, 'no hook leaks into the shared nav');
  assert.doesNotMatch(draws, /navPinRef|IntersectionObserver|ConsoleSectionNav/u, 'no scroll spy on the draw screen');
});

test('deep links name their section where the scroll spy cannot see it arrive', () => {
  // Same bottom-of-page cause over a fresh load or a pasted fragment: the
  // heading may never cross the band, so the hash names the section too.
  // Operations validates against the actually rendered (gated) list: a
  // gated-off or unknown anchor pins nothing and the marker keeps the
  // default section instead of pointing at no rendered link.
  // The draw screen resolves the same fragments by selecting that item.
  assert.match(draws, /draws-vote" \|\| id === "draws-roulette" \|\| id === "draws-lucky"/u, 'draws deep links select the stage item');
  assert.match(draws, /draw-program-/u, 'a program fragment selects that program');
  assert.match(draws, /window\.addEventListener\("hashchange", applyHash\)/u, 'later fragment changes keep working');
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
  assert.doesNotMatch(nav.slice(nav.indexOf('const isActive = activeId')), /event\.preventDefault\(\)/u);
});

test('the draw and vote screen keeps its four jobs addressable', () => {
  // The four jobs are items of one stage picker; each keeps its own state line.
  for (const key of ['"vote"', '"roulette"', '"lucky"']) {
    assert.ok(draws.includes(`key: ${key}`), `${key} stays selectable`);
  }
  assert.match(draws, /key: `program:\$\{item\.id\}`/u, 'every draw program is selectable');
  assert.match(draws, /id=\{kind === "program" && program \? `draw-program-\$\{program\.id\}` : `draws-\$\{kind\}`\}/u, 'anchors survive on the stage card');
});
