'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', 'assets', 'js', 'server-sync.js');
const ACCOUNT = { id: 'agency-1', email: 'agency@example.test', name: '운영사', role: 'AGENCY', active: true };

function state(overrides = {}) {
  return {
    version: 9,
    revision: 0,
    activeEventId: 'event-1',
    events: [{ id: 'event-1', slug: 'event-one', name: '행사', stage: 'LIVE', features: [], date: '2026-11-01', start: '09:00', end: '17:00', capacity: 10 }],
    workspaces: {
      'event-1': {
        participants: [],
        checks: [],
        desks: [{ id: 'desk-1', name: '입장 데스크', action: 'IN', open: true }],
        assignments: [{ id: 'assignment-1', accountId: ACCOUNT.id, type: 'DESK', targetId: 'desk-1' }],
        publishedVersion: 1,
        publishedFields: [{ id: 'name', label: '이름', type: 'text', required: true }],
        registrationOpen: true,
        consentText: '안내',
        ...overrides.workspace,
      },
    },
    clients: [],
    accounts: [ACCOUNT],
    memberships: [],
    invitations: [],
    globalAudit: [],
    commands: [],
    ...overrides,
  };
}

function loadAdapter(fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
  assert.ok(fs.existsSync(SOURCE), 'the server-sync adapter must be present before its transport contract is exercised');
  const calls = [];
  const listeners = new Map();
  const values = new Map();
  let localStorageWrites = 0;
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { localStorageWrites += 1; values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const window = {
    ET: {
      ui: {},
      handlers: {},
      state: null,
      session: null,
      route: null,
      forms: {},
      readDisk: () => ({ version: 9, events: [{ id: 'demo' }] }),
      storageMode: 'server',
      id: () => 'command-fixed-123456',
      copy: (value) => JSON.parse(JSON.stringify(value)),
      event() { return this.state?.events.find((event) => event.id === this.route?.eventId) || null; },
      can: () => true,
      persist() { throw new Error('server mode must not persist app state locally'); },
      acceptState(next) { this.state = next; },
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return fetchImpl(String(url), options);
    },
    localStorage,
    navigator: { onLine: true },
    location: { hash: '#/login' },
    crypto: { randomUUID: () => 'random-id' },
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), { window, URLSearchParams });
  return {
    E: window.ET,
    calls,
    values,
    get localStorageWrites() { return localStorageWrites; },
    set online(value) { window.navigator.onLine = value; },
    dispatch(name) { return listeners.get(name)?.(); },
  };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('invitation transport retains a one-time link only in current-tab account-bound memory', async () => {
  const h = loadAdapter(async (url, options) => {
    if (url === '/api/auth/invitations') {
      const body=JSON.parse(options.body); assert.equal(body.commandId,'invite-stable-123');
      return response(201,{invitation:{id:'inv-1',name:'팀원',role:'STAFF',status:'PENDING'},token:'one-time-synthetic-token'});
    }
    if (url === '/api/auth/invitations/inv-1/revoke') return response(200,{invitation:{id:'inv-1',status:'REVOKED'}});
    return response(200,{});
  });
  h.E.session=ACCOUNT;h.E.state=state();
  assert.equal(typeof h.E.remote.createInvitation,'function');
  const created=await h.E.remote.createInvitation({name:'팀원',email:'team@example.test',role:'STAFF',commandId:'invite-stable-123'});
  assert.equal(created.id,'inv-1');assert.equal(created.token,undefined);
  assert.equal(h.E.remote.invitationLink('inv-1'),'#/invite/one-time-synthetic-token');
  assert.equal(JSON.stringify(h.E.state).includes('one-time-synthetic-token'),false);
  assert.equal(h.localStorageWrites,0);
  h.E.session={...ACCOUNT,id:'another-account'};
  assert.equal(h.E.remote.invitationLink('inv-1'),null);
  h.E.session=ACCOUNT;
  await h.E.remote.revokeInvitation('inv-1','revoke-stable-123');
  assert.equal(h.E.remote.invitationLink('inv-1'),null);
});
test('lost invitation response retries the identical command and reports unavailable link honestly', async () => {
  let attempts=0;
  const h=loadAdapter(async()=>{
    if(++attempts===1)throw Error('response lost');
    return response(409,{error:'초대 링크 재발급 불가',code:'INVITATION_LINK_UNAVAILABLE'});
  });
  h.E.session=ACCOUNT;h.E.state=state();
  assert.equal(typeof h.E.remote.createInvitation,'function');
  await assert.rejects(h.E.remote.createInvitation({name:'팀원',email:'team@example.test',role:'STAFF',commandId:'invite-lost-123'}),{status:409,code:'INVITATION_LINK_UNAVAILABLE'});
  assert.equal(h.calls.length,2);assert.equal(h.calls[0].options.body,h.calls[1].options.body);
  assert.equal(h.E.remote.invitationLink('inv-1'),null);
});
test('invitation links are not recoverable in a new tab or after logout',async()=>{
  const fresh=loadAdapter();assert.equal(typeof fresh.E.remote.invitationLink,'function');
  assert.equal(fresh.E.remote.invitationLink('inv-1'),null);
  const h=loadAdapter(async url=>url==='/api/auth/invitations'?response(201,{invitation:{id:'inv-1'},token:'one-time-token'}):response(200,{}));
  h.E.session=ACCOUNT;
  await h.E.remote.createInvitation({role:'STAFF',commandId:'invite-logout-123'});
  await h.E.remote.logout();h.E.session=ACCOUNT;
  assert.equal(h.E.remote.invitationLink('inv-1'),null);assert.equal(h.localStorageWrites,0);
});

test('member commands use invitation endpoints and hydrate token-free state instead of event commands',async()=>{
  let revoked=false;
  const h=loadAdapter(async(url,options)=>{
    if(url==='/api/bootstrap')return response(200,{state:state({invitations:[{id:'inv-1',status:revoked?'REVOKED':'PENDING'}]})});
    if(url==='/api/auth/invitations'){
      const input=JSON.parse(options.body);assert.equal(input.role,'MANAGER');assert.equal(input.commandId,'invite-command-123');
      return response(201,{invitation:{id:'inv-1',status:'PENDING'},token:'one-time-command-token'});
    }
    if(url==='/api/auth/invitations/inv-1/revoke'){revoked=true;return response(200,{invitation:{id:'inv-1',status:'REVOKED'}});}
    return response(404,{error:'wrong command route'});
  });
  h.E.state=state();h.E.session=ACCOUNT;h.E.route={scope:'agency',page:'team'};
  h.E.handlers['member.invite']={group:'agency',options:{}};h.E.handlers['member.revoke']={group:'agency',options:{}};
  const created=await h.E.run('member.invite',{name:'매니저',email:'manager@example.test',role:'MANAGER',commandId:'invite-command-123'});
  assert.equal(created.id,'inv-1');assert.equal(h.E.state.invitations[0].status,'PENDING');
  assert.equal(h.E.remote.invitationLink('inv-1'),'#/invite/one-time-command-token');
  await h.E.run('member.revoke',{id:'inv-1',commandId:'revoke-command-123'});
  assert.equal(h.E.state.invitations[0].status,'REVOKED');assert.equal(h.E.remote.invitationLink('inv-1'),null);
  assert.equal(JSON.stringify(h.E.state).includes('one-time-command-token'),false);assert.equal(h.localStorageWrites,0);
});

test('legacy operator invitations post as manager with only the server contract fields', async () => {  let body = null;
  const h = loadAdapter(async (url, options) => {
    if (url === '/api/auth/invitations') {
      body = JSON.parse(options.body);
      return response(201, { invitation: { id: 'inv-legacy', role: 'MANAGER', status: 'PENDING' }, token: 'legacy-one-time-token' });
    }
    return response(200, {});
  });
  h.E.session = ACCOUNT; h.E.state = state();
  const created = await h.E.remote.createInvitation({ name: '팀원', email: 'legacy@example.test', role: 'OPERATOR', eventId: 'event-1', write: ['all'], orgPermissions: ['team.manage'], commandId: 'invite-legacy-1' });
  assert.equal(created.id, 'inv-legacy');
  assert.equal(body.role, 'MANAGER');
  assert.equal(body.eventId, 'event-1');
  assert.equal(body.commandId, 'invite-legacy-1');
  assert.equal(Object.hasOwn(body, 'write'), false);
  assert.equal(Object.hasOwn(body, 'orgPermissions'), false);
  await assert.rejects(h.E.remote.createInvitation({ name: '팀원', email: 'admin@example.test', role: 'ADMIN' }), /운영사 구성원|현장 스태프/);
  await assert.rejects(h.E.remote.createInvitation({ name: '행사 지정 스태프', email: 'staff@example.test', role: 'STAFF', eventId: 'event-1' }), /행사/);
  assert.equal(h.calls.filter(call => call.url === '/api/auth/invitations').length, 1);
  assert.equal(h.E.remote.invitationLink('inv-legacy'), '#/invite/legacy-one-time-token');
});

test('file upload sends raw bytes with a stable retry ID and no local authoritative write', async () => {
  const file = {name:'배치도.png',type:'image/png',size:3,bytes:new Uint8Array([1,2,3])};
  let attempts = 0;
  const harness = loadAdapter(async (url, options) => {
    assert.equal(options.body,file);
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.headers['content-type'],'image/png');
    if (++attempts === 1) throw Error('response lost');
    return response(201,{file:{fileId:'file-123',name:file.name,type:file.type,size:3,width:320,height:200,storage_key:'do-not-use'}});
  });
  assert.equal(typeof harness.E.remote.uploadFile,'function');
  const result = await harness.E.remote.uploadFile(file,{eventId:'event-1',commandId:'upload-fixed-123'});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{fileId:'file-123',name:file.name,type:'image/png',size:3,width:320,height:200});
  assert.equal(harness.calls.length,2); assert.equal(harness.calls[0].url,harness.calls[1].url);
  assert.ok(harness.calls[0].url.includes('commandId=upload-fixed-123'));
  assert.equal(harness.localStorageWrites,0);
});
test('file upload preserves permission errors and preview never contacts the shared API', async () => {
  const h = loadAdapter(async () => response(403,{error:'권한 없음'}));
  assert.equal(typeof h.E.remote.uploadFile,'function');
  await assert.rejects(h.E.remote.uploadFile({name:'map.png',type:'image/png',size:1},{eventId:'event-1'}),{status:403});
  h.E.previewMode = true;
  await assert.rejects(h.E.remote.uploadFile({name:'map.png',type:'image/png',size:1},{eventId:'event-1'}),/서버/);
  assert.equal(h.calls.length,1);
});
test('file URLs remain same-origin and reject missing or unsafe identifiers', () => {
  const h = loadAdapter(); assert.equal(typeof h.E.remote.fileURL,'function');
  assert.equal(h.E.remote.fileURL({eventId:'event-1',fileId:'file-1'}),'/api/events/event-1/files/file-1');
  assert.equal(h.E.remote.fileURL({slug:'event-one',fileId:'file-1',public:true}),'/api/public/events/event-one/files/file-1');
  for (const input of [{fileId:'file-1'},{eventId:'../secret',fileId:'file-1'},
    {eventId:'event-1',fileId:'https://other.test/file'},{public:true,slug:'../secret',fileId:'file-1'}])
    assert.throws(() => h.E.remote.fileURL(input));
});

