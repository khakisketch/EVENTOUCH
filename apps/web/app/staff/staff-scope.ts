// Shared field-work projection: the hub and the event work screen read the same
// server-owned bootstrap. A staff account sees its own active DESK/BOOTH
// assignments. An operator who holds the field permission opens any desk or
// booth of a running or upcoming event without being assigned to it (owner
// decision 2026-11-25). Scans stay server-checked; this module never decides
// admission.
import { canWriteEvent } from "../../lib/event-capabilities";

export type StaffAssignment = { id: string; type: string; targetId: string };
export type StaffDesk = { id: string; name: string; action: string; open?: boolean; nametag?: boolean; mode?: string };
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
  // True when the viewer works here as an operator, not through an assignment.
  operator: boolean;
};

// Who is looking, as the bootstrap names them.
export type StaffAccess = { viewer?: unknown; memberships?: unknown };

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
  workspaces: Record<string, BootstrapWorkspace>,
  access?: StaffAccess
): StaffScope[] {
  const viewer = typeof access?.viewer === "object" && access.viewer !== null ? access.viewer as { id?: unknown; role?: unknown } : null;
  const operator = viewer?.role === "AGENCY" || viewer?.role === "MANAGER";
  const next: StaffScope[] = [];
  for (const event of events) {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) continue;
    const workspace = workspaces[id] ?? {};
    const assignments = Array.isArray(workspace.assignments)
      ? (workspace.assignments as StaffAssignment[])
      : [];
    const desks = Array.isArray(workspace.desks)
      ? (workspace.desks as StaffDesk[])
      : [];
    const booths = Array.isArray(workspace.booths)
      ? (workspace.booths as StaffBooth[])
      : [];
    // The server ignores an operator's assignment id (it checks the event permission), so the
    // screen can name each place itself and keep one code path for both kinds of account.
    const over = event.stage === "ENDED" || event.stage === "ARCHIVED";
    const may = (command: string) => operator && !over && canWriteEvent({
      role: viewer?.role, userId: viewer?.id, memberships: access?.memberships, eventId: id,
    }, command);
    const asOperator = (type: "DESK" | "BOOTH", places: Array<{ id: string }>): StaffAssignment[] =>
      places.map((place) => ({ id: `operator:${place.id}`, type, targetId: place.id }));
    const stampOn = !Array.isArray(event.features) || event.features.includes("stamp");
    const deskAssignments = operator
      ? (may("check.scan") ? asOperator("DESK", desks) : [])
      : assignments.filter((item) => item.type === "DESK");
    const boothAssignments = operator
      ? (may("booth.visit") && stampOn ? asOperator("BOOTH", booths) : [])
      : assignments.filter((item) => item.type === "BOOTH");
    if (!deskAssignments.length && !boothAssignments.length) continue;
    const checksAvailable = workspace.checksAvailable === true && Array.isArray(workspace.checks) &&
      workspace.checks.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    const participantsAvailable = workspace.participantsAvailable === true && Array.isArray(workspace.participants) &&
      workspace.participants.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    // A staff account is only sent its own desks' checks; an operator account
    // opening this screen receives every desk's, so narrow to the assigned desks.
    const checks = checksAvailable
      ? (workspace.checks as StaffCheckRow[]).filter((check) =>
          deskAssignments.some((item) => item.targetId === check.deskId))
      : [];
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
      operator,
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
