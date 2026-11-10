'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');

let harness;
const ids = { agency: 'receipt-agency', manager: 'receipt-manager', other: 'receipt-other', staff: 'receipt-staff', event: 'receipt-event', event2: 'receipt-event-two' };
const ticket = `ET:${ids.event}:T-${randomUUID()}`;
const otherTicket = `ET:${ids.event}:T-${randomUUID()}`;
let cookies;

before(async () => {
  harness = await startApiHarness();
  for (const [key, role] of [['agency', 'AGENCY'], ['manager', 'MANAGER'], ['other', 'MANAGER'], ['staff', 'STAFF']]) {
    await insertAccount(harness.database, { id: ids[key], role, name: key, email: `${key}@fixture.invalid`, orgId: LEGACY_ORG });
  }
  const participant = (id, bearer) => ({ id, name: id, ticket: bearer, status: 'APPROVED', paymentStatus: 'FREE', revoked: false, ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
  const payload = id => ({ id, slug: id, name: '합성 행사', date: '2026-12-01', stage: 'READY', features: ['poll'] });
  await insertEvent(harness.database, { id: ids.event, slug: ids.event, orgId: LEGACY_ORG, payload: payload(ids.event), workspace: {
    participants: [participant('p1', ticket), participant('p2', otherTicket)],
    modules: [{ id: 'poll-one', type: 'poll', title: '합성 투표', status: 'OPEN', published: true, options: ['예', '아니요'] }],
  } });
  await insertEvent(harness.database, { id: ids.event2, slug: ids.event2, orgId: LEGACY_ORG, payload: payload(ids.event2), workspace: { participants: [] } });
  await insertMembership(harness.database, ids.manager, ids.event, ['all']);
  await insertMembership(harness.database, ids.other, ids.event, ['all']);
  await insertAssignment(harness.database, { id: 'receipt-assignment', accountId: ids.staff, eventId: ids.event, type: 'DESK', targetId: 'desk-one' });
  cookies = Object.fromEntries(await Promise.all(['agency', 'manager', 'other', 'staff'].map(async key => [key, await sessionCookie(harness, ids[key])])));
});
after(async () => { if (harness) await harness.close(); });

test('receipt lookup proves commit without revealing payload or another person\'s result', async () => {
  const commandId = `receipt-${randomUUID()}`;
  const cmd = await requestJson(harness.baseUrl, `/api/events/${ids.event}/commands`, { method: 'POST', bearer: ticket, body: { commandId, command: 'response.submit', payload: { moduleId: 'poll-one', answer: '예', comment: '개인 응답' } } });
  assert.equal(cmd.status, 201, JSON.stringify(cmd.json));
  const url = `/api/events/${ids.event}/command-receipts/${commandId}`;
  const result = await requestJson(harness.baseUrl, url, { bearer: ticket });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.json, { status: 'APPLIED', command: 'response.submit' });
  assert.deepEqual((await requestJson(harness.baseUrl, url, { bearer: otherTicket })).json, { status: 'UNCONFIRMED' });
  assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: cookies.agency })).json, { status: 'UNCONFIRMED' });
  assert.deepEqual((await requestJson(harness.baseUrl, `/api/events/${ids.event}/command-receipts/unknown-request-id`, { bearer: ticket })).json, { status: 'UNCONFIRMED' });
  assert.equal((await requestJson(harness.baseUrl, url, { bearer: 'invalid-ticket' })).status, 404);
  assert.equal((await requestJson(harness.baseUrl, url)).status, 401);
  assert.equal((await requestJson(harness.baseUrl, `/api/events/${ids.event}/command-receipts/bad`, { bearer: ticket })).status, 400);
  const boothId = `receipt-${randomUUID()}`;
  const hash = require('../server/commands/shared.ts').hashTicket(ticket);
  await harness.database.query('INSERT INTO command_receipts (command_id,event_id,actor_id,org_id,result) VALUES ($1,$2,NULL,$3,$4::jsonb)',
    [boothId, ids.event, LEGACY_ORG, JSON.stringify({ command: 'booth.visit', ticketHash: hash, participantId: null })]);
  const boothUrl = `/api/events/${ids.event}/command-receipts/${boothId}`;
  assert.deepEqual((await requestJson(harness.baseUrl, boothUrl, { bearer: ticket })).json, { status: 'APPLIED', command: 'booth.visit' });
  assert.deepEqual((await requestJson(harness.baseUrl, boothUrl, { bearer: otherTicket })).json, { status: 'UNCONFIRMED' });
  const before = (await harness.database.query('SELECT revision FROM event_workspaces WHERE event_id=$1', [ids.event])).rows[0].revision;
  await requestJson(harness.baseUrl, url, { bearer: ticket });
  const after = (await harness.database.query('SELECT revision FROM event_workspaces WHERE event_id=$1', [ids.event])).rows[0].revision;
  assert.equal(after, before, 'lookup is read-only');
  const workspace = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [ids.event])).rows[0].payload;
  workspace.participants[0].revoked = true;
  await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [ids.event, JSON.stringify(workspace)]);
  assert.equal((await requestJson(harness.baseUrl, url, { bearer: ticket })).status, 404, 'revocation applies to receipt reads too');
});

