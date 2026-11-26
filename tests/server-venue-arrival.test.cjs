'use strict';

// Venue arrivals: a poster scan, a staff line scan or an on-site signup puts a person on a
// desk's waiting list; entry happens at the desk (handover or ticket scan).

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment,
  sessionCookie, requestJson, LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const accounts = { manager: `arrive-manager-${suffix}`, staff: `arrive-staff-${suffix}`, viewer: `arrive-viewer-${suffix}`, owner: `arrive-owner-${suffix}` };
const cookies = {};
let harness;
let counter = 0;
const command = () => `arrive-${crypto.randomUUID()}`;
const station = 'station-aaaaaaaa';

function person(eventId, name, phone, extra = {}) {
  return {
    id: `person-${crypto.randomUUID()}`, name, phone, email: '', company: `${name} 회사`, group: '일반', status: 'APPROVED',
    inside: false, everIn: false, revoked: false, ticket: `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`,
    ticketExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString(), paymentStatus: 'FREE', answers: {}, consent: null,
    createdAt: new Date().toISOString(), ...extra,
  };
}

async function fixture({ stage = 'LIVE', people = () => [], exit = false, allowReentry = true } = {}) {
  counter += 1;
  const id = `arrive-${counter}-${suffix}`;
  const desks = [
    { id: `gate-${counter}-${suffix}`, name: '정문 데스크', action: 'IN', mode: 'desk', open: true },
    { id: `side-${counter}-${suffix}`, name: '옆문 데스크', action: 'IN', mode: 'desk', open: true, nametag: false },
    ...(exit ? [{ id: `exit-${counter}-${suffix}`, name: '출구 데스크', action: 'OUT', mode: 'desk', open: true }] : []),
  ];
  const participants = people(id);
  await insertEvent(harness.database, {
    orgId: LEGACY_ORG, id, slug: id,
    payload: { id, slug: id, name: '도착 검증 행사', date: '2026-12-01', start: '09:00', end: '17:00', capacity: 100, stage, features: [] },
    workspace: {
      participants, desks, booths: [], assignments: [], checks: [], visits: [], audit: [], allowReentry,
      registrationOpen: true, publishedVersion: 1, formVersion: 1, consentText: '',
      publishedFields: [{ id: 'name', label: '이름', type: 'text', required: true }, { id: 'phone', label: '연락처', type: 'tel', required: true }],
    },
  });
  await insertMembership(harness.database, accounts.manager, id, ['all']);
  await insertMembership(harness.database, accounts.viewer, id, ['messages']);
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  await insertAssignment(harness.database, { id: assignmentId, accountId: accounts.staff, eventId: id, type: 'DESK', targetId: desks[0].id });
  return { id, slug: id, gate: desks[0].id, side: desks[1].id, exit: desks[2]?.id, assignmentId, participants };
}

const run = (event, name, payload, { actor = 'manager', assignmentId, id = command() } = {}) =>
  requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, { method: 'POST', cookie: cookies[actor], body: { commandId: id, command: name, assignmentId, payload } });
const list = (event, deskId, actor = 'manager', query = '') =>
  requestJson(harness.baseUrl, `/api/events/${event.id}/desks/${deskId}/arrivals${query}`, { cookie: cookies[actor] });
const arrive = (event, body, cookie) =>
  requestJson(harness.baseUrl, `/api/public/events/${event.slug}/arrival`, { method: 'POST', cookie, body });
const workspace = async (event) => (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [event.id])).rows[0].payload;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role] of [['manager', 'MANAGER'], ['staff', 'STAFF'], ['viewer', 'MANAGER'], ['owner', 'AGENCY']]) {
    await insertAccount(harness.database, { orgId: LEGACY_ORG, id: accounts[key], role, name: key, email: `${accounts[key]}@example.test` });
    cookies[key] = await sessionCookie(harness, accounts[key]);
  }
});
after(async () => { if (harness) await harness.close(); });

