'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { participationSnapshot, readParticipationHandoff } = require('../apps/web/lib/participation-work.ts');

test('participation work counts unique questions while keeping overlapping approval, answer and edit classes explicit', () => {
  const workspace = {
    modules: [{ id: 'qa', type: 'qa', status: 'OPEN', published: true }],
    questions: [
      { id: 'q1', moduleId: 'qa', answer: '', approved: false },
      { id: 'q1', moduleId: 'qa', answer: '', approved: false },
      { id: 'q2', moduleId: 'qa', answer: '기존 답변', approved: true, pendingEdit: { id: 'edit', text: '수정안' } },
      { id: 'q3', moduleId: 'qa', answer: '답변 완료', approved: true },
      { id: 'orphan', moduleId: 'missing', answer: '', approved: false },
    ],
  };
  const tasks = participationSnapshot(workspace, ['qa']).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].count, '질문 2개');
  assert.equal(tasks[0].hint, '미답변 1건 · 승인 대기 1건 · 수정안 1건');
  assert.equal(tasks[0].review, 'qa-edits');
  assert.deepEqual(participationSnapshot(workspace, []).tasks, []);
  assert.equal(workspace.questions.length, 5, 'a read summary never changes stored rows');
});

test('only enabled participation types and pending records produce review links; malformed data degrades to an empty summary', () => {
  const workspace = {
    modules: [{ id: 'photo', type: 'photo', published: true, status: 'CLOSED' }, { id: 'board', type: 'board', published: true, status: 'OPEN' }],
    photos: [{ id: 'p1', status: 'PENDING' }, { id: 'p2', status: 'APPROVED' }],
    posts: [{ id: 'b1', status: 'PENDING' }, { id: 'b2', status: 'HIDDEN' }],
  };
  const result = participationSnapshot(workspace, ['photo', 'board']);
  assert.deepEqual(result.tasks.map(task => task.review), ['photo', 'post']);
  assert.deepEqual(result.open.map(module => module.id), ['board']);
  assert.deepEqual(participationSnapshot(workspace, ['board']).tasks.map(task => task.review), ['post']);
  assert.deepEqual(participationSnapshot({ modules: null, photos: 'invalid', questions: [null, 1, []] }, ['qa']), { tasks: [], open: [] });
  assert.deepEqual(participationSnapshot({ modules: [{ id: 'qa', type: 'qa' }], questions: [{ id: 'q', moduleId: 'qa', approved: true, answer: '완료', pendingEdit: {} }] }, ['qa']).tasks, []);
});

test('navigation handoffs accept one explicit read intent and reject ambiguous, unknown or path-like values without mutating the URL', () => {
  assert.equal(readParticipationHandoff(new URLSearchParams('from=overview')), null);
  assert.deepEqual(readParticipationHandoff(new URLSearchParams('review=qa-pending')), { kind: 'review', target: 'qa-pending' });
  assert.deepEqual(readParticipationHandoff(new URLSearchParams('module=module-1')), { kind: 'module', id: 'module-1' });
  assert.deepEqual(readParticipationHandoff(new URLSearchParams('status=OPEN')), { kind: 'status', status: 'OPEN' });
  for (const query of ['review=unknown', 'review=qa-pending&review=post', 'review=post&module=module-1', 'module=../../other', 'module=javascript:bad', 'status=ARCHIVED', 'module=']) {
    const params = new URLSearchParams(query), before = params.toString();
    assert.deepEqual(readParticipationHandoff(params), { kind: 'invalid' });
    assert.equal(params.toString(), before);
  }
});
