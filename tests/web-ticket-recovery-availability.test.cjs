'use strict';

// Ticket-recovery availability: where no SMS code can arrive (mock/none
// transports) the attendee screens must not advertise "내 티켓 찾기" — the
// recover screen itself refuses those modes, so the link would be a dead
// end. Blocked states show device-only + operator-contact guidance instead.
// The availability signal rides the existing public /api/health
// `verification` field; no new server contract is introduced.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('recovery availability resolves from the existing health response', () => {
  const hook = read('lib/use-verification-mode.ts');
  assert.match(hook, /\/api\/health/u, 'mode comes from public health, not a new endpoint');
  assert.match(hook, /data\?\.verification/u, 'reads the existing verification field');
  assert.match(hook, /mode === "mock" \|\| mode === "none"/u, 'mock and none both block recovery');
  assert.match(hook, /useState<ClientVerificationMode>\("unknown"\)/u, 'links stay until the mode resolves');
});

test('registration hides the dead-end link when recovery is blocked', () => {
  const form = read('app/event/[slug]/register/RegisterForm.tsx');
  assert.match(form, /recoveryBlocked \? \(/u, 'duplicate-registration branches on availability');
  assert.equal(
    (form.match(/ticket\/recover/g) ?? []).length,
    1,
    'exactly one recovery link remains: the available-mode branch only'
  );
  assert.match(form, /신청한 기기에서만 열 수 있습니다\. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요\./u, 'blocked duplicate names device + operator');
  const page = read('app/event/[slug]/register/page.tsx');
  assert.match(page, /verificationMode === "none" \|\| verificationMode === "mock"/u, 'mock blocks too, like the recover screen');
});

test('attendee home gates every recovery entry on availability', () => {
  const home = read('app/event/[slug]/home/HomeShell.tsx');
  assert.match(home, /useVerificationMode\(\)/u, 'home resolves the transport mode');
  assert.match(home, /recoveryBlocked \? null : \(/u, 'need-ticket link steps aside when blocked');
  assert.match(home, /신청한 기기에서만 열 수 있습니다\./u, 'blocked guidance names the device limit');
});

test('ticket screen gates missing, failed and kept-ticket recovery copy', () => {
  const view = read('app/event/[slug]/ticket/TicketView.tsx');
  assert.match(view, /useVerificationMode\(\)/u, 'ticket screen resolves the transport mode');
  assert.match(view, /state\.canRecover && !recoveryBlocked/u, 'failed 404 hides recover when blocked');
  assert.match(view, /다른 기기에서 열 수 없습니다\. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요\./u, 'kept-ticket note stops promising cross-device recovery');
});

test('engagement and event pages gate their recovery entries', () => {
  const engage = read('app/event/[slug]/engage/EngageClient.tsx');
  assert.match(engage, /recoveryBlocked \? null : \(/u, 'missing-ticket link steps aside when blocked');
  const eventPage = read('app/event/[slug]/page.tsx');
  assert.match(eventPage, /loadVerificationMode\(\)/u, 'event page reads the same server-side mode');
  assert.match(eventPage, /recoveryBlocked \? \(/u, 'event page branches on availability');
  assert.match(eventPage, /문자로 다시 연결할 수 없는 행사입니다/u, 'blocked event page names the limit, not the link');
});

test('recover screen still refuses mock and none transports', () => {
  const recover = read('app/event/[slug]/ticket/recover/page.tsx');
  assert.match(recover, /verificationMode === "mock" \|\| verificationMode === "none"/u, 'server contract unchanged: recover stays unavailable there');
});
