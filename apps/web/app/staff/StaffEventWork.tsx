"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CameraScan from "./CameraScan";
import { loginHrefForLocation } from "../auth-redirect";
import { buildStaffScopes, resolveStaffScopeId, type StaffScope } from "./staff-scope";

type ScanResult =
  | { kind: "idle" }
  | { kind: "ok"; name: string; action: string; reentry: boolean; booth?: string }
  | { kind: "failed"; message: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function StaffEventWork({ eventId }: { eventId: string }) {
  const router = useRouter();
  const targetEventId = resolveStaffScopeId(eventId);
  const pendingScanIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<StaffScope | null>(null);
  const [missingAssignment, setMissingAssignment] = useState(false);
  const [task, setTask] = useState<"desk" | "booth">("desk");
  const [deskId, setDeskId] = useState("");
  const [boothId, setBoothId] = useState("");
  const [ticket, setTicket] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [result, setResult] = useState<ScanResult>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const scopeRef = useRef<StaffScope | null>(null);
  scopeRef.current = scope;

  async function load(silent = false) {
    // A post-scan refresh must not unmount the result the operator just
    // read: only the first load takes over the screen.
    if (!silent) {
      setLoading(true);
      setMissingAssignment(false);
    }
    setLoadError(null);
    try {
      const res = await fetch("/api/bootstrap", { cache: "no-store" });
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
      const state = data?.state;
      if (!res.ok || !state) {
        setLoadError("업무 정보를 불러오지 못했습니다.");
        return;
      }
      const scopes = buildStaffScopes(
        Array.isArray(state.events) ? state.events : [],
        state.workspaces ?? {}
      );
      const next = scopes.find((item) => item.eventId === targetEventId) ?? null;
      if (!next) {
        // Assignment revoked, wrong event, or signed in as an operator
        // without desk work: stay on a stable explanation, never a loop.
        if (silent && scopeRef.current) {
          setLoadError("최신 업무를 불러오지 못했습니다. 표시된 내용이 오래되었을 수 있습니다.");
        } else {
          setScope(null);
          setMissingAssignment(true);
        }
        return;
      }
      setScope(next);
      setMissingAssignment(false);
      if (!silent) {
        setDeskId("");
        setBoothId("");
        setTask(next.desks.length ? "desk" : "booth");
        setResult({ kind: "idle" });
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
  }, [targetEventId]);

  if (loading) return <p className="loading-state" role="status">업무 정보를 불러오고 있습니다.</p>;
  if (missingAssignment || (!scope && loadError)) {
    return (
      <section className="staff-workspace state-panel">
        <p role="alert">{loadError ?? "이 행사에 대한 업무 배정이 없습니다. 운영자에게 문의하세요."}</p>
        <p>
          <button type="button" className="button button-secondary" onClick={() => load()}>
            다시 불러오기
          </button>{" "}
          <Link className="button button-secondary" href="/staff">
            내 업무로
          </Link>
        </p>
      </section>
    );
  }
  if (!scope) return <p className="loading-state">배정된 업무가 없습니다.</p>;

  const activeScope: StaffScope = scope;
  const hasDeskWork = activeScope.desks.length > 0;
  const hasBoothWork = activeScope.booths.length > 0;
  const activeTask: "desk" | "booth" =
    task === "booth" && hasBoothWork ? "booth" : hasDeskWork ? "desk" : "booth";
  const assignment = activeTask === "desk"
    ? activeScope.assignments.find((item) => item.targetId === deskId) ?? null
    : activeScope.boothAssignments.find((item) => item.targetId === boothId) ?? null;
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
      const res = await fetch(`/api/events/${encodeURIComponent(activeScope.eventId)}/commands`, {
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
    <section className="staff-workspace" aria-label={`${activeScope.eventName} 현장 업무`}>
      <p className="staff-event-context">
        <Link className="staff-back-link" href="/staff">
          ← 내 업무
        </Link>
        <span>{activeScope.eventName}</span>
      </p>
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
            {activeScope.desks.map((desk) => (
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
            {activeScope.booths.map((booth) => (
              <option key={booth.id} value={booth.id}>
                {booth.name}
                {booth.status && booth.status !== "OPEN" ? " (진행 전)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {activeTask === "booth" && activeScope.stampMode === "SELF" ? (
        <p className="notice" role="status">
          참가자가 부스 QR을 스캔하는 방식입니다. 이 화면에서 티켓을 대신 처리하지 않습니다.
        </p>
      ) : null}
      {activeTask === "booth" && activeScope.stampMode === "SELF" && boothId ? (
        <p className="staff-booth-code">
          부스 QR: <code>{`ET:BOOTH:${activeScope.eventId}:${boothId}`}</code>
        </p>
      ) : null}
      {activeTask === "booth" && activeScope.stampMode !== "SELF" ? (
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
        {activeTask === "booth" && activeScope.stampMode === "SELF" ? null : (
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
      {loadError && scope ? (
        <p className="notice" role="status">
          {loadError}{" "}
          <button type="button" className="button button-secondary" onClick={() => load()}>
            다시 불러오기
          </button>
        </p>
      ) : null}
      {activeScope.checks.length ? (
        <ul className="activity-list">
          {activeScope.checks.slice(0, 10).map((check) => (
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
