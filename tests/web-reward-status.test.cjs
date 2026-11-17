'use strict';

// The 경품 지급 현황 screen and the 운영 현황 task queue must count prizes with
// one rule (apps/web/lib/reward-status.ts). This runs the real module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/web/lib/reward-status.ts'), 'utf8');

function loadModule() {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = { exports: {}, module: { exports: {} } };
  vm.runInNewContext(js, { ...sandbox, require }, { filename: 'reward-status.ts' });
  return sandbox.exports;
}

const { rewardParticipantIssue, rewardBucket, countRewardAttention } = loadModule();

const person = (overrides = {}) => ({ id: 'p1', status: 'APPROVED', ...overrides });

test('a recipient is only clean when exactly one approved, uncancelled participant matches', () => {
  assert.equal(rewardParticipantIssue([person()]), '');
  assert.equal(rewardParticipantIssue([]), 'missing');
  assert.equal(rewardParticipantIssue([person(), person()]), 'missing', 'two records for one id cannot be trusted');
  assert.equal(rewardParticipantIssue([person({ status: 'cancelled' })]), 'cancelled', 'status compares case-insensitively');
  assert.equal(rewardParticipantIssue([person({ cancelled: true })]), 'conflict');
  assert.equal(rewardParticipantIssue([person({ ticketReview: 'cancelled' })]), 'conflict');
  assert.equal(rewardParticipantIssue([person({ status: 'PENDING' })]), 'unapproved');
  assert.equal(rewardParticipantIssue([person({ status: 'WAITLIST' })]), 'unapproved');
});

test('buckets: blocked or unclear is 확인 필요, clean READY is 지급 대기, finished is done', () => {
  assert.equal(rewardBucket('RECEIVED', ''), 'done');
  assert.equal(rewardBucket('CANCELLED', 'missing'), 'done', 'a cancelled prize is done whatever its recipient');
  assert.equal(rewardBucket('READY', ''), 'waiting');
  assert.equal(rewardBucket('READY', 'cancelled'), 'attention');
  assert.equal(rewardBucket('PENDING', ''), 'attention', 'no recipient yet is not ready to hand over');
  assert.equal(rewardBucket('FAILED', ''), 'attention');
  assert.equal(rewardBucket('', ''), 'attention', 'an unreadable status is never counted as fine');
});

test('countRewardAttention counts straight from a bootstrap workspace', () => {
  const workspace = {
    participants: [
      person({ id: 'ok' }),
      person({ id: 'gone', status: 'CANCELLED' }),
      person({ id: 'late', status: 'PENDING' }),
    ],
    rewards: [
      { id: 'r1', status: 'READY', participantId: 'ok' },
      { id: 'r2', status: 'READY', participantId: 'gone' },
      { id: 'r3', status: 'READY', participantId: 'late' },
      { id: 'r4', status: 'READY', participantId: 'nobody' },
      { id: 'r5', status: 'PENDING', participantId: '' },
      { id: 'r6', status: 'RECEIVED', participantId: 'ok' },
      { id: 'r7', status: 'CANCELLED', participantId: 'gone' },
      { status: 'READY', participantId: 'ok' },
    ],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(countRewardAttention(workspace))), { attention: 4, waiting: 1 });
});

test('countRewardAttention says nothing rather than a false zero when the list is unreadable', () => {
  assert.equal(countRewardAttention(null), null);
  assert.equal(countRewardAttention({}), null);
  assert.equal(countRewardAttention({ rewards: 'broken' }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(countRewardAttention({ rewards: [] }))), { attention: 0, waiting: 0 });
  // Without a participant list every recipient is unmatched, so prizes need a look.
  assert.deepEqual(JSON.parse(JSON.stringify(countRewardAttention({ rewards: [{ id: 'r', status: 'READY', participantId: 'x' }] }))), { attention: 1, waiting: 0 });
});

test('the console screen delegates to the same rule instead of keeping a copy', () => {
  const screen = fs.readFileSync(path.join(root, 'apps/web/app/console/events/[id]/rewards/RewardsWorkspace.tsx'), 'utf8');
  assert.match(screen, /import \{ rewardBucket, rewardParticipantIssue \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/reward-status";/);
  assert.match(screen, /return rewardBucket\(reward\.status, reward\.participantIssue\);/);
  assert.match(screen, /rewardParticipantIssue\(matches\)/);
  assert.doesNotMatch(screen, /participantStatus !== "APPROVED"/, 'the participant rule lives only in lib/reward-status.ts');
});
