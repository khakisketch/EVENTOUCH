// Shared staff assignment projection: the hub and the event work screen read
// the same server-owned bootstrap and keep only the current account's active
// DESK/BOOTH assignments. Scans stay server-checked; this module never
// decides admission.

export type StaffAssignment = { id: string; type: string; targetId: string };
export type StaffDesk = { id: string; name: string; action: string; open?: boolean };
export type StaffBooth = {
  id: string; name: string; zone: string; status: string;
  startsAt?: string | null; endsAt?: string | null; capacity?: number; used?: number;
};
export type StaffCheckRow = {
  id: string;
  participantId: string;
  name: string;
  action: string;
  deskId: string;
  at: string;
  corrected: boolean;
};
type StaffBoothVisit = { id: string; boothId: string; at: string };
export type StaffScope = {
  eventId: string;
  eventName: string;
  stage: string;
  date: string;
  start: string;
  end: string;
  desks: StaffDesk[];
  assignments: StaffAssignment[];
  booths: StaffBooth[];
  boothAssignments: StaffAssignment[];
  stampMode: string;
  stampAvailable: boolean;
  checks: StaffCheckRow[];
  checksAvailable: boolean;
  participantsAvailable: boolean;
  boothVisits: StaffBoothVisit[];
};

type BootstrapWorkspace = {
  desks?: unknown;
  booths?: unknown;
  assignments?: unknown;
  checks?: unknown;
  checksAvailable?: unknown;
  participants?: unknown;
  participantsAvailable?: unknown;
  visits?: unknown;
  stampMode?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildStaffScopes(
  events: Array<{ id?: unknown; name?: unknown; stage?: unknown; features?: unknown; date?: unknown; start?: unknown; end?: unknown }>,
  workspaces: Record<string, BootstrapWorkspace>
): StaffScope[] {
  const next: StaffScope[] = [];
  for (const event of events) {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) continue;
    const workspace = workspaces[id] ?? {};
    const assignments = Array.isArray(workspace.assignments)
      ? (workspace.assignments as StaffAssignment[])
      : [];
    const deskAssignments = assignments.filter((item) => item.type === "DESK");
    const boothAssignments = assignments.filter((item) => item.type === "BOOTH");
    if (!deskAssignments.length && !boothAssignments.length) continue;
    const desks = Array.isArray(workspace.desks)
      ? (workspace.desks as StaffDesk[])
      : [];
    const booths = Array.isArray(workspace.booths)
      ? (workspace.booths as StaffBooth[])
      : [];
    const checksAvailable = workspace.checksAvailable === true && Array.isArray(workspace.checks) &&
      workspace.checks.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    const participantsAvailable = workspace.participantsAvailable === true && Array.isArray(workspace.participants) &&
      workspace.participants.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    const checks = checksAvailable ? (workspace.checks as StaffCheckRow[]) : [];
    const boothVisits = Array.isArray(workspace.visits)
      ? (workspace.visits as StaffBoothVisit[]).filter((visit) =>
          visit && boothAssignments.some((assignment) => assignment.targetId === visit.boothId))
      : [];
    next.push({
      eventId: id,
      eventName: typeof event.name === "string" ? event.name : id,
      stage: typeof event.stage === "string" ? event.stage : "",
      date: text(event.date),
      start: text(event.start),
      end: text(event.end),
      desks: desks.filter((desk) =>
        deskAssignments.some((item) => item.targetId === desk.id)
      ),
      assignments: deskAssignments,
      booths: booths.filter((booth) =>
        boothAssignments.some((item) => item.targetId === booth.id)
      ),
      boothAssignments,
      stampMode: workspace.stampMode === "SELF" ? "SELF" : "STAFF",
      stampAvailable: (event.stage === undefined || event.stage === "LIVE") &&
        (!Array.isArray(event.features) || event.features.includes("stamp")),
      checks,
      checksAvailable,
      participantsAvailable,
      boothVisits,
    });
  }
  return next;
}

export function staffScopeSummary(scope: StaffScope): string {
  const parts: string[] = [];
  if (scope.desks.length) parts.push(`데스크 ${scope.desks.length}`);
  if (scope.booths.length) parts.push(`부스 ${scope.booths.length}`);
  const names = [...scope.desks.map((desk) => desk.name), ...scope.booths.map((booth) => booth.name)]
    .filter(Boolean)
    .slice(0, 2);
  const detail = names.length ? ` · ${names.join(" · ")}` : "";
  return `${parts.join(" · ") || "배정 업무"}${detail}${text("")}`;
}

export function resolveStaffScopeId(raw: string): string {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded || raw;
  } catch {
    return raw;
  }
}

// List line under an event in the assignment hub: what kind of work and how
// many places. Names stay on the work screen, where the desk is chosen.
export function staffScopeLine(scope: StaffScope): string {
  const parts: string[] = [];
  if (scope.desks.length) parts.push(`데스크 ${scope.desks.length}곳`);
  if (scope.booths.length) parts.push(`부스 ${scope.booths.length}곳`);
  return parts.join(" · ") || "배정 업무";
}

// The hub's one live event: the first LIVE scope. Others keep their order.
export function staffHubGroups(scopes: StaffScope[]): { live: StaffScope | null; rest: StaffScope[] } {
  const live = scopes.find((scope) => scope.stage === "LIVE") ?? null;
  return { live, rest: scopes.filter((scope) => scope !== live) };
}

// "09:00" today, "내일 10:00" tomorrow, "12.20 09:30" otherwise. Day-level
// text, so the screen's own clock is precise enough.
export function staffStartLabel(scope: StaffScope, now: Date): string {
  if (!scope.start) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scope.date);
  if (!match) return `${scope.start} 시작`;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return `${scope.start} 시작`;
  if (diff === 1) return `내일 ${scope.start} 시작`;
  return `${match[2]}.${match[3]} ${scope.start} 시작`;
}