test('name and phone put an approved person on the desk list; handover is the entry', async () => {
  const event = await fixture({ people: (id) => [person(id, '김 하늘', '010-1111-2222')] });
  const id = command();
  const first = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: id, name: '김하늘', phone: '01011112222' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual([first.json.result, first.json.name, first.json.deskName], ['waiting', '김 하늘', '정문 데스크']);
  assert.equal(JSON.stringify(first.json).includes('ET:'), false, 'name and phone never return a ticket');
  const replay = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: id, name: '김하늘', phone: '01011112222' });
  assert.deepEqual(replay.json, first.json);
  assert.equal((await arrive(event, { action: 'arrive', deskId: event.gate, commandId: id, name: '다른', phone: '01011112222' })).status, 404);
  assert.equal((await arrive(event, { action: 'arrive', deskId: event.side, commandId: id, name: '김하늘', phone: '01011112222' })).status, 409, 'the same command id names one desk');

  const view = await list(event, event.gate);
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.deepEqual([view.json.arrivals.length, view.json.entered, view.json.total, view.json.canApprove], [1, 0, 1, true]);
  assert.equal(Object.hasOwn(view.json.arrivals[0], 'phone'), false);
  assert.equal((await workspace(event)).checks.length, 0, 'arriving is not entering');
  assert.equal(JSON.stringify((await workspace(event)).arrivals).includes('김'), false, 'an arrival stores no name');

  const handed = await run(event, 'arrival.handover', { deskId: event.gate, arrivalId: view.json.arrivals[0].id });
  assert.equal(handed.status, 200, JSON.stringify(handed.json));
  const after_ = await workspace(event);
  assert.equal(after_.participants[0].inside, true);
  assert.equal(after_.arrivals[0].checkId, handed.json.checkId);
  assert.equal((await list(event, event.gate)).json.arrivals.length, 0);
  const again = await run(event, 'arrival.handover', { deskId: event.gate, arrivalId: view.json.arrivals[0].id });
  assert.equal(again.status, 409);
  const inside = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '김하늘', phone: '01011112222' });
  assert.equal(inside.json.result, 'inside');
});

test('refusals read the same and repeated misses are slowed down', async () => {
  const event = await fixture({ people: (id) => [person(id, '이도윤', '01033334444'), person(id, '취소자', '01055556666', { status: 'CANCELLED', cancelled: true })] });
  const wrongName = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '아무개', phone: '01033334444' });
  const unknown = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '아무개', phone: '01099998888' });
  const cancelled = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '취소자', phone: '01055556666' });
  assert.deepEqual([wrongName.status, unknown.status, cancelled.status], [404, 404, 404]);
  assert.equal(new Set([wrongName.json.error, unknown.json.error, cancelled.json.error]).size, 1);
  assert.equal((await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command() })).status, 404, 'no session, no name: refused');
  let status = 0;
  for (let i = 0; i < 8; i += 1) status = (await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '아무개', phone: '01033334444' })).status;
  assert.equal(status, 429);
});

test('a running event and a running entry desk are required', async () => {
  const ready = await fixture({ stage: 'READY', people: (id) => [person(id, '박서연', '01012121212')] });
  const view = await arrive(ready, { action: 'view', deskId: ready.gate });
  assert.deepEqual([view.status, view.json.open, view.json.deskName, view.json.known], [200, false, '정문 데스크', null]);
  assert.equal((await arrive(ready, { action: 'arrive', deskId: ready.gate, commandId: command(), name: '박서연', phone: '01012121212' })).status, 409);
  assert.equal((await arrive(ready, { action: 'view', deskId: 'no-such-desk' })).status, 404);
  const draft = await fixture({ stage: 'DRAFT' });
  assert.equal((await arrive(draft, { action: 'view', deskId: draft.gate })).status, 404);
});

