const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FEATURE_PATH = path.join(ROOT, 'features', 'participants.js');
const SAMPLE_PATH = path.join(ROOT, 'data', 'sample.json');
const HTML_PATH = path.join(ROOT, 'index.html');

function loadParticipants() {
  const src = fs.readFileSync(FEATURE_PATH, 'utf8');
  const sandbox = { console };
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'features/participants.js' });
  return sandbox.window.ETKO || sandbox.ETKO;
}

function samplePeople() {
  return JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8')).participants;
}

test('filterPeople searches by name, email and code', () => {
  const ETKO = loadParticipants();
  const people = samplePeople();
  assert.equal(typeof ETKO.filterPeople, 'function', 'ETKO.filterPeople must be a function');

  const byName = ETKO.filterPeople({ q: '민준' }, people);
  assert.ok(byName.some((p) => p.id === 'p1'), 'name search must find p1');

  const byEmail = ETKO.filterPeople({ q: 'seoyeon.lee' }, people);
  assert.ok(byEmail.some((p) => p.id === 'p2'), 'email search must find p2');

  const byCode = ETKO.filterPeople({ q: 'evt-1003' }, people);
  assert.ok(byCode.some((p) => p.id === 'p3'), 'code search must be case-insensitive and find p3');
});

test('filterPeople filters VIP tickets', () => {
  const ETKO = loadParticipants();
  const people = samplePeople();
  const vips = ETKO.filterPeople({ ticket: 'VIP' }, people);
  assert.deepEqual(
    vips.map((p) => p.id).sort(),
    ['p2', 'p4'],
    'VIP filter must return exactly p2 and p4'
  );
});

test('filterPeople normalizes status case-insensitively (IN filter)', () => {
  const ETKO = loadParticipants();
  const people = samplePeople();
  // Sample mixes lowercase "registered" with uppercase "IN"; both casings must work.
  const upper = ETKO.filterPeople({ status: 'IN' }, people);
  const lower = ETKO.filterPeople({ status: 'in' }, people);
  assert.deepEqual(
    upper.map((p) => p.id).sort(),
    ['p3', 'p4'],
    'status IN must return p3 and p4'
  );
  assert.deepEqual(
    lower.map((p) => p.id).sort(),
    ['p3', 'p4'],
    'status in (lowercase) must also return p3 and p4'
  );
  const registered = ETKO.filterPeople({ status: 'REGISTERED' }, people);
  assert.deepEqual(
    registered.map((p) => p.id).sort(),
    ['p1', 'p2', 'p5'],
    'status REGISTERED (any case) must return the registered three'
  );
});

test('empty result copy is Korean', () => {
  const ETKO = loadParticipants();
  const copy = ETKO.PEOPLE_EMPTY;
  assert.ok(typeof copy === 'string' && copy.trim() !== '', 'PEOPLE_EMPTY must be non-empty');
  assert.match(copy, /[가-힣]/, 'empty result copy must be Korean');
});

test('selection set survives re-render', () => {
  const ETKO = loadParticipants();
  // NOTE: vm sandbox has its own Set realm, so duck-type instead of instanceof.
  assert.ok(
    ETKO.selectedIds &&
      typeof ETKO.selectedIds.has === 'function' &&
      typeof ETKO.selectedIds.add === 'function' &&
      typeof ETKO.selectedIds.clear === 'function',
    'ETKO.selectedIds must be a Set'
  );
  const people = samplePeople().slice(0, 2);
  const first = { innerHTML: '' };
  const second = { innerHTML: '' };

  ETKO.clearSelection();
  ETKO.toggleSelect('p1');
  assert.ok(ETKO.selectedIds.has('p1'), 'toggleSelect must add p1');

  ETKO.renderPeople(first, people);
  ETKO.renderPeople(second, people);
  assert.ok(ETKO.selectedIds.has('p1'), 'selection must survive re-render');
  assert.match(second.innerHTML, /checked/, 're-rendered HTML must keep p1 checked');
});

test('counts and bulk IN mark selected participants', () => {
  const ETKO = loadParticipants();
  const people = samplePeople();
  const counts = ETKO.peopleCounts(people);
  assert.equal(counts.total, 5, 'sample has five participants');
  assert.equal(counts.in, 2, 'two participants are IN');

  ETKO.clearSelection();
  ETKO.toggleSelect('p1');
  const marked = ETKO.bulkCheckIn(people);
  assert.equal(marked, 1, 'bulk IN must mark one selected participant');
  assert.equal(
    people.find((p) => p.id === 'p1').status,
    'IN',
    'bulk IN must set p1 status to IN'
  );
});

test('index.html mounts the participants directory', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.match(
    html,
    /<script[^>]*src="features\/participants\.js"[^>]*>/,
    'index.html must load features/participants.js'
  );
  assert.match(html, /참가자/, 'participants mount must carry Korean copy');
});
