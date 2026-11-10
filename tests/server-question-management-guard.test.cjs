'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership,
  sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name,
  { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('Q&A management compares the reviewed state under lock and replays committed receipts', async () => {
  const harness = await startApiHarness();
  try {
    const eventId = `qa-guard-${crypto.randomUUID()}`;
    const accountId = `qa-manager-${crypto.randomUUID()}`;
    const outsideId = `qa-outside-${crypto.randomUUID()}`;
    for (const id of [accountId, outsideId]) {
      await insertAccount(harness.database, { id, role: 'MANAGER', name: '합성 운영자',
        email: `${id}@example.test`, orgId: LEGACY_ORG });
    }
    const workspace = emptyWorkspace();
    workspace.modules = [{ id: 'qa', type: 'qa', title: '질문', status: 'OPEN', published: true }];
    workspace.questions = [
      { id: 'q', moduleId: 'qa', text: '원래 질문', answer: '', approved: false, likes: [] },
      { id: 'other', moduleId: 'qa', text: '다른 질문', answer: '', approved: false, likes: [] },
      { id: 'edited', moduleId: 'qa', text: '수정된 질문', answer: '', approved: false, edited: true, likes: [] },
      { id: 'legacy', moduleId: 'qa', text: '이전 질문' },
    ];
    await insertEvent(harness.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'READY', features: ['qa'] }, workspace });
    await insertMembership(harness.database, accountId, eventId, ['all']);
    const cookie = await sessionCookie(harness, accountId);
    const outside = await sessionCookie(harness, outsideId);
    const send = (payload, id = crypto.randomUUID(), session = cookie) => requestJson(harness.baseUrl,
      `/api/events/${eventId}/commands`, { method: 'POST', cookie: session,
        body: { commandId: id, command: 'question.manage', payload } });
    const stored = async () => (await harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId])).rows[0].payload;
    const base = { text: '원래 질문', answer: '', approved: false };
    const firstPayload = { id: 'q', expectedText: base.text, expectedQuestion: base, answer: '공개 답변', approved: true };

    // Both manager bootstrap routes return the guard's complete legacy
    // defaults, without mutating the original JSON stored in PostgreSQL.
    for (const url of ['/api/bootstrap', `/api/events/${eventId}/bootstrap`]) {
      const result = await requestJson(harness.baseUrl, url, { cookie });
      assert.equal(result.status, 200, JSON.stringify(result.json));
      const legacy = result.json.state.workspaces[eventId].questions.find((item) => item.id === 'legacy');
      assert.deepEqual({ text: legacy.text, answer: legacy.answer, approved: legacy.approved },
        { text: '이전 질문', answer: '', approved: false });
    }
    const untouched = (await stored()).questions.find((item) => item.id === 'legacy');
    assert.equal(Object.hasOwn(untouched, 'answer'), false);
    assert.equal(Object.hasOwn(untouched, 'approved'), false);
    assert.equal((await send({ id: 'legacy', expectedText: '이전 질문',
      expectedQuestion: { text: '이전 질문', answer: '', approved: false }, answer: '이전 질문 답변', approved: true })).status, 200);

    assert.ok([403, 404].includes((await send(firstPayload, crypto.randomUUID(), outside)).status));
    for (const bad of [null, {}, { ...base, answer: null }, { ...base, approved: 'false' }, []]) {
      const result = await send({ ...firstPayload, expectedQuestion: bad });
      assert.equal(result.status, 400, JSON.stringify(result.json));
    }
    // Unrelated questions do not invalidate the reviewed state.
    assert.equal((await send({ id: 'other', answer: '다른 답변', approved: true })).status, 200);
    const firstId = crypto.randomUUID();
    const first = await send(firstPayload, firstId);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const latest = { text: base.text, answer: '공개 답변', approved: true };
    for (const expectedQuestion of [base, { ...latest, text: '이전 질문' },
      { ...latest, answer: '이전 답변' }, { ...latest, approved: false }]) {
      const stale = await send({ ...firstPayload, answer: '덮어쓰기', approved: false, expectedQuestion });
      assert.equal(stale.status, 409, JSON.stringify(stale.json));
      assert.equal(stale.json.code, 'QUESTION_MANAGEMENT_CHANGED');
      const current = (await stored()).questions.find((q) => q.id === 'q');
      assert.equal(current.answer, '공개 답변');
      assert.equal(current.approved, true);
    }

    // Two independent operators reviewed the same state: only one may save.
    const contenders = await Promise.all(['동시 답변 A', '동시 답변 B'].map((answer) => send({
      id: 'q', expectedText: base.text, expectedQuestion: latest, answer, approved: true,
    })));
    assert.deepEqual(contenders.map((response) => response.status).sort(), [200, 409]);
    assert.equal(contenders.find((response) => response.status === 409).json.code, 'QUESTION_MANAGEMENT_CHANGED');
    const afterRace = (await stored()).questions.find((q) => q.id === 'q');
    assert.ok(['동시 답변 A', '동시 답변 B'].includes(afterRace.answer));
    assert.equal(afterRace.approved, true);
    // A response-lost retry returns its original receipt, even after another save.
    const replay = await send(firstPayload, firstId);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, first.json);
    assert.equal((await stored()).questions.find((q) => q.id === 'q').answer, afterRace.answer);

    // Legacy calls and the pre-existing edited-question protection are unchanged.
    assert.equal((await send({ id: 'edited', answer: '답변', approved: true, expectedText: '이전 질문' })).status, 409);
    assert.equal((await send({ id: 'edited', answer: '답변', approved: true, expectedText: '수정된 질문' })).status, 200);
    assert.equal((await send({ id: 'q', answer: '이전 호출', approved: false })).status, 200);
  } finally {
    await harness.close();
  }
});