test('a signup at the poster arrives, and that browser is recognised afterwards', async () => {
  const event = await fixture();
  const signup = await requestJson(harness.baseUrl, `/api/events/${event.slug}/signup`, {
    method: 'POST', body: { commandId: command(), formVersion: 1, name: '오민석', phone: '01077778888', deskId: event.gate },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  assert.deepEqual(signup.json.arrival, { deskName: '정문 데스크', review: null });
  const view = await list(event, event.gate);
  assert.equal(view.json.arrivals[0].source, 'SIGNUP');
  const cookie = String(signup.headers.get('set-cookie')).split(';')[0];
  const known = await arrive(event, { action: 'view', deskId: event.gate }, cookie);
  assert.deepEqual(known.json.known, { name: '오민석', company: '', state: 'waiting' }, 'a signup here is already waiting here');
  const byCookie = await arrive(event, { action: 'arrive', deskId: event.side, commandId: command() }, cookie);
  assert.equal(byCookie.json.result, 'waiting', 'a phone never admits, even at a desk without name tags');
  assert.equal((await workspace(event)).checks.length, 0);
  assert.equal((await list(event, event.gate)).json.arrivals.length, 0, 'an untouched wait moves with the person');
  const waiting = (await list(event, event.side)).json.arrivals;
  assert.equal(waiting.length, 1);
  assert.equal((await run(event, 'arrival.handover', { deskId: event.side, arrivalId: waiting[0].id })).status, 200, 'staff admit at the desk');
  assert.equal((await workspace(event)).participants[0].inside, true);
});

test('an opening rush is answered in a few shared writes', async () => {
  const names = Array.from({ length: 60 }, (_, i) => [`동시${i}`, `010555${String(i).padStart(5, '0')}`]);
  const event = await fixture({ people: (id) => names.map(([name, phone]) => person(id, name, phone)) });
  const revision = async () => Number((await harness.database.query('SELECT revision FROM event_workspaces WHERE event_id=$1', [event.id])).rows[0].revision);
  const before_ = await revision();
  const ids = names.map(() => command());
  const send = () => Promise.all(names.map(([name, phone], i) => arrive(event, { action: 'arrive', deskId: event.gate, commandId: ids[i], name, phone })));
  const results = await send();
  assert.deepEqual([...new Set(results.map((item) => `${item.status} ${item.json.result}`))], ['200 waiting']);
  assert.equal((await list(event, event.gate)).json.arrivals.length, 60);
  assert.ok((await revision()) - before_ < 20, 'arrivals waiting together share one write');
  const replay = await send();
  assert.deepEqual(replay.map((item) => item.json), results.map((item) => item.json));
  // The same command id sent twice at once records one arrival.
  const [name, phone] = names[0];
  const twice = command();
  const both = await Promise.all([event.side, event.side].map((deskId) => arrive(event, { action: 'arrive', deskId, commandId: twice, name, phone })));
  assert.deepEqual(both.map((item) => item.status), [200, 200]);
  assert.equal((await workspace(event)).audit.filter((entry) => entry.id === twice).length, 1);
});

test('simultaneous signups at the poster all succeed', async () => {
  const event = await fixture();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => requestJson(harness.baseUrl, `/api/events/${event.slug}/signup`, {
    method: 'POST', body: { commandId: command(), formVersion: 1, name: `신청${i}`, phone: `010666${String(i).padStart(5, '0')}`, deskId: event.gate },
  })));
  assert.deepEqual([...new Set(results.map((item) => item.status))], [201]);
  assert.equal((await list(event, event.gate)).json.arrivals.length, 30);
});

test('simultaneous guesses cannot pass the limit, and a recorded retry is still answered', async () => {
  const event = await fixture({ people: (id) => [person(id, '서지호', '01061616161')] });
  const id = command();
  const body = { action: 'arrive', deskId: event.gate, commandId: id, name: '서지호', phone: '01061616161' };
  assert.equal((await arrive(event, body)).status, 200);
  const guesses = await Promise.all(Array.from({ length: 20 }, (_, i) => arrive(event, { ...body, commandId: command(), name: `추측${i}` })));
  assert.deepEqual([guesses.filter((item) => item.status === 404).length, guesses.filter((item) => item.status === 429).length], [6, 14]);
  assert.equal((await arrive(event, { ...body, commandId: command() })).status, 429);
  assert.equal((await arrive(event, body)).json.result, 'waiting', 'a lost reply can be asked again');
});