test('operator and organization receipt access follows current role and original actor', async () => {
  const eventCommand = `receipt-${randomUUID()}`;
  const orgCommand = `receipt-${randomUUID()}`;
  await harness.database.query('INSERT INTO command_receipts (command_id,event_id,actor_id,org_id,result) VALUES ($1,$2,$3,$4,$5::jsonb),($6,NULL,$7,$4,$8::jsonb)', [eventCommand, ids.event, ids.manager, LEGACY_ORG, JSON.stringify({ command: 'event.update', response: { secret: 'do not expose' } }), orgCommand, ids.agency, JSON.stringify({ command: 'client.save', response: { secret: 'do not expose' } })]);
  const url = `/api/events/${ids.event}/command-receipts/${eventCommand}`;
  assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: cookies.manager })).json, { status: 'APPLIED', command: 'event.update' });
  assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: cookies.other })).json, { status: 'UNCONFIRMED' });
  assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: cookies.staff })).json, { status: 'UNCONFIRMED' });
  assert.deepEqual((await requestJson(harness.baseUrl, `/api/events/${ids.event2}/command-receipts/${eventCommand}`, { cookie: cookies.agency })).json, { status: 'UNCONFIRMED' });
  assert.equal((await requestJson(harness.baseUrl, `/api/events/${ids.event2}/command-receipts/${eventCommand}`, { cookie: cookies.manager })).status, 403);
  assert.deepEqual((await requestJson(harness.baseUrl, `/api/command-receipts/${orgCommand}`, { cookie: cookies.agency })).json, { status: 'APPLIED', command: 'client.save' });
  assert.equal((await requestJson(harness.baseUrl, `/api/command-receipts/${orgCommand}`, { cookie: cookies.manager })).status, 403);
  assert.deepEqual((await requestJson(harness.baseUrl, `/api/command-receipts/${eventCommand}`, { cookie: cookies.agency })).json, { status: 'UNCONFIRMED' });
  await harness.database.query('DELETE FROM memberships WHERE account_id=$1 AND event_id=$2', [ids.manager, ids.event]);
  assert.equal((await requestJson(harness.baseUrl, url, { cookie: cookies.manager })).status, 403, 'revoked event membership cannot read old receipts');
  await harness.database.query('UPDATE staff_assignments SET active=false WHERE id=$1', ['receipt-assignment']);
  assert.equal((await requestJson(harness.baseUrl, url, { cookie: cookies.staff })).status, 403, 'revoked assignment cannot read old receipts');
});

test('an uncommitted receipt is unconfirmed and can be checked again after commit', async () => {
  const commandId = `receipt-${randomUUID()}`;
  let signalStarted;
  let allowCommit;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const commit = new Promise(resolve => { allowCommit = resolve; });
  const transaction = harness.database.transaction(async client => {
    await client.query('INSERT INTO command_receipts (command_id,event_id,actor_id,org_id,result) VALUES ($1,$2,$3,$4,$5::jsonb)', [commandId, ids.event, ids.agency, LEGACY_ORG, JSON.stringify({ command: 'event.update' })]);
    signalStarted();
    await commit;
  });
  try {
    await started;
    const url = `/api/events/${ids.event}/command-receipts/${commandId}`;
    assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: cookies.agency })).json, { status: 'UNCONFIRMED' });
    allowCommit();
    await transaction;
    assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: cookies.agency })).json, { status: 'APPLIED', command: 'event.update' });
  } finally { allowCommit(); await transaction; }
});