test('automatic online replay removes the stale pending panel and renders confirmed server records', async () => {
  const updated = state({ workspace: { checks: [{ id: 'check-confirmed' }] } });
  const harness = loadAdapter(async (url) => response(200, url === '/api/bootstrap' ? { state: updated } : { action: 'IN' }));
  harness.E.state = state();
  harness.E.session = ACCOUNT;
  harness.E.ui.scanResult = { pendingSync: true };
  harness.E.remote.enqueueCheckin({ eventId: 'event-1', assignmentId: 'assignment-1', payload: { ticket: 'test-ticket', deskId: 'desk-1' } });
  let visibleCheck = null;
  harness.E.render = () => { visibleCheck = harness.E.state.workspaces['event-1'].checks[0]; };
  await harness.dispatch('online');
  await new Promise(setImmediate);
  assert.equal(harness.E.remote.readCheckinQueue().length, 0);
  assert.equal(harness.E.ui.scanResult, null);
  assert.equal(visibleCheck?.id, 'check-confirmed');
});

test('partial check-in replay shows committed records while preserving the denied queue item', async () => {
  const updated = state({ workspace: { checks: [{ id: 'check-first' }] } });
  const harness = loadAdapter(async (url, options) => {
    if (url === '/api/bootstrap') return response(200, { state: updated });
    return JSON.parse(options.body).commandId === 'second-command'
      ? response(403, { error: '업무 배정이 해제되었습니다' }) : response(200, { action: 'IN' });
  });
  harness.E.state = state();
  harness.E.session = ACCOUNT;
  for (const [commandId, ticket] of [['first-command', 'first-ticket'], ['second-command', 'second-ticket']]) {
    harness.E.remote.enqueueCheckin({ eventId: 'event-1', assignmentId: 'assignment-1', commandId, payload: { ticket, deskId: 'desk-1' } });
  }
  const result = await harness.E.remote.replayCheckins();
  assert.equal(result.applied, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.error.status, 403);
  assert.equal(harness.E.remote.readCheckinQueue()[0].commandId, 'second-command');
  assert.equal(harness.E.state.workspaces['event-1'].checks[0]?.id, 'check-first');
  assert.equal(harness.E.remote.status, 'denied');
});

