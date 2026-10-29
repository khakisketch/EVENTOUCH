'use strict';

// Event format (진행 형태): optional display metadata only.
//
// Contract: create accepts omitted/'' as unspecified and exactly
// offline|online|hybrid otherwise (else 400 field=format); update without
// format keeps the stored value, '' clears explicitly, anything else 400.
// Stored in events.payload only (no migration, no new column). Legacy rows
// without the key stay unspecified — never defaulted to 'offline', never
// backfilled. Duplicate copies the setting but keeps the new-event rules
// (DRAFT, closed registration, no file references). Receipts keep the
// pre-existing request shape: an unspecified create matches the legacy
// 7-field fingerprint, a specified format joins it.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const ids = { agency: `fmt-agency-${suffix}` };
let harness;
let cookie;

const api = (url, options) => requestJson(harness.baseUrl, url, options);
const commandId = (tag) => `fmt-${tag}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const H = (orgId, version) => ({
  'x-eventouch-organization-id': orgId,
  'x-eventouch-context-version': String(version),
});

async function createEvent(input, headers) {
  const res = await api('/api/events', {
    method: 'POST', cookie, ...(headers ? { headers } : {}),
    body: { commandId: commandId('create'), name: `형태 행사 ${suffix}`, slug: `fmt-${suffix}-${Math.floor(Math.random() * 1e9)}`, date: '2026-12-01', start: '10:00', end: '17:00', capacity: 50, ...input },
  });
  return res;
}

async function bootstrapEvents() {
  const res = await api('/api/bootstrap', { cookie });
  assert.equal(res.status, 200);
  return res.json.state ? res.json.state.events : res.json.events;
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertAccount(harness.database, {
    orgId: LEGACY_ORG, id: ids.agency, role: 'AGENCY',
    name: '형태 관리자', email: `${ids.agency}@example.test`,
  });
  cookie = await sessionCookie(harness, ids.agency);
});

after(async () => {
  if (harness) await harness.close();
});

test('create stores each format and reads stay consistent', async (t) => {
  if (!databaseUrl) return t.skip();
  const seen = {};
  for (const format of ['offline', 'online', 'hybrid']) {
    const created = await createEvent({ format });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.event.format, format);
    seen[format] = created.json.event.id;
  }
  const events = await bootstrapEvents();
  for (const format of ['offline', 'online', 'hybrid']) {
    const found = events.find((event) => event.id === seen[format]);
    assert.ok(found, `${format} visible in bootstrap`);
    assert.equal(found.format, format);
  }
  const detail = await api(`/api/events/${seen.hybrid}/bootstrap`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.state.events[0].format, 'hybrid');
  const directory = await api('/api/console/directory', { cookie });
  assert.equal(directory.status, 200);
  for (const format of ['offline', 'online', 'hybrid']) {
    const foundDir = directory.json.directory.events.find((event) => event.id === seen[format]);
    assert.ok(foundDir, `${format} visible in directory`);
    assert.equal(foundDir.format, format);
  }
});

test('create omits format when unspecified and never defaults to offline', async (t) => {
  if (!databaseUrl) return t.skip();
  for (const extra of [{}, { format: '' }]) {
    const created = await createEvent(extra);
    assert.equal(created.status, 201);
    assert.ok(!('format' in created.json.event), 'unspecified stays absent, not offline');
  }
  const id = (await createEvent({})).json.event.id;
  const events = await bootstrapEvents();
  const found = events.find((event) => event.id === id);
  assert.ok(found && !('format' in found), 'read keeps unspecified absent');
  const directory = await api('/api/console/directory', { cookie });
  assert.equal(directory.status, 200);
  const foundDir = directory.json.directory.events.find((event) => event.id === id);
  assert.ok(foundDir && !('format' in foundDir), 'directory keeps unspecified absent');
});

test('create rejects unknown formats with field=format', async (t) => {
  if (!databaseUrl) return t.skip();
  for (const bad of ['onsite', 'remote', 'OFFLINE ', 'hybrid ', 42, null, false, ['offline']]) {
    const res = await createEvent({ format: bad });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.field, 'format');
  }
});

test('update keeps, clears, or sets format; rejects the rest', async (t) => {
  if (!databaseUrl) return t.skip();
  const created = await createEvent({ format: 'hybrid' });
  const id = created.json.event.id;
  const put = (body) => api(`/api/events/${id}/commands`, {
    method: 'POST', cookie,
    body: { commandId: commandId('upd'), command: 'event.update', payload: { name: '형태 행사', ...body } },
  });
  // Omitted: keeps the stored value.
  const kept = await put({ date: '2026-12-02', start: '10:00', end: '17:00', capacity: 50 });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.event.format, 'hybrid');
  // Explicit clear: the key is removed (unspecified), not defaulted.
  const cleared = await put({ date: '2026-12-02', start: '10:00', end: '17:00', capacity: 50, format: '' });
  assert.equal(cleared.status, 200);
  assert.ok(!('format' in cleared.json.event), 'explicit clear removes the key');
  // Set again.
  const set = await put({ date: '2026-12-02', start: '10:00', end: '17:00', capacity: 50, format: 'online' });
  assert.equal(set.status, 200);
  assert.equal(set.json.event.format, 'online');
  // Unknown values are rejected without touching the stored value.
  const bad = await put({ date: '2026-12-02', start: '10:00', end: '17:00', capacity: 50, format: 'onsite' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, 'format');
  const invalidNull = await put({ date: '2026-12-02', start: '10:00', end: '17:00', capacity: 50, format: null });
  assert.equal(invalidNull.status, 400);
  assert.equal(invalidNull.json.field, 'format');
  const reread = (await bootstrapEvents()).find((event) => event.id === id);
  assert.equal(reread.format, 'online');
});

test('duplicate copies format as setting metadata, keeps new-event rules', async (t) => {
  if (!databaseUrl) return t.skip();
  const source = (await createEvent({ format: 'offline' })).json.event;
  const dup = await api(`/api/events/${source.id}/duplicate`, {
    method: 'POST', cookie,
    body: { commandId: commandId('dup'), name: `복사 행사 ${suffix}`, slug: `fmt-copy-${suffix}` },
  });
  assert.equal(dup.status, 201);
  assert.equal(dup.json.event.format, 'offline');
  assert.equal(dup.json.event.stage, 'DRAFT');
  const legacy = (await createEvent({})).json.event;
  const legacyDup = await api(`/api/events/${legacy.id}/duplicate`, {
    method: 'POST', cookie,
    body: { commandId: commandId('dup2'), name: `복사2 ${suffix}`, slug: `fmt-copy2-${suffix}` },
  });
  assert.equal(legacyDup.status, 201);
  assert.ok(!('format' in legacyDup.json.event), 'legacy source stays unspecified');
});

test('receipts keep the legacy shape: unspecified replays, format change conflicts', async (t) => {
  if (!databaseUrl) return t.skip();
  const key = commandId('receipt');
  const base = {
    name: `영수증 ${suffix}`, slug: `fmt-rcpt-${suffix}`, date: '2026-12-01',
    start: '10:00', end: '17:00', capacity: 10,
  };
  const first = await api('/api/events', { method: 'POST', cookie, body: { commandId: key, ...base } });
  assert.equal(first.status, 201);
  const replay = await api('/api/events', { method: 'POST', cookie, body: { commandId: key, ...base } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.event.id, first.json.event.id);
  const replayUnspecified = await api('/api/events', { method: 'POST', cookie, body: { commandId: key, ...base, format: '' } });
  assert.equal(replayUnspecified.status, 200);
  assert.equal(replayUnspecified.json.event.id, first.json.event.id);
  const conflict = await api('/api/events', { method: 'POST', cookie, body: { commandId: key, ...base, format: 'online' } });
  assert.equal(conflict.status, 409);
  const keyed = commandId('receipt-fmt');
  const shaped = { ...base, slug: `fmt-rcpt2-${suffix}`, format: 'hybrid' };
  const created = await api('/api/events', { method: 'POST', cookie, body: { commandId: keyed, ...shaped } });
  assert.equal(created.status, 201);
  const replaySame = await api('/api/events', { method: 'POST', cookie, body: { commandId: keyed, ...shaped } });
  assert.equal(replaySame.status, 200);
  assert.equal(replaySame.json.event.id, created.json.event.id);
});

test('legacy rows stay unspecified and byte-stable with no backfill', async (t) => {
  if (!databaseUrl) return t.skip();
  const id = `fmt-legacy-${suffix}`;
  await harness.database.query(
    'INSERT INTO events (id, slug, client_id, org_id, payload) VALUES ($1, $2, NULL, $3, $4::jsonb)',
    [id, `fmt-leg-${suffix}`, LEGACY_ORG, JSON.stringify({ id, name: '이전 행사 üñí', slug: `fmt-leg-${suffix}`, date: '2026-12-01', start: '10:00', end: '17:00', capacity: 5, stage: 'DRAFT', features: [] })]
  );
  await harness.database.query('INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)', [id, JSON.stringify({ participants: [], fields: [], publishedFields: [], notices: [], program: [], groups: [] })]);
  const readPayload = () => harness.database.query('SELECT payload::text AS p FROM events WHERE id = $1', [id]).then((r) => r.rows[0].p);
  const before = await readPayload();
  assert.ok(!before.includes('"format"'), 'legacy fixture carries no format key');
  // Pure reads change nothing: identical JSONB text before and after.
  const events = await bootstrapEvents();
  const found = events.find((event) => event.id === id);
  assert.ok(found, 'legacy row is readable');
  assert.ok(!('format' in found), 'legacy rows never default to offline');
  const detail = await api(`/api/events/${id}/bootstrap`, { cookie });
  assert.equal(detail.status, 200);
  assert.ok(!('format' in detail.json.state.events[0]), 'detail keeps unspecified absent');
  assert.equal(await readPayload(), before, 'reads do not rewrite stored bytes');
  // An unrelated update keeps the value unspecified (key stays absent).
  const updated = await api(`/api/events/${id}/commands`, {
    method: 'POST', cookie,
    body: { commandId: commandId('legacy-upd'), command: 'event.update', payload: { name: '이전 행사 이름 변경', date: '2026-12-01', start: '10:00', end: '17:00', capacity: 5 } },
  });
  assert.equal(updated.status, 200);
  assert.ok(!('format' in updated.json.event), 'omitted update preserves unspecified');
  const after = await readPayload();
  assert.ok(!after.includes('"format"'), 'no format key is invented by the update');
  assert.equal(JSON.parse(after).name, '이전 행사 이름 변경');
});

test('cross-org writes stay denied and values persist across restart', async (t) => {
  if (!databaseUrl) return t.skip();
  const org = await api('/api/auth/organizations', {
    method: 'POST', cookie,
    body: { name: `형태 조직 ${suffix}`, commandId: commandId('org') },
  });
  assert.equal(org.status, 201);
  const orgB = org.json.organization.id;
  const rev0 = (await api('/api/auth/me', { cookie })).json.user.contextVersion;
  const other = (await createEvent({}, H(LEGACY_ORG, rev0))).json.event;
  const sel = await api('/api/auth/organizations/select', {
    method: 'POST', cookie,
    body: { organizationId: orgB, expectedContextVersion: rev0, commandId: commandId('sel') },
  });
  assert.equal(sel.status, 200);
  const headers = H(orgB, sel.json.contextVersion);
  const cross = await api(`/api/events/${other.id}/commands`, {
    method: 'POST', cookie, headers,
    body: { commandId: commandId('cross'), command: 'event.stage', payload: { stage: 'READY' } },
  });
  assert.equal(cross.status, 409);
  assert.equal(cross.json.code, 'ORGANIZATION_CONTEXT_CHANGED');
  await harness.restartHttp();
  const backHome = await api('/api/auth/organizations/select', {
    method: 'POST', cookie,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: sel.json.contextVersion, commandId: commandId('sel-back') },
  });
  assert.equal(backHome.status, 200);
  const events = await bootstrapEvents();
  assert.ok(events.some((event) => event.id === other.id), 'values survive an HTTP restart');
});

test('public projection does not expand for format', async (t) => {
  if (!databaseUrl) return t.skip();
  const meNow = await api('/api/auth/me', { cookie });
  const home = await api('/api/auth/organizations/select', {
    method: 'POST', cookie,
    body: { organizationId: LEGACY_ORG, expectedContextVersion: meNow.json.user.contextVersion, commandId: commandId('back-home') },
  });
  assert.equal(home.status, 200);
  const created = await createEvent({ format: 'hybrid' }, H(LEGACY_ORG, home.json.contextVersion));
  const id = created.json.event.id;
  const slug = created.json.event.slug;
  const ready = await api(`/api/events/${id}/commands`, {
    method: 'POST', cookie, headers: H(LEGACY_ORG, home.json.contextVersion),
    body: { commandId: commandId('ready'), command: 'event.stage', payload: { stage: 'READY' } },
  });
  assert.equal(ready.status, 200);
  const pub = await requestJson(harness.baseUrl, `/api/public/events/${slug}`);
  assert.equal(pub.status, 200);
  assert.ok(!('format' in pub.json.event), 'public projection stays minimal');
});
