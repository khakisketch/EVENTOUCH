'use strict';

// Moderation triage follow-through contract for the programs workbench.
// Covers the code-review corrections: the next focus target must come from
// the currently rendered list (same module, same filter page) — never the
// global store — the request is scheduled only after a confirmed success
// (never before the write, never on failure), a missing next row always
// falls back to #moderation-status, and bounded counts read honestly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'apps/web/app/console/events/[id]/programs/ProgramsWorkspace.tsx'),
  'utf8'
);

function bodyBetween(start, end) {
  const from = SOURCE.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = end ? SOURCE.indexOf(end, from + start.length) : SOURCE.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return SOURCE.slice(from, to);
}

// Extracts the pure next-visible helper between its marker comments and
// evaluates it. The helper keeps plain TypeScript annotations, so the
// extractor strips exactly those (param/return types only) before eval.
function loadNextVisibleModerationId() {
  const begin = '// __NEXT_VISIBLE_MODERATION_ID_BEGIN__';
  const end = '// __NEXT_VISIBLE_MODERATION_ID_END__';
  const from = SOURCE.indexOf(begin);
  const to = SOURCE.indexOf(end);
  assert.notEqual(from, -1, 'missing helper begin marker');
  assert.notEqual(to, -1, 'missing helper end marker');
  let helper = SOURCE.slice(from + begin.length, to);
  helper = helper
    .replace(/export function nextVisibleModerationId/, 'function nextVisibleModerationId')
    .replace(/: string\[\]/g, '')
    .replace(/: string/g, '')
    .replace(/\| null/g, '');
  const factory = new Function(`${helper}; return nextVisibleModerationId;`);
  const fn = factory();
  assert.equal(typeof fn, 'function', 'helper must evaluate to a function');
  return fn;
}

test('moderation focus is scheduled only after a confirmed success', () => {
  for (const [name, start, end] of [
    ['manageQuestion', 'async function manageQuestion', 'function requestPhotoModeration'],
    ['moderatePhoto', 'async function moderatePhoto', 'function requestPostModeration'],
    ['moderatePost', 'async function moderatePost', 'if (state.kind === "loading")'],
  ]) {
    const body = bodyBetween(start, end);
    const writeAt = body.indexOf('await postCommand');
    assert.notEqual(writeAt, -1, `${name} must go through the idempotent postCommand path`);
    const scheduleAt = body.indexOf('moderationFocusRef.current =');
    assert.notEqual(scheduleAt, -1, `${name} must park a follow-through focus request`);
    assert.ok(
      scheduleAt > writeAt,
      `${name} must schedule focus after the confirmed write, never before it`
    );
    assert.ok(
      !body.slice(0, writeAt).includes('moderationFocusRef'),
      `${name} must not touch the focus request before the write resolves (or a failure would steal focus later)`
    );
  }
});

test('next focus target is scoped to the visible DOM list, with a status fallback', () => {
  assert.match(SOURCE, /function visibleModerationRowIds/, 'DOM-scoped visible row reader must exist');
  assert.match(SOURCE, /closest\("ul"\)/, 'scoping must use the row’s own rendered list');
  assert.match(
    SOURCE,
    /nextVisibleModerationId\(visibleModerationRowIds\(/,
    'scheduling must derive the next row from the visible DOM list'
  );
  assert.match(
    SOURCE,
    /document\.getElementById\("moderation-status"\)/,
    'a missing next row must always fall back to the moderation status line'
  );
});

test('bounded moderation counts read honestly', () => {
  assert.ok(
    !/\{filtered\.length\}건 표시/.test(SOURCE),
    'must not claim the filtered total as the shown count while only the first page renders'
  );
  const honest = SOURCE.match(/전체 조건 \{filtered\.length\}건 중 \{shown\.length\}건 표시/g) ?? [];
  assert.equal(honest.length, 3, 'Q&A, photo, and post lists must each show total-vs-shown counts');
});

test('no duplicate writeLocked guards remain', () => {
  assert.ok(
    !/if \(writeLocked\) return;\s*\n\s*if \(writeLocked\) return;/.test(SOURCE),
    'doubled writeLocked early-returns must be collapsed to one'
  );
});

test('review strip sits ahead of the toolbar and drives one backlog class', () => {
  const toolbarAt = SOURCE.indexOf('toolbar={state.canManage ? (');
  assert.notEqual(toolbarAt, -1, 'toolbar slot must exist');
  const toolbarEnd = SOURCE.indexOf(') : undefined}', toolbarAt);
  const toolbar = SOURCE.slice(toolbarAt, toolbarEnd);
  const stripAt = toolbar.indexOf('<ReviewStrip');
  const consoleToolbarAt = toolbar.indexOf('<ConsoleToolbar');
  assert.notEqual(stripAt, -1, 'review strip must render in the toolbar slot');
  assert.notEqual(consoleToolbarAt, -1, 'console toolbar must remain');
  assert.ok(stripAt < consoleToolbarAt, 'review strip must come before the toolbar');
  assert.match(SOURCE, /function runReviewShortcut\(target: ReviewTarget\)/, 'shortcut runner must exist');
  const shortcut = bodyBetween('function runReviewShortcut(target: ReviewTarget)', 'const kind = target');
  assert.match(shortcut, /setProgramQuery\(""\)/, 'shortcut must clear the obstructing program search');
  assert.match(shortcut, /setProgramStatusFilter\(""\)/, 'shortcut must clear the obstructing program status');
   assert.match(shortcut, /setModuleLimit\(\(current\) => Math\.max\(current, targetIndex \+ 1\)\)/, 'shortcut exposes the relevant module without unbounding every module');
  assert.match(shortcut, /setQaFilter\("unanswered"\)/, 'unanswered shortcut must set the nested Q&A filter');
  assert.match(shortcut, /setQaFilter\("pending"\)/, 'pending shortcut must set the nested Q&A filter');
  assert.match(shortcut, /setPhotoFilter\("PENDING"\)/, 'photo shortcut must set the nested photo filter');
  assert.match(shortcut, /setPostFilter\("PENDING"\)/, 'post shortcut must set the nested post filter');
  assert.match(SOURCE, /filter: "all" \| "unanswered" \| "pending";\s*\n\s*onFilterChange/, 'nested Q&A filter must be lifted, not list-local');
  const strip = bodyBetween('function ReviewStrip', 'function QuestionList');
  assert.ok(!/검토 대기 \d|합계|총 \d+건/.test(strip), 'strip must show no summed total across overlapping classes');
  for (const gate of ['props.unanswered > 0', 'props.qaPending > 0', 'props.photoPending > 0', 'props.postPending > 0']) {
    assert.ok(strip.includes(gate), `zero-count class must render no control (${gate})`);
  }
});
test('nextVisibleModerationId behaves over the visible order', () => {
  const nextVisibleModerationId = loadNextVisibleModerationId();
  assert.equal(nextVisibleModerationId(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(nextVisibleModerationId(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(nextVisibleModerationId(['a', 'b', 'c'], 'c'), null);
  assert.equal(nextVisibleModerationId(['a'], 'a'), null);
  assert.equal(nextVisibleModerationId([], 'a'), null);
  assert.equal(nextVisibleModerationId(['a', 'b'], 'missing'), 'a');
});
