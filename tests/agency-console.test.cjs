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

function formBox(values, actionAttrs) {
  const handlers = {};
  const fields = {};
  const buttons = {};
  Object.keys(values).forEach((attr) => {
    fields[attr] = {
      value: values[attr],
      checked: false,
      focused: false,
      focus() { this.focused = true; },
    };
  });
  (actionAttrs || []).forEach((attr) => {
    buttons[attr] = {
      addEventListener(type, handler) { if (type === 'click') handlers[attr] = handler; },
      getAttribute(name) { return name === attr ? '' : null; },
    };
  });
  return {
    handlers,
    fields,
    buttons,
    innerHTML: '',
    querySelector(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      return match ? fields[match[1]] || buttons[match[1]] || null : null;
    },
    querySelectorAll(selector) {
      const match = /^\[([^\]]+)\]$/.exec(selector);
      if (!match) return [];
      const item = fields[match[1]] || buttons[match[1]];
      return item ? [item] : [];
    },
  };
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

test('agency home heading states context and offers event creation shortcut', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  assert.match(b.innerHTML, /대행사 · 전체 현장/, 'home heading misses the context eyebrow');
  assert.match(b.innerHTML, /관리 중인 행사와 현장 요청을 한곳에서 확인합니다/, 'home heading misses the sub-copy');
  assert.match(b.innerHTML, /새 행사 만들기/, 'home heading misses the creation shortcut');
});

test('agency home events panel links to the full list', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  assert.match(b.innerHTML, /최근 일정과 준비 상태/, 'events panel misses the sub-copy');
  assert.match(b.innerHTML, /행사 목록 모두 보기/, 'events panel misses the view-all link');
});

test('agency home stat cards carry context sub-labels', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  const subs = b.innerHTML.match(/stat-sub/g) || [];
  assert.equal(subs.length, 4, 'each of the four stat cards needs a context sub-label');
});

test('agency home event cards mark the primary action and status chip', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  assert.match(b.innerHTML, /data-event-open[^>]*event-open-primary|event-open-primary[^>]*data-event-open/, 'workspace entry misses primary marking');
  assert.match(b.innerHTML, /event-status-chip/, 'event card misses the status chip');
  assert.match(b.innerHTML, /data-event-status/, 'event card misses status control');
});

test('agency home lays events and activity out as a dashboard', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  assert.match(b.innerHTML, /agency-dashboard/, 'home misses the dashboard layout wrapper');
});

test('empty activity offers a next action on an existing route', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderAgencyHome(b);
  assert.match(b.innerHTML, /최근 활동이 없습니다/, 'home misses the empty activity copy');
  assert.match(b.innerHTML, /data-agency-next="agency-events"/, 'empty activity misses the next-action route');
});

test('PRE overview names the next step toward day-of operation', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/results.js', '../features/agency-ui.js']);
  const b = box();
  ETKO.renderOverview(b);
  assert.match(b.innerHTML, /진행 중으로 전환/, 'PRE overview misses the next-step note');
  ETKO.setEventStatus(ETKO.store.activeEventId, 'LIVE');
  const live = box();
  ETKO.renderOverview(live);
  assert.doesNotMatch(live.innerHTML, /진행 중으로 전환/, 'LIVE overview must not show the PRE next-step note');
});

test('selected-event overview shows live context and routes quick actions to existing day-of views', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/results.js', '../features/agency-ui.js']);
  const handlers = {};
  const routes = [];
  const actions = ['checkin', 'booth'].map((route) => ({
    getAttribute(name) { return name === 'data-overview-route' ? route : null; },
    addEventListener(type, fn) { if (type === 'click') handlers[route] = fn; },
  }));
  const b = {
    innerHTML: '',
    querySelectorAll(selector) { return selector === '[data-overview-route]' ? actions : []; },
  };
  ETKO.navigate = (route) => { routes.push(route); return route; };

  ETKO.renderOverview(b);

  const event = ETKO.store.events.find((item) => item.id === ETKO.store.activeEventId);
  assert.match(b.innerHTML, new RegExp(event.name));
  assert.match(b.innerHTML, new RegExp(event.date));
  assert.match(b.innerHTML, new RegExp(event.venue));
  assert.match(b.innerHTML, /data-overview-metric="total"/);
  assert.match(b.innerHTML, /data-overview-route="checkin"/);
  assert.match(b.innerHTML, /data-overview-route="booth"/);
  handlers.checkin.call(actions[0]);
  handlers.booth.call(actions[1]);
  assert.deepEqual(routes, ['checkin', 'booth']);
});

test('overview hides quick actions the current role cannot open', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/results.js', '../features/agency-ui.js']);
  ETKO.setRole('VIEWER');
  const b = box();

  ETKO.renderOverview(b);

  assert.doesNotMatch(b.innerHTML, /data-overview-route="checkin"/);
  assert.match(b.innerHTML, /data-overview-route="booth"/);
});

test('agency renderer uses structured field metadata even when error copy has no field keyword', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const clients = formBox({
    'data-client-name': '고객사 샘플',
    'data-client-contact': '김담당',
    'data-client-email': 'invalid-email',
  }, ['data-client-save']);
  ETKO.saveClient = function () {
    const error = new Error('Validation rejected this value');
    error.field = 'email';
    throw error;
  };

  ETKO.renderAgencyClients(clients);
  clients.handlers['data-client-save'].call(clients.buttons['data-client-save']);

  assert.match(clients.innerHTML, /data-client-email[^>]*aria-invalid="true"/);
  assert.equal(clients.fields['data-client-email'].focused, true);
});