for (const scope of ['agency', 'console', 'staff']) {
  test(`${scope} navigation reads other users' committed changes before rendering`, async () => {
    const updated = state({ workspace: { participants: [{ id: 'new-person', name: '새 참가자', inside: true }] } });
    const harness = loadAdapter(async () => response(200, { state: updated }));
    harness.E.state = state();
    harness.E.session = ACCOUNT;
    harness.E.parseRoute = () => ({ scope, eventId: 'event-1', params: new URLSearchParams() });
    let renderedPerson = null;
    harness.E.render = () => { renderedPerson = harness.E.state.workspaces['event-1'].participants[0]; };
    await harness.E.handleRouteChange();
    assert.equal(renderedPerson?.id, 'new-person');
    assert.equal(renderedPerson.inside, true);
    assert.equal(harness.calls[0].url, '/api/bootstrap');
    assert.equal(harness.localStorageWrites, 0);
  });
}

test('credential login hydrates the PostgreSQL bootstrap using same-origin cookies', async () => {
  const serverState = state();
  const harness = loadAdapter(async (url, options) => {
    if (url === '/api/auth/login') {
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      assert.deepEqual(JSON.parse(options.body), { email: ACCOUNT.email, password: 'a-real-test-password' });
      return response(200, { user: ACCOUNT });
    }
    if (url === '/api/bootstrap') return response(200, { state: serverState });
    return response(404, { error: 'unexpected route' });
  });

  await harness.E.remote.login({ email: ACCOUNT.email, password: 'a-real-test-password' });

  assert.equal(harness.E.storageMode, 'server');
  assert.equal(harness.E.session.id, ACCOUNT.id);
  assert.equal(harness.E.state.events[0].id, 'event-1');
  assert.deepEqual(harness.calls.map((call) => call.url), ['/api/auth/login', '/api/bootstrap']);
  assert.equal(harness.localStorageWrites, 0);
});