test('invitation receipt exposes only status to its original owner', async () => {
  const commandId = `receipt-invite-${randomUUID()}`;
  const created = await requestJson(harness.baseUrl, '/api/auth/invitations', {
    method: 'POST', cookie: cookies.agency,
    body: { commandId, name: '합성 초대', email: `receipt-${randomUUID()}@fixture.invalid`, role: 'MANAGER', eventId: ids.event },
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.token);
  const url = `/api/command-receipts/${commandId}`;
  const receipt = await requestJson(harness.baseUrl, url, { cookie: cookies.agency });
  assert.deepEqual(receipt.json, { status: 'APPLIED', command: 'invitation.create' });
  assert.equal(JSON.stringify(receipt.json).includes(created.json.token), false);
  assert.equal((await requestJson(harness.baseUrl, url, { cookie: cookies.manager })).status, 403);
  await insertAccount(harness.database, { id: 'receipt-agency-other', role: 'AGENCY', name: 'other agency', email: 'other-agency@fixture.invalid', orgId: LEGACY_ORG });
  const otherAgencyCookie = await sessionCookie(harness, 'receipt-agency-other');
  assert.deepEqual((await requestJson(harness.baseUrl, url, { cookie: otherAgencyCookie })).json, { status: 'UNCONFIRMED' });
});

test('password-reset receipt exposes no password or target details', async () => {
  const target = `receipt-reset-${randomUUID()}`;
  await insertAccount(harness.database, { id: target, role: 'MANAGER', name: '합성 계정', email: `${target}@fixture.invalid`, orgId: LEGACY_ORG });
  const commandId = `receipt-password-${randomUUID()}`;
  const reset = await requestJson(harness.baseUrl, `/api/auth/accounts/${target}/password`, {
    method: 'POST', cookie: cookies.agency, body: { commandId, password: 'synthetic-password-only' },
  });
  assert.equal(reset.status, 200);
  const url = `/api/command-receipts/${commandId}`;
  const receipt = await requestJson(harness.baseUrl, url, { cookie: cookies.agency });
  assert.deepEqual(receipt.json, { status: 'APPLIED', command: 'account.password-reset' });
  assert.equal(JSON.stringify(receipt.json).includes(target), false);
  assert.equal(JSON.stringify(receipt.json).includes('synthetic-password-only'), false);
  assert.equal((await requestJson(harness.baseUrl, url, { cookie: cookies.manager })).status, 403);
});

test('another organization cannot use a pointer to see the original receipt', async () => {
  const org = 'org-receipt-other';
  const otherAgency = 'receipt-agency-other-org';
  const event = 'receipt-event-other-org';
  await harness.database.query('INSERT INTO organizations (id,name) VALUES ($1,$2)', [org, '다른 검증 조직']);
  await insertAccount(harness.database, { id: otherAgency, role: 'AGENCY', name: 'other', email: 'other-org@fixture.invalid', orgId: org });
  await insertEvent(harness.database, { id: event, slug: event, orgId: org, payload: { id: event, slug: event }, workspace: {} });
  const cookie = await sessionCookie(harness, otherAgency);
  const commandId = `receipt-${randomUUID()}`;
  await harness.database.query('INSERT INTO command_receipts (command_id,event_id,actor_id,org_id,result) VALUES ($1,$2,$3,$4,$5::jsonb)', [commandId, ids.event, ids.agency, LEGACY_ORG, JSON.stringify({ command: 'event.create', response: { secret: 'private' } })]);
  assert.deepEqual((await requestJson(harness.baseUrl, `/api/command-receipts/${commandId}`, { cookie })).json, { status: 'UNCONFIRMED' });
  assert.deepEqual((await requestJson(harness.baseUrl, `/api/events/${event}/command-receipts/${commandId}`, { cookie })).json, { status: 'UNCONFIRMED' });
  const cross = await requestJson(harness.baseUrl, `/api/events/${ids.event}/command-receipts/${commandId}`, { cookie });
  assert.notEqual(cross.status, 200);
  assert.equal(JSON.stringify(cross.json).includes('private'), false);
});