test('opening a workspace from the cross-site list switches event and enters its overview', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const eventId = ETKO.createEvent({ name: '워크스페이스 이동 확인', date: '2026-10-10', venue: '테스트 장소' });
  const handlers = {};
  const button = {
    getAttribute(name) { return name === 'data-event-open' ? eventId : null; },
    addEventListener(type, fn) { if (type === 'click') handlers.open = fn; },
  };
  const mount = {
    innerHTML: '',
    querySelectorAll(selector) { return selector === '[data-event-open]' ? [button] : []; },
  };
  ETKO.currentView = 'agency-events';

  ETKO.renderAgencyEvents(mount);
  handlers.open.call(button);

  assert.equal(ETKO.store.activeEventId, eventId);
  assert.equal(ETKO.currentView, 'overview');
});

test('overview shell delegates to the selected-event renderer', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /view === 'overview'[\s\S]{0,220}ETKO\.renderOverview\(mount\)/);
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

test('agency forms use date and email input types', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const events = box();
  const clients = box();
  const team = box();
  ETKO.renderAgencyEvents(events);
  ETKO.renderAgencyClients(clients);
  ETKO.renderAgencyTeam(team);
  assert.match(events.innerHTML, /data-wdate type="date"/);
  assert.match(clients.innerHTML, /data-client-email type="email"/);
  assert.match(team.innerHTML, /data-member-email type="email"/);
});

test('wizard date errors stay on that field, restore focus, and preserve the other values', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const events = formBox({
    'data-wname': '운영 포럼',
    'data-wdate': '',
    'data-wvenue': 'A홀',
  }, ['data-wizard-next', 'data-wizard-back']);
  ETKO.renderAgencyEvents(events);
  events.handlers['data-wizard-next'].call(events.buttons['data-wizard-next']);
  assert.match(events.innerHTML, /data-wdate[^>]*aria-invalid="true"/);
  assert.match(events.innerHTML, /id="wdate-error"[^>]*>행사 날짜를 입력하세요/);
  assert.match(events.innerHTML, /value="운영 포럼"/);
  assert.match(events.innerHTML, /value="A홀"/);
  assert.equal(events.fields['data-wdate'].focused, true);

  events.fields['data-wdate'].value = '2026-10-04';
  events.handlers['data-wizard-next'].call(events.buttons['data-wizard-next']);
  assert.match(events.innerHTML, /2단계 참여기능/);
  assert.doesNotMatch(events.innerHTML, /행사 날짜를 입력하세요/);
  events.handlers['data-wizard-back'].call(events.buttons['data-wizard-back']);
  assert.match(events.innerHTML, /value="2026-10-04"/);
  assert.match(events.innerHTML, /value="운영 포럼"/);
  assert.match(events.innerHTML, /value="A홀"/);

  const clients = box();
  ETKO.renderAgencyClients(clients);
  assert.doesNotMatch(clients.innerHTML, /행사 날짜를 입력하세요/);
});

test('client email error preserves draft and focuses the invalid email field', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const clients = formBox({
    'data-client-name': '고객사 샘플',
    'data-client-contact': '김담당',
    'data-client-email': 'invalid-email',
  }, ['data-client-save']);
  ETKO.renderAgencyClients(clients);
  clients.handlers['data-client-save'].call(clients.buttons['data-client-save']);
  assert.match(clients.innerHTML, /data-client-email[^>]*aria-invalid="true"/);
  assert.match(clients.innerHTML, /id="client-email-error"[^>]*>이메일 형식이 올바르지 않습니다/);
  assert.match(clients.innerHTML, /value="고객사 샘플"/);
  assert.match(clients.innerHTML, /value="김담당"/);
  assert.match(clients.innerHTML, /value="invalid-email"/);
  assert.equal(clients.fields['data-client-email'].focused, true);
  assert.equal(ETKO.store.clients.length, 0, 'invalid data must not be written');
});

test('team form errors and drafts stay event-local and restore when returning to that event', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/agency-ui.js']);
  const firstEvent = ETKO.store.activeEventId;
  const first = formBox({
    'data-member-name': '현장 담당자',
    'data-member-email': 'invalid-email',
  }, ['data-member-add']);
  ETKO.renderAgencyTeam(first);
  first.handlers['data-member-add'].call(first.buttons['data-member-add']);
  assert.match(first.innerHTML, /member-email-error/);
  assert.equal(first.fields['data-member-email'].focused, true);

  const secondEvent = ETKO.createEvent({ name: '다른 현장', date: '2026-12-01', venue: 'B홀' });
  ETKO.switchEvent(secondEvent);
  const second = box();
  ETKO.renderAgencyTeam(second);
  assert.doesNotMatch(second.innerHTML, /invalid-email|현장 담당자|이메일 형식이 올바르지 않습니다/);

  ETKO.switchEvent(firstEvent);
  const restored = box();
  ETKO.renderAgencyTeam(restored);
  assert.match(restored.innerHTML, /value="현장 담당자"/);
  assert.match(restored.innerHTML, /value="invalid-email"/);
  assert.match(restored.innerHTML, /이메일 형식이 올바르지 않습니다/);
});

test('shell keeps four agency-owned routes while placing team in the selected-event preparation group', () => {
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
  assert.equal(ko['agency-home'], '현장 홈');
  assert.equal(ko['agency-events'], '현장 관리');
  assert.equal(ko['agency-clients'], '고객사');
  assert.equal(ko['agency-team'], '운영 팀');
  const globalGroup = /<div[^>]*data-nav-layer="agency"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] || '';
  const preparationGroup = /<div[^>]*data-nav-layer="event"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] || '';
  assert.match(globalGroup, /data-view="agency-home"/);
  assert.match(globalGroup, /data-view="agency-events"/);
  assert.match(globalGroup, /data-view="agency-clients"/);
  assert.doesNotMatch(globalGroup, /agency-team/);
  assert.match(preparationGroup, /data-view="agency-team"/);
});
