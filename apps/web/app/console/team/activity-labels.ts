// Canonical Korean labels for every audit-producing event command.
//
// Source of truth for the command universe is server-side:
// preparation + engagement + content-results + booth-map + event-evidence +
// attendee-experience (domain path, every command audited) and operations.js
// (operations path, every command audited). The participants path writes no
// audit entries today, but its keys stay mapped so a future audit row still
// reads in Korean. Labels reuse existing screen vocabulary only; unknown keys
// never render raw on their own — rows read UNKNOWN_ACTIVITY_LABEL and offer
// the raw key inside an on-demand details block so evidence is not lost.
//
// Kept free of JSX and complex types on purpose: source-contract tests load
// this file by stripping the few annotations below, never the workspaces.

export const ACTIVITY_LABELS: Record<string, string> = {
  // Preparation (settings, intake, content basics).
  "event.update": "행사 정보 변경",
  "event.features": "기능 설정",
  "event.stage": "행사 단계 변경",
  "field.save": "신청 항목 저장",
  "field.move": "신청 항목 순서 변경",
  "field.delete": "신청 항목 삭제",
  "form.publish": "참가 신청 게시",
  "form.close": "참가 접수 마감",
  "group.save": "그룹 저장",
  "group.assign": "그룹 지정",
  "notice.save": "공지 저장",
  "notice.delete": "공지 삭제",
  "program.save": "일정 저장",
  "program.delete": "일정 삭제",
  "venue.save": "장소 저장",
  "branding.save": "행사 브랜드 저장",
  "attendee.page.save": "참가자 페이지 초안 저장",
  "attendee.page.publish": "참가자 페이지 게시",
  // Engagement (programs, Q&A, photo wall, board, draws, display).
  "module.save": "참여 프로그램 저장",
  "module.status": "참여 프로그램 상태 변경",
  "module.reveal": "참여 프로그램 공개 변경",
  "response.submit": "참여 응답 제출",
  "question.submit": "Q&A 질문",
  "question.manage": "Q&A 답변",
  "question.like": "Q&A 공감",
  "photo.submit": "포토월 사진 제출",
  "photo.moderate": "포토월 사진 검토",
  "post.submit": "게시글 등록",
  "post.moderate": "게시글 검토",
  "draw.run": "무대 추첨 실행",
  "draw.publish": "추첨 결과 게시",
  "display.set": "전광판 출력 변경",
  // Content results (templates, messages, payments, rewards, reports).
  "template.save": "템플릿 저장",
  "message.create": "메시지 발송 요청",
  "message.cancel": "메시지 예약 취소",
  "message.retry": "메시지 다시 보내기",
  "message.sync": "메시지 상태 확인",
  "payment.simulate": "결제 흐름 확인",
  "payment.refund-request": "환불 요청",
  "payment.refund": "환불 처리",
  "reward.create": "경품 등록",
  "reward.assign": "경품 지정",
  "reward.fulfill": "경품 지급",
  "reward.cancel": "경품 취소",
  "report.create": "보고서 만들기",
  "report.update": "보고서 수정",
  "report.publish": "결과 보고서 공유 완료",
  "report.successor": "후속 보고서 연결",
  // Booth map presets.
  "booth.map.save": "부스 지도 초안 저장",
  "booth.map.publish": "부스 지도 게시",
  "booth.map.unpublish": "부스 지도 게시 내림",
  // Evidence photos.
  "evidence.photo.add": "증빙 사진 등록",
  "evidence.photo.move": "증빙 사진 구간 변경",
  "evidence.photo.remove": "증빙 사진 보관함 제외",
  // Attendee experience (draws, roulette, ranked votes).
  "lucky.assign": "럭키번호 부여",
  "lucky.config.save": "럭키번호 설정 저장",
  "lucky.preassign": "럭키번호 사전 부여",
  "roulette.spin": "룰렛 돌리기",
  "roulette.config.save": "룰렛 설정 저장",
  "vote.ranked": "순위 투표 참여",
  "vote.config.save": "투표 설정 저장",
  "vote.tally": "투표 집계 확인",
  "team.save": "투표 팀 저장",
  "draw.program.save": "추첨 프로그램 설정 저장",
  "draw.program.run": "추첨 프로그램 실행",
  // Operations (desks, booths, checks, staff).
  "desk.save": "데스크 저장",
  "desk.set-open": "데스크 가동 변경",
  "staff.assign": "스태프 배정",
  "staff.unassign": "스태프 배정 해제",
  "check.scan": "입퇴장 스캔",
  "check.correct": "입퇴장 기록 정정",
  "booth.save": "부스 저장",
  "booth.mode": "부스 인증 방식 변경",
  "booth.visit": "부스 인증 처리",
  "reward.lookup": "경품 조회",
  "reward.collect": "경품 수령",
  // Participants (no audit rows today; mapped for forward compatibility).
  "participant.create": "참가자 등록",
  "participant.update": "참가자 정보 변경",
  "participant.status": "참가자 상태 변경",
  "participant.self-update": "참가자 본인 정보 수정",
  "participant.cancel": "참가 취소",
  "ticket.reissue": "티켓 재발급",
  "participant.import": "참가자 명단 가져오기",
};

export const UNKNOWN_ACTIVITY_LABEL = "기록된 작업";

export function isKnownActivityType(type: string): boolean {
  if (Object.prototype.hasOwnProperty.call(ACTIVITY_LABELS, type)) return true;
  return type.startsWith("participant.");
}

export function getActivityLabel(type: string): string | null {
  if (Object.prototype.hasOwnProperty.call(ACTIVITY_LABELS, type)) return ACTIVITY_LABELS[type];
  return null;
}
