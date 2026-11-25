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
const accounts = { manager: `arrive-manager-${suffix}`, staff: `arrive-staff-${suffix}`, viewer: `arrive-viewer-${suffix}` };
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

async function fixture({ stage = 'LIVE', people = () => [] } = {}) {
  counter += 1;
  const id = `arrive-${counter}-${suffix}`;
  const desks = [
    { id: `gate-${counter}-${suffix}`, name: '정문 데스크', action: 'IN', mode: 'desk', open: true },
    { id: `side-${counter}-${suffix}`, name: '옆문 데스크', action: 'IN', mode: 'desk', open: true, nametag: false },
  ];
  const participants = people(id);
  await insertEvent(harness.database, {
    orgId: LEGACY_ORG, id, slug: id,
    payload: { id, slug: id, name: '도착 검증 행사', date: '2026-12-01', start: '09:00', end: '17:00', capacity: 100, stage, features: [] },
    workspace: {
      participants, desks, booths: [], assignments: [], checks: [], visits: [], audit: [],
      registrationOpen: true, publishedVersion: 1, formVersion: 1, consentText: '',
      publishedFields: [{ id: 'name', label: '이름', type: 'text', required: true }, { id: 'phone', label: '연락처', type: 'tel', required: true }],
    },
  });
  await insertMembership(harness.database, accounts.manager, id, ['all']);
  await insertMembership(harness.database, accounts.viewer, id, ['messages']);
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  await insertAssignment(harness.database, { id: assignmentId, accountId: accounts.staff, eventId: id, type: 'DESK', targetId: desks[0].id });
  return { id, slug: id, gate: desks[0].id, side: desks[1].id, assignmentId, participants };
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
  for (const [key, role] of [['manager', 'MANAGER'], ['staff', 'STAFF'], ['viewer', 'MANAGER']]) {
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
  assert.equal((await arrive(event, { action: 'arrive', deskId: event.gate, commandId: id, name: '다른', phone: '01011112222' })).status, 409);

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
  assert.equal(known.json.known.name, '오민석');
  const byCookie = await arrive(event, { action: 'arrive', deskId: event.side, commandId: command() }, cookie);
  assert.equal(byCookie.json.result, 'entered', 'a desk without name tags admits on arrival');
  assert.equal((await list(event, event.gate)).json.arrivals.length, 0, 'entering anywhere ends the wait');
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
