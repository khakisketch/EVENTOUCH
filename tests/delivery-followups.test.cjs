'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loginHistoryPolicy } = require('../server/login-history');
const { startApiHarness, insertAccount, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { loadHelpers, seedAuditFixture } = require('../scripts/audit-fixture.cjs');

test('login timestamps require a retention policy and are restricted to the signed-in holder', async () => {
  for (const raw of ['', '0', '-1', '1.5', 'garbage']) assert.equal(loginHistoryPolicy({ EVENTOUCH_LOGIN_HISTORY_DAYS: raw }).enabled, false);
  const h = await startApiHarness({ authOptions: { env: { ...process.env, EVENTOUCH_LOGIN_HISTORY_DAYS: '14' } } });
  try {
    for (const id of ['history-a', 'history-b']) await insertAccount(h.database, { id, orgId: LEGACY_ORG, role: 'AGENCY', name: id, email: `${id}@example.test` });
    assert.equal((await requestJson(h.baseUrl, '/api/auth/login-history')).status, 401);
    const login = await requestJson(h.baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'history-a@example.test', password: 'not-a-real-test-password' } });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    await requestJson(h.baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'history-a@example.test', password: 'wrong-password' } });
    assert.equal((await h.database.query('SELECT count(*)::int AS n FROM account_login_events')).rows[0].n, 1);
    await h.database.query("INSERT INTO account_login_events (id,account_id,occurred_at) VALUES ('old','history-b',now()-interval '30 days')");
    const history = await requestJson(h.baseUrl, '/api/auth/login-history', { cookie });
    assert.equal(history.status, 200); assert.equal(history.json.retentionDays, 14); assert.equal(history.json.entries.length, 1);
    assert.deepEqual(Object.keys(history.json.entries[0]), ['at']);
    const other = await sessionCookie(h, 'history-b');
    assert.equal((await requestJson(h.baseUrl, '/api/auth/login-history', { cookie: other })).json.entries.length, 0);
    assert.equal((await h.database.query("SELECT count(*)::int AS n FROM account_login_events WHERE id='old'")).rows[0].n, 0);
  } finally { await h.close(); }
});

test('quiz manual grading preserves permissions, stale guards, receipt replay and archived/public boundaries', async () => {
  const h = await startApiHarness();
  try {
    const f = await seedAuditFixture(h, loadHelpers());
    const { review } = require('../scripts/event-purge-review.cjs');
    const impact = await review(h.database, LEGACY_ORG, f.eventId);
    assert.equal(impact.deletionEnabled, false); assert.equal(impact.counts.participants, 8);
    await assert.rejects(review(h.database, 'another-org', f.eventId));

    await h.database.query("UPDATE events SET payload=jsonb_set(payload,'{features}','[\"quiz\"]'::jsonb) WHERE id=$1", [f.eventId]);
    const command = (name, payload, cookie = f.manager.cookie, commandId = crypto.randomUUID()) => requestJson(h.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie, body: { commandId, command: name, payload } });
    const module = (await command('module.save', { type: 'quiz', title: '수동 채점 검증', answer: '정답' })).json.module;
    await command('module.status', { id: module.id, status: 'CLOSED' });
    const row = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    row.responses.push({ id: 'manual-response', moduleId: module.id, participantId: row.participants[0].id, answer: '정 답' });
    await h.database.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [f.eventId, row]);
    const payload = { moduleId: module.id, responseId: 'manual-response', grade: 'CORRECT', expectedGradeVersion: 0 }, key = crypto.randomUUID();
    assert.equal((await command('response.grade', payload, f.staff.cookie)).status, 403);
    const first = await command('response.grade', payload, f.manager.cookie, key); assert.equal(first.status, 200, JSON.stringify(first.json)); assert.equal(first.json.gradeVersion, 1);
    assert.deepEqual((await command('response.grade', payload, f.manager.cookie, key)).json, first.json);
    assert.equal((await command('response.grade', { ...payload, grade: 'INCORRECT' })).status, 409);
    const cleared = await command('response.grade', { ...payload, grade: 'AUTO', expectedGradeVersion: 1 }); assert.equal(cleared.status, 200); assert.equal(cleared.json.manualGrade, null); assert.equal(cleared.json.gradeVersion, 2);
    assert.equal((await command('response.grade', { ...payload, responseId: 'another-event-response', expectedGradeVersion: 0 })).status, 404);
    const publicView = await requestJson(h.baseUrl, `/api/public/events/${f.slug}`); assert.equal(publicView.status, 200); assert.equal(JSON.stringify(publicView.json).includes('gradedBy'), false);
    await h.database.query("UPDATE events SET payload=jsonb_set(payload,'{stage}','\"ARCHIVED\"'::jsonb) WHERE id=$1", [f.eventId]);
    assert.equal((await command('response.grade', { ...payload, expectedGradeVersion: 2 })).status, 409);
  } finally { await h.close(); }
});
