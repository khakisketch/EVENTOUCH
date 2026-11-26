// Attendee ticket and recovery: the QR is the hero, the recovery path is
// one step at a time, and no state is a dead end.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const ticket = read("apps/web/app/event/[slug]/ticket/TicketView.tsx");
const recover = read("apps/web/app/event/[slug]/ticket/recover/RecoverForm.tsx");
const register = read("apps/web/app/event/[slug]/register/RegisterForm.tsx");

test("the ticket screen points at what the attendee has to do", () => {
  assert.match(ticket, /입장할 때 이 QR을 보여 주세요/u);
  // Reopened 2026-11-19: with the QR in hand the obvious next step is the
  // event's content, so it is the one primary below the QR and the facts; the
  // recheck beside it is a quiet utility. A ticket that cannot show a QR keeps
  // the recheck as its primary.
  // Reopened 2026-11-20: the next step is the BottomAction fixed to the bottom of the phone column
  // (alone, so it never covers the QR; see web-attendee-entry-composition); the recheck is a quiet ghost
  // button in the page; without a QR the recheck is the primary.
  assert.match(ticket, /<BottomAction label="다음 행동" primary=\{\{ label: "참여 콘텐츠 보기", href: `\/event\/\$\{encodeURIComponent\(slug\)\}\/engage` \}\} \/>/u);
  // Reopened 2026-11-24: the recheck is a real (secondary) button; the quiet text link read as a caption.
  assert.match(ticket, /<ProductButton type="button" variant="secondary" disabled=\{rechecking\} onClick=\{\(\) => void recheckTicket\(\)\}>/u);
  assert.match(ticket, /<BottomAction label="다음 행동" primary=\{recheckAction\} \/>/u);
});

test("a missing or failed ticket always offers a way forward", () => {
  assert.match(ticket, /ticket\/recover/u);
  assert.match(ticket, /다시 신청하기/u);
  assert.match(ticket, /행사 안내로/u);
});

// 표현 고정 갱신(2026-10-25 외부 대면 마감): 신청 성공이 즉시 티켓 화면으로
// 이동하면서 영수증이 사라지던 문제 — 같은 내비게이션에 registered=1을 태워
// 티켓 화면이 1회성 완료 배너를 읽는다. bearer 처리(history.replaceState·
// sessionStorage·영수증 재시도) 동작 계약은 그대로.
test("a fresh registration reads as a one-time completion receipt", () => {
  assert.match(ticket, /registered/u);
  assert.match(ticket, /justRegistered/u);
  assert.match(ticket, /query\.delete\("registered"\)/u);
  assert.match(ticket, /신청이 완료되었습니다\. 이 화면이 입장권입니다\./u);
  // The flag rides the same bearer navigation and is cleaned with it —
  // no new storage key, no lingering query.
  assert.match(register, /registered=1/u);
});

