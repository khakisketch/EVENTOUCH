"use client";

import ProductButton from "../ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import ProductLink from "../ui/ProductLink";
import { useRouter } from "next/navigation";
import { OrganizationContextNotice } from "../OrganizationSwitcher";
import { ensureOperatorContext } from "../../lib/operator-context";
import StaffAccountMenu from "./StaffAccountMenu";
import { useOperatorContextSnapshot } from "./use-operator-context";
import {
  describeWorkingOrg,
  isSelectionRequiredError,
  shouldAutoRouteStaffHub,
} from "./staff-org-guard";
import workStyles from "./staff-event-work.module.css";
import { loginHrefForLocation } from "../auth-redirect";
import { buildStaffScopes, staffHubGroups, staffScopeLine, staffStartLabel, type StaffScope } from "./staff-scope";
import { ArrowRightIcon, BangIcon, ChevronRightIcon, ClockIcon } from "../console/console-ui/ConsoleIcons";
import StatusPill from "../console/console-ui/StatusPill";
import { readStaffBootstrap, staffReadErrorMessage } from "./staff-bootstrap";

type HubState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; scopes: StaffScope[]; operator: boolean };

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
    const controller = new AbortController();
    async function load() {
      setState({ kind: "loading" });
      // Seed the shared context; the bootstrap below stays the scope source.
      // The adapter publishes loading/selection failures to its snapshot;
      // background initialization must not create an unhandled page error.
      void ensureOperatorContext().catch(() => {});
      try {
        const { status, state: bootstrap } = await readStaffBootstrap(controller);
        if (cancelled) return;
        if (status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        if (!bootstrap) {
          setState({ kind: "failed", message: "업무 정보를 불러오지 못했습니다." });
          return;
        }
        const scopes = buildStaffScopes(
          Array.isArray(bootstrap.events) ? bootstrap.events : [],
          bootstrap.workspaces ?? {},
          bootstrap
        );
        const viewerRole = (bootstrap.viewer as { role?: unknown } | undefined)?.role;
        setState({ kind: "ready", scopes, operator: viewerRole === "AGENCY" || viewerRole === "MANAGER" });
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "failed", message: staffReadErrorMessage(error) });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
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
      <div className={workStyles.hubBar}>
        <span className={workStyles.hubWordmark}>EVENTOUCH</span>
        <StaffAccountMenu compact tone="dark" confirmLeave={confirmLeaveHub} confirmLeaveAccount={confirmLeaveHub} />
      </div>
      <p className={workStyles.orgLine}>{orgLineText()}</p>
      {orgChanged ? <OrganizationContextNotice confirmLeave={confirmLeaveHub} /> : null}
    </>
  );

  if (state.kind === "loading") {
    return (
      <>
        {chrome}
        <p className={`loading-state ${workStyles.hubLoading}`} role="status">업무 정보를 불러오고 있습니다.</p>
      </>
    );
  }
  if (state.kind === "failed") {
    return (
      <>
        {chrome}
        <section className={`staff-workspace state-panel ${workStyles.hubState}`}>
          <span className={workStyles.hubTile} data-tone="danger" aria-hidden="true"><BangIcon /></span>
          <p role="alert" className={workStyles.hubNote}>{state.message}</p>
          <ProductButton type="button" variant="secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
            다시 불러오기
          </ProductButton>
        </section>
      </>
    );
  }
  if (!state.scopes.length) {
    return (
      <>
        {chrome}
        <section className={`staff-workspace state-panel ${workStyles.hubState}`}>
          <span className={workStyles.hubTile} data-tone="warn" aria-hidden="true"><ClockIcon /></span>
          {state.operator ? (
            <>
              <p role="status" className={workStyles.hubNote}>열 수 있는 데스크가 없습니다.</p>
              <p className={workStyles.hubNote}>운영 콘솔 &gt; 입장 관리에서 데스크를 만드세요. 데스크가 있는데 보이지 않으면 이 행사의 현장 운영 권한을 확인하세요.</p>
              <ProductLink className="button button-secondary" href="/console">운영 콘솔로</ProductLink>
            </>
          ) : (
            <>
              <p role="status" className={workStyles.hubNote}>배정된 업무가 없습니다. 운영자에게 문의하세요.</p>
              <p className={workStyles.hubNote}>업무 배정은 운영 콘솔 운영 콘솔 &gt; 입장 관리의 여러 곳 · 부스 · 스태프 설정에서 지정됩니다.gt; 입장 관리의 여러 곳 · 부스 · 스태프 설정에서 하는 스태프 배정으로 지정됩니다. 아직 배정 전이라면 대기 상태이며, 배정이 올라오면 다시 불러오기 후 목록에 표시됩니다.</p>
              <p className={workStyles.hubNote}>이 화면을 안내한 담당자(초대 메일·행사 안내의 문의처)에게 배정 여부를 확인해 주세요.</p>
            </>
          )}
          <ProductButton type="button" variant="secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
            다시 불러오기
          </ProductButton>
        </section>
      </>
    );
  }
  if (state.scopes.length === 1) {
    return (
      <>
        {chrome}
        <p className={`loading-state ${workStyles.hubLoading}`} role="status">배정된 행사로 이동하고 있습니다.</p>
      </>
    );
  }

  const { live, rest } = staffHubGroups(state.scopes);
  const now = new Date();
  const open = (scope: StaffScope) => `/staff/events/${encodeURIComponent(scope.eventId)}`;
  return (
    <>
      {chrome}
      <section className="staff-workspace" aria-label={state.operator ? "현장 업무 목록" : "내 배정 업무"}>
        <h2 className={workStyles.hubHeading}>
          오늘 처리할 행사 <span className={workStyles.hubCount}>{state.scopes.length}곳</span>
        </h2>
        {!live ? <p className={workStyles.hubQuiet}>지금 진행 중인 행사는 없어요.</p> : null}
        {live ? (
          <div className={workStyles.hubLive}>
            <StatusPill tone="ok" dot>지금 진행 중</StatusPill>
            <strong className={workStyles.hubLiveName}>{live.eventName}</strong>
            {live.start ? <span className={workStyles.hubLiveTime}>{live.start}{live.end ? <> <i>~</i> {live.end}</> : null}</span> : null}
            <span className={workStyles.hubLiveMine}>{live.operator ? "" : "내 배정 · "}{staffScopeLine(live)}</span>
            {orgChanged ? (
              <ProductButton type="button" variant="primary" disabled title="다른 탭에서 조직이 전환됐습니다. 위 안내에서 전환을 먼저 확인하세요.">
                업무 열기
              </ProductButton>
            ) : (
              <ProductLink className={workStyles.hubGo} href={open(live)}>
                업무 열기<ArrowRightIcon />
              </ProductLink>
            )}
          </div>
        ) : null}
        {rest.length ? <h3 className={workStyles.hubSub}>{live ? "그 밖의 배정" : "배정된 행사"}</h3> : null}
        <ul className="staff-assignment-list">
          {rest.map((scope) => {
            const body = (
              <>
                <span className={workStyles.hubInitial} aria-hidden="true">{scope.eventName.slice(0, 1)}</span>
                <span className={workStyles.hubRowText}>
                  <strong className={workStyles.hubEventName}>{scope.eventName}</strong>
                  <span className={workStyles.hubScope}>{[staffStartLabel(scope, now), staffScopeLine(scope)].filter(Boolean).join(" · ")}</span>
                </span>
                <span className={workStyles.hubRowEnd}>
                  {scope.stage === "LIVE" ? <StatusPill tone="ok" size="sm" dot>진행 중</StatusPill> : <StatusPill tone="wait" size="sm" dot>준비 중</StatusPill>}
                  <ChevronRightIcon />
                </span>
              </>
            );
            return (
              <li key={scope.eventId} className={`staff-assignment-row ${workStyles.hubRow}`}>
                {orgChanged ? (
                  <span className={`${workStyles.hubRowLink} ${workStyles.hubRowOff}`} title="다른 탭에서 조직이 전환됐습니다. 위 안내에서 전환을 먼저 확인하세요.">{body}</span>
                ) : (
                  <ProductLink className={workStyles.hubRowLink} href={open(scope)}>{body}</ProductLink>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
