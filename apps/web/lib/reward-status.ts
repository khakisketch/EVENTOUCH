// One definition of "where a reward stands", shared by the 경품 지급 현황 screen
// and the 운영 현황 task queue, so both always show the same count.

export type RewardIssue = "" | "missing" | "cancelled" | "conflict" | "unapproved";
export type RewardBucket = "attention" | "waiting" | "done";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): string {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
}

// A recipient that cannot be matched to exactly one participant is "missing";
// otherwise the participant's own state decides whether handing over is safe.
export function rewardParticipantIssue(matches: ReadonlyArray<Record<string, unknown>>): RewardIssue {
  const person = matches.length === 1 ? matches[0] : null;
  if (!person) return "missing";
  const status = typeof person.status === "string" ? person.status.toUpperCase() : "";
  if (status === "CANCELLED") return "cancelled";
  if (person.cancelled === true || person.ticketReview === "cancelled") return "conflict";
  return status !== "APPROVED" ? "unapproved" : "";
}

// Anything blocked or unclear is 확인 필요, a clean READY prize is 지급 대기,
// finished ones are done.
export function rewardBucket(status: string, issue: RewardIssue): RewardBucket {
  if (status === "RECEIVED" || status === "CANCELLED") return "done";
  if (status === "READY" && !issue) return "waiting";
  return "attention";
}

export type RewardCounts = { attention: number; waiting: number };

// Counts straight from a workspace bootstrap payload. Returns null when the
// reward list itself cannot be read, so a caller shows nothing rather than a
// misleading zero.
export function countRewardAttention(workspace: unknown): RewardCounts | null {
  const space = record(workspace);
  if (!space || !Array.isArray(space.rewards)) return null;
  const people = new Map<string, Array<Record<string, unknown>>>();
  if (Array.isArray(space.participants)) {
    for (const item of space.participants) {
      const person = record(item);
      const id = identifier(person?.id);
      if (person && id) people.set(id, [...(people.get(id) ?? []), person]);
    }
  }
  const counts: RewardCounts = { attention: 0, waiting: 0 };
  for (const item of space.rewards) {
    const reward = record(item);
    if (!reward || typeof reward.id !== "string") continue;
    const status = typeof reward.status === "string" ? reward.status : "";
    const bucket = rewardBucket(status, rewardParticipantIssue(people.get(identifier(reward.participantId)) ?? []));
    if (bucket === "attention") counts.attention += 1;
    else if (bucket === "waiting") counts.waiting += 1;
  }
  return counts;
}
