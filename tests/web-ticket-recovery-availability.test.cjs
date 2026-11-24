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
// Reopened 2026-11-24 (attendee screens review): where a ticket reopens is the BROWSER that registered (the signup
// session cookie), not the tab. The words live in one module and the screens use it.
const guidance = read('app/event/[slug]/attendee-guidance.ts');

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
    2,
    'duplicate and changed-result guidance each provide an available-mode recovery link'
  );
  assert.match(form, /signupSuperseded[\s\S]*?recoveryBlocked \? \([\s\S]*?행사 주최 측에 문의하세요[\s\S]*?ticket\/recover/u, 'changed-result guidance also gates recovery');
  assert.match(form, /organizerContactLine\(recoveryContact\)/u, 'blocked duplicate offers the contact, not a tab to look for');
  assert.doesNotMatch(form, /브라우저 탭/u, 'no tab boundary is promised');
  assert.match(guidance, /value \? `문의: \$\{value\}` : fallback/u, 'only a visible contact is shown');
  const page = read('app/event/[slug]/register/page.tsx');
  assert.match(page, /verificationMode === "none" \|\| verificationMode === "mock"/u, 'mock blocks too, like the recover screen');
});

test('attendee home gates every recovery entry on availability', () => {
  const home = read('app/event/[slug]/home/HomeShell.tsx');
  assert.match(home, /useVerificationMode\(\)/u, 'home resolves the transport mode');
  assert.match(home, /recoveryBlocked \? null : \(/u, 'need-ticket link steps aside when blocked');
  assert.match(home, /noTicketHereNote\(\)/u, 'blocked guidance is the shared note');
  assert.match(guidance, /신청을 완료한 기기의 같은 브라우저에서 열어 주세요/u, 'blocked guidance names the browser limit');
});

test('ticket screen gates missing, failed and kept-ticket recovery copy', () => {
  const view = read('app/event/[slug]/ticket/TicketView.tsx');
  assert.match(view, /useVerificationMode\(\)/u, 'ticket screen resolves the transport mode');
  assert.match(view, /state\.canRecover && !recoveryBlocked/u, 'failed 404 hides recover when blocked');
  assert.match(view, /TICKET_BROWSER_NOTE/u, 'kept-ticket note is the one shared explanation');
  assert.match(guidance, /이 브라우저에서는 티켓을 다시 열 수 있습니다\. 다른 기기나 시크릿 창에서는 열리지 않으니 입장 QR 화면을 캡처해 두세요\./u, 'kept-ticket note names the browser boundary');
});

test('engagement and event pages gate their recovery entries', () => {
  const engage = read('app/event/[slug]/engage/EngageClient.tsx');
  assert.match(engage, /recoveryBlocked \? null : \(/u, 'missing-ticket link steps aside when blocked');
  const eventPage = read('app/event/[slug]/page.tsx');
  assert.match(eventPage, /loadVerificationMode\(\)/u, 'event page reads the same server-side mode');
  assert.match(eventPage, /recoveryBlocked \? \(/u, 'event page branches on availability');
  assert.match(eventPage, /noTicketHereNote\(recoveryContact\)/u, 'blocked event page names the limit, not the link');
  assert.match(guidance, /이 행사는 문자로 티켓을 다시 연결할 수 없습니다/u);
});

test('recover screen still refuses mock and none transports', () => {
  const recover = read('app/event/[slug]/ticket/recover/page.tsx');
  assert.match(recover, /verificationMode === "mock" \|\| verificationMode === "none"/u, 'server contract unchanged: recover stays unavailable there');
});
