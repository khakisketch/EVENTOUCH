import { eventStageLabel } from "../event-stage";

// Cross-screen handoff contracts (UI only, no commands, no API surface).
// Team -> operations carries one staff account id (?assignAccount=) so the
// existing assignment dialog can preselect the person; the roster ->
// message handoff carries recipient ids (?to=) plus an explicit recipient
// status filter (?status=). Every reader below is total: absent or malformed
// input falls back to a safe default and never throws.

type TeamEventOption = { id: string; name: string; stage: string };

// Active stages lead, closed stages follow, unknown stages sort last.
// Array.sort is stable, so equal ranks keep their bootstrap order.
const TEAM_EVENT_STAGE_RANK: Record<string, number> = {
  DRAFT: 0,
  READY: 1,
  LIVE: 2,
  ENDED: 3,
  ARCHIVED: 4,
};

function teamEventStageRank(stage: string): number {
  const key = (stage || "").trim().toUpperCase();
  return TEAM_EVENT_STAGE_RANK[key] ?? 5;
}

function isKnownTeamEventStage(stage: string): boolean {
  const key = (stage || "").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(TEAM_EVENT_STAGE_RANK, key);
}

export function sortTeamEventsForAssign<T extends TeamEventOption>(events: T[]): T[] {
  return [...events].sort(
    (a, b) => teamEventStageRank(a.stage) - teamEventStageRank(b.stage)
  );
}

// Option copy keeps the person, role and event choice readable: every
// option names the event and its server stage. Ended/archived events are
// never hidden; archived ones (read-only server-side) say so, and unknown
// stages read as needing confirmation instead of guessing a stage.
export function teamEventOptionLabel(event: TeamEventOption): string {
  const name = (event.name || "").trim() || event.id;
  const stage = (event.stage || "").trim().toUpperCase();
  if (!isKnownTeamEventStage(event.stage)) return `${name} · 단계 확인 필요`;
  const label = eventStageLabel(stage);
  if (stage === "ARCHIVED") return `${name} · ${label} · 읽기 전용`;
  return `${name} · ${label}`;
}

export function readAssignAccountParam(search: string): string {
  try {
    return (new URLSearchParams(search).get("assignAccount") ?? "").trim();
  } catch {
    return "";
  }
}

export function buildStaffAssignHandoffHref(eventId: string, accountId: string): string {
  return `/console/events/${encodeURIComponent(eventId)}/operations?assignAccount=${encodeURIComponent(accountId)}#ops-staff`;
}

// The composer already filters recipients by status; the handoff only names
// which filter to show. Absent means "leave the filter alone" (existing
// ?to= behavior); an unknown value falls back to the composer default.
const RECIPIENT_HANDOFF_STATUSES = ["APPROVED", "PENDING", "WAITLIST", "ALL"] as const;

export function readRecipientStatusHandoff(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get("status");
    if (raw === null) return null;
    const key = raw.trim().toUpperCase();
    return (RECIPIENT_HANDOFF_STATUSES as readonly string[]).includes(key)
      ? key
      : "APPROVED";
  } catch {
    return null;
  }
}

// Bulk-approval follow-up: exactly the ids just approved travel on the
// existing ?to= handoff, with the approved filter stated explicitly.
export function buildApprovedMessageHandoffHref(eventId: string, ids: string[]): string {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  return `/console/events/${encodeURIComponent(eventId)}/messages?to=${encodeURIComponent(unique.join(","))}&status=APPROVED`;
}
