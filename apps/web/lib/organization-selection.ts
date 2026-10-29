"use client";
import {
  acceptOperatorContext,
  getOperatorContextSnapshot,
  listUncertainAttempts,
  observeSelectedOrganization,
  operatorFetch,
  refreshOperatorContext,
  renewPinnedOrganizationVersion,
} from "./operator-context";
import { invalidateConsoleReads } from "./console-api";
import { safeNextPath } from "../app/auth-redirect";

export type SelectionAttempt = {
  organizationId: string;
  organizationName: string;
  commandId: string;
  expectedContextVersion: number;
  mode: "switch" | "restore";
};
type SelectionSnapshot = { attempt: SelectionAttempt | null; busy: boolean; uncertain: boolean; error: string | null; notice: string | null };
let snapshot: SelectionSnapshot = { attempt: null, busy: false, uncertain: false, error: null, notice: null };
const listeners = new Set<() => void>();
const warnUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
function update(next: SelectionSnapshot) {
  const hadPending = snapshot.attempt !== null;
  snapshot = next;
  if (typeof window !== "undefined") {
    if (!hadPending && next.attempt) window.addEventListener("beforeunload", warnUnload);
    if (hadPending && !next.attempt) window.removeEventListener("beforeunload", warnUnload);
  }
  for (const listener of listeners) listener();
}
export const getOrganizationSelectionSnapshot = () => snapshot;
export function subscribeOrganizationSelection(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function organizationSelectionDestination(role: string, search: string): string {
  const next = safeNextPath(new URLSearchParams(search).get("next"));
  // Only the already-validated invitation return survives an initial org
  // choice; arbitrary event URLs cannot bypass the effective-role home.
  if (next?.startsWith("/invite/")) return next;
  return role === "STAFF" ? "/staff" : "/console";
}
function navigateToRoleHome(role: string) {
  // Only after an explicit selection and its successful server response.
  // Clear approved draft warnings immediately before leaving, not while a
  // selection request may still fail or have an unknown result.
  window.dispatchEvent(new Event("eventouch:organization-confirmed-exit"));
  window.location.assign(organizationSelectionDestination(role, window.location.search));
}

export async function selectOrganization(attempt?: SelectionAttempt): Promise<void> {
  if (snapshot.busy) return;
  const chosen = snapshot.attempt ?? attempt;
  if (!chosen) return;
  if (!Number.isSafeInteger(chosen.expectedContextVersion) || chosen.expectedContextVersion < 0) {
    update({ attempt: null, busy: false, uncertain: false, error: "전환에 필요한 접속 정보를 확인하지 못했습니다. 소속을 다시 확인하세요.", notice: null });
    return;
  }
  update({ attempt: chosen, busy: true, uncertain: false, error: null, notice: null });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await operatorFetch("/api/auth/organizations/select", {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: chosen.organizationId, commandId: chosen.commandId,
        expectedContextVersion: chosen.expectedContextVersion }),
    });
    const data: unknown = await response.json().catch(() => null);
    const root = record(data);
    const user = record(root?.user);
    if (!response.ok) {
      const ambiguous = response.status >= 500 || response.status === 408;
      update({ attempt: ambiguous ? chosen : null, busy: false, uncertain: ambiguous,
        error: ambiguous ? "전환 결과를 확인하지 못했습니다. 이미 전환되었을 수 있으므로 같은 요청으로 다시 확인하세요."
          : response.status === 401 ? "로그인이 필요합니다. 로그인한 뒤 소속을 다시 확인하세요."
          : response.status === 403 || response.status === 404 ? "이 운영사에 접근할 수 없습니다. 활성 소속 여부를 확인하세요."
          : response.status === 409 ? "다른 탭에서 운영사 선택이 바뀌었습니다. 소속을 다시 확인하고 명시적으로 선택하세요."
          : response.status === 429 ? "요청이 많습니다. 잠시 후 소속을 다시 확인하세요."
          : "전환할 운영사를 다시 선택하세요.", notice: null });
      void refreshOperatorContext();
      return;
    }
    if (!user || user.organizationId !== chosen.organizationId ||
      !["AGENCY", "MANAGER", "STAFF"].includes(String(user.role)) ||
      typeof user.contextVersion !== "number") {
      update({ attempt: chosen, busy: false, uncertain: true, error: "전환 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.", notice: null });
      void refreshOperatorContext();
      return;
    }
    const current = getOperatorContextSnapshot().context;
    invalidateConsoleReads();
    if (chosen.mode === "restore" && current?.organizationId === chosen.organizationId) {
      if (current.role === user.role) {
        // This is recovery of the SAME pinned working organization, not a new
        // view. Preserve the form and its receipt; approved renewal changes
        // only its context-version header for that original organization.
        acceptOperatorContext(user);
        update({ attempt: null, busy: false, uncertain: false, error: null,
          notice: `${chosen.organizationName}에 다시 연결했습니다. 남아 있는 요청은 같은 요청으로 결과를 확인하세요.` });
        return;
      }
      // Same org, but the ACTUAL server role differs from the pinned view
      // (e.g. another owner changed it while receipts were still pending).
      // Renew ONLY the context version (server-confirmed), then STOP. The
      // original workspace, its drafts, its guards, and the locked
      // reads/writes stay exactly as they are — no navigate, no role adopt,
      // no draft clear, and never a guessed home. The explicit move to the
      // changed role home happens afterwards through the fresh-me role
      // check, once every same-org receipt is resolved. Any later drift
      // invalidates the replay grant (adapter-enforced).
      if (!renewPinnedOrganizationVersion(user)) {
        update({ attempt: chosen, busy: false, uncertain: true,
          error: "조직 정보를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.", notice: null });
        void refreshOperatorContext();
        return;
      }
      const pendingSameOrg = listUncertainAttempts().some((item) => item.organizationId === chosen.organizationId);
      update({ attempt: null, busy: false, uncertain: false, error: null,
        notice: pendingSameOrg
          ? `${chosen.organizationName}의 역할이 바뀌었습니다. 미확인 요청을 같은 요청으로 먼저 확인한 뒤, 현재 역할 다시 확인으로 변경된 역할의 홈으로 이동하세요.`
          : `${chosen.organizationName}의 역할이 바뀌었습니다. 변경된 역할의 홈으로 이동하려면 현재 역할을 다시 확인하세요.` });
      return;
    } else {
      observeSelectedOrganization(user);
      update({ attempt: null, busy: false, uncertain: false, error: null, notice: null });
      navigateToRoleHome(String(user.role));
    }
  } catch {
    update({ attempt: chosen, busy: false, uncertain: true, error: "전환 결과를 확인하지 못했습니다. 연결을 확인한 뒤 같은 요청으로 다시 확인하세요.", notice: null });
    void refreshOperatorContext();
  } finally { window.clearTimeout(timer); }
}
