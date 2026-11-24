// What an attendee can do about signing up right now, in one place, so the
// guide, the application and the in-form refresh all say the same thing.
// "Not receiving signups" used to be one sentence for five different reasons
// (not open, closed, full, ended); each reason now has its own line and its
// own next step (attendee screens review, 2026-11-24).
//
// Inputs are the public projection: the stage, the intake switch, the server's
// capacity flag and whether signups need approval. A full event with approval
// still takes signups as a waiting list (server/commands/participants.js:
// full && approvalRequired -> WAITLIST); without approval it refuses them.

export type SignupAvailability =
  | { kind: "open"; waitlist: boolean; title: string; next: string }
  | { kind: "not-open" | "closed" | "full" | "ended"; title: string; next: string; waitlist: false };

export function signupAvailability(input: {
  stage: string;
  registrationOpen: boolean;
  full: boolean;
  approvalRequired: boolean;
}): SignupAvailability {
  const stage = input.stage.toUpperCase();
  if (stage === "ENDED") {
    return { kind: "ended", waitlist: false, title: "종료된 행사입니다.", next: "신청은 마감되었습니다. 이미 신청했다면 내 티켓을 확인하세요." };
  }
  if (!input.registrationOpen || (stage !== "READY" && stage !== "LIVE")) {
    // READY plus a closed intake is either "not yet" or "already over"; the
    // projection cannot tell which, so the line is true for both.
    return stage === "LIVE"
      ? { kind: "closed", waitlist: false, title: "신청 접수가 마감되었습니다.", next: "이미 신청했다면 내 티켓을 확인하세요." }
      : { kind: "not-open", waitlist: false, title: "지금은 신청 접수 기간이 아닙니다.", next: "접수가 열리면 이 주소에서 신청할 수 있습니다. 일정은 행사 안내에서 확인하세요." };
  }
  if (input.full) {
    return input.approvalRequired
      ? { kind: "open", waitlist: true, title: "정원이 마감되어 대기 신청으로 받고 있습니다.", next: "신청하면 대기 명단에 올라가고, 자리가 나면 운영자가 확정합니다." }
      : { kind: "full", waitlist: false, title: "정원이 마감되었습니다.", next: "더 이상 신청할 수 없습니다. 이미 신청했다면 내 티켓을 확인하세요." };
  }
  return { kind: "open", waitlist: false, title: "참가 신청을 받고 있습니다.", next: "" };
}

/** Closed states where someone who already signed up may come looking for their ticket. */
export function mayHaveTicket(kind: SignupAvailability["kind"]): boolean {
  return kind === "closed" || kind === "full" || kind === "ended";
}
