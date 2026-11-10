// Attendee registration: the form states the outcome, recovers from a
// duplicate application, and explains phone verification before the user
// starts while placing the request action after its required phone input.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const form = read("apps/web/app/event/[slug]/register/RegisterForm.tsx");

test("the registration form states what the attendee gets", () => {
  // 표현 고정 갱신(2026-10-25 외부 대면 마감): "참가 티켓" → "입장 티켓".
  // 티켓 화면의 "입장 티켓" 라벨·"입장할 때 이 QR" 안내와 같은 단어로 통일
  // (H4 일관성). 결과 진술·리드 위치 동작 계약은 그대로.
  assert.match(form, /입장 티켓이 바로 발급됩니다/u);
  assert.match(form, /className=\{styles\.outcomeNote\} role="note"/u);
});

// 표현 고정 갱신(2026-10-27 재검수): 승인제 행사에서 "바로 발급"은 거짓
// 약속이 된다. approvalRequired이면 접수+승인 뒤 QR 표시로 리드를 바꾸고,
// 즉시 발급 문구는 비승인제 분기에만 둔다. 서버 계약 변경 없음(공개 워크
// 스페이스에 이미 있는 approvalRequired를 읽기만 한다).
test("an approval-gated event promises a receipt, not an instant ticket", () => {
  assert.match(form, /approvalRequired\?: boolean/u);
  assert.match(form, /신청 접수 후 운영자가 승인하면 입장 QR이 표시됩니다/u);
});

// 표현 고정 갱신(추가 재검수): 결제 흐름(payments v1-제외지만 서버는
// paymentPending으로 착지)에서도 즉시 입장 약속을 하지 않는다. 공개
// 프로젝션의 features·price만 읽고 결제 동작은 건드리지 않는다.
test("a payment-pending event promises confirmation after payment", () => {
  assert.match(form, /paymentPending\?: boolean/u);
  assert.match(form, /신청 접수 후 결제 확인이 끝나면 입장 QR이 표시됩니다/u);
});

// 표현 고정 갱신(추가 재검수 2): 승인+결제 복합 조건에서 승인 단독 약속은
// 거짓이다(서버는 상태 PENDING에도 paymentStatus를 PENDING으로 둔다).
// 양쪽 문구를 모두 명시하고, 결제 동작·정책은 건드리지 않는다.
test("a combined approval and payment gate names both", () => {
  assert.match(form, /approvalRequired && paymentPending/u);
  assert.match(form, /운영자 승인과 결제 확인이 모두 끝나면 입장 QR이 표시됩니다/u);
});

test("phone verification is announced before fields and requested after the phone input", () => {
  const outcome = form.indexOf('className={styles.outcomeNote}');
  const verification = form.indexOf('className="verification-panel"');
  const fields = form.indexOf("{fields.map(renderField)}");
  assert.ok(outcome > 0 && fields > outcome && verification > fields);
  assert.match(form, /verificationRequired \? " 신청 전 연락처 인증이 필요합니다\."/u, "the requirement is still disclosed before typing");
});

test("the supplied field order is rendered without regrouping", () => {
  assert.match(form, /\{fields\.map\(renderField\)\}/u);
  assert.doesNotMatch(form, /fields\.(?:filter|sort|reverse|splice)\(/u);
  assert.match(form, /function renderField\(field: PublishedField\)/u);
});

test("a duplicate application offers the way back to the ticket", () => {
  assert.match(form, /alreadyRegistered/u);
  assert.match(form, /이미 신청하신 연락처로 등록되어 있습니다/u);
  assert.match(form, /ticket\/recover/u);
});

test("the attendee's keyboard can fill the common fields", () => {
  assert.match(form, /field\.id === "name" \? "name"/u);
  assert.match(form, /field\.id === "email" \? "email"/u);
  assert.match(form, /field\.id === "company" \? "organization"/u);
  assert.match(form, /field\.id === "phone" \? "tel"/u);
});
