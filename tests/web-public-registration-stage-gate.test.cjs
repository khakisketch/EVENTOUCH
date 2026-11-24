'use strict';

// Public signup is only writable on READY/LIVE (server/commands/
// participants.js publicSignupEvent). An ENDED event with the intake flag
// still on must not offer a live form or entry link that can only fail:
// the entry CTA and the register route both fall back to a closed state using
// the already-projected stage. DRAFT/ARCHIVED never reach these branches
// (public 404).
//
// Reopened 2026-11-24 (attendee screens review): "현재 신청을 받지 않습니다." was one sentence for
// five different situations. signup-availability.ts now names each one (접수 예정 기간 / 접수 마감 /
// 정원 마감 / 행사 종료 / 대기 신청) with its own next step, and both the guide and the application
// read it. The stage rule itself is unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const WEB = path.join(__dirname, '..', 'apps', 'web', 'app');
const webRequire = createRequire(path.join(__dirname, '..', 'apps', 'web', 'package.json'));
const ts = webRequire('typescript');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

function loadAvailability() {
  const out = ts.transpileModule(read('event/[slug]/signup-availability.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(out, { module, exports: module.exports });
  return module.exports;
}

const { signupAvailability, mayHaveTicket } = loadAvailability();
const open = { stage: 'LIVE', registrationOpen: true, full: false, approvalRequired: false };

test('each way of not taking signups has its own line and next step', () => {
  const ended = signupAvailability({ ...open, stage: 'ENDED' });
  assert.equal(ended.kind, 'ended');
  assert.equal(ended.title, '종료된 행사입니다.');
  const closed = signupAvailability({ ...open, registrationOpen: false });
  assert.equal(closed.kind, 'closed');
  assert.equal(closed.title, '신청 접수가 마감되었습니다.');
  const notOpen = signupAvailability({ ...open, stage: 'READY', registrationOpen: false });
  assert.equal(notOpen.kind, 'not-open');
  assert.match(notOpen.next, /접수가 열리면/u);
  const full = signupAvailability(({ ...open, full: true }));
  assert.equal(full.kind, 'full');
  assert.equal(full.title, '정원이 마감되었습니다.');
  const titles = new Set([ended.title, closed.title, notOpen.title, full.title]);
  assert.equal(titles.size, 4, 'four situations, four different lines');
  for (const item of [ended, closed, notOpen, full]) {
    assert.doesNotMatch(item.title, /현재 신청을 받지 않습니다/u);
    assert.ok(item.next.length > 0, 'every closed state says what to do next');
  }
});

test('ENDED wins over an intake flag that is still on, and a full event without approval refuses', () => {
  assert.equal(signupAvailability({ ...open, stage: 'ENDED', registrationOpen: true }).kind, 'ended');
  assert.equal(signupAvailability({ ...open, stage: 'ENDED', full: true }).kind, 'ended');
  // Intake closed beats full: the closed line is the more basic fact.
  assert.equal(signupAvailability({ ...open, registrationOpen: false, full: true }).kind, 'closed');
  assert.equal(signupAvailability({ ...open, full: true, approvalRequired: false }).kind, 'full');
});

test('a full event that takes approvals queues a waiting list instead of refusing', () => {
  // server/commands/participants.js createParticipant: full && approvalRequired -> WAITLIST.
  const waitlist = signupAvailability({ ...open, full: true, approvalRequired: true });
  assert.equal(waitlist.kind, 'open');
  assert.equal(waitlist.waitlist, true);
  assert.match(waitlist.title, /정원이 마감되어 대기 신청/u);
  assert.equal(signupAvailability(open).waitlist, false);
  assert.equal(signupAvailability(open).kind, 'open');
});

test('only the states after signup may have a ticket to find', () => {
  assert.equal(mayHaveTicket('closed'), true);
  assert.equal(mayHaveTicket('full'), true);
  assert.equal(mayHaveTicket('ended'), true);
  assert.equal(mayHaveTicket('not-open'), false);
  assert.equal(mayHaveTicket('open'), false);
});

test('public entry offers signup only when the stage admits it', () => {
  const page = read('event/[slug]/page.tsx');
  assert.match(page, /acceptingSignup/);
  assert.match(page, /signupAvailability\(\{/);
  assert.match(page, /stage: event\.stage,/);
  assert.match(page, /full: workspace\.full === true,/);
  assert.match(page, /\{acceptingSignup \? \(/);
  // The closed state names its own reason; the old catch-all sentence is gone from the guide.
  assert.match(page, /title=\{availability\.title\}/);
  assert.doesNotMatch(page, /현재 신청을 받지 않습니다/);
});

test('public register closes on ENDED even with the intake flag on', () => {
  const page = read('event/[slug]/register/page.tsx');
  const parser = read('event/[slug]/register/register-data.ts');
  assert.match(parser, /stage: string/);
  assert.match(parser, /event\.stage\.toUpperCase\(\)/);
  assert.match(parser, /full: workspace\.full === true,/);
  assert.match(page, /parseRegisterData\(await res\.json\(\)\)/);
  assert.match(page, /signupAvailability\(\{[\s\S]*?stage: data\.stage,[\s\S]*?full: data\.full,/);
  assert.match(page, /availability\.kind !== "open"/);
  assert.match(page, /title=\{availability\.title\}/);
  assert.doesNotMatch(page, /현재 신청을 받지 않습니다/);
  // A closed page does not ask someone who cannot have a ticket yet about recovering it.
  assert.match(page, /mayHaveTicket\(availability\.kind\)/);
});

test('a full event is named before the form, and the in-form refresh agrees', () => {
  const form = read('event/[slug]/register/RegisterForm.tsx');
  const page = read('event/[slug]/register/page.tsx');
  assert.match(page, /availability\.waitlist \? <AttendeeStateMessage kind="info" title=\{availability\.title\}/);
  assert.match(page, /waitlist=\{availability\.waitlist\}/);
  assert.match(form, /signupAvailability\(\{ stage: next\.stage, registrationOpen: next\.registrationOpen, full: next\.full, approvalRequired: next\.approvalRequired \}\)/);
});
