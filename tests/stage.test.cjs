const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const STAGE_PATH = path.join(ROOT, 'features', 'stage.js');

function loadStage(seed) {
  const sandbox = { console };
  sandbox.window = seed || {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(STAGE_PATH, 'utf8'), sandbox, {
    filename: 'features/stage.js',
  });
  return sandbox.window.ETKO || sandbox.ETKO;
}

function loadStageWithScenes() {
  const sandbox = { console, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'features', 'scenes.js'), 'utf8'), sandbox, {
    filename: 'features/scenes.js',
  });
  vm.runInContext(fs.readFileSync(STAGE_PATH, 'utf8'), sandbox, {
    filename: 'features/stage.js',
  });
  return sandbox.window.ETKO || sandbox.ETKO;
}

function fullChecks() {
  return { disclose: [true, true], confirm: [true, true] };
}

test('canTake requires both disclosure checks and both confirm checks', () => {
  const ETKO = loadStage();
  assert.equal(typeof ETKO.canTake, 'function', 'ETKO.canTake must exist');
  assert.equal(ETKO.canTake(fullChecks()), true, 'all four checks must allow TAKE');
  assert.equal(
    ETKO.canTake({ disclose: [true, false], confirm: [true, true] }),
    false,
    'one missing disclosure must block TAKE'
  );
  assert.equal(
    ETKO.canTake({ disclose: [true, true], confirm: [false, true] }),
    false,
    'one missing confirm must block TAKE'
  );
  assert.equal(
    ETKO.canTake({ disclose: [false, false], confirm: [false, false] }),
    false,
    'no checks must block TAKE'
  );
});

test('canTake never throws on missing or bad input', () => {
  const ETKO = loadStage();
  assert.equal(ETKO.canTake(), false, 'no args must block TAKE');
  assert.equal(ETKO.canTake({}), false, 'empty object must block TAKE');
  assert.equal(
    ETKO.canTake({ disclose: 'yes', confirm: null }),
    false,
    'non-array checks must block TAKE'
  );
  assert.equal(
    ETKO.canTake({ disclose: [true], confirm: [true, true] }),
    false,
    'a single disclosure check must block TAKE'
  );
});

test('safety returns distinct Korean copy for BLACK, HOLD and LOGO', () => {
  const ETKO = loadStage();
  assert.equal(typeof ETKO.safety, 'function', 'ETKO.safety must exist');
  const modes = ['BLACK', 'HOLD', 'LOGO'];
  const seen = new Set();
  modes.forEach((mode) => {
    const msg = ETKO.safety(mode);
    assert.match(msg.title, /[가-힣]/, mode + ' title must be Korean');
    assert.match(msg.detail, /[가-힣]/, mode + ' detail must be Korean');
    seen.add(msg.title);
    // Case-insensitive: lowercase input must resolve the same way.
    assert.deepEqual(ETKO.safety(mode.toLowerCase()), msg, mode + ' must be case-insensitive');
  });
  assert.equal(seen.size, modes.length, 'each safety mode must have distinct copy');
});

test('safety returns fresh objects and falls back to Korean on unknown mode', () => {
  const ETKO = loadStage();
  const first = ETKO.safety('BLACK');
  const second = ETKO.safety('BLACK');
  assert.deepEqual(first, second, 'same mode must return equal copy');
  assert.notEqual(first, second, 'safety must return a fresh object per call');
  const fallback = ETKO.safety('nope');
  assert.match(fallback.title, /[가-힣]/, 'unknown mode title must be Korean');
  assert.match(fallback.detail, /[가-힣]/, 'unknown mode detail must be Korean');
});

test('preview change alone never alters program; applyTake needs all four checks', () => {
  const ETKO = loadStage();
  assert.equal(typeof ETKO.applyTake, 'function', 'ETKO.applyTake must exist');
  const state = { preview: 'HOLD', program: 'LOGO', disclose: [false, false], confirm: [false, false] };
  state.preview = 'BLACK';
  assert.equal(state.program, 'LOGO', 'preview change alone must not alter program');

  const blocked = ETKO.applyTake(state);
  assert.equal(blocked, false, 'applyTake without checks must refuse');
  assert.equal(state.program, 'LOGO', 'refused TAKE must leave program untouched');

  state.disclose = [true, true];
  state.confirm = [true, true];
  const taken = ETKO.applyTake(state);
  assert.equal(taken, true, 'applyTake with all checks must take');
  assert.equal(state.program, 'BLACK', 'TAKE must copy preview to program');
});

