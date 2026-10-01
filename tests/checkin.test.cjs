const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CHECKIN_PATH = path.join(ROOT, 'features', 'checkin.js');
const PARTICIPANTS_PATH = path.join(ROOT, 'features', 'participants.js');
const SAMPLE_PATH = path.join(ROOT, 'data', 'sample.json');

function loadCheckin() {
  const sandbox = { console };
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PARTICIPANTS_PATH, 'utf8'), sandbox, {
    filename: 'features/participants.js',
  });
  vm.runInContext(fs.readFileSync(CHECKIN_PATH, 'utf8'), sandbox, {
    filename: 'features/checkin.js',
  });
  return sandbox.window.ETKO || sandbox.ETKO;
}


// vm-realm note (cf. Task 3 report): result objects are created inside the vm
// context, so cross-realm deepEqual on the whole object fails on prototype
// identity. Compare the two string fields instead — product bug-free.
assert.scanResult = function (res, kind, key) {
  assert.equal(res && res.kind, kind, 'scan kind must be ' + kind);
  assert.equal(res && res.key, key, 'scan key must be ' + key);
};

function freshState() {
  const people = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8')).participants;
  return { people, queue: [] };
}

function statuses(state) {
  return state.people.map((p) => p.id + ':' + p.status).join(',');
}

test('booth badge QR is rejected as wrong-kind', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const before = statuses(state);
  const res = ETKO.scan({ code: 'BADGE-14', direction: 'IN', online: true, state });
  assert.scanResult(res, 'bad', 'wrong-kind');
  assert.equal(statuses(state), before, 'wrong-kind must not change statuses');
  assert.equal(state.queue.length, 0, 'wrong-kind must not queue');
});

test('other-event ticket is rejected as wrong-event', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const before = statuses(state);
  const res = ETKO.scan({ code: 'VIP-7781', direction: 'IN', online: true, state });
  assert.scanResult(res, 'bad', 'wrong-event');
  assert.equal(statuses(state), before, 'wrong-event must not change statuses');
  assert.equal(state.queue.length, 0, 'wrong-event must not queue');
});

test('unknown code is not-found', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const res = ETKO.scan({ code: 'EVT-9999', direction: 'IN', online: true, state });
  assert.scanResult(res, 'bad', 'not-found');
  assert.equal(state.queue.length, 0, 'not-found must not queue');
});

test('online IN marks registered person IN', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const res = ETKO.scan({ code: 'EVT-1001', direction: 'IN', online: true, state });
  assert.scanResult(res, 'good', 'success');
  assert.equal(
    state.people.find((p) => p.id === 'p1').status,
    'IN',
    'online IN must mark p1 IN in place'
  );
});

test('duplicate IN is warn + no-op', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const res = ETKO.scan({ code: 'EVT-1003', direction: 'IN', online: true, state });
  assert.scanResult(res, 'warn', 'duplicate');
  assert.equal(
    state.people.find((p) => p.id === 'p3').status,
    'IN',
    'duplicate IN must leave status IN'
  );
  assert.equal(state.queue.length, 0, 'duplicate IN must not queue');
});

test('duplicate IN includes already-queued IN', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const queued = ETKO.scan({ code: 'EVT-1001', direction: 'IN', online: false, state });
  assert.scanResult(queued, 'warn', 'queued');
  assert.equal(
    state.people.find((p) => p.id === 'p1').status,
    'registered',
    'offline scan must not mark status'
  );
  assert.equal(state.queue.length, 1, 'offline scan must queue exactly one entry');

  const again = ETKO.scan({ code: 'EVT-1001', direction: 'IN', online: false, state });
  assert.scanResult(again, 'warn', 'duplicate');
  assert.equal(state.queue.length, 1, 'queued duplicate must not create a second entry');

  const onlineWhileQueued = ETKO.scan({
    code: 'EVT-1001',
    direction: 'IN',
    online: true,
    state,
  });
  assert.scanResult(onlineWhileQueued, 'warn', 'duplicate');
  assert.equal(
    state.people.find((p) => p.id === 'p1').status,
    'registered',
    'online scan of queued IN must stay a no-op until sync'
  );
  assert.equal(state.queue.length, 1, 'online duplicate must not touch the queue');
});

test('OUT without IN is not-in', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const res = ETKO.scan({ code: 'EVT-1001', direction: 'OUT', online: true, state });
  assert.scanResult(res, 'warn', 'not-in');
  assert.equal(
    state.people.find((p) => p.id === 'p1').status,
    'registered',
    'not-in must not change status'
  );
  assert.equal(state.queue.length, 0, 'not-in must not queue');
});

test('online OUT marks IN person back to registered', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  const res = ETKO.scan({ code: 'EVT-1003', direction: 'OUT', online: true, state });
  assert.scanResult(res, 'good', 'success');
  assert.equal(
    state.people.find((p) => p.id === 'p3').status,
    'registered',
    'online OUT must revert p3 to registered'
  );
});

test('sync applies queued scans exactly once', () => {
  const ETKO = loadCheckin();
  const state = freshState();
  ETKO.scan({ code: 'EVT-1001', direction: 'IN', online: false, state });
  assert.equal(state.queue.length, 1);

  const applied = ETKO.syncQueue(state);
  assert.equal(applied, 1, 'sync must apply the single queued entry');
  assert.equal(
    state.people.find((p) => p.id === 'p1').status,
    'IN',
    'sync must mark p1 IN'
  );
  assert.equal(state.queue.length, 0, 'sync must drain the queue');

  const again = ETKO.syncQueue(state);
  assert.equal(again, 0, 'second sync must be a no-op');
  assert.equal(
    state.people.find((p) => p.id === 'p1').status,
    'IN',
    'second sync must not change status'
  );
});

test('check-in desk renders Korean direction toggle, result panel and queue', () => {
  const ETKO = loadCheckin();
  assert.equal(typeof ETKO.renderCheckin, 'function', 'ETKO.renderCheckin must exist');
  const state = freshState();
  const container = { innerHTML: '' };
  ETKO.renderCheckin(container, state);
  assert.match(container.innerHTML, /입장/, 'desk must carry Korean IN copy');
  assert.match(container.innerHTML, /퇴장/, 'desk must carry Korean OUT copy');
  assert.match(container.innerHTML, /대기/, 'desk must carry Korean queue copy');
  assert.match(container.innerHTML, /동기화/, 'desk must carry Korean sync copy');
});
