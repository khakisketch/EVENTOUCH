'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClientAddressResolver, developmentLoginEmail } = require('../server/runtime-security.ts');
const { requestRoute, createRequestObservability } = require('../server/request-observability.ts');
const { createServer } = require('node:http');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');

const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('development quick login requires an explicit development runtime', () => {
  assert.equal(developmentLoginEmail({}), '');
  for (const NODE_ENV of [undefined, 'test', 'production']) {
    assert.throws(() => developmentLoginEmail({ NODE_ENV, EVENTOUCH_DEV_QUICK_LOGIN: 'owner@example.test' }), /NODE_ENV=development/);
  }
  assert.equal(developmentLoginEmail({ NODE_ENV: 'development', EVENTOUCH_DEV_QUICK_LOGIN: ' Owner@Example.test ' }), 'owner@example.test');
});

test('untrusted peers cannot spoof forwarded client addresses', () => {
  assert.equal(createClientAddressResolver({})(request('::ffff:127.0.0.1', '198.51.100.1')), '127.0.0.1');
  const resolve = createClientAddressResolver({ EVENTOUCH_TRUSTED_PROXIES: '10.0.0.0/8' });
  assert.equal(resolve(request('203.0.113.8', '198.51.100.1')), '203.0.113.8');
});

test('trusted proxy chains choose the nearest untrusted hop, not an injected leftmost address', () => {
  const resolve = createClientAddressResolver({ EVENTOUCH_TRUSTED_PROXIES: '10.0.0.0/8,127.0.0.1,::1' });
  assert.equal(resolve(request('127.0.0.1', '192.0.2.200, 203.0.113.8, 10.0.0.2')), '203.0.113.8');
  assert.equal(resolve(request('::1', '2001:0DB8:0000::1')), '2001:db8::1');
  assert.equal(resolve(request('10.0.0.2', 'untrusted-text')), '10.0.0.2');
  assert.equal(resolve(request('10.0.0.2', Array(34).fill('127.0.0.1').join(','))), '10.0.0.2');
});

test('invalid proxy configuration fails closed instead of trusting all peers', () => {
  for (const value of ['*', 'localhost', '10.0.0.1/33', '::1/129', '127.0.0.1/8/8', '10.0.0.1/']) {
    assert.throws(() => createClientAddressResolver({ EVENTOUCH_TRUSTED_PROXIES: value }), /EVENTOUCH_TRUSTED_PROXIES/);
  }
});

test('request route templates never retain path credentials or query parameters', () => {
  assert.equal(requestRoute('/api/auth/invitations/secret-bearer?phone=01012345678'), '/api/auth/invitations/:token');
  assert.equal(requestRoute('/api/public/events/private-slug/files/private-file?ticket=secret'), '/api/public/events/:slug/files/:fileId');
  assert.equal(requestRoute('/arbitrary/secret-bearer'), '/unmatched');
});

test('access logs correlate responses without recording secrets, identities or raw URLs', async () => {
  const lines = [];
  const observations = createRequestObservability({ env: { EVENTOUCH_REQUEST_LOGS: '1', EVENTOUCH_BUILD_REVISION: 'synthetic-123' }, write: line => lines.push(line) });
  const server = createServer((req, res) => { observations.attach(req, res); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/invitations/secret-bearer?email=private@example.test`, {
      headers: { authorization: 'Bearer secret-token', cookie: 'etko_session=secret-cookie', 'x-request-id': 'private-user-input' },
    });
    await res.text();
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.requestId, res.headers.get('x-request-id'));
    assert.equal(entry.status, 200);
    assert.equal(entry.route, '/api/auth/invitations/:token');
    assert.equal(observations.snapshot().release, 'synthetic-123');
    assert.equal(observations.snapshot().routes[0].requests, 1);
    assert.doesNotMatch(JSON.stringify({ lines, snapshot: observations.snapshot() }), /secret-|private@|private-user/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

let harness;
before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness({ env: { EVENTOUCH_SIGNUP_ADDRESS_LIMIT: '2', EVENTOUCH_SIGNUP_EVENT_LIMIT: '5', EVENTOUCH_BUILD_REVISION: 'synthetic-runtime' } });
  for (const role of ['AGENCY', 'MANAGER']) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,  id: `runtime-${role}`, name: role, role, email: `runtime-${role}@example.test` });
  }
  const workspace = emptyWorkspace();
  workspace.registrationOpen = true;
  workspace.publishedVersion = 1;
  workspace.publishedFields = workspace.fields;
  await insertEvent(harness.database, {orgId: LEGACY_ORG,  id: 'runtime-event', slug: 'runtime-event', payload: { stage: 'READY', capacity: 100, features: [] }, workspace });
});
after(async () => { if (harness) await harness.close(); });

test('signup admission survives HTTP restart and does not count a response-loss retry twice', { skip: !databaseUrl }, async () => {
  const send = (key, name, phone) => requestJson(harness.baseUrl, '/api/events/runtime-event/signup', { method: 'POST', body: { commandId: key, name, phone, formVersion: 1, consent: true } });
  const first = await send('runtime-signup-0001', '합성1', '01010000001');
  assert.equal(first.status, 201);
  assert.equal((await send('runtime-signup-0002', '합성2', '01010000002')).status, 201);
  await harness.restartHttp();
  const replay = await send('runtime-signup-0001', '합성1', '01010000001');
  assert.equal(replay.status, 200);
  assert.equal(replay.json.participant.id, first.json.participant.id);
  const limited = await send('runtime-signup-0003', '합성3', '01010000003');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const count = await harness.database.query('SELECT count(*)::int AS n FROM signup_request_attempts');
  assert.equal(count.rows[0].n, 2);
  const state = await harness.database.query("SELECT jsonb_array_length(payload->'participants')::int AS n FROM event_workspaces WHERE event_id = 'runtime-event'");
  assert.equal(state.rows[0].n, 2);
  const raw = await harness.database.query('SELECT command_hash, address_hash FROM signup_request_attempts');
  assert.doesNotMatch(JSON.stringify(raw.rows), /runtime-signup|127\.0\.0\.1|010100/);
});

test('operational diagnostics are owner-only and expose no workspace or credentials', { skip: !databaseUrl }, async () => {
  assert.equal((await requestJson(harness.baseUrl, '/api/diagnostics')).status, 401);
  const manager = await sessionCookie(harness, 'runtime-MANAGER');
  assert.equal((await requestJson(harness.baseUrl, '/api/diagnostics', { cookie: manager })).status, 403);
  const agency = await sessionCookie(harness, 'runtime-AGENCY');
  const result = await requestJson(harness.baseUrl, '/api/diagnostics', { cookie: agency });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.json.release, 'synthetic-runtime');
  assert.doesNotMatch(JSON.stringify(result.json), /runtime-signup|etko_session|runtime-AGENCY@|010100/);
});
