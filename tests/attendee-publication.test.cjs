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

// Added 2026-11-24 (attendee screens review, D2): a full event says so before the form is filled in.
// The rule is the signup writer's own (server/commands/participants.js createParticipant):
// capacity > 0 and active (not cancelled) participants, waiting list included, reached it.
test('public projection flags a full event with the signup writer rule and never exposes the headcount', () => {
  const people = (statuses) => statuses.map((status, index) => ({ id: `p${index}`, status, name: `이름${index}`, phone: '01012345678' }));
  const full = publicWorkspace({ participants: people(['APPROVED', 'PENDING']) }, { capacity: 2, features: [] });
  assert.equal(full.full, true);
  assert.equal(publicWorkspace({ participants: people(['APPROVED', 'WAITLIST', 'APPROVED']) }, { capacity: 2, features: [] }).full, true);
  // Cancelled people free their seat, in both of the ways the writer treats as cancelled.
  assert.equal(publicWorkspace({ participants: [...people(['APPROVED']), { id: 'x', status: 'CANCELLED' }, { id: 'y', status: 'APPROVED', cancelled: true }] }, { capacity: 2, features: [] }).full, false);
  // No capacity (0 or missing) means no limit.
  assert.equal(publicWorkspace({ participants: people(['APPROVED', 'APPROVED']) }, { capacity: 0, features: [] }).full, false);
  assert.equal(publicWorkspace({ participants: people(['APPROVED']) }, { features: [] }).full, false);
  assert.equal(publicWorkspace({}, { capacity: 5, features: [] }).full, false);
  // Only the boolean crosses over: no other participant is projected without a ticket.
  assert.deepEqual(full.participants, []);
  assert.doesNotMatch(JSON.stringify(full), /이름0|01012345678/);
});

test('the public full flag keeps the same active-participant rule as the signup writer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const writer = fs.readFileSync(path.join(__dirname, '..', 'server', 'commands', 'participants.js'), 'utf8');
  const projection = fs.readFileSync(path.join(__dirname, '..', 'server', 'public-events.js'), 'utf8');
  assert.match(writer, /return person && person\.status !== 'CANCELLED' && person\.cancelled !== true;/);
  assert.match(projection, /return Boolean\(person\) && person\.status !== 'CANCELLED' && person\.cancelled !== true;/);
  assert.match(writer, /const full = capacity > 0 && activeCount >= capacity;/);
  assert.match(projection, /\.length >= capacity;/);
});