test('server command retries with the same command id and never writes the local app store', async () => {
  const originalState = state();
  const refreshedState = state({ revision: 1 });
  let commandAttempts = 0;
  const harness = loadAdapter(async (url, options) => {
    if (url === '/api/events/event-1/commands') {
      commandAttempts += 1;
      if (commandAttempts === 1) throw new TypeError('temporary network failure');
      return response(200, { name: '참가자', action: 'IN' });
    }
    if (url === '/api/bootstrap') return response(200, { state: refreshedState });
    return response(404, { error: 'unexpected route' });
  });
  const E = harness.E;
  E.storageMode = 'server';
  E.state = originalState;
  E.session = ACCOUNT;
  E.route = { scope: 'staff', eventId: 'event-1', assignmentId: 'assignment-1' };
  E.handlers['check.scan'] = {
    group: 'onsite',
    options: {},
    fn(shadow, payload) { shadow.workspaces['event-1'].checks.push(payload); },
  };

  const result = await E.run('check.scan', { deskId: 'desk-1', ticket: 'ticket-1' });

  const posts = harness.calls.filter((call) => call.url === '/api/events/event-1/commands');
  assert.equal(commandAttempts, 2);
  assert.equal(JSON.parse(posts[0].options.body).commandId, JSON.parse(posts[1].options.body).commandId);
  assert.equal(JSON.parse(posts[0].options.body).assignmentId, 'assignment-1');
  assert.deepEqual(result, { name: '참가자', action: 'IN' });
  assert.equal(harness.E.state.revision, 1);
  assert.deepEqual(originalState.workspaces['event-1'].checks, []);
  assert.equal(harness.localStorageWrites, 0);
});

