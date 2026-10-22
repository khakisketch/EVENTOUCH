'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicWorkspace } = require('../server/public-events.js');

test('attendee draw projection excludes unpublished programs and winner identities', () => {
  const source = {
    drawPrograms: [
      { id: 'draft', published: false, winners: [{ name: '비공개 당첨자', company: '비공개 소속' }] },
      { id: 'implicit-draft', winners: [{ name: '게시 전 당첨자' }] },
      { id: 'published', published: true, status: 'DONE', winners: [{ name: '게시 당첨자', company: '게시 소속', participantId: 'private-id', phone: 'private-phone' }] },
    ],
  };
  const view = publicWorkspace(source, { features: ['draw'] });
  assert.deepEqual(view.drawPrograms.map((item) => item.id), ['published']);
  assert.deepEqual(view.drawPrograms[0].winners, [{ name: '게시 당첨자', company: '게시 소속' }]);
  assert.doesNotMatch(JSON.stringify(view), /비공개|게시 전|private-id|private-phone/);
});

test('attendee draw projection hides programs when the draw feature is disabled', () => {
  const source = { drawPrograms: [{ id: 'published', published: true, winners: [{ name: '당첨자' }] }] };
  assert.deepEqual(publicWorkspace(source, { features: [] }).drawPrograms, []);
});
