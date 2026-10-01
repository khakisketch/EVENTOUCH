const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
globalThis.ETKO = globalThis.ETKO || {};
try {
  globalThis.ETKO.sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8')
  );
} catch (err) {}
require('../features/agency.js');
require('../features/content.js');

const ETKO = globalThis.ETKO;

test('program end before start throws a Korean error', () => {
  assert.throws(
    () => ETKO.saveProgram({ title: 't', time: '10:00', end: '09:00', location: 'hall' }),
    /종료는 시작보다/
  );
});

test('saveProgram creates, updates and sorts by time', () => {
  ETKO.workspace().program = [];
  const second = ETKO.saveProgram({ title: 'B', time: '11:00', end: '12:00', location: '홀' });
  const first = ETKO.saveProgram({ title: 'A', time: '09:00', end: '10:00', location: '홀' });
  assert.ok(second.id && first.id);
  assert.equal(ETKO.workspace().program[0].id, first.id);
  const updated = ETKO.saveProgram({ id: first.id, title: 'A2', time: '09:00', end: '10:00', location: '홀' });
  assert.equal(updated.title, 'A2');
  assert.throws(
    () => ETKO.saveProgram({ id: 'program-x', title: 'x', time: '09:00', end: '10:00', location: '홀' }),
    /프로그램을 찾을 수 없습니다/
  );
});

test('deleteProgram removes the row', () => {
  ETKO.workspace().program = [];
  const row = ETKO.saveProgram({ title: 'D', time: '09:00', end: '10:00', location: '홀' });
  ETKO.deleteProgram(row.id);
  assert.deepEqual(ETKO.workspace().program, []);
});

test('saveNotice creates pinned notices and rejects unknown ids', () => {
  ETKO.workspace().notices = [];
  const notice = ETKO.saveNotice({ title: '공지', body: '내용', pinned: true });
  assert.equal(notice.pinned, true);
  assert.equal(ETKO.workspace().notices[0].id, notice.id);
  assert.throws(() => ETKO.saveNotice({ id: 'n-x', title: 't', body: 'b' }), /공지를 찾을 수 없습니다/);
});

test('saveVenue stores the venue guide', () => {
  const venue = ETKO.saveVenue({ name: 'A홀', address: '1층', description: '안내' });
  assert.equal(venue.name, 'A홀');
  assert.equal(ETKO.workspace().venue.name, 'A홀');
  assert.throws(() => ETKO.saveVenue({ name: '' }), /행사장 이름/);
});

test('createPost validates the participant and the 300-char limit', () => {
  ETKO.workspace().posts = [];
  const person = ETKO.workspace().participants[0];
  const post = ETKO.createPost(person.id, '안녕하세요');
  assert.equal(post.author, person.name);
  assert.throws(() => ETKO.createPost('nobody', 'hi'), /참가자를 찾을 수 없습니다/);
  assert.throws(() => ETKO.createPost(person.id, ''), /300자/);
  assert.throws(() => ETKO.createPost(person.id, 'x'.repeat(301)), /300자/);
});

test('homeNow returns now and next program rows', () => {
  ETKO.workspace().program = [];
  ETKO.saveProgram({ title: '오전', time: '09:00', end: '10:00', location: '홀' });
  ETKO.saveProgram({ title: '오후', time: '10:00', end: '11:00', location: '홀' });
  const feed = ETKO.homeNow('09:30');
  assert.equal(feed.now.title, '오전');
  assert.equal(feed.next.title, '오후');
});