// 표현 고정 갱신(2026-10-25 외부 대면 마감): 티켓 없는 상태의 막다른 해소 —
// 복구 가능 행사에서는 missing 상태도 복구 primary + 신청 secondary를 함께
// 준다. 차단 행사 분기는 그대로(복구 링크 없음·기기+운영자 안내).
test("a missing ticket offers recovery where recovery exists", () => {
  // Reopened 2026-11-20: the actions are one list; recovery leads where it exists.
  assert.match(ticket, /if \(recoveryBlocked\) actions\.push\(\{ label: "처음 신청하기"/u);
  assert.match(ticket, /연락처 인증으로 티켓 다시 찾기/u);
});

// 표현 고정 갱신(2026-10-27 여정 검수): 승인 대기·대기 명단은 운영자 승인·자리
// 변동으로 참가자 조작 없이 바뀔 수 있지만 티켓 화면은 1회 로딩이다. 재확인
// 버튼이 없으면 영수증이 stale 상태로 남고 QR을 볼 방법이 없다.
// 표현 고정 갱신(2026-10-27 재검수): 결제 확인·취소 등 다른 미입장 상태도
// 서버에서 바뀔 수 있어 재확인을 상태 공통으로 통일한다(PENDING/WAITLIST
// 한정 검사를 교체, 동작 계약은 그대로).
test("any non-admitted ticket offers a status re-check", () => {
  assert.match(ticket, /상태 다시 확인/u);
  assert.doesNotMatch(ticket, /state\.status === "PENDING" \|\| state\.status === "WAITLIST"/u);
});

// 표현 고정 갱신(2026-10-27 재검수): 저장소 거부(비공개·제한 모드)에서도 열린
// 영수증의 재확인이 동작해야 한다. 탭 내 ref가 현재 bearer를 들고 재시도하고,
// slug가 바뀌면 물려주지 않으며 404 확정 시 비운다. 거절 표시는 탭과 URL에
// 비민감 상태만 남기며 bearer는 localStorage·쿠키·URL에 새로 저장하지 않는다.
test("status retries keep the in-tab bearer without new persistence", () => {
  assert.match(ticket, /ticketRef\.current\.slug !== slug/u);
  assert.match(ticket, /ticketRef\.current = \{ slug, ticket: "" \}/u);
  assert.match(ticket, /fromLink \|\| ticketRef\.current\.ticket \|\| initialTicket \|\| getAllowedTicketForTab\(slug\) \|\| \(storageUsable \? readStoredTicket\(slug\) : ""\)/u);
  assert.match(ticket, /query\.delete\("ticket"\)/u);
  assert.match(ticket, /window\.history\.replaceState\(null, "", cleaned\)/u);
  // A failed in-memory recovery must not erase an older tab bearer that
  // storage rejected replacing. Other confirmed 404s still clear storage.
  assert.match(ticket, /if \(res\.status === 404 && ticket && !cancelled\) \{\s*if \(!\(hasRecovery && recoveryMode === "memory"\)\) clearStoredTicket\(slug\);\s*ticketRef\.current = \{ slug, ticket: "" \}/u);
  assert.match(ticket, /\[slug, reloadTick, initialTicket\]/u);
  assert.doesNotMatch(ticket, /localStorage\./u);
  assert.doesNotMatch(ticket, /document\.cookie/u);
});

// 표현 고정 갱신(2026-10-27 재검수): fresh 배너는 입장권 주장과 접수 영수증을
// 가린다. 승인 대기 중에 "이 화면이 입장권입니다"가 뜨면 입장이 되는 것으로
// 오해한다. 입장 주장은 usable 분기 안에만 둔다.
test("a fresh receipt never claims admission before the QR exists", () => {
  assert.match(ticket, /신청이 접수되었습니다\. 아래에서 진행 상태를 확인하세요/u);
  assert.match(ticket, /\{state\.fresh \? \(\s*usable \? \(/u);
});

// 표현 고정 갱신(추가 재검수): 대기열은 자리 비움이 자동 승격시키지 않는다
// (setParticipantStatus에 자동 승격 없음·명시적 APPROVED 전이만). "자리가
// 나면 표시됩니다"는 거짓 약속이므로 운영자 승인 조건으로 고친다.
// Reopened 2026-11-26 (attendee audit): a text may never come, so the waitlist no longer waits for
// a "확정 안내"; the shared note says the result shows on this screen.
test("the waitlist names operator approval, not automatic display", () => {
  assert.match(ticket, /자리가 나면 운영자가 확정할 수 있습니다\./u);
  assert.match(ticket, /결과는 이 화면에서 확인할 수 있습니다\. 행사에 따라 안내 문자가 오지 않을 수 있으니 상태를 다시 확인해 주세요\./u);
  assert.doesNotMatch(ticket, /확정 안내를 받았다면/u);
  assert.doesNotMatch(ticket, /자리가 나면 이 화면에 입장 QR이 표시됩니다/u);
});

// 표현 고정 갱신(추가 재검수): superseded 로드의 늦은 응답이 현재 탭의
// bearer·저장소를 덮어쓰거나 비우면 안 된다. 404 확정 정리와 성공 복원 모두
// 마운트된 로드에서만 쓴다.
test("late responses never clobber the current tab bearer", () => {
  assert.match(ticket, /if \(res\.status === 404 && ticket && !cancelled\)/u);
  assert.match(ticket, /if \(!cancelled\) \{\s*clearTicketRejected\(slug\);\s*if \(resolvedTicket\) \{\s*ticketRef\.current = \{ slug, ticket: resolvedTicket \};\s*const stored = storeTicket\(slug, resolvedTicket\)/u);
  assert.match(ticket, /if \(stored && storageUsable\) clearSessionForTab\(slug\);\s*else allowSessionForTab\(slug, resolvedTicket\)/u);
});

// 표현 고정 갱신(추가 재검수 2): 승인+결제 복합 조건의 영수증도 양쪽 문을
// 말한다. 결제 플래그가 명시된 경우에만 복합 문구를 쓰고, 기존 문구·핀은
// 그대로 둔다.
// Reopened 2026-11-26 (attendee audit): the product takes no payment, so the gate is the organizer
// confirming the fee ("참가비 확인"), with who to contact.
test("combined gates name approval and payment together", () => {
  assert.match(ticket, /운영자 승인과 참가비 확인 후 상태를 다시 확인하면 입장 QR을 볼 수 있습니다/u);
  assert.match(ticket, /확정과 참가비 확인이 끝나면 입장 QR을 볼 수 있습니다/u);
  assert.match(ticket, /참가비는 주최 측에서 확인합니다\. \$\{organizerContactLine\(contact\)\}/u);
  assert.doesNotMatch(ticket, /결제를 마친|안내받은 방법으로/u);
  assert.match(ticket, /신청이 접수되었습니다\. 운영자 승인 후 상태를 다시 확인하면 입장 QR을 볼 수 있습니다/u);
});

test("the recovery flow shows one step at a time", () => {
  assert.match(recover, /1\. 신청할 때 입력한 연락처로 인증번호를 받으세요/u);
  assert.match(recover, /2\. 문자로 받은 인증번호를 입력해 주세요/u);
  assert.match(recover, /10분 안에 입력해 주세요/u);
  assert.match(recover, /연락처 바꾸기/u);
  assert.match(recover, /내 티켓 열기/u);
});