test('a phone cannot print a second tag, and pressing again writes nothing', async () => {
  const event = await fixture({ people: (id) => [person(id, '문가온', '01062626262')] });
  const press = (deskId) => arrive(event, { action: 'arrive', deskId, commandId: command(), name: '문가온', phone: '01062626262' });
  await press(event.gate);
  const audits = (await workspace(event)).audit.length;
  assert.equal((await press(event.gate)).json.result, 'waiting');
  assert.equal((await workspace(event)).audit.length, audits, 'a repeat at the same desk changes nothing');
  const arrivalId = (await list(event, event.gate)).json.arrivals[0].id;
  await run(event, 'arrival.claim-print', { deskId: event.gate, arrivalId, station });
  await run(event, 'arrival.print-result', { deskId: event.gate, arrivalId, station, ok: true });
  const elsewhere = await press(event.side);
  assert.deepEqual([elsewhere.json.result, elsewhere.json.deskName], ['waiting', '정문 데스크']);
  const view = (await list(event, event.gate)).json.arrivals[0];
  assert.ok(view.printedAt, 'the printed tag stays where it is');
  assert.equal((await list(event, event.side)).json.arrivals.length, 0);
});

test('typed numbers with a country code match, and erasing leaves no identity in receipts', async () => {
  const event = await fixture({ people: (id) => [person(id, '남도현', '010-6363-6363', { company: '도현 상사' })] });
  const id = command();
  const body = { action: 'arrive', deskId: event.gate, commandId: id, name: '남도현', phone: '+82 10-6363-6363' };
  assert.equal((await arrive(event, body)).json.result, 'waiting');
  const stored = async () => JSON.stringify((await harness.database.query('SELECT result FROM command_receipts WHERE command_id=$1', [id])).rows[0].result);
  // The whole number: a random id or hash can contain a few of its digits by chance.
  const identity = /남도현|도현 상사|010-?6363-?6363|82 ?10-?6363-?6363/;
  assert.equal(identity.test(await stored()), false);
  const erased = await run(event, 'participant.erase', { id: event.participants[0].id }, { actor: 'owner' });
  assert.equal(erased.status, 200, JSON.stringify(erased.json));
  assert.equal(identity.test(await stored()), false);
  assert.equal((await arrive(event, body)).status, 404);
});

test('an expired ticket is held for review and namesakes are marked on the desk', async () => {
  const event = await fixture({ people: (id) => [
    person(id, '유하람', '01064646464', { ticketExpiresAt: new Date(Date.now() - 1000).toISOString() }),
    person(id, '강이안', '01065656565', { company: '같은 회사' }),
    person(id, '강이안', '01067676767', { company: '같은 회사' }),
  ] });
  const first = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '유하람', phone: '01064646464' });
  assert.equal(first.json.result, 'review');
  await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '강이안', phone: '01065656565' });
  const view = (await list(event, event.gate)).json;
  assert.ok(Number.isFinite(Date.parse(view.now)));
  assert.deepEqual(view.arrivals.map((item) => [item.review, item.namesake]), [['EXPIRED', false], [null, true]]);
  assert.equal(JSON.stringify(view).includes('01065656565'), false);
});

test('approving from a stale card never revives a cancelled registration', async () => {
  const event = await fixture({ people: (id) => [person(id, '배소율', '01068686868', { status: 'PENDING' })] });
  const target = event.participants[0].id;
  const cancelled = await run(event, 'participant.status', { id: target, status: 'CANCELLED' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const approve = await run(event, 'participant.status', { id: target, status: 'APPROVED', expectedStatus: 'PENDING' });
  assert.equal(approve.status, 409);
});

test('a pending person waits for review: no print claim, no handover until approved', async () => {
  const event = await fixture({ people: (id) => [person(id, '최민준', '01024242424', { status: 'PENDING' })] });
  assert.equal((await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '최민준', phone: '01024242424' })).json.result, 'review');
  const row = (await list(event, event.gate)).json.arrivals[0];
  assert.equal(row.review, 'PENDING');
  assert.equal((await run(event, 'arrival.claim-print', { deskId: event.gate, arrivalId: row.id, station })).json.claimed, false);
  assert.equal((await run(event, 'arrival.handover', { deskId: event.gate, arrivalId: row.id })).status, 409);
  const cancelled = await run(event, 'arrival.cancel', { deskId: event.gate, arrivalId: row.id });
  assert.equal(cancelled.status, 200);
  assert.equal((await list(event, event.gate)).json.arrivals.length, 0);
});

