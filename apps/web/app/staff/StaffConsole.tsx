"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Assignment = { id: string; type: string; targetId: string };
type Desk = { id: string; name: string; action: string };
type CheckRow = {
  id: string;
  participantId: string;
  name: string;
  action: string;
  deskId: string;
  at: string;
  corrected: boolean;
};
type Scope = {
  eventId: string;
  eventName: string;
  desks: Desk[];
  assignments: Assignment[];
  checks: CheckRow[];
};
type ScanResult =
  | { kind: "idle" }
  | { kind: "ok"; name: string; action: string; reentry: boolean }
  | { kind: "failed"; message: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function StaffConsole() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [deskId, setDeskId] = useState("");
  const [ticket, setTicket] = useState("");
  const [result, setResult] = useState<ScanResult>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);

  async function load(silent = false) {
    // A post-scan refresh must not unmount the result the operator just
    // read: only the first load takes over the screen.
    if (!silent) {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/staff/login");
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        state?: {
          events?: Array<{ id?: unknown; name?: unknown }>;
          workspaces?: Record<string, {
            desks?: Desk[];
            assignments?: Assignment[];
            checks?: CheckRow[];
          }>;
        } | null;
      } | null;
      const state = data?.state;
      if (!res.ok || !state) {
        setLoadError("업무 정보를 불러오지 못했습니다.");
        return;
      }
      const events = Array.isArray(state.events) ? state.events : [];
      const workspaces = state.workspaces ?? {};
      const next: Scope[] = [];
      for (const event of events) {
        const id = typeof event.id === "string" ? event.id : "";
        if (!id) continue;
        const workspace = workspaces[id] ?? {};
        const assignments = Array.isArray(workspace.assignments)
          ? workspace.assignments
          : [];
        const deskAssignments = assignments.filter((item) => item.type === "DESK");
        if (!deskAssignments.length) continue;
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        next.push({
          eventId: id,
          eventName: typeof event.name === "string" ? event.name : id,
          desks: desks.filter((desk) =>
            deskAssignments.some((item) => item.targetId === desk.id)
          ),
          assignments: deskAssignments,
          checks: Array.isArray(workspace.checks) ? workspace.checks : [],
        });
      }
      setScopes(next);
      if (!silent) {
        setScopeIndex(0);
        setDeskId("");
        setResult({ kind: "idle" });
        if (!next.length) setLoadError("배정된 데스크가 없습니다. 운영자에게 문의하세요.");
      }
      // A silent refresh keeps the operator's desk selection and the result
      // just read; only the scope data (recent checks) updates underneath.
    } catch {
      setLoadError("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p>업무 정보를 불러오고 있습니다.</p>;
  if (loadError && !scopes.length) {
    return (
      <section>
        <p role="alert">{loadError}</p>
        <button type="button" onClick={() => load()}>다시 불러오기</button>
      </section>
    );
  }
  const scope = scopes[scopeIndex];
  if (!scope) return <p>배정된 데스크가 없습니다.</p>;
  const assignment = scope.assignments.find((item) => item.targetId === deskId) ?? null;

  async function onScan(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || !assignment || !deskId || !ticket.trim()) return;
    setSubmitting(true);
    setResult({ kind: "idle" });
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(scope.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          command: "check.scan",
          assignmentId: assignment.id,
          payload: { deskId, ticket: ticket.trim() },
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        name?: unknown;
        action?: unknown;
        reentry?: unknown;
      } | null;
      if (!res.ok) {
        setResult({
          kind: "failed",
          message:
            typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
        });
        return;
      }
      setResult({
        kind: "ok",
        name: typeof data?.name === "string" ? data.name : "",
        action: typeof data?.action === "string" ? data.action : "",
        reentry: data?.reentry === true,
      });
      setTicket("");
      await load(true);
    } catch {
      setResult({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      {scopes.length > 1 ? (
        <div>
          <label htmlFor="staff-event">행사</label>
          <select
            id="staff-event"
            value={String(scopeIndex)}
            onChange={(event) => {
              setScopeIndex(Number(event.target.value));
              setDeskId("");
              setResult({ kind: "idle" });
            }}
          >
            {scopes.map((item, index) => (
              <option key={item.eventId} value={index}>
                {item.eventName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p>{scope.eventName}</p>
      )}
      <div>
        <label htmlFor="staff-desk">데스크</label>
        <select
          id="staff-desk"
          value={deskId}
          onChange={(event) => {
            setDeskId(event.target.value);
            setResult({ kind: "idle" });
          }}
        >
          <option value="">선택하세요</option>
          {scope.desks.map((desk) => (
            <option key={desk.id} value={desk.id}>
              {desk.name}
            </option>
          ))}
        </select>
      </div>
      <form onSubmit={onScan}>
        <div>
          <label htmlFor="staff-ticket">티켓 코드</label>
          <input
            id="staff-ticket"
            type="text"
            autoComplete="off"
            placeholder="티켓 코드를 입력하거나 스캔하세요"
            value={ticket}
            onChange={(event) => setTicket(event.target.value)}
          />
        </div>
        <button type="submit" disabled={submitting || !assignment || !ticket.trim()}>
          {submitting ? "처리 중입니다" : "체크인"}
        </button>
      </form>
      {result.kind === "ok" ? (
        <p role="status">
          {result.name} · {result.action === "IN" ? "입장" : "퇴장"}
          {result.reentry ? " (재입장)" : ""}
        </p>
      ) : null}
      {result.kind === "failed" ? <p role="alert">{result.message}</p> : null}
      <h2>최근 처리</h2>
      {scope.checks.length ? (
        <ul>
          {scope.checks.slice(0, 10).map((check) => (
            <li key={check.id}>
              {check.name} · {check.action === "IN" ? "입장" : "퇴장"}
              {check.corrected ? " (정정됨)" : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>아직 처리 기록이 없습니다.</p>
      )}
    </section>
  );
}
