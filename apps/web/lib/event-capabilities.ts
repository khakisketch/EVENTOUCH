// Event-scoped write capabilities for the console UI.
//
// This is the single client-side mirror of server/event-permissions.js, which
// stays the authority: every command is re-checked on the server, and this
// module only decides what the console shows (write affordances vs. concise
// read-only explanations). Keep the two files in sync when scopes change.
//
// Stored meaning (set only through POST /api/events/:id/members):
//   - a membership with no `write` field (older shapes) reads as full access,
//     matching the pre-allow-list behaviour for omitted grants;
//   - `write: ['all', ...]` grants every event write;
//   - any other entry grants exactly the command family listed under that key
//     in COMMAND_WRITE_SCOPE below;
//   - an explicitly stored empty array grants no writes (read-only);
//   - anything else (unknown command, unknown key, no membership, non-manager
//     role) grants nothing. Unknown membership entries are skipped, never
//     treated as grants.
"use client";

export type EventMembershipInput = {
  accountId?: unknown;
  eventId?: unknown;
  write?: unknown;
};

export type CanWriteEventInput = {
  role?: unknown;
  userId?: unknown;
  memberships?: unknown;
  eventId?: unknown;
};

export type EventWriteScope = {
  scope: string;
  label: string;
  description: string;
};

// The eight grant keys of server EVENT_PERMISSIONS, with the console wording
// used by the team permission editor and the read-only/cross-scope notes.
// Labels name the work, descriptions name what the grant actually changes.
export const EVENT_WRITE_SCOPES: EventWriteScope[] = [
  {
    scope: "participants",
    label: "참가자·명단",
    description: "명단 추가·상태 변경·가져오기, 그룹 지정, 입력 항목과 접수 게시·마감",
  },
  {
    scope: "page",
    label: "참가자 화면",
    description: "참가자 홈 초안 저장·게시, 대표 이미지, 공지·장소 안내",
  },
  {
    scope: "programs",
    label: "프로그램·추첨",
    description: "프로그램·진행 모듈·질문/사진/후기 관리, 추첨 실행·게시, 전광판 출력",
  },
  {
    scope: "onsite",
    label: "현장 데스크",
    description: "데스크 개설·개방, 스태프 배정, 체크인 스캔·정정, 현장 경품 조회·수령",
  },
  {
    scope: "booth",
    label: "부스·스탬프",
    description: "부스·인증 방식·방문 기록, 스탬프 지도 초안 저장·게시",
  },
  {
    scope: "messages",
    label: "메시지",
    description: "문자 발송·취소·재시도, 템플릿, 참가비 모의 처리",
  },
  {
    scope: "results",
    label: "결과·경품",
    description: "보고서 작성·게시, 경품 등록·지정·수령·취소, 증빙 사진",
  },
  {
    scope: "settings",
    label: "행사 설정",
    description: "행사 정보·기능·진행 단계 변경",
  },
];

