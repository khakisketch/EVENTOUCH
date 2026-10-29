// Pure staff leave rules. Kept free of DOM and React so the
// contract test executes this logic at runtime instead of only
// pattern-matching the components.

export type StaffLeaveState = {
  // A write is in flight right now (scan/correction/reward submit).
  busyWrites: boolean;
  // A write went out but its verdict is unknown (retained receipts).
  uncertainWrites: boolean;
  // Typed but unsubmitted input (ticket/reason/lookup text, open camera or
  // nametag sheet) that a switch would strand.
  unsavedDraft: boolean;
};

export type StaffLeaveVerdict = {
  allow: boolean;
  // True only when the switch may proceed after the operator explicitly
  // confirms; cancel preserves everything in place.
  needsConfirm: boolean;
};

// The staff leave gate: busy or uncertain writes block even if the
// operator would confirm — the leave must never strand an unconfirmed
// receipt or move it into another organization. Unsaved drafts ask once;
// cancel keeps every draft, selection, and retained id untouched.
export function resolveStaffLeave(state: StaffLeaveState): StaffLeaveVerdict {
  if (state.busyWrites || state.uncertainWrites) {
    return { allow: false, needsConfirm: false };
  }
  if (state.unsavedDraft) {
    return { allow: true, needsConfirm: true };
  }
  return { allow: true, needsConfirm: false };
}

// The hub auto-route rule: a single assignment goes straight to its event
// screen — except after an other-tab organization change, when the loaded
// scopes may belong to the previous organization. Never auto-navigate on a
// changed context, and never route twice for the same mount.
export function shouldAutoRouteStaffHub(input: {
  ready: boolean;
  scopeCount: number;
  contextChanged: boolean;
  alreadyRouted: boolean;
}): boolean {
  return (
    input.ready &&
    input.scopeCount === 1 &&
    !input.contextChanged &&
    !input.alreadyRouted
  );
}

// Fixed current-organization line copy for the staff surface: the active
// organization and role; an explicit selection prompt when authenticated
// but nothing is selected; loading/error placeholders otherwise. The
// organization name comes verbatim from the shared context; only the role
// is localized.
export function describeWorkingOrg(
  context: { organizationName: string; role: unknown } | null,
  loading: boolean,
  selectionRequired = false
): string {
  if (context) {
    return `현재 작업 조직: ${context.organizationName} · ${staffRoleLabel(context.role)}`;
  }
  if (selectionRequired) return "운영사 선택 필요";
  return loading
    ? "현재 작업 조직을 확인하고 있습니다."
    : "현재 작업 조직을 불러오지 못했습니다. 계정 메뉴에서 다시 확인하세요.";
}

// Selection-required signal mirrored from the shared adapter contract
// (SELECTION_MESSAGE): authenticated, but no operating organization is
// pinned. This is not a load failure and never a logout.
export function isSelectionRequiredError(error: string | null): boolean {
  return error === "조직을 선택하세요";
}

// Account role wording for the staff surface. Only the two roles this
// surface operates under get short labels; anything else (including a raw
// server key the worker never assigned) falls back to a Korean placeholder
// instead of leaking an internal key.
export function staffRoleLabel(role: unknown): string {
  if (role === "STAFF") return "스태프";
  if (role === "AGENCY") return "운영자";
  return "역할 확인 필요";
}
