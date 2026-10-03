const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function load(files) {
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function box() {
  return { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
}

const AGENCY_VIEWS = ['agency-home', 'agency-events', 'agency-clients', 'agency-team'];

test('clients CRUD validates and writes behind permission', () => {
  const ETKO = load(['../app.js', '../features/agency.js']);
  assert.throws(() => ETKO.saveClient({ name: '', email: 'a@b.co' }), /이름/);
  assert.throws(() => ETKO.saveClient({ name: '고객사', email: 'not-an-email' }), /이메일/);
  const c = ETKO.saveClient({ name: '고객사', contact: '김담당', email: 'a@b.co' });
  assert.ok(c.id, 'client must get an id');
  assert.equal(ETKO.store.clients.length, 1);
  const updated = ETKO.saveClient({ id: c.id, name: '고객사2', email: 'b@c.co' });
  assert.equal(updated.name, '고객사2');
  assert.throws(() => ETKO.saveClient({ id: 'c-999', name: 'x', email: 'x@y.co' }), /찾을 수 없습니다/);
  ETKO.setRole('VIEWER');
  assert.throws(() => ETKO.saveClient({ name: '침입', email: 'x@y.co' }), /권한/);
  ETKO.setRole('AGENCY');
  assert.equal(ETKO.removeClient(c.id), c.id);
  assert.equal(ETKO.store.clients.length, 0);
  assert.throws(() => ETKO.removeClient('c-999'), /찾을 수 없습니다/);
});

test('event status moves forward only', () => {
  const ETKO = load(['../app.js', '../features/agency.js']);
  const id = ETKO.createEvent({ name: '신규', date: '2026-12-01', venue: 'B홀' });
  assert.equal(ETKO.setEventStatus(id, 'LIVE'), 'LIVE');
  assert.equal(ETKO.setEventStatus(id, 'END'), 'END');
  assert.throws(() => ETKO.setEventStatus(id, 'LIVE'), /상태/);
  const id2 = ETKO.createEvent({ name: '신규2', date: '2026-12-02', venue: 'C홀' });
  assert.throws(() => ETKO.setEventStatus(id2, 'END'), /상태/);
  assert.throws(() => ETKO.setEventStatus('evt-999', 'LIVE'), /찾을 수 없습니다/);
  ETKO.setRole('VIEWER');
  assert.throws(() => ETKO.setEventStatus(id2, 'LIVE'), /권한/);
  ETKO.setRole('AGENCY');
});

test('agency summary aggregates every event', () => {
  const ETKO = load(['../app.js', '../features/agency.js']);
  const s = ETKO.agencySummary();
  assert.equal(s.total, ETKO.store.events.length);
  assert.equal(s.live + s.pre + s.ended, s.total);
  assert.ok(s.participants >= 0 && s.pending >= 0);
});

test('agency routes gate by role', () => {
  const ETKO = load(['../app.js', '../features/agency.js']);
  for (const v of AGENCY_VIEWS) {
    assert.equal(ETKO.canRoute('AGENCY', v), true, `${v} agency`);
    assert.equal(ETKO.canRoute('MANAGER', v), true, `${v} manager`);
    assert.equal(ETKO.canRoute('STAFF', v), false, `${v} staff denied`);
    assert.equal(ETKO.canRoute('VIEWER', v), true, `${v} viewer read`);
  }
  assert.equal(ETKO.canRoute('STAFF', 'checkin'), true, 'staff keeps field routes');
});

test('agency home renders stats, events and activity in the shared patterns', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  assert.match(b.innerHTML, /진행 중/, 'home misses live count');
  assert.match(b.innerHTML, /stat-value/, 'home misses stat band');
  assert.match(b.innerHTML, /class="cards"/, 'home event list misses cards');
  assert.match(b.innerHTML, /EVENTOUCH 운영 샘플/, 'home misses the seeded event');
});

test('agency events view renders the 3-step wizard and the event list', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/results.js', '../features/agency-ui.js']);
  ETKO.agencyUi = { step: 1, draft: {} };
  const b = box();
  ETKO.renderAgencyEvents(b);
  assert.match(b.innerHTML, /행사명/, 'wizard step 1 misses the name field');
  assert.match(b.innerHTML, /data-wizard-next/, 'wizard misses next');
  ETKO.agencyUi = { step: 2, draft: { name: '신규', date: '2026-12-01', venue: 'B홀', features: {} } };
  const step2 = box();
  ETKO.renderAgencyEvents(step2);
  assert.match(step2.innerHTML, /투표/, 'wizard step 2 misses feature labels');
  assert.match(step2.innerHTML, /럭키드로우/, 'wizard step 2 misses feature labels');
  assert.match(b.innerHTML, /data-event-open/, 'event list misses workspace entry');
  assert.match(b.innerHTML, /data-event-status/, 'event list misses status control');
});

test('agency clients view renders cards, form and shared empty', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyClients(b);
  assert.match(b.innerHTML, /data-empty/, 'clients misses the empty pattern');
  assert.match(b.innerHTML, /등록된 고객사가 없습니다/, 'clients misses empty copy');
  assert.match(b.innerHTML, /data-client-save/, 'clients misses the form');
  ETKO.saveClient({ name: '고객사', email: 'a@b.co' });
  const full = box();
  ETKO.renderAgencyClients(full);
  assert.match(full.innerHTML, /고객사/, 'clients misses saved rows');
  assert.match(full.innerHTML, /data-client-del/, 'clients misses delete');
});

test('agency team view renders the member matrix on the active event', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyTeam(b);
  assert.match(b.innerHTML, /data-empty/, 'team misses the empty pattern');
  ETKO.saveMember({ name: '팀원', email: 't@e.co', role: 'STAFF' });
  const full = box();
  ETKO.renderAgencyTeam(full);
  assert.match(full.innerHTML, /팀원/, 'team misses saved members');
  assert.match(full.innerHTML, /data-member-add/, 'team misses the add control');
});

test('shell carries the four agency views with sections, mounts and labels', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ko = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'ko.json'), 'utf8'));
  const mounts = {
    'agency-home': 'agency-home-mount',
    'agency-events': 'agency-events-mount',
    'agency-clients': 'agency-clients-mount',
    'agency-team': 'agency-team-mount',
  };
  for (const v of AGENCY_VIEWS) {
    assert.match(html, new RegExp('data-view="' + v + '"'), `shell misses nav ${v}`);
    assert.match(html, new RegExp('id="' + v + '-view"'), `shell misses section ${v}`);
    assert.match(html, new RegExp('id="' + mounts[v] + '"'), `shell misses mount ${v}`);
    assert.ok(typeof ko[v] === 'string' && ko[v].trim() !== '', `ko.json misses label ${v}`);
  }
  assert.equal(ko['agency-home'], '대행사 홈');
  assert.equal(ko['agency-events'], '행사 관리');
  assert.equal(ko['agency-clients'], '고객사');
  assert.equal(ko['agency-team'], '팀과 권한');
});