test('stage renders Korean two-stage dialog with TAKE gated on all checks', () => {
  const ETKO = loadStage();
  assert.equal(typeof ETKO.renderStage, 'function', 'ETKO.renderStage must exist');

  const blocked = { innerHTML: '' };
  ETKO.renderStage(blocked, {
    preview: 'HOLD',
    program: 'LOGO',
    disclose: [true, false],
    confirm: [true, true],
  });
  assert.match(blocked.innerHTML, /[가-힣]/, 'stage must carry Korean copy');
  assert.match(blocked.innerHTML, /disabled/, 'TAKE must be disabled until all checks pass');
  const blockedVisible = blocked.innerHTML.replace(/<[^>]*>/g, ' ');
  assert.ok(!/BLACK|HOLD|LOGO/.test(blockedVisible), 'stage must not leak raw mode keys');

  const open = { innerHTML: '' };
  ETKO.renderStage(open, {
    preview: 'HOLD',
    program: 'LOGO',
    disclose: [true, true],
    confirm: [true, true],
  });
  assert.ok(!/disabled/.test(open.innerHTML), 'TAKE must enable when all checks pass');
});

test('stage renders safety buttons and reduced-motion toggle in Korean', () => {
  const ETKO = loadStage();
  const container = { innerHTML: '' };
  ETKO.renderStage(container, {
    preview: 'LOGO',
    program: 'LOGO',
    disclose: [true, true],
    confirm: [true, true],
  });
  assert.match(container.innerHTML, /암전/, 'stage must carry Korean BLACK copy');
  assert.match(container.innerHTML, /대기/, 'stage must carry Korean HOLD copy');
  assert.match(container.innerHTML, /로고/, 'stage must carry Korean LOGO copy');
  assert.match(container.innerHTML, /모션/, 'stage must carry Korean reduced-motion copy');
});

test('reduced-motion toggle defaults off and switches on request', () => {
  const ETKO = loadStage();
  assert.equal(ETKO.reducedMotion, false, 'reduced motion must default off');
  assert.equal(typeof ETKO.setReducedMotion, 'function', 'ETKO.setReducedMotion must exist');
  assert.equal(ETKO.setReducedMotion(true), true, 'must switch reduced motion on');
  assert.equal(ETKO.reducedMotion, true, 'reducedMotion must stay on');
  assert.equal(ETKO.setReducedMotion(false), false, 'must switch reduced motion off');
});

test('stage consumes ETKO.navigate without altering it', () => {
  const ETKO = loadStage({ ETKO: { navigate: () => 'kept', currentView: 'stage' } });
  assert.equal(typeof ETKO.navigate, 'function', 'ETKO.navigate must survive stage load');
  assert.equal(ETKO.navigate('stage'), 'kept', 'stage must not alter navigate semantics');
});

test('stage groups all 28 canonical scenes by the six existing group values', () => {
  const ETKO = loadStageWithScenes();
  const box = { innerHTML: '' };
  ETKO.renderStage(box, { disclose: [false, false], confirm: [false, false] });
  const groups = [...box.innerHTML.matchAll(/<section class="scene-group" data-scene-group="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
  const expectedGroups = Array.from(new Set(Array.from(ETKO.SCENES, (scene) => scene.group)));
  assert.deepEqual(groups.map((match) => match[1]), expectedGroups);
  const renderedIds = groups.flatMap((match) => [...match[2].matchAll(/data-scene="([^"]+)"/g)].map((item) => item[1]));
  assert.equal(renderedIds.length, 28);
  assert.deepEqual(renderedIds, Array.from(ETKO.SCENES, (scene) => scene.id));
  for (const groupId of expectedGroups) {
    const expectedIds = Array.from(ETKO.SCENES).filter((scene) => scene.group === groupId).map((scene) => scene.id);
    const groupMarkup = groups.find((match) => match[1] === groupId)[2];
    assert.match(groupMarkup, /<h3/);
    assert.deepEqual([...groupMarkup.matchAll(/data-scene="([^"]+)"/g)].map((match) => match[1]), expectedIds);
  }
  assert.match(box.innerHTML, /data-take[^>]*disabled/);
});