test('one laptop claims a tag; the other waits; failure and reprint are explicit', async () => {
  const event = await fixture({ people: (id) => [person(id, '정하윤', '01036363636')] });
  await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '정하윤', phone: '01036363636' });
  const arrivalId = (await list(event, event.gate)).json.arrivals[0].id;
  const claim = (other, force = false) => run(event, 'arrival.claim-print', { deskId: event.gate, arrivalId, station: other, force });
  assert.equal((await claim(station)).json.claimed, true);
  assert.equal((await claim('station-bbbbbbbb')).json.claimed, false);
  const failed = await run(event, 'arrival.print-result', { deskId: event.gate, arrivalId, station, ok: false });
  assert.ok(failed.json.printFailedAt);
  assert.equal((await claim('station-bbbbbbbb')).json.claimed, false, 'a failed print is retried only on request');
  assert.equal((await claim('station-bbbbbbbb', true)).json.claimed, true);
  const done = await run(event, 'arrival.print-result', { deskId: event.gate, arrivalId, station: 'station-bbbbbbbb', ok: true });
  assert.ok(done.json.printedAt);
  assert.equal((await claim(station)).json.claimed, false);
  // The same command id with another desk or outcome is refused.
  const id = command();
  assert.equal((await run(event, 'arrival.claim-print', { deskId: event.gate, arrivalId, station, force: true }, { id })).status, 200);
  assert.equal((await run(event, 'arrival.claim-print', { deskId: event.gate, arrivalId, station: 'station-cccccccc', force: true }, { id })).status, 409);
});

test('staff scan lines up arrivals only at the assigned desk, and a desk ticket scan hands over', async () => {
  const event = await fixture({ people: (id) => [person(id, '한지우', '01048484848')] });
  const ticket = event.participants[0].ticket;
  const staff = { actor: 'staff', assignmentId: event.assignmentId };
  const recorded = await run(event, 'arrival.record', { deskId: event.gate, ticket }, staff);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
  assert.deepEqual([recorded.json.name, recorded.json.review], ['한지우', null]);
  assert.equal((await run(event, 'arrival.record', { deskId: event.side, ticket }, staff)).status, 403);
  assert.equal((await list(event, event.gate, 'staff', `?assignmentId=${event.assignmentId}`)).status, 200);
  assert.equal((await list(event, event.side, 'staff', `?assignmentId=${event.assignmentId}`)).status, 403);
  assert.equal((await list(event, event.gate, 'viewer')).status, 403, 'a manager without field permission cannot read the desk');
  assert.equal((await requestJson(harness.baseUrl, `/api/events/${event.id}/desks/${event.gate}/arrivals`)).status, 401);
  const scanned = await run(event, 'check.scan', { deskId: event.gate, ticket, expectedAction: 'IN' }, staff);
  assert.equal(scanned.status, 200, JSON.stringify(scanned.json));
  const state = await workspace(event);
  assert.equal(state.arrivals[0].checkId, scanned.json.checkId, 'the desk scan closes the arrival');
  assert.equal((await run(event, 'arrival.record', { deskId: event.gate, ticket }, staff)).json.code, 'ALREADY_CHECKED_IN');
});

test('the desk keeps its name tag setting', async () => {
  const event = await fixture();
  const saved = await run(event, 'desk.save', { id: event.gate, name: '정문 데스크', action: 'IN', mode: 'desk', open: true, nametag: false });
  assert.equal(saved.json.desk.nametag, false);
  const kept = await run(event, 'desk.save', { id: event.gate, name: '정문 안내', action: 'IN', mode: 'desk', open: true });
  assert.equal(kept.json.desk.nametag, false, 'an editor that does not send it keeps it');
  assert.equal((await run(event, 'desk.save', { id: event.gate, name: '정문', action: 'IN', mode: 'desk', open: true, nametag: 'yes' })).status, 400);
});

