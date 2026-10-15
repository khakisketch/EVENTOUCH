// Shared staff assignment projection: the hub and the event work screen read
// the same server-owned bootstrap and keep only the current account's active
// DESK/BOOTH assignments. Scans stay server-checked; this module never
// decides admission.

export type StaffAssignment = { id: string; type: string; targetId: string };
export type StaffDesk = { id: string; name: string; action: string };
export type StaffBooth = { id: string; name: string; zone: string; status: string };
export type StaffCheckRow = {
  id: string;
  participantId: string;
  name: string;
  action: string;
  deskId: string;
  at: string;
  corrected: boolean;
};
export type StaffScope = {
  eventId: string;
  eventName: string;
  desks: StaffDesk[];
  assignments: StaffAssignment[];
  booths: StaffBooth[];
  boothAssignments: StaffAssignment[];
  stampMode: string;
  checks: StaffCheckRow[];
};

type BootstrapWorkspace = {
  desks?: unknown;
  booths?: unknown;
  assignments?: unknown;
  checks?: unknown;
  stampMode?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildStaffScopes(
  events: Array<{ id?: unknown; name?: unknown }>,
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
    const checks = Array.isArray(workspace.checks)
      ? (workspace.checks as StaffCheckRow[])
      : [];
    next.push({
      eventId: id,
      eventName: typeof event.name === "string" ? event.name : id,
      desks: desks.filter((desk) =>
        deskAssignments.some((item) => item.targetId === desk.id)
      ),
      assignments: deskAssignments,
      booths: booths.filter((booth) =>
        boothAssignments.some((item) => item.targetId === booth.id)
      ),
      boothAssignments,
      stampMode: workspace.stampMode === "SELF" ? "SELF" : "STAFF",
      checks,
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
