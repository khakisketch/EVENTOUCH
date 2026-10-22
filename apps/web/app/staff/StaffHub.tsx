"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
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
  // starts by re-picking the only possible event.
  useEffect(() => {
    if (state.kind !== "ready" || state.scopes.length !== 1) return;
    const only = state.scopes[0];
    router.replace(`/staff/events/${encodeURIComponent(only.eventId)}`);
  }, [router, state]);

  if (state.kind === "loading") {
    return <p className="loading-state" role="status">업무 정보를 불러오고 있습니다.</p>;
  }
  if (state.kind === "failed") {
    return (
      <section className="staff-workspace state-panel">
        <p role="alert">{state.message}</p>
        <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
          다시 불러오기
        </button>
      </section>
    );
  }
  if (!state.scopes.length) {
    return (
      <section className="staff-workspace state-panel">
        <p role="status">배정된 업무가 없습니다. 운영자에게 문의하세요.</p>
        <p>업무 배정은 운영 콘솔 &gt; 현장 운영 &gt; 스태프 배정에서 지정됩니다. 아직 배정 전이라면 대기 상태이며, 배정이 올라오면 다시 불러오기 후 목록에 표시됩니다. 이 화면을 안내한 담당자(초대 메일·행사 안내의 문의처)에게 배정 여부를 확인해 주세요.</p>
        <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
          다시 불러오기
        </button>
      </section>
    );
  }
  if (state.scopes.length === 1) {
    return <p className="loading-state" role="status">배정된 행사로 이동하고 있습니다.</p>;
  }

  return (
    <section className="staff-workspace" aria-label="내 배정 업무">
      <ul className="staff-assignment-list">
        {state.scopes.map((scope) => (
          <li key={scope.eventId} className="staff-assignment-row">
            <div className="staff-assignment-summary">
              <strong>{scope.eventName}</strong>
              <span>{staffScopeSummary(scope)}</span>
            </div>
            <Link
              className="button button-primary"
              href={`/staff/events/${encodeURIComponent(scope.eventId)}`}
            >
              업무 열기
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
