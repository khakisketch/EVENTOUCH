'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apply } = require('../server/commands/engagement');

test('a Q&A module with questions cannot be overwritten via module.save', async () => {
  const original = { id: 'qa', type: 'qa', title: '질문', status: 'OPEN', published: true };
  const question = { id: 'q', moduleId: 'qa', text: '공개 질문', answer: '답변', approved: true, likes: ['p'] };
  const workspace = { modules: [original], responses: [], questions: [question] };
  const ctx = {
    command: 'module.save', input: { id: 'qa', type: 'poll', title: '변경', options: ['a', 'b'] },
    event: { features: ['qa', 'poll'] }, workspace,
    clean: (value, max) => String(value || '').trim().slice(0, max),
    makeId: () => 'new', fail: (status, message) => Object.assign(new Error(message), { status }),
  };
  await assert.rejects(apply(ctx), (error) => error.status === 409);
  assert.equal(original.type, 'qa');
  assert.deepEqual(question, { id: 'q', moduleId: 'qa', text: '공개 질문', answer: '답변', approved: true, likes: ['p'] });
});
