'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, startApiHarness, insertEvent, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { createAttendeeAccess } = require('../server/attendees');
const { emptyWorkspace } = require('../server/state');

let harness;
let access;
const codes = new Map();
let sends = 0;
before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertEvent(harness.database, {orgId: LEGACY_ORG,  id: 'verification-race', slug: 'verification-race', payload: { stage: 'READY' }, workspace: emptyWorkspace() });
  access = createAttendeeAccess(harness.database, { transport: { sendCode: async ({ to, code }) => {
    sends += 1; codes.set(to, code); return { sent: true, mode: 'mock' };
  } } });
});
after(async () => { if (harness) await harness.close(); });

test('concurrent verification-code requests reserve only one send', { skip: !databaseUrl }, async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => access.requestChallenge({ eventRef: 'verification-race', phone: '01020000001', purpose: 'ENROLL' })));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(value => value.status === 'rejected' && value.reason.status === 429).length, 7);
  assert.equal(sends, 1);
  const rows = await harness.database.query('SELECT count(*)::int AS n FROM attendee_challenges');
  assert.equal(rows.rows[0].n, 1);
});

test('a verification code is consumed once even when confirmed concurrently', { skip: !databaseUrl }, async () => {
  const code = codes.get('01020000001');
  assert.ok(code);
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => access.confirmChallenge({ eventRef: 'verification-race', phone: '01020000001', code })));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  const grants = await harness.database.query("SELECT count(*)::int AS n FROM attendee_grants WHERE phone = '01020000001'");
  assert.equal(grants.rows[0].n, 1);
});

test('concurrent wrong codes cannot lose failed-attempt increments', { skip: !databaseUrl }, async () => {
  await access.requestChallenge({ eventRef: 'verification-race', phone: '01020000002', purpose: 'ENROLL' });
  const correct = codes.get('01020000002');
  const wrong = correct === '000000' ? '111111' : '000000';
  const attempts = await Promise.allSettled(Array.from({ length: 9 }, () => access.confirmChallenge({ eventRef: 'verification-race', phone: '01020000002', code: wrong })));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 0);
  const row = await harness.database.query("SELECT attempts, consumed_at FROM attendee_challenges WHERE phone = '01020000002'");
  assert.equal(row.rows[0].attempts, 5);
  assert.ok(row.rows[0].consumed_at);
  await assert.rejects(access.confirmChallenge({ eventRef: 'verification-race', phone: '01020000002', code: correct }));
  const grants = await harness.database.query("SELECT count(*)::int AS n FROM attendee_grants WHERE phone = '01020000002'");
  assert.equal(grants.rows[0].n, 0);
});