test('public attendee hydration keeps ticket bearer transport out of the URL', async () => {
  const publicResponse = { event: state().events[0], workspace: state().workspaces['event-1'] };
  const participant = { id: 'person-1', ticket: 'ticket-bearer-123', name: '참가자', status: 'APPROVED' };
  const ticketResponse = {
    ...publicResponse,
    workspace: { ...publicResponse.workspace, participants: [participant] },
    participant,
  };
  const harness = loadAdapter(async (url, options) => {
    if (url === '/api/public/events/event-one') return response(200, publicResponse);
    if (url === '/api/public/events/event-one/ticket') {
      assert.equal(options.headers.authorization, 'Bearer ticket-bearer-123');
      return response(200, ticketResponse);
    }
    return response(404, { error: 'unexpected route' });
  });

  await harness.E.remote.loadPublic('event-one');
  await harness.E.remote.loadPublic('event-one', 'ticket-bearer-123');

  assert.equal(harness.E.state.events[0].slug, 'event-one');
  assert.equal(harness.E.state.workspaces['event-1'].participants[0].ticket, 'ticket-bearer-123');
  assert.ok(harness.calls.every((call) => !call.url.includes('ticket-bearer-123')));
  assert.equal(harness.localStorageWrites, 0);
});

test('offline check-in outbox dedupes equivalent scans and removes them only after replay succeeds', async () => {
  let acknowledged = false;
  const harness = loadAdapter(async (url, options) => {
    if (url === '/api/events/event-1/commands') {
      acknowledged = true;
      return response(200, { name: '참가자', action: 'IN' });
    }
    if (url === '/api/bootstrap') return response(200, { state: state({ revision: 1 }) });
    return response(404, { error: 'unexpected route' });
  });
  const scan = {
    eventId: 'event-1',
    assignmentId: 'assignment-1',
    payload: { deskId: 'desk-1', ticket: 'ticket-1' },
  };

  harness.E.session = ACCOUNT;
  const first = harness.E.remote.enqueueCheckin(scan);
  const duplicate = harness.E.remote.enqueueCheckin(scan);
  assert.equal(first.commandId, duplicate.commandId);
  assert.equal(harness.E.remote.readCheckinQueue().length, 1);
  assert.equal(harness.localStorageWrites, 1);

  harness.E.state = state();
  harness.E.session = ACCOUNT;
  harness.E.route = { scope: 'staff', eventId: 'event-1', assignmentId: 'assignment-1' };
  harness.online = true;
  await harness.E.remote.replayCheckins();

  assert.equal(acknowledged, true);
  assert.equal(harness.E.remote.readCheckinQueue().length, 0);
  const post = harness.calls.find((call) => call.url === '/api/events/event-1/commands');
  assert.equal(JSON.parse(post.options.body).commandId, first.commandId);
});

test('server error status and message are preserved for the visible error state', async () => {
  const harness = loadAdapter(async () => response(403, { error: '배정된 데스크만 처리할 수 있습니다' }));

  await assert.rejects(
    harness.E.remote.post('/events/event-1/commands', { command: 'check.scan' }),
    (error) => error.status === 403 && error.message === '배정된 데스크만 처리할 수 있습니다'
  );
  assert.equal(harness.localStorageWrites, 0);
});

