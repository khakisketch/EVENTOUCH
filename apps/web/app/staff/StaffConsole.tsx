"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import CameraScan from "./CameraScan";

type Assignment = { id: string; type: string; targetId: string };
type Desk = { id: string; name: string; action: string };
type Booth = { id: string; name: string; zone: string; status: string };
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
  booths: Booth[];
  boothAssignments: Assignment[];
  stampMode: string;
  checks: CheckRow[];
};
type ScanResult =
  | { kind: "idle" }
  | { kind: "ok"; name: string; action: string; reentry: boolean; booth?: string }
  | { kind: "failed"; message: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function StaffConsole() {
  const router = useRouter();
  const pendingScanIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [task, setTask] = useState<"desk" | "booth">("desk");
  const [deskId, setDeskId] = useState("");
  const [boothId, setBoothId] = useState("");
  const [ticket, setTicket] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [result, setResult] = useState<ScanResult>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const scopesRef = useRef<Scope[]>([]);
  scopesRef.current = scopes;

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
            booths?: Booth[];
            assignments?: Assignment[];
            checks?: CheckRow[];
            stampMode?: unknown;
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
        const boothAssignments = assignments.filter((item) => item.type === "BOOTH");
        if (!deskAssignments.length && !boothAssignments.length) continue;
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        const booths = Array.isArray(workspace.booths) ? workspace.booths : [];
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
          checks: Array.isArray(workspace.checks) ? workspace.checks : [],
        });
      }
      if (silent && !next.length && scopesRef.current.length) {
        // A silent refresh must never strand an operator mid-shift on an
        // empty screen: keep the current scopes and say the list may be
        // stale instead. The notice below offers a full reload.
        setLoadError("최신 업무를 불러오지 못했습니다. 표시된 내용이 오래되었을 수 있습니다.");
      } else {
        setScopes(next);
      }
      if (!silent) {
        setScopeIndex(0);
        setDeskId("");
        setBoothId("");
        setTask(next[0] && next[0].desks.length ? "desk" : "booth");
        setResult({ kind: "idle" });
        if (!next.length) setLoadError("배정된 업무가 없습니다. 운영자에게 문의하세요.");
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

  if (loading) return <p className="loading-state" role="status">업무 정보를 불러오고 있습니다.</p>;
  if (loadError && !scopes.length) {
    return (
      <section className="staff-workspace state-panel">
        <p role="alert">{loadError}</p>
        <button type="button" className="button button-secondary" onClick={() => load()}>다시 불러오기</button>
      </section>
    );
  }
  const scope = scopes[scopeIndex];
  if (!scope) return <p className="loading-state">배정된 업무가 없습니다.</p>;
  const hasDeskWork = scope.desks.length > 0;
  const hasBoothWork = scope.booths.length > 0;
  const activeTask: "desk" | "booth" =
    task === "booth" && hasBoothWork ? "booth" : hasDeskWork ? "desk" : "booth";
  const assignment = activeTask === "desk"
    ? scope.assignments.find((item) => item.targetId === deskId) ?? null
    : scope.boothAssignments.find((item) => item.targetId === boothId) ?? null;
  const ready = activeTask === "desk"
    ? Boolean(assignment && deskId)
    : Boolean(assignment && boothId);

  async function submitTicket(code: string) {
    const activeAssignment = assignment;
    if (submitting || !activeAssignment || !code.trim()) return;
    setSubmitting(true);
    setResult({ kind: "idle" });
    // One command id per scan attempt: a lost response must replay the SAME
    // request, or the retry would look like a second scan of the same
    // ticket. Cleared as soon as any response is received.
    const commandId = pendingScanIdRef.current ?? randomCommandId();
    pendingScanIdRef.current = commandId;
    try {
      const isDesk = activeTask === "desk";
      const res = await fetch(`/api/events/${encodeURIComponent(scope.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          command: isDesk ? "check.scan" : "booth.visit",
          assignmentId: activeAssignment.id,
          payload: isDesk
            ? { deskId, ticket: code.trim() }
            : { boothId, ticket: code.trim() },
        }),
      });
      pendingScanIdRef.current = null;
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        name?: unknown;
        action?: unknown;
        reentry?: unknown;
        booth?: unknown;
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
        action: isDesk
          ? typeof data?.action === "string" ? data.action : ""
          : "STAMP",
        reentry: data?.reentry === true,
        booth: typeof data?.booth === "string" ? data.booth : "",
      });
      setTicket("");
      await load(true);
    } catch {
      setResult({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setSubmitting(false);
    }
  }

  async function onScan(event: React.FormEvent) {
    event.preventDefault();
    await submitTicket(ticket);
  }

  return (
    <section className="staff-workspace">
      {scopes.length > 1 ? (
        <div className="staff-select-field">
          <label htmlFor="staff-event">행사</label>
          <select
            id="staff-event"
            value={String(scopeIndex)}
            onChange={(event) => {
              setScopeIndex(Number(event.target.value));
              setDeskId("");
              setBoothId("");
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
        <p className="staff-event-context">{scope.eventName}</p>
      )}
      {hasDeskWork && hasBoothWork ? (
        <div className="staff-task-switch" role="group" aria-label="업무 종류">
          <button
            type="button"
            className={`button ${activeTask === "desk" ? "button-primary" : "button-secondary"}`}
            aria-pressed={activeTask === "desk"}
            onClick={() => {
              setTask("desk");
              setResult({ kind: "idle" });
            }}
          >
            데스크 체크인
          </button>
          <button
            type="button"
            className={`button ${activeTask === "booth" ? "button-primary" : "button-secondary"}`}
            aria-pressed={activeTask === "booth"}
            onClick={() => {
              setTask("booth");
              setResult({ kind: "idle" });
            }}
          >
            부스 인증
          </button>
        </div>
      ) : null}
      {activeTask === "desk" ? (
        <div className="staff-select-field">
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
      ) : (
        <div className="staff-select-field">
          <label htmlFor="staff-booth">부스</label>
          <select
            id="staff-booth"
            value={boothId}
            onChange={(event) => {
              setBoothId(event.target.value);
              setResult({ kind: "idle" });
            }}
          >
            <option value="">선택하세요</option>
            {scope.booths.map((booth) => (
              <option key={booth.id} value={booth.id}>
                {booth.name}
                {booth.status && booth.status !== "OPEN" ? " (진행 전)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {activeTask === "booth" && scope.stampMode === "SELF" ? (
        <p className="notice" role="status">
          참가자가 부스 QR을 스캔하는 방식입니다. 이 화면에서 티켓을 대신 처리하지 않습니다.
        </p>
      ) : null}
      {activeTask === "booth" && scope.stampMode === "SELF" && boothId ? (
        <p className="staff-booth-code">
          부스 QR: <code>{`ET:BOOTH:${scope.eventId}:${boothId}`}</code>
        </p>
      ) : null}
      {activeTask === "booth" && scope.stampMode !== "SELF" ? (
        <form className="scan-form" onSubmit={onScan}>
          <div className="form-field">
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
          <button className="button button-primary" type="submit" disabled={submitting || !ready || !ticket.trim()}>
            {submitting ? "처리 중입니다" : "부스 인증"}
          </button>
        </form>
      ) : null}
      {activeTask === "desk" ? (
        <form className="scan-form" onSubmit={onScan}>
          <div className="form-field">
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
          <button className="button button-primary" type="submit" disabled={submitting || !ready || !ticket.trim()}>
            {submitting ? "처리 중입니다" : "체크인"}
          </button>
        </form>
      ) : null}
      <div className="camera-action">
        {activeTask === "booth" && scope.stampMode === "SELF" ? null : (
          <button
            type="button"
            disabled={!ready}
            className="button button-secondary"
            onClick={() => {
              setResult({ kind: "idle" });
              setCameraOpen(true);
            }}
          >
            카메라로 스캔
          </button>
        )}
      </div>
      {cameraOpen && ready ? (
        <CameraScan
          onDetected={(code) => {
            setCameraOpen(false);
            setTicket(code);
            submitTicket(code);
          }}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}
      {result.kind === "ok" ? (
        <p className="scan-result scan-success" role="status">
          {result.name} ·{" "}
          {result.action === "STAMP"
            ? `부스 인증${result.booth ? ` · ${result.booth}` : ""}`
            : result.action === "IN" ? "입장" : "퇴장"}
          {result.reentry ? " (재입장)" : ""}
        </p>
      ) : null}
      {result.kind === "failed" ? <p className="scan-result scan-failure" role="alert">{result.message}</p> : null}
      <h2 className="activity-heading">최근 처리</h2>
      {loadError && scopes.length ? (
        <p className="notice" role="status">
          {loadError}{" "}
          <button type="button" className="button button-secondary" onClick={() => load()}>
            다시 불러오기
          </button>
        </p>
      ) : null}
      {scope.checks.length ? (
        <ul className="activity-list">
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
