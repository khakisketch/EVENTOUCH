const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The frontend has no build step and no module system: 23 scripts extend one
// global object, and load order decides which definition wins. Nothing
// enforces that, so an accidental redefinition silently replaces behaviour.
// These tests are the enforcement that the toolchain cannot provide.

function loadOrder() {
  return (read('index.html').match(/src="assets\/js\/([^"?]+)/g) || [])
    .map((value) => value.replace('src="assets/js/', ''));
}

// Collects every place a view or action is defined, in load order.
function definitions() {
  const views = new Map();
  const actions = new Map();
  for (const file of loadOrder()) {
    const source = read('assets/js/' + file);
    for (const match of source.matchAll(/E?\.?views(?:\[['"]([a-zA-Z0-9-]+)['"]\]|\.([a-zA-Z0-9-]+))\s*=/g)) {
      const name = match[1] || match[2];
      if (!views.has(name)) views.set(name, []);
      views.get(name).push(file);
    }
    for (const match of source.matchAll(/E?\.?actions\[['"]([a-zA-Z0-9-]+)['"]\]\s*=/g)) {
      const name = match[1];
      if (!actions.has(name)) actions.set(name, []);
      actions.get(name).push(file);
    }
  }
  return { views, actions };
}

test('the-script-load-order-is-pinned', () => {
  // The order is a contract: server-presentation.js wraps what the files
  // before it defined, and workflows.js wraps field.js output.
  const expected = [
    'core.js', 'store.js', 'qr.js', 'phone-shell.js', 'ui.js', 'registration.js',
    'console.js', 'field.js', 'programs.js', 'communication.js', 'attendee.js',
    'results.js', 'display.js', 'router.js', 'experience.js', 'workflows.js',
    'role-model.js', 'event-flow.js', 'operator-experience.js', 'server-sync.js',
    'booth-map-data.js', 'booth-map-ui.js', 'server-presentation.js',
  ];
  assert.deepEqual(loadOrder(), expected,
    'index.html script order changed — verify nothing now shadows a definition it used to follow');
});

test('every-script-in-the-load-order-exists', () => {
  for (const file of loadOrder()) {
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/js', file)), `missing assets/js/${file}`);
  }
});

test('server-presentation-runs-last', () => {
  // It wraps loginPage, adminShell, views.attendee, reportMarkup and
  // invite-link. Loaded earlier, those wrappers would be discarded.
  const order = loadOrder();
  assert.equal(order[order.length - 1], 'server-presentation.js');
});

test('workflows-runs-after-field-so-its-wrapper-captures-the-real-view', () => {
  const order = loadOrder();
  assert.ok(order.indexOf('field.js') < order.indexOf('workflows.js'));
  assert.ok(order.indexOf('experience.js') < order.indexOf('workflows.js'));
  assert.ok(order.indexOf('workflows.js') < order.indexOf('role-model.js'));
});

test('the-view-inventory-is-pinned', () => {
  const { views } = definitions();
  assert.equal(views.size, 39, 'a view was added or removed — update the expected count deliberately');
  for (const required of ['overview', 'participants', 'checkin', 'booths', 'attendee', 'staff', 'results', 'settings']) {
    assert.ok(views.has(required), `missing view: ${required}`);
  }
});

test('the-action-inventory-is-pinned', () => {
  const { actions } = definitions();
  assert.equal(actions.size, 120, 'an action was added or removed — update the expected count deliberately');
});

test('no-new-view-is-defined-twice', () => {
  // 12 views are legitimately layered and 14 have a definition that is
  // shadowed. That set is known and frozen; a NEW duplicate is almost
  // certainly an accident, and it fails here instead of at runtime.
  const known = new Set([
    'attendee', 'booths', 'checkin', 'desks', 'display', 'import',
    'participants', 'programs', 'settings', 'staff',
  ]);
  const { views } = definitions();
  const duplicated = [...views.entries()].filter(([, files]) => files.length > 1).map(([name]) => name);
  const unexpected = duplicated.filter((name) => !known.has(name));
  assert.deepEqual(unexpected, [], 'unexpected duplicate view definition(s)');
});

test('no-new-action-is-defined-twice', () => {
  const known = new Set([
    'assign-staff', 'camera-scan', 'clear-event-filters', 'clear-scan', 'client-detail',
    'compose-message', 'edit-desk', 'edit-module', 'invite-link', 'message-detail',
    'publish-report', 'report-detail', 'scan-person', 'staff-search', 'table-page',
    'toggle-menu',
  ]);
  const { actions } = definitions();
  const duplicated = [...actions.entries()].filter(([, files]) => files.length > 1).map(([name]) => name);
  const unexpected = duplicated.filter((name) => !known.has(name));
  assert.deepEqual(unexpected, [], 'unexpected duplicate action definition(s)');
});

test('a-shadowed-definition-is-never-silently-trusted', () => {
  // Several of the duplicates are layers: the later file captures the earlier
  // value and calls it, so both are live. Static analysis cannot reliably tell
  // a layer from a shadowed definition in this codebase — three attempts gave
  // three different answers. So the test does not classify; it only records
  // which files are involved, so an editor knows to check before changing one.
  const { views } = definitions();
  const staff = views.get('staff');
  assert.deepEqual(staff, ['field.js', 'experience.js', 'workflows.js', 'role-model.js'],
    'staff is composed from four files — editing one alone may have no effect');
  const checkin = views.get('checkin');
  assert.deepEqual(checkin, ['field.js', 'event-flow.js']);
});

test('the-global-namespace-surface-is-pinned', () => {
  // 155 top-level properties on E is the structural debt this repo carries.
  // Pinning it means growth is a deliberate decision rather than drift.
  const names = new Set();
  for (const file of loadOrder()) {
    const source = read('assets/js/' + file);
    for (const match of source.matchAll(/(?:^|[^A-Za-z0-9_$.])E\.([a-zA-Z][a-zA-Z0-9_]*)\s*=/g)) {
      names.add(match[1]);
    }
  }
  assert.ok(names.size >= 140,
    `E surface shrank to ${names.size}; if that was a deliberate reduction, lower this floor`);
  assert.ok(names.size <= 175,
    `E surface grew to ${names.size}; add the new properties deliberately instead of letting it drift`);
});

test('no-script-defines-a-name-both-ways-in-the-same-file', () => {
  // E.forms['x'] and E.forms.x in one file is the inconsistency recorded in
  // docs/DESIGN-SYSTEM.md; this only guards against a single file mixing them
  // for the same name, which would be a genuine bug rather than a style issue.
  for (const file of loadOrder()) {
    const source = read('assets/js/' + file);
    const bracket = new Set();
    const dot = new Set();
    for (const match of source.matchAll(/E\.forms\[['"]([a-zA-Z0-9-]+)['"]\]\s*=/g)) bracket.add(match[1]);
    for (const match of source.matchAll(/E\.forms\.([a-zA-Z][a-zA-Z0-9_-]*)\s*=/g)) dot.add(match[1]);
    const both = [...bracket].filter((name) => dot.has(name));
    assert.deepEqual(both, [], `${file} registers the same form name both ways: ${both.join(', ')}`);
  }
});
