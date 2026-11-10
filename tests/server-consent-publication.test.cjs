'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, insertAccount, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('a consent publication invalidates the prior form while committed signup retries remain valid', async () => {
  const harness = await startApiHarness();
  const suffix = crypto.randomUUID();
  const accountId = `consent-manager-${suffix}`;
  const fields = [
    { id: 'name', label: '이름', type: 'text', required: true, options: [] },
    { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
  ];
  const event = `consent-${suffix}`;
  const noConsentEvent = `no-consent-${suffix}`;
  const legacyEvent = `legacy-consent-${suffix}`;
  const historyEvent = `history-consent-${suffix}`;
  try {
    await insertAccount(harness.database, { id: accountId, role: 'MANAGER', name: '합성 운영자', email: `${accountId}@example.test`, orgId: LEGACY_ORG });
    for (const [id, consentText] of [[event, '안내 A'], [noConsentEvent, ''], [legacyEvent, '기존 안내'], [historyEvent, '예전 안내']]) {
      await insertEvent(harness.database, { id, slug: id, orgId: LEGACY_ORG,
        payload: { id, slug: id, name: '합성 행사', date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], fields, publishedFields: fields, formVersion: 5, publishedVersion: 5,
          registrationOpen: true, approvalRequired: false, consentText, consentVersion: 4, price: 0, verificationRequired: false },
      });
      await insertMembership(harness.database, accountId, id, ['all']);
    }
    const cookie = await sessionCookie(harness, accountId);
    const command = (id, command, payload, key = crypto.randomUUID()) => requestJson(harness.baseUrl, `/api/events/${id}/commands`, {
      method: 'POST', cookie, body: { commandId: key, command, payload },
    });
    const signup = (id, body) => requestJson(harness.baseUrl, `/api/events/${id}/signup`, { method: 'POST', body });
    const workspace = async id => (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    const publishId = crypto.randomUUID();
    const first = await command(event, 'form.publish', { consentText: '안내 B', expectedFormVersion: 5 }, publishId);
    assert.equal(first.status, 200);
    assert.equal(first.json.publishedVersion, 6, 'changed consent must create a new public form version');
    assert.equal(first.json.reviewedFormVersion, 5); assert.equal(first.json.reviewedPublishedVersion, 5);
    assert.equal(first.json.reviewedConsentVersion, 4); assert.equal(first.json.reviewedConsentText, '안내 A');
    assert.equal(first.json.consentVersion, 5); assert.equal(first.json.consentText, '안내 B'); assert.equal(first.json.consentChanged, true);
    const replay = await command(event, 'form.publish', { consentText: '안내 B', expectedFormVersion: 5 }, publishId);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.publishedVersion, 6, 'receipt replay keeps the original response');
    let state = await workspace(event);
    assert.equal(state.formVersion, 6); assert.equal(state.publishedVersion, 6); assert.equal(state.consentVersion, 5);
    assert.equal(state.consentNotices.length, 1, 'the same publication receipt never duplicates a notice');
    assert.equal(state.consentNotices[0].text, '안내 B'); assert.equal(state.consentNotices[0].version, 5);
    const changedConsent = await command(event, 'form.publish', { consentText: '다른 안내', expectedFormVersion: 6,
      expectedConsentVersion: 4, expectedConsentText: '안내 A' });
    assert.equal(changedConsent.status, 409); assert.equal((await workspace(event)).consentText, '안내 B');
    const stale = await signup(event, { commandId: crypto.randomUUID(), formVersion: 5, name: '이전 화면', phone: '01089002201', consent: true });
    assert.equal(stale.status, 409); assert.equal(stale.json.field, 'formVersion'); assert.equal(stale.json.code, 'SIGNUP_FORM_CHANGED');
    assert.equal((await workspace(event)).participants.length, 0);
    const oldOperator = await command(event, 'form.publish', { consentText: '안내 A', expectedFormVersion: 5 });
    assert.equal(oldOperator.status, 409); assert.equal((await workspace(event)).consentText, '안내 B');
    const freshBody = { commandId: crypto.randomUUID(), formVersion: 6, name: '현재 화면', phone: '01089002202', consent: true };
    const fresh = await signup(event, freshBody);
    assert.equal(fresh.status, 201); assert.equal(fresh.json.participant.consent.version, 5);
    assert.equal((await command(event, 'form.publish', { consentText: '안내 C', expectedFormVersion: 6 })).status, 200);
    const freshRetry = await signup(event, freshBody);
    assert.equal(freshRetry.status, 200); assert.equal(freshRetry.json.participant.id, fresh.json.participant.id);
    assert.equal((await workspace(event)).participants.length, 1, 'lost-response replay must not create a second participant');
    const unchanged = await command(event, 'form.publish', { consentText: '안내 C', expectedFormVersion: 7 });
    assert.equal(unchanged.status, 200); assert.equal(unchanged.json.publishedVersion, 7, 'same consent must not create a false new version');
    assert.equal((await command(event, 'field.save', { id: 'meal', label: '식사', type: 'text', expectedFormVersion: 7 })).status, 200);
    const mixed = await command(event, 'form.publish', { consentText: '안내 D', expectedFormVersion: 8 });
    assert.equal(mixed.status, 200); assert.equal(mixed.json.publishedVersion, 9);
    state = await workspace(event); assert.equal(state.consentVersion, 7); assert.ok(state.publishedFields.some(field => field.id === 'meal'));
    assert.equal((await signup(event, { commandId: crypto.randomUUID(), formVersion: 8, name: '이전 초안', phone: '01089002203', consent: true })).status, 409);
    assert.equal((await command(noConsentEvent, 'form.publish', { expectedFormVersion: 5 })).status, 200);
    assert.equal(Object.hasOwn(await workspace(noConsentEvent), 'consentNotices'), false, 'empty notice does not create evidence');
    assert.equal((await command(noConsentEvent, 'form.publish', { consentText: '새 필수 안내', expectedFormVersion: 5 })).status, 200);
    const oldNoConsent = await signup(noConsentEvent, { commandId: crypto.randomUUID(), formVersion: 5, name: '안내 전 화면', phone: '01089002204' });
    assert.equal(oldNoConsent.status, 409); assert.equal((await workspace(noConsentEvent)).participants.length, 0);
    const legacy = await workspace(legacyEvent); legacy.formVersion = 2;
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [legacyEvent, JSON.stringify(legacy)]);
    const legacyPublish = await command(legacyEvent, 'form.publish', { consentText: '새 안내', expectedFormVersion: 2 });
    assert.equal(legacyPublish.status, 200); assert.equal(legacyPublish.json.publishedVersion, 6, 'legacy draft must advance beyond the published version');
    assert.equal((await signup(legacyEvent, { commandId: crypto.randomUUID(), formVersion: 5, name: '기존 게시 화면', phone: '01089002205', consent: true })).status, 409);
    const historical = await workspace(historyEvent);
    historical.participants.push({ id: 'historic', name: '이전 참가자', phone: '01089002206', status: 'APPROVED', consent: { version: 4, at: '2026-01-01T00:00:00Z' } });
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [historyEvent, JSON.stringify(historical)]);
    assert.equal((await command(historyEvent, 'form.publish', { consentText: '새 안내', expectedFormVersion: 5 })).status, 200);
    const afterHistory = await workspace(historyEvent);
    assert.deepEqual(afterHistory.participants[0].consent, { version: 4, at: '2026-01-01T00:00:00Z' }, 'old acceptances are never backfilled');
    assert.deepEqual(afterHistory.consentNotices.map(item => item.text), ['새 안내'], 'old unavailable text is never invented');
  } finally { await harness.close(); }
});