test('one switch: the same poster admits through the desk in 입장 and records the exit in 퇴장', async () => {
  const event = await fixture({ people: (id) => [person(id, '조은솔', '01071717171'), person(id, '임다온', '01072727272')] });
  const body = (name, phone) => ({ action: 'arrive', deskId: event.gate, commandId: command(), name, phone });
  // 입장: the phone waits for the desk.
  await arrive(event, body('조은솔', '01071717171'));
  const arrivalId = (await list(event, event.gate)).json.arrivals[0].id;
  assert.equal((await run(event, 'arrival.handover', { deskId: event.gate, arrivalId })).status, 200);
  // The desk screen switches to 퇴장 and stays open.
  const switched = await run(event, 'desk.save', { id: event.gate, name: '정문 데스크', action: 'OUT', mode: 'desk', open: true,
    confirmDirectionChange: true, keepOpen: true, expectedDesk: { name: '정문 데스크', action: 'IN', mode: 'desk', open: true } });
  assert.equal(switched.status, 200, JSON.stringify(switched.json));
  assert.deepEqual([switched.json.desk.action, switched.json.desk.open], ['OUT', true]);
  const view = await arrive(event, { action: 'view', deskId: event.gate });
  assert.deepEqual([view.json.open, view.json.action], [true, 'OUT']);
  const left = await arrive(event, body('조은솔', '01071717171'));
  assert.equal(left.json.result, 'left');
  const state = await workspace(event);
  assert.equal(state.participants.find((p) => p.name === '조은솔').inside, false);
  assert.equal(state.checks[0].action, 'OUT');
  assert.equal((await arrive(event, body('임다온', '01072727272'))).json.result, 'notInside', 'someone never admitted cannot leave');
  const exits = (await list(event, event.gate)).json;
  assert.deepEqual(exits.left.map((person) => person.name), ['조은솔'], 'the exit desk shows who just left');
  assert.equal(/0107\d{7}/.test(JSON.stringify(exits.left)), false);
  // Without the switch flag a direction change still stops the desk.
  const plain = await run(event, 'desk.save', { id: event.gate, name: '정문 데스크', action: 'IN', mode: 'desk', open: true, confirmDirectionChange: true });
  assert.equal(plain.json.desk.open, false);
});

// Reopened 2026-11-26 (door-day audit): refusals the door can act on, and a one-time re-entry.
test('a pending, waitlisted or unpaid ticket gets its own code and says who settles it', async () => {
  const event = await fixture({ exit: true, people: (id) => [
    person(id, '승인대기', '01021000001', { status: 'PENDING' }),
    person(id, '대기명단', '01021000002', { status: 'WAITLIST' }),
    person(id, '결제대기', '01021000003', { paymentStatus: 'PENDING' }),
  ] });
  const expected = [['TICKET_APPROVAL_PENDING', /승인을 요청/], ['TICKET_WAITLISTED', /참가 확정을 요청/], ['TICKET_PAYMENT_REQUIRED', /결제 확인을 요청/]];
  for (const [index, [code, nextStep]] of expected.entries()) {
    const ticket = event.participants[index].ticket;
    const refused = await run(event, 'check.scan', { deskId: event.gate, ticket, expectedAction: 'IN' });
    assert.deepEqual([refused.status, refused.json.code, refused.json.details], [409, code, { waiting: false }], JSON.stringify(refused.json));
    assert.match(refused.json.error, /행사 책임자/);
    assert.match(refused.json.error, nextStep);
    // An exit desk has nothing to admit: its refusal is unchanged.
    const leaving = await run(event, 'check.scan', { deskId: event.exit, ticket, expectedAction: 'OUT' });
    assert.deepEqual([leaving.status, leaving.json.code], [409, undefined]);
  }
  // The public poster still answers only "waiting for the desk".
  const arrived = await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '승인대기', phone: '01021000001' });
  assert.deepEqual(Object.keys(arrived.json).sort(), ['company', 'deskName', 'name', 'result']);
  assert.equal(arrived.json.result, 'review');
  const listed = await run(event, 'check.scan', { deskId: event.gate, ticket: event.participants[0].ticket, expectedAction: 'IN' });
  assert.deepEqual(listed.json.details, { waiting: true }, 'this desk already lists the person');
  const elsewhere = await run(event, 'check.scan', { deskId: event.side, ticket: event.participants[0].ticket, expectedAction: 'IN' });
  assert.deepEqual(elsewhere.json.details, { waiting: false });
  assert.equal((await workspace(event)).checks.length, 0);
});

