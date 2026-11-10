'use strict';

const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { emptyWorkspace } = require('../server/state');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name,
  { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

test('question reactions project only the viewer state and guard stale concurrent actions', async () => {
  const harness = await startApiHarness();
  try {
    const eventId = `like-${crypto.randomUUID()}`;
    const person = (name, status = 'APPROVED') => ({
      id: `person-${crypto.randomUUID()}`, name, status, revoked: false,
      ticket: crypto.randomBytes(32).toString('base64url'),
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      phone: '01000000000', group: '일반', paymentStatus: 'FREE',
    });
    const alice = person('합성 참가자 A'), bob = person('합성 참가자 B'), pending = person('승인 대기', 'PENDING');
    const workspace = emptyWorkspace();
    workspace.participants = [alice, bob, pending];
    workspace.modules = [{ id: 'qa', type: 'qa', title: '합성 Q&A', status: 'OPEN', published: true }];
    workspace.questions = [
      { id: 'public-q', moduleId: 'qa', participantId: bob.id, name: bob.name, text: '공개 질문', answer: '답변', approved: true, likes: [] },
      { id: 'private-q', moduleId: 'qa', participantId: bob.id, name: bob.name, text: '비공개 질문', answer: '', approved: false, likes: [] },
    ];
    await insertEvent(harness.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG,
      payload: { id: eventId, slug: eventId, name: '합성 행사', stage: 'LIVE', features: ['qa'] }, workspace });
    const managerId = `qa-manager-${crypto.randomUUID()}`;
    await insertAccount(harness.database, { id: managerId, role: 'MANAGER', name: '합성 운영자',
      email: `${managerId}@example.test`, orgId: LEGACY_ORG });
    await insertMembership(harness.database, managerId, eventId, ['all']);
    const managerCookie = await sessionCookie(harness, managerId);
    const stored = async () => (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const send = (ticket, payload, commandId = crypto.randomUUID()) => requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', ...(ticket ? { bearer: ticket } : {}),
      body: { commandId, command: 'question.like', payload },
    });
    const view = (ticket) => requestJson(harness.baseUrl, `/api/public/events/${eventId}${ticket ? '/ticket' : ''}`,
      ticket ? { bearer: ticket } : {});
    const question = (result) => result.json.workspace.questions.find((item) => item.id === 'public-q');
    const inspectView = (result, expected) => {
      assert.equal(result.status, 200, JSON.stringify(result.json));
      assert.match(result.headers.get('cache-control') || '', /no-store/i);
      const row = question(result);
      assert.ok(row);
      assert.equal(Array.isArray(row.likes), true);
      assert.ok(row.likes.every((entry) => entry === true));
      assert.ok(Number.isSafeInteger(row.likedCount) && row.likedCount >= 0);
      assert.equal(Object.hasOwn(row, 'likedByMe'), expected !== null);
      if (expected !== null) assert.equal(row.likedByMe, expected);
      assert.equal(JSON.stringify(row).includes(alice.id), false);
      assert.equal(JSON.stringify(row).includes(bob.id), false);
    };

    inspectView(await view(), null);
    inspectView(await view(alice.ticket), false);
    inspectView(await view(bob.ticket), false);
    assert.ok([401, 403].includes((await send(null, { id: 'public-q', expectedLiked: false, liked: true, expectedQuestionText: '공개 질문' })).status));
    const deniedPending = await send(pending.ticket, { id: 'public-q', expectedLiked: false, liked: true, expectedQuestionText: '공개 질문' });
    assert.equal(deniedPending.status, 409);
    assert.match(deniedPending.json.error, /참가 확정/);
    assert.equal((await send(alice.ticket, { id: 'private-q', expectedLiked: false, liked: true, expectedQuestionText: '비공개 질문' })).status, 404);
    for (const payload of [
      { id: 'public-q', liked: true }, { id: 'public-q', expectedLiked: false },
      { id: 'public-q', expectedLiked: false, liked: true },
      { id: 'public-q', expectedLiked: 'false', liked: true, expectedQuestionText: '공개 질문' },
      { id: 'public-q', expectedLiked: false, liked: null, expectedQuestionText: '공개 질문' },
    ]) assert.equal((await send(alice.ticket, payload)).status, 400);
    assert.deepEqual((await stored()).questions[0].likes, []);

    // Two tabs with the same visible false state cannot reverse one another.
    const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
    const payload = { id: 'public-q', expectedLiked: false, liked: true, expectedQuestionText: '공개 질문' };
    const attempts = await Promise.all([send(alice.ticket, payload, firstId), send(alice.ticket, payload, secondId)]);
    assert.deepEqual(attempts.map((item) => item.status).sort(), [200, 409]);
    const winnerId = attempts[0].status === 200 ? firstId : secondId;
    const winner = attempts.find((item) => item.status === 200);
    const conflict = attempts.find((item) => item.status === 409);
    assert.equal(winner.json.confirmedQuestionText, '공개 질문');
    assert.equal(conflict.json.code, 'QUESTION_LIKE_CHANGED');
    assert.equal(conflict.json.field, 'expectedLiked');
    assert.deepEqual((await stored()).questions[0].likes, [alice.id]);
    inspectView(await view(alice.ticket), true);
    inspectView(await view(bob.ticket), false);
    inspectView(await view(), null);

    // Another participant's reaction never changes this participant's flag.
    assert.equal((await send(bob.ticket, { id: 'public-q', expectedLiked: false, liked: true, expectedQuestionText: '공개 질문' })).status, 200);
    inspectView(await view(alice.ticket), true);
    inspectView(await view(bob.ticket), true);
    assert.equal(question(await view()).likes.length, 2);
    assert.equal((await send(alice.ticket, { id: 'public-q', expectedLiked: true, liked: false, expectedQuestionText: '공개 질문' })).status, 200);
    inspectView(await view(alice.ticket), false);
    inspectView(await view(bob.ticket), true);

    // After response loss and another write the original receipt still wins
    // before the stale-state check, and cannot toggle or reapply the action.
    const replay = await send(alice.ticket, payload, winnerId);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, winner.json);
    assert.deepEqual((await stored()).questions[0].likes, [bob.id]);

    // Existing clients remain supported: omitting both fields toggles as before.
    assert.equal((await send(alice.ticket, { id: 'public-q' })).json.liked, true);
    assert.equal((await send(alice.ticket, { id: 'public-q' })).json.liked, false);
    assert.deepEqual((await stored()).questions[0].likes, [bob.id]);

    // A question edit may be approved after a viewer sees its old wording.
    // The old action must not be attached to the new question; an already
    // committed receipt still replays before this guard.
    const editing = await requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', bearer: bob.ticket,
      body: { commandId: crypto.randomUUID(), command: 'question.edit', payload: {
        id: 'public-q', text: '새로운 질문', expectedText: '공개 질문', expectedPendingId: '', expectedApproved: true,
      } },
    });
    assert.equal(editing.status, 200, JSON.stringify(editing.json));
    const approval = await requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: managerCookie,
      body: { commandId: crypto.randomUUID(), command: 'question.edit.approve', payload: {
        id: 'public-q', expectedEditId: editing.json.editId, expectedText: '공개 질문', expectedAnswer: '답변', expectedNewText: '새로운 질문',
      } },
    });
    assert.equal(approval.status, 200, JSON.stringify(approval.json));
    assert.deepEqual((await stored()).questions[0].likes, [bob.id], 'approving an edit preserves existing likes');
    const oldQuestionAction = await send(alice.ticket, payload);
    assert.equal(oldQuestionAction.status, 409);
    assert.equal(oldQuestionAction.json.code, 'QUESTION_LIKE_CONTEXT_CHANGED');
    assert.equal(oldQuestionAction.json.field, 'expectedQuestionText');
    assert.deepEqual((await stored()).questions[0].likes, [bob.id]);
    const contextReplay = await send(alice.ticket, payload, winnerId);
    assert.equal(contextReplay.status, 200);
    assert.deepEqual(contextReplay.json, winner.json);
    assert.deepEqual((await stored()).questions[0].likes, [bob.id]);
    const latestPayload = { id: 'public-q', expectedLiked: false, liked: true, expectedQuestionText: '새로운 질문' };
    const latestAction = await send(alice.ticket, latestPayload);
    assert.equal(latestAction.status, 200);
    assert.equal(latestAction.json.confirmedQuestionText, '새로운 질문');
    assert.equal((await send(alice.ticket, { ...latestPayload, expectedLiked: true, liked: false })).status, 200);
    assert.deepEqual((await stored()).questions[0].likes, [bob.id]);

    // The legacy anonymized array stays bounded, while the aggregate is
    // accurate beyond that bound and exposes no identifier to either view.
    const many = await stored();
    many.questions[0].likes.push(...Array.from({ length: 1001 }, (_, index) => `synthetic-${index}`));
    await harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(many)]);
    for (const ticket of [null, alice.ticket, bob.ticket]) {
      const result = await view(ticket);
      inspectView(result, ticket === null ? null : ticket === bob.ticket);
      assert.equal(question(result).likes.length, 1000);
      assert.equal(question(result).likedCount, 1002);
      assert.equal(JSON.stringify(question(result)).includes('synthetic-'), false);
    }
  } finally {
    await harness.close();
  }
});