test('staff scan delegates ticket validation to the server without running the demo mutation', async () => {
  const harness = loadAdapter(async (url) => {
    if (url === '/api/events/event-1/commands') return response(200, { name: '참가자', action: 'IN' });
    if (url === '/api/bootstrap') return response(200, { state: state() });
    return response(404, { error: 'unexpected route' });
  });
  const E = harness.E;
  E.state = state();
  E.session = ACCOUNT;
  E.route = { scope: 'staff', eventId: 'event-1', assignmentId: 'assignment-1' };
  E.handlers['check.scan'] = { group: 'onsite', options: {}, fn() { throw Error('demo roster has no ticket'); } };
  const result = await E.run('check.scan', { deskId: 'desk-1', ticket: 'ticket-1' });
  assert.equal(result.action, 'IN');
  assert.equal(harness.localStorageWrites, 0);
});

test('the product entry loads the adapter after demo overrides and before DOM startup', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const adapter = html.indexOf('src="assets/js/server-sync.js');
  assert.ok(adapter > html.indexOf('src="assets/js/store.js'));
  assert.ok(adapter > html.indexOf('src="assets/js/operator-experience.js'));
});

test('event creation selects the new event for subsequent wizard commands', async () => {
  const created = { ...state().events[0], id: 'event-new', slug: 'new-event' };
  const updated = state();
  updated.events.push(created);
  updated.workspaces[created.id] = { ...updated.workspaces['event-1'] };
  const harness = loadAdapter(async url => {
    if (url === '/api/events') return response(201, { event: created });
    if (url === '/api/bootstrap') return response(200, { state: updated });
    return response(404, { error: 'unexpected route' });
  });
  harness.E.state = state();
  harness.E.session = ACCOUNT;
  harness.E.route = { scope: 'agency' };
  harness.E.handlers['event.create'] = { group: 'agency', options: {} };
  assert.equal(await harness.E.run('event.create', { name: 'new event' }), created.id);
  assert.equal(harness.E.state.activeEventId, created.id);
});

test('operator participant creation returns the participant rather than the API envelope', async () => {
  const participant = { id: 'person-new', ticket: 'ticket-new', name: '참가자' };
  const harness = loadAdapter(async url => {
    if (url === '/api/events/event-1/commands') return response(201, { participant });
    if (url === '/api/bootstrap') return response(200, { state: state() });
    return response(404, { error: 'unexpected route' });
  });
  harness.E.state = state();
  harness.E.session = ACCOUNT;
  harness.E.route = { scope: 'console', eventId: 'event-1' };
  harness.E.handlers['participant.create'] = { group: 'onsite', options: {} };
  const result = await harness.E.run('participant.create', { name: participant.name });
  assert.equal(result.id, participant.id);
  assert.equal(harness.E.dirty, true, 'successful server commands must notify the existing UI dispatcher to rerender');
});

test('default startup does not hydrate demo state when server authentication is unavailable', async () => {
  const harness = loadAdapter(async () => response(401, { error: '로그인이 필요합니다' }));
  await harness.E.startup();
  assert.equal(harness.E.storageMode, 'server');
  assert.equal(harness.E.session, null);
  assert.equal(harness.E.state.events.length, 0);
  assert.equal(harness.localStorageWrites, 0);
});

test('the final login form handler uses credentials rather than a demo account id', async () => {
  const harness = loadAdapter(async url => {
    if (url === '/api/auth/login') return response(200, { user: ACCOUNT });
    if (url === '/api/bootstrap') return response(200, { state: state() });
    return response(404, { error: 'unexpected route' });
  });
  harness.E.navigate = hash => { harness.E.ui.nextRoute = hash; };
  assert.equal(typeof harness.E.forms.login, 'function');
  await harness.E.forms.login({ email: ACCOUNT.email, password: 'not-demo' });
  assert.equal(harness.E.session.id, ACCOUNT.id);
  assert.equal(harness.E.ui.nextRoute, '#/console/agency/events');
});

