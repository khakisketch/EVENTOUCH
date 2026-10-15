"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CameraScan from "./CameraScan";
import QRCode from "react-qr-code";
import { loginHrefForLocation } from "../auth-redirect";
import { buildStaffScopes, resolveStaffScopeId, type StaffScope } from "./staff-scope";

type ScanResult =
  | { kind: "idle" }
  | { kind: "ok"; participantId: string; name: string; action: string; reentry: boolean; booth?: string }
  | { kind: "failed"; message: string };

type Nametag = {
  name: string;
  company: string;
  eventName: string;
  deskName: string;
  action: string;
  at: string;
};

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
  const [kiosk, setKiosk] = useState(false);
  const [nametag, setNametag] = useState<Nametag | null>(null);
  const [result, setResult] = useState<ScanResult>({ kind: "idle" });
  const [correctReason, setCorrectReason] = useState("");
  const [correctNotice, setCorrectNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [directory, setDirectory] = useState<Record<string, string>>({});
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
            participants?: unknown;
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
      // Name directory for nametags: the staff projection already carries
      // names and companies for desk work, so no extra read is needed.
      const directoryMap: Record<string, string> = {};
      const roster = state.workspaces?.[targetEventId]?.participants;
      if (Array.isArray(roster)) {
        for (const entry of roster) {
          if (typeof entry === "object" && entry !== null) {
            const person = entry as Record<string, unknown>;
            if (typeof person.id === "string" && person.id) {
              directoryMap[person.id] = typeof person.company === "string" ? person.company : "";
            }
          }
        }
      }
      setDirectory(directoryMap);
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

  useEffect(() => {
    if (!kiosk || loading) return;
    const input = document.getElementById("staff-ticket");
    if (input instanceof HTMLInputElement) input.focus();
  }, [kiosk, loading, task, deskId, boothId]);

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
        id?: unknown;
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
        participantId: typeof data?.id === "string" ? data.id : "",
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

  // A valid QR for the wrong person is accepted instantly, so the latest
  // record of this session carries its own correction. The server still
  // enforces desk scope and authorship; other records stay read-only here.
  const correctableCheck = result.kind === "ok" && result.action !== "STAMP"
    ? activeScope.checks.find(
        (check) => check.participantId === result.participantId && check.corrected !== true && check.deskId === deskId
      ) ?? null
    : null;

  async function correctLatest(event: React.FormEvent) {
    event.preventDefault();
    if (correcting || !correctableCheck || !assignment || !correctReason.trim()) return;
    setCorrecting(true);
    setCorrectNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(activeScope.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          command: "check.correct",
          assignmentId: assignment.id,
          payload: { id: correctableCheck.id, reason: correctReason.trim() },
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setCorrectNotice(typeof data?.error === "string" ? data.error : "정정하지 못했습니다.");
        return;
      }
      setCorrectNotice("기록을 정정했습니다. 현재 입장 상태에 반영되었습니다.");
      setCorrectReason("");
      setResult({ kind: "idle" });
      await load(true);
    } catch {
      setCorrectNotice("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setCorrecting(false);
    }
  }

  return (
    <section className={`staff-workspace${kiosk ? " kiosk-mode" : ""}`} aria-label={`${activeScope.eventName} 현장 업무`}>
      <p className="staff-event-context">
        <Link className="staff-back-link" href="/staff">
          ← 내 업무
        </Link>
        <span>{activeScope.eventName}</span>
        <button
          type="button"
          className="button button-secondary kiosk-toggle"
          aria-pressed={kiosk}
          onClick={() => {
            setKiosk((current) => !current);
            setResult({ kind: "idle" });
          }}
        >
          {kiosk ? "일반 화면" : "키오스크 모드"}
        </button>
      </p>
      {kiosk ? (
        <p className="notice" role="status">
          공용 태블릿용 큰 화면입니다. 같은 배정·같은 로그인으로 처리하며, 무인 셀프 체크인은 지원하지 않습니다.
        </p>
      ) : null}
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
                {desk.name} · {desk.action === "OUT" ? "퇴장" : "입장"}
              </option>
            ))}
          </select>
          {deskId ? (
            <p className="staff-direction-hint" role="status">
              {(() => {
                const selected = activeScope.desks.find((desk) => desk.id === deskId);
                return selected
                  ? `이 데스크는 ${selected.action === "OUT" ? "퇴장" : "입장"} 처리합니다.`
                  : "";
              })()}
            </p>
          ) : null}
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
              <option
                key={booth.id}
                value={booth.id}
                disabled={booth.status !== "" && booth.status !== "OPEN"}
              >
                {booth.name}
                {booth.status === "WAITING" ? " (운영 전)" : booth.status === "CLOSED" ? " (종료)" : ""}
              </option>
            ))}
          </select>
          {(() => {
            const selected = activeScope.booths.find((booth) => booth.id === boothId);
            if (!selected) return null;
            if (selected.status === "WAITING") {
              return <p className="staff-direction-hint" role="status">아직 운영을 시작하지 않은 부스입니다. 운영자가 부스를 열면 선택할 수 있습니다.</p>;
            }
            if (selected.status === "CLOSED") {
              return <p className="staff-direction-hint" role="status">종료된 부스입니다. 운영자가 다시 열면 선택할 수 있습니다.</p>;
            }
            return null;
          })()}
        </div>
      )}
      {activeTask === "booth" && activeScope.stampMode === "SELF" ? (
        <p className="notice" role="status">
          참가자가 부스 QR을 스캔하는 방식입니다. 이 화면에서 티켓을 대신 처리하지 않습니다.
        </p>
      ) : null}
      {activeTask === "booth" && activeScope.stampMode === "SELF" && boothId ? (
        <div className="staff-booth-code">
          <p>이 QR을 참가자에게 보여주세요. 참가자가 직접 스캔합니다.</p>
          <div role="img" aria-label={`${activeScope.booths.find((booth) => booth.id === boothId)?.name ?? "부스"} 인증 QR`}>
            <QRCode value={`ET:BOOTH:${activeScope.eventId}:${boothId}`} size={200} />
          </div>
          <p>
            <button
              type="button"
              className="button button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`ET:BOOTH:${activeScope.eventId}:${boothId}`);
                  setCorrectNotice("부스 코드를 복사했습니다.");
                } catch {
                  setCorrectNotice("복사에 실패했습니다. 아래 코드를 직접 전달하세요.");
                }
              }}
            >
              코드 복사
            </button>
          </p>
          <p><code>{`ET:BOOTH:${activeScope.eventId}:${boothId}`}</code></p>
        </div>
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
      {result.kind === "ok" && result.action === "IN" ? (
        <p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setNametag({
                name: result.name,
                company: (result.participantId && directory[result.participantId]) || "",
                eventName: activeScope.eventName,
                deskName: activeScope.desks.find((desk) => desk.id === deskId)?.name ?? "",
                action: result.action,
                at: new Date().toISOString(),
              });
              document.body.classList.add("nametag-printing");
            }}
          >
            네임택 인쇄
          </button>
        </p>
      ) : null}
      {result.kind === "failed" ? <p className="scan-result scan-failure" role="alert">{result.message}</p> : null}
      {correctableCheck ? (
        <form className="correction-form" onSubmit={correctLatest}>
          <p className="staff-direction-hint">다른 분의 QR을 처리했다면 여기서 바로 정정하세요. 본인 배정 데스크의 최신 기록만 정정됩니다.</p>
          <div className="form-field">
            <label htmlFor="correct-reason">정정 사유</label>
            <input
              id="correct-reason"
              type="text"
              maxLength={300}
              placeholder="예: 다른 분 티켓을 잘못 스캔함"
              value={correctReason}
              onChange={(event) => setCorrectReason(event.target.value)}
            />
          </div>
          <button className="button button-secondary" type="submit" disabled={correcting || !correctReason.trim()}>
            {correcting ? "정정 중입니다" : "최신 기록 정정"}
          </button>
        </form>
      ) : null}
      {correctNotice ? <p className="scan-result" role="status">{correctNotice}</p> : null}
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
      {nametag ? (
        <section className="nametag-sheet" aria-label="네임택 인쇄">
          <p className="nametag-event">{nametag.eventName}</p>
          <p className="nametag-name">{nametag.name}</p>
          {nametag.company ? <p className="nametag-company">{nametag.company}</p> : null}
          <p className="nametag-meta">
            {[nametag.deskName, nametag.action === "IN" ? "입장" : "퇴장"].filter(Boolean).join(" · ")}
          </p>
          <p className="nametag-actions">
            <button type="button" className="button button-primary" onClick={() => window.print()}>
              인쇄하기
            </button>{" "}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setNametag(null);
                document.body.classList.remove("nametag-printing");
              }}
            >
              닫기
            </button>
          </p>
        </section>
      ) : null}
    </section>
  );
}
