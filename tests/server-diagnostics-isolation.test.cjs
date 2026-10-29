'use strict';
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL URL required' }, fn);
let h;
before(async () => {
  if (!databaseUrl) return;
  h = await startApiHarness();
  await h.database.query("INSERT INTO organizations(id,name) VALUES('diagnostics-org-b','합성 B')");
  for (const [orgId, suffix] of [[LEGACY_ORG, 'a'], ['diagnostics-org-b', 'b']]) {
    await insertAccount(h.database, { orgId, id: `diagnostics-${suffix}`, name: `합성 ${suffix}`, email: `diagnostics-${suffix}@example.test`, role: 'AGENCY' });
    await insertEvent(h.database, { orgId, id: `diagnostics-event-${suffix}`, slug: `diagnostics-event-${suffix}`, payload: { name: `합성 ${suffix}`, stage: 'DRAFT', features: [] }, workspace: emptyWorkspace() });
  }
  for (const [id, eventId] of [['diag-a-1', 'diagnostics-event-a'], ['diag-b-1', 'diagnostics-event-b'], ['diag-b-2', 'diagnostics-event-b']]) {
    await h.database.query("INSERT INTO message_outbox(message_id,event_id,status,next_attempt_at) VALUES($1,$2,'PENDING',now())", [id, eventId]);
  }
});
after(async () => { if (h) await h.close(); });

test('public health never exposes aggregate tenant work', async () => {
  const health = await requestJson(h.baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(Object.hasOwn(health.json, 'outboxPending'), false);
});

test('owner diagnostics count only the verified owning organization', async () => {
  for (const [suffix, expected] of [['a', 1], ['b', 2]]) {
    const cookie = await sessionCookie(h, `diagnostics-${suffix}`);
    const result = await requestJson(h.baseUrl, '/api/diagnostics', { cookie });
    assert.equal(result.status, 200);
    assert.equal(result.json.outboxPending, expected);
    assert.equal(result.headers.get('x-eventouch-organization-id'), result.json.organizationId);
    assert.equal(Object.hasOwn(result.json, 'routes'), false);
  }
  assert.equal((await requestJson(h.baseUrl, '/api/diagnostics')).status, 401);
});