test('queued scans cannot be replayed under a different logged-in account', async () => {
  const harness = loadAdapter(async () => response(200, {}));
  harness.E.session = ACCOUNT;
  harness.E.remote.enqueueCheckin({
    eventId: 'event-1', assignmentId: 'assignment-1', payload: { deskId: 'desk-1', ticket: 'ticket-1' },
  });
  harness.E.session = { ...ACCOUNT, id: 'different-account' };
  await harness.E.remote.replayCheckins();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.E.remote.readCheckinQueue().length, 1);
});

test('HTTP denial is never queued as an offline scan', async () => {
  const harness = loadAdapter(async () => response(403, { error: 'permission denied' }));
  harness.E.state = state();
  harness.E.session = ACCOUNT;
  harness.E.route = { scope: 'staff', eventId: 'event-1', assignmentId: 'assignment-1' };
  harness.E.handlers['check.scan'] = { group: 'onsite', options: {} };
  await assert.rejects(harness.E.run('check.scan', { deskId: 'desk-1', ticket: 'ticket-1' }), error => error.status === 403);
  assert.equal(harness.E.remote.readCheckinQueue().length, 0);
  assert.equal(harness.localStorageWrites, 0);
});

test('server mode never reads the local demo state through refresh-data helpers', () => {
  const harness = loadAdapter();
  assert.equal(harness.E.readDisk(), null);
  harness.E.previewMode = true;
  assert.equal(harness.E.readDisk().events[0].id, 'demo');
});

test('manual retry after two lost command responses reuses the uncertain command id', async () => {
  let posts = 0;
  const harness = loadAdapter(async url => {
    if (url === '/api/events/event-1/commands') {
      if (++posts <= 2) throw new TypeError('lost response');
      return response(201, { participant: { id: 'person-new' } });
    }
    return response(200, { state: state() });
  });
  const E = harness.E;
  let generated = 0;
  E.id = () => 'manual-command-' + (++generated);
  E.state = state(); E.session = ACCOUNT;
  E.route = { scope: 'console', eventId: 'event-1' };
  E.handlers['participant.create'] = { group: 'onsite', options: {} };
  await assert.rejects(E.run('participant.create', { name: '참가자' }), /lost response/);
  await E.run('participant.create', { name: '참가자' });
  const commands = harness.calls.filter(call => call.url.endsWith('/commands')).map(call => JSON.parse(call.options.body));
  assert.equal(commands[2].commandId, commands[0].commandId);
  await E.run('participant.create', { name: '참가자' });
  const latest = JSON.parse(harness.calls.filter(call => call.url.endsWith('/commands')).at(-1).options.body);
  assert.notEqual(latest.commandId, commands[0].commandId);
});

test('business denials keep the connection state without raising the storage banner', async () => {
  const harness = loadAdapter(async () => response(403, { error: 'permission denied' }));
  harness.E.storageWarning = '';
  harness.E.state = state();
  harness.E.session = ACCOUNT;
  harness.E.route = { scope: 'staff', eventId: 'event-1', assignmentId: 'assignment-1' };
  harness.E.handlers['check.scan'] = { group: 'onsite', options: {} };
  await assert.rejects(harness.E.run('check.scan', { deskId: 'desk-1', ticket: 'ticket-1' }), error => error.status === 403);
  assert.equal(harness.E.ui.connectionState.status, 'denied');
  assert.equal(harness.E.storageWarning, '');
});

test('connection failures raise the storage banner and a later success clears it', async () => {
  let mode = 'offline';
  const harness = loadAdapter(async url => {
    if (mode === 'offline') throw new Error('network down');
    if (url === '/api/bootstrap') return response(200, { state: state() });
    return response(404, { error: 'unexpected route' });
  });
  harness.E.session = ACCOUNT;
  await assert.rejects(harness.E.remote.bootstrap(), error => error.message === 'network down');
  assert.equal(harness.E.ui.connectionState.status, 'offline');
  assert.equal(harness.E.storageWarning, 'network down');
  mode = 'online';
  await harness.E.remote.bootstrap();
  assert.equal(harness.E.storageWarning, '');
});
