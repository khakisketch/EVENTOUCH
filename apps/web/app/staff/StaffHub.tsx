"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OrganizationContextNotice } from "../OrganizationSwitcher";
import {
  ensureOperatorContext,
  operatorFetch,
} from "../../lib/operator-context";
import StaffAccountMenu from "./StaffAccountMenu";
import { useOperatorContextSnapshot } from "./use-operator-context";
import {
  describeWorkingOrg,
  isSelectionRequiredError,
  shouldAutoRouteStaffHub,
} from "./staff-org-guard";
import workStyles from "./staff-event-work.module.css";
import { loginHrefForLocation } from "../auth-redirect";
import { buildStaffScopes, staffScopeSummary, type StaffScope } from "./staff-scope";

type HubState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; scopes: StaffScope[] };

export default function StaffHub() {
  const router = useRouter();
  const [state, setState] = useState<HubState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  // Shared operator context: who is signed in, which organization is
  // operating, and whether another tab changed it underneath this one.
  const orgSnapshot = useOperatorContextSnapshot();
  const orgChanged = orgSnapshot.changed;
  const workingOrg = orgSnapshot.context;
  // The single-assignment shortcut fires at most once per mount — and never
  // on a changed context, when the loaded scopes may belong to the previous
  // organization. No automatic role-home navigation on context change.
  const autoRoutedRef = useRef(false);

  // The hub holds no drafts and issues no writes, so the switch gate only
  // blocks while the bootstrap itself is still loading.
  function confirmLeaveHub(): boolean {
    return state.kind !== "loading";
  }

  function orgLineText(): string {
    // Authenticated without a selected organization is not a load failure
    // and never a logout: prompt for selection, and never bounce to login.
    if (workingOrg) {
      return describeWorkingOrg(workingOrg, orgSnapshot.loading, false);
    }
    if (!orgSnapshot.loading && isSelectionRequiredError(orgSnapshot.error)) {
      return describeWorkingOrg(null, false, true);
    }
    return describeWorkingOrg(null, orgSnapshot.loading, false);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Seed the shared context; the bootstrap below stays the scope source.
      // The adapter publishes loading/selection failures to its snapshot;
      // background initialization must not create an unhandled page error.
      void ensureOperatorContext().catch(() => {});
      try {
        const res = await operatorFetch("/api/bootstrap", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: Array<{ id?: unknown; name?: unknown }>;
            workspaces?: Record<string, {
              desks?: unknown;
              booths?: unknown;
              assignments?: unknown;
              checks?: unknown;
              stampMode?: unknown;
            }>;
          } | null;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.state) {
          setState({ kind: "failed", message: "업무 정보를 불러오지 못했습니다." });
          return;
        }
        const scopes = buildStaffScopes(
          Array.isArray(data.state.events) ? data.state.events : [],
          data.state.workspaces ?? {}
        );
        setState({ kind: "ready", scopes });
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [router, reloadTick]);

  // One assignment goes straight to its event work screen so the desk never
  // starts by re-picking the only possible event — unless the organization
  // changed in another tab, in which case the operator picks explicitly
  // after confirming the switch.
  useEffect(() => {
    if (
      !shouldAutoRouteStaffHub({
        ready: state.kind === "ready",
        scopeCount: state.kind === "ready" ? state.scopes.length : 0,
        contextChanged: orgChanged,
        alreadyRouted: autoRoutedRef.current,
      })
    ) {
      return;
    }
    autoRoutedRef.current = true;
    const only = (state as { kind: "ready"; scopes: StaffScope[] }).scopes[0];
    router.replace(`/staff/events/${encodeURIComponent(only.eventId)}`);
  }, [router, state, orgChanged]);

  // Account access and the fixed organization line stay visible in every hub
  // state — including loading, empty, and error — so the operator always
  // knows which organization a retry or an opened event would act under.
  const chrome = (
    <>
      <StaffAccountMenu confirmLeave={confirmLeaveHub} confirmLeaveAccount={confirmLeaveHub} />
      <p className={workStyles.orgLine}>{orgLineText()}</p>
      {orgChanged ? <OrganizationContextNotice confirmLeave={confirmLeaveHub} /> : null}
    </>
  );

  if (state.kind === "loading") {
    return (
      <>
        {chrome}
        <p className="loading-state" role="status">업무 정보를 불러오고 있습니다.</p>
      </>
    );
  }
  if (state.kind === "failed") {
    return (
      <>
        {chrome}
        <section className="staff-workspace state-panel">
          <p role="alert" className={workStyles.hubNote}>{state.message}</p>
          <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
            다시 불러오기
          </button>
        </section>
      </>
    );
  }
  if (!state.scopes.length) {
    return (
      <>
        {chrome}
        <section className="staff-workspace state-panel">
          <p role="status" className={workStyles.hubNote}>배정된 업무가 없습니다. 운영자에게 문의하세요.</p>
          <p className={workStyles.hubNote}>업무 배정은 운영 콘솔 &gt; 현장 운영 &gt; 스태프 배정에서 지정됩니다. 아직 배정 전이라면 대기 상태이며, 배정이 올라오면 다시 불러오기 후 목록에 표시됩니다.</p>
          <p className={workStyles.hubNote}>이 화면을 안내한 담당자(초대 메일·행사 안내의 문의처)에게 배정 여부를 확인해 주세요.</p>
          <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
            다시 불러오기
          </button>
        </section>
      </>
    );
  }
  if (state.scopes.length === 1) {
    return (
      <>
        {chrome}
        <p className="loading-state" role="status">배정된 행사로 이동하고 있습니다.</p>
      </>
    );
  }

  return (
    <>
      {chrome}
      <section className="staff-workspace" aria-label="내 배정 업무">
        <h2 className={workStyles.hubHeading}>
          오늘 처리할 행사 <span className={workStyles.hubCount}>{state.scopes.length}곳</span>
        </h2>
        <ul className="staff-assignment-list">
          {state.scopes.map((scope) => (
            <li key={scope.eventId} className={`staff-assignment-row ${workStyles.hubRow}`}>
              <div className="staff-assignment-summary">
                <strong className={workStyles.hubEventName}>{scope.eventName}</strong>
                <span className={workStyles.hubScope}>{staffScopeSummary(scope)}</span>
              </div>
              {orgChanged ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled
                  title="다른 탭에서 조직이 전환됐습니다. 위 안내에서 전환을 먼저 확인하세요."
                >
                  업무 열기
                </button>
              ) : (
                <Link
                  className="button button-primary"
                  href={`/staff/events/${encodeURIComponent(scope.eventId)}`}
                >
                  업무 열기
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