// Command-to-scope map mirrored from server COMMAND_WRITE_SCOPE. One command
// belongs to exactly one scope; anything not listed here is denied.
const COMMAND_WRITE_SCOPE: Record<string, string> = {
  "participant.create": "participants",
  "participant.update": "participants",
  "participant.status": "participants",
  "participant.import": "participants",
  "ticket.reissue": "participants",
  "group.save": "participants",
  "group.assign": "participants",
  "field.save": "participants",
  "field.move": "participants",
  "field.delete": "participants",
  "form.publish": "participants",
  "form.close": "participants",
  "event.update": "settings",
  "event.features": "settings",
  "event.stage": "settings",
  "attendee.page.save": "page",
  "attendee.page.publish": "page",
  "branding.save": "page",
  "notice.save": "page",
  "notice.delete": "page",
  "venue.save": "page",
  "program.save": "programs",
  "program.delete": "programs",
  "module.save": "programs",
  "module.status": "programs",
  "module.reveal": "programs",
  "question.manage": "programs",
  "photo.moderate": "programs",
  "post.moderate": "programs",
  "draw.run": "programs",
  "draw.publish": "programs",
  "display.set": "programs",
  "team.save": "programs",
  "vote.config.save": "programs",
  "vote.tally": "programs",
  "lucky.config.save": "programs",
  "lucky.preassign": "programs",
  "roulette.config.save": "programs",
  "draw.program.save": "programs",
  "draw.program.run": "programs",
  "desk.save": "onsite",
  "desk.set-open": "onsite",
  "staff.assign": "onsite",
  "staff.unassign": "onsite",
  "check.scan": "onsite",
  "check.correct": "onsite",
  "reward.lookup": "onsite",
  "reward.collect": "onsite",
  "booth.save": "booth",
  "booth.mode": "booth",
  "booth.visit": "booth",
  "booth.map.save": "booth",
  "booth.map.publish": "booth",
  "booth.map.unpublish": "booth",
  "message.create": "messages",
  "message.cancel": "messages",
  "message.retry": "messages",
  "message.sync": "messages",
  "template.save": "messages",
  "payment.simulate": "messages",
  "payment.refund-request": "messages",
  "payment.refund": "messages",
  "report.create": "results",
  "report.update": "results",
  "report.publish": "results",
  "report.successor": "results",
  "reward.create": "results",
  "reward.assign": "results",
  "reward.fulfill": "results",
  "reward.cancel": "results",
  "evidence.photo.add": "results",
  "evidence.photo.move": "results",
  "evidence.photo.remove": "results",
  "participants.write": "participants",
};

export function writeScopeForCommand(command: string): string | null {
  return Object.hasOwn(COMMAND_WRITE_SCOPE, String(command || ""))
    ? COMMAND_WRITE_SCOPE[String(command)]
    : null;
}

function normalizeMemberships(memberships: unknown): EventMembershipInput[] {
  if (!Array.isArray(memberships)) return [];
  const out: EventMembershipInput[] = [];
  for (const item of memberships) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.accountId !== "string" || typeof record.eventId !== "string") continue;
    out.push({ accountId: record.accountId, eventId: record.eventId, write: record.write });
  }
  return out;
}

// Grants for one operator on one event. Returns null when there is no
// membership (no writes), otherwise the normalized grant list: only an
// omitted `write` field reads as ['all'] (omitted grant keeps full access).
// An explicit array — including an explicit [] for read-only — is used
// as-is, and any other malformed value denies ([]) rather than widening to
// full access. The server stores only valid arrays, so legitimate grants
// lose nothing to the strict fallback.
export function getEventWriteGrants(
  memberships: unknown,
  ref: { userId?: unknown; eventId?: unknown }
): string[] | null {
  const userId = typeof ref.userId === "string" ? ref.userId : "";
  const eventId = typeof ref.eventId === "string" ? ref.eventId : "";
  if (!userId || !eventId) return null;
  const found = normalizeMemberships(memberships).find(
    (item) => item.accountId === userId && item.eventId === eventId
  );
  if (!found) return null;
  if (found.write === undefined) return ["all"];
  if (!Array.isArray(found.write)) return [];
  return found.write.map((value) => String(value));
}

function scopeLabel(scope: string): string {
  return EVENT_WRITE_SCOPES.find((item) => item.scope === scope)?.label ?? scope;
}

export function scopeLabelForCommand(command: string): string {
  const scope = writeScopeForCommand(command);
  return scope ? scopeLabel(scope) : "쓰기 권한";
}

// Display-only gate: does this operator hold the grant the server requires
// for `command` on this event? AGENCY bypasses everything (server contract);
// STAFF and other roles hold no membership writes here (STAFF desk work is
// authorized through assignments on its own screen, not through this gate).
export function canWriteEvent(input: CanWriteEventInput, command: string): boolean {
  const role = typeof input.role === "string" ? input.role : "";
  if (role === "AGENCY") return true;
  if (role !== "MANAGER") return false;
  const grants = getEventWriteGrants(input.memberships, {
    userId: input.userId,
    eventId: input.eventId,
  });
  if (grants === null) return false;
  if (grants.includes("all")) return true;
  const scope = writeScopeForCommand(command);
  if (!scope) return false;
  return grants.includes(scope);
}