test('an exit scan for someone already out says so with the time', async () => {
  const event = await fixture({ exit: true, people: (id) => [person(id, '나간사람', '01022000001'), person(id, '안온사람', '01022000002')] });
  const [gone, never] = event.participants;
  const scanAt = (deskId, who, expectedAction) => run(event, 'check.scan', { deskId, ticket: who.ticket, expectedAction });
  assert.equal((await scanAt(event.gate, gone, 'IN')).status, 200);
  assert.equal((await scanAt(event.exit, gone, 'OUT')).status, 200);
  const leftAt = (await workspace(event)).checks[0].at;
  const again = await scanAt(event.exit, gone, 'OUT');
  assert.deepEqual([again.status, again.json.code, again.json.details],
    [409, 'ALREADY_CHECKED_OUT', { name: '나간사람', lastCheckedOutAt: leftAt }], JSON.stringify(again.json));
  const unseen = await scanAt(event.exit, never, 'OUT');
  assert.deepEqual([unseen.status, unseen.json.code], [409, undefined], 'someone who never entered did not leave');
  assert.match(unseen.json.error, /현재 입장 상태가 아닙니다/);
  assert.equal((await workspace(event)).checks.length, 2);
});

test('one re-entry: the event lead admits with a reason, staff cannot, and the event rule stays', async () => {
  const event = await fixture({ exit: true, allowReentry: false, people: (id) => [
    person(id, '다시온', '01023000001', { everIn: true }),
    person(id, '또다시', '01023000002', { everIn: true }),
    person(id, '결제전', '01023000003', { everIn: true, paymentStatus: 'PENDING' }),
  ] });
  for (const phone of ['01023000001', '01023000002', '01023000003']) {
    const name = event.participants.find((item) => item.phone === phone).name;
    assert.equal((await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name, phone })).status, 200);
  }
  const view = (await list(event, event.gate)).json;
  assert.equal(view.canReadmit, true);
  assert.equal((await list(event, event.gate, 'owner')).json.canReadmit, true);
  assert.equal((await list(event, event.gate, 'staff', `?assignmentId=${event.assignmentId}`)).json.canReadmit, false);
  const arrivalOf = (index) => view.arrivals.find((item) => item.participantId === event.participants[index].id);
  assert.deepEqual([0, 1, 2].map((index) => arrivalOf(index).review), ['REENTRY', 'REENTRY', 'PAYMENT']);
  const payload = (index, extra = {}) => ({ deskId: event.gate, arrivalId: arrivalOf(index).id, ...extra });
  const staff = { actor: 'staff', assignmentId: event.assignmentId };

  const plain = await run(event, 'arrival.handover', payload(0));
  assert.deepEqual([plain.status, plain.json.code], [409, 'REENTRY_NOT_ALLOWED'], 'without a reason the rule holds');
  assert.match(plain.json.error, /행사 책임자에게 요청/);
  const refused = await run(event, 'arrival.handover', payload(0, { reentryReason: '식사·외출' }), staff);
  assert.deepEqual([refused.status, refused.json.code], [403, 'REENTRY_OVERRIDE_FORBIDDEN']);
  assert.match(refused.json.error, /행사 책임자에게 요청/);
  assert.equal((await run(event, 'arrival.handover', payload(0, { reentryReason: '식사·외출' }), { actor: 'viewer' })).status, 403, 'a manager without field permission');
  // The ticket scan ignores the field: the override belongs to the desk card only.
  const scanned = await run(event, 'check.scan', { deskId: event.gate, ticket: event.participants[0].ticket, expectedAction: 'IN', reentryReason: '식사·외출' }, staff);
  assert.deepEqual([scanned.status, scanned.json.code], [409, 'REENTRY_NOT_ALLOWED']);
  for (const bad of ['', '   ', 'x'.repeat(201), 7, null, `외출 ${event.participants[1].ticket}`]) {
    const res = await run(event, 'arrival.handover', payload(0, { reentryReason: bad }));
    assert.equal(res.status, 400, JSON.stringify([bad, res.json]));
  }
  const unpaid = await run(event, 'arrival.handover', payload(2, { reentryReason: '식사·외출' }));
  assert.deepEqual([unpaid.status, unpaid.json.code], [409, 'TICKET_PAYMENT_REQUIRED'], 'the override lifts only the re-entry rule');
  assert.equal((await workspace(event)).checks.length, 0);

  const id = command();
  const reason = `외부 통화 ${'가'.repeat(190)}`;
  const admitted = await run(event, 'arrival.handover', payload(0, { reentryReason: reason }), { id });
  assert.equal(admitted.status, 200, JSON.stringify(admitted.json));
  assert.deepEqual([admitted.json.action, admitted.json.readmitted, admitted.json.checkId], ['IN', true, id]);
  const replay = await run(event, 'arrival.handover', payload(0, { reentryReason: reason }), { id });
  assert.deepEqual([replay.status, replay.json], [200, admitted.json], 'a lost response replays the admission');
  for (const changed of [payload(0, { reentryReason: '다른 사유' }), payload(0)]) {
    const mismatch = await run(event, 'arrival.handover', changed, { id });
    assert.deepEqual([mismatch.status, mismatch.json.code], [409, 'ARRIVAL_RECEIPT_MISMATCH']);
  }
  const state = await workspace(event);
  assert.equal(state.checks.length, 1);
  assert.equal(state.participants[0].inside, true);
  assert.equal(state.allowReentry, false, 'the event setting is unchanged');
  const audit = state.audit.filter((entry) => entry.id === id);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].type, audit[0].actor, audit[0].detail, audit[0].reentryOverride],
    ['arrival.handover', accounts.manager, reason, { participantId: event.participants[0].id, participantName: '다시온' }]);
  const receipt = await harness.database.query('SELECT result::text AS body FROM command_receipts WHERE command_id=$1', [id]);
  assert.equal(receipt.rows[0].body.includes('외부 통화'), false, 'the receipt keeps only a proof of the reason');

  const owner = await run(event, 'arrival.handover', payload(1, { reentryReason: '식사·외출' }), { actor: 'owner' });
  assert.equal(owner.status, 200, JSON.stringify(owner.json));
  // Once: after leaving again the same rule applies again.
  assert.equal((await run(event, 'check.scan', { deskId: event.exit, ticket: event.participants[0].ticket, expectedAction: 'OUT' })).status, 200);
  const third = await run(event, 'check.scan', { deskId: event.gate, ticket: event.participants[0].ticket, expectedAction: 'IN' });
  assert.deepEqual([third.status, third.json.code], [409, 'REENTRY_NOT_ALLOWED']);
});

test('a plain handover replays under its first command id', async () => {
  const event = await fixture({ people: (id) => [person(id, '한번만', '01024000001', { everIn: false })] });
  await arrive(event, { action: 'arrive', deskId: event.gate, commandId: command(), name: '한번만', phone: '01024000001' });
  const arrivalId = (await list(event, event.gate)).json.arrivals[0].id;
  const id = command();
  const first = await run(event, 'arrival.handover', { deskId: event.gate, arrivalId }, { id });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(Object.hasOwn(first.json, 'readmitted'), false);
  const again = await run(event, 'arrival.handover', { deskId: event.gate, arrivalId }, { id });
  assert.deepEqual([again.status, again.json], [200, first.json]);
  // The proof of a receipt without a re-entry reason is unchanged, so receipts saved earlier keep replaying.
  const saved = (await harness.database.query('SELECT result FROM command_receipts WHERE command_id=$1', [id])).rows[0].result;
  const before = crypto.createHash('sha256').update(JSON.stringify(['arrival.handover', event.gate, arrivalId, '', '', false, false])).digest('hex');
  assert.equal(saved.arrivalProof, before);
});
