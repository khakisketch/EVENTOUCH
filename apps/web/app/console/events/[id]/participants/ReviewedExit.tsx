"use client";
import ProductButton from "../../../../ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import { consoleFetch } from "../../../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, waitForOperatorReceiptIdle } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./participants.module.css";

type Expected = { name: string; company: string; phone: string; status: string; paymentStatus: string; ticketExpiresAt: string; revoked: boolean; ticketRevision: number };
type Snapshot = { expected: Expected; entryId: string; enteredAt: string; entryName: string; deskId: string; deskName: string; ticketReview: string; action: "IN" | "OUT"; fingerprint: string; beforeInside: boolean | null; beforeEver: boolean | null };
type ExitPayload = { participantId: string; entryId: string; expected: Expected; expectedEntry: { at: string; name: string; deskId: string }; reason: string; confirmed: true };
type ReconcilePayload = { participantId: string; checkId: string; action: "IN" | "OUT"; fingerprint: string; reason: string; confirmed: true };
type Attempt = { commandId: string; command: "check.reviewed-exit"; payload: ExitPayload } | { commandId: string; command: "check.reconcile"; payload: ReconcilePayload };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";
const statusLabel = (status: string) => ({ APPROVED: "참가 확정", PENDING: "승인 대기", WAITLIST: "대기 명단", CANCELLED: "신청 취소" } as Record<string, string>)[status] || "확인 필요";
const paymentLabel = (status: string) => ({ FREE: "무료", PAID: "결제 완료", PENDING: "결제 대기", REFUND_REQUESTED: "환불 요청" } as Record<string, string>)[status] || "확인 필요";
const maskedPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 4 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : "연락처 확인 필요";
};
const identityKey = (person: Record<string, unknown>) => {
  const phone = text(person.phone).replace(/\D/g, "");
  return JSON.stringify([text(person.name).trim().toLowerCase(), text(person.company).trim().toLowerCase(), phone.slice(0, 3), phone.slice(-4)]);
};
const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "시각 확인 필요" : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
};

export default function ReviewedExit({ eventId, participantId, mode = "exit", onRefresh, onClose, onDone }: {
  eventId: string; participantId: string; mode?: "exit" | "reconcile"; onRefresh: () => Promise<boolean>; onClose: () => void; onDone: () => void;
}) {
  const isReconcile = mode === "reconcile";
  const operator = useOperatorContextSnapshot();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Attempt | null>(null);
  const [dismiss, setDismiss] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const activeRef = useRef(true);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  useConsoleDraftGuard(Boolean(reason.trim()) || Boolean(pending) || busy, pending || busy ? (isReconcile ? "출입 확인의 처리 결과를 아직 확인하지 못했습니다." : "퇴장 기록의 처리 결과를 아직 확인하지 못했습니다.") : (isReconcile ? "작성한 출입 확인 사유가 있습니다." : "작성한 퇴장 확인 사유가 있습니다."));
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; requestRef.current?.abort(); }; }, []);
  useEffect(() => pending ? manageOperatorReceipt(pending.commandId) : undefined, [pending]);
  useEffect(() => {
    if (busy || loading || !error) return;
    if (pending) recoveryRef.current?.focus();
    else if (!snapshot) reloadRef.current?.focus();
  }, [busy, loading, error, pending, snapshot]);

  async function readLatest() {
    if (requestRef.current) return;
    if (operator.changed) { setLoading(false); setError("현재 조직을 확인한 뒤 다시 시도하세요."); return; }
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setLoading(true); setError(""); setSnapshot(null); setConfirmed(false);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const body = record(await response.json().catch(() => null));
      const state = record(body?.state), workspaces = record(state?.workspaces), workspace = record(workspaces?.[eventId]);
      const events = Array.isArray(state?.events) ? state.events.map(record).filter(Boolean) : [];
      const event = events.find(item => item?.id === eventId);
      if (!response.ok || !event || text(event.stage).toUpperCase() !== "LIVE" || !workspace || !Array.isArray(workspace.participants) || !Array.isArray(workspace.checks)) {
        throw new Error("최신 현장 기록을 확인할 수 없습니다. 행사 진행 상태와 접근 권한을 확인하세요.");
      }
      const people = workspace.participants.map(record).filter(item => item?.id === participantId);
      const person = people[0];
      if (people.length !== 1 || !person || (!isReconcile && person.inside !== true) || !text(person.name).trim() || !/^\d{9,15}$/.test(text(person.phone).replace(/\D/g, "")) ||
          (person.revoked !== undefined && typeof person.revoked !== "boolean") ||
          (person.ticketRevision !== undefined && (typeof person.ticketRevision !== "number" || !Number.isSafeInteger(person.ticketRevision) || person.ticketRevision < 0))) {
        throw new Error("참가자 또는 입장 상태가 바뀌었거나 확인되지 않습니다. 최신 명단을 확인하세요.");
      }
      if (workspace.participants.map(record).filter((item) => item && identityKey(item) === identityKey(person)).length !== 1) {
        throw new Error("표시된 이름·소속·연락처가 같은 참가자가 있습니다. 현장 기록으로 대상을 구분해 주세요.");
      }
      const entry = workspace.checks.map(record).find(item => item?.participantId === participantId && item.corrected !== true);
      const candidate = record(person.attendanceReconciliation);
      if (!entry || (!isReconcile && entry.action !== "IN") || (entry.action !== "IN" && entry.action !== "OUT") || (entry.corrected !== undefined && entry.corrected !== false) || !text(entry.id) || !text(entry.at) || Number.isNaN(Date.parse(text(entry.at))) ||
          (isReconcile && (!candidate || candidate.checkId !== entry.id || candidate.action !== entry.action || candidate.at !== entry.at ||
            candidate.checkName !== text(entry.name) || candidate.deskId !== text(entry.deskId) || !/^[0-9a-f]{64}$/.test(text(candidate.fingerprint))))) {
        throw new Error(isReconcile ? "복구에 필요한 참가자 정보 또는 출입·작업 기록을 확인할 수 없습니다. 현장 기록을 추가로 확인하세요." : "최근 입장 기록을 확인할 수 없습니다. 현장 기록을 먼저 확인하세요.");
      }
      const desks = Array.isArray(workspace.desks) ? workspace.desks.map(record) : [];
      const desk = desks.find(item => item?.id === entry.deskId);
      if (!activeRef.current || controller.signal.aborted) return;
      setSnapshot({ entryId: text(entry.id), enteredAt: text(entry.at), entryName: text(entry.name), deskId: text(entry.deskId), deskName: text(desk?.name), ticketReview: text(person.ticketReview), action: entry.action, fingerprint: text(candidate?.fingerprint),
        beforeInside: typeof person.inside === "boolean" ? person.inside : null,
        beforeEver: typeof person.everIn === "boolean" ? person.everIn : person.everIn === undefined ? false : null, expected: {
        name: text(person.name), company: text(person.company), phone: text(person.phone), status: text(person.status),
        paymentStatus: text(person.paymentStatus), ticketExpiresAt: text(person.ticketExpiresAt), revoked: person.revoked === true,
        ticketRevision: typeof person.ticketRevision === "number" && Number.isSafeInteger(person.ticketRevision) && person.ticketRevision >= 0 ? person.ticketRevision : 0,
      } });
    } catch (cause) {
      if (activeRef.current) setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "최신 현장 기록을 불러오지 못했습니다. 다시 확인하세요.");
    } finally {
      window.clearTimeout(timer); requestRef.current = null;
      if (activeRef.current) setLoading(false);
    }
  }
  useEffect(() => { void readLatest(); /* event and participant identify this mounted dialog */ }, [eventId, participantId]);

  function canClose() {
    if (busy || loading || requestRef.current) return false;
    if (pending || reason.trim()) { setDismiss(true); return false; }
    return true;
  }
  async function finish(attempt: Attempt) {
    if (!await onRefresh() || !activeRef.current) {
      if (activeRef.current) { attemptRef.current = attempt; setPending(attempt); setError(isReconcile ? "출입 확인은 저장됐지만 명단을 갱신하지 못했습니다. 서버 처리 확인을 다시 선택하세요." : "퇴장 기록은 확인됐지만 명단을 갱신하지 못했습니다. 서버 처리 확인을 다시 선택하세요."); }
      return;
    }
    await waitForOperatorReceiptIdle(attempt.commandId);
    if (!activeRef.current) return;
    if (!forgetOperatorReceipt(attempt.commandId)) {
      attemptRef.current = attempt; setPending(attempt); setError(isReconcile ? "출입 확인은 저장됐지만 처리 확인 항목을 정리하지 못했습니다. 서버 처리 확인을 다시 선택하세요." : "퇴장 기록은 확인됐지만 처리 확인 항목을 정리하지 못했습니다. 서버 처리 확인을 다시 선택하세요.");
      return;
    }
    acknowledgeOperatorReceipt(attempt.commandId);
    attemptRef.current = null; setPending(null); onDone();
  }
  async function execute(statusOnly = false) {
    if (busy || requestRef.current || operator.changed) return;
    const previous = attemptRef.current;
    if (statusOnly && !previous) return;
    if (!previous && (!snapshot || !confirmed || !reason.trim())) { setError(isReconcile ? "현재 현장 상태를 확인하고 사유를 입력해 주세요." : "실제 퇴장을 확인하고 사유를 입력해 주세요."); return; }
    const commandId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `attendance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const attempt: Attempt = previous ?? (isReconcile ? { commandId, command: "check.reconcile", payload: {
      participantId, checkId: snapshot!.entryId, action: snapshot!.action, fingerprint: snapshot!.fingerprint, reason: reason.trim(), confirmed: true,
    } } : { commandId, command: "check.reviewed-exit", payload: {
      participantId, entryId: snapshot!.entryId, expected: snapshot!.expected,
      expectedEntry: { at: snapshot!.enteredAt, name: snapshot!.entryName, deskId: snapshot!.deskId }, reason: reason.trim(), confirmed: true,
    } });
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setBusy(true); setError("");
    const uncertain = () => { attemptRef.current = attempt; setPending(attempt); setError("처리 결과를 확인하지 못했습니다. 서버 처리 확인이나 같은 요청 다시 시도를 선택하세요."); };
    try {
      const base = `/api/events/${encodeURIComponent(eventId)}`;
      const response = statusOnly
        ? await consoleFetch(`${base}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { signal: controller.signal })
        : await consoleFetch(`${base}/commands`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
            body: JSON.stringify({ commandId: attempt.commandId, command: attempt.command, payload: attempt.payload }) });
      const body = record(await response.json().catch(() => null));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (statusOnly) {
        if (response.ok && body?.status === "APPLIED" && body.command === attempt.command) await finish(attempt);
        else setError("서버 처리 결과를 아직 확인하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.");
        return;
      }
      if (!response.ok) {
        const staleReview = attempt.command === "check.reconcile" && response.status === 409 && body?.code === "ATTENDANCE_RECONCILIATION_CHANGED";
        if ((!staleReview && previous) || response.status >= 500 || [408, 425, 429].includes(response.status)) { uncertain(); return; }
        abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
        if (staleReview) { attemptRef.current = null; setPending(null); }
        if (response.status === 409 && ["REVIEWED_EXIT_CHANGED", "REVIEWED_EXIT_AMBIGUOUS", "ATTENDANCE_RECONCILIATION_CHANGED"].includes(text(body?.code))) { setSnapshot(null); setConfirmed(false); }
        setError(text(body?.error) || (isReconcile ? "출입 확인을 저장하지 못했습니다." : "퇴장 기록을 저장하지 못했습니다.")); return;
      }
      const result = record(attempt.command === "check.reconcile" ? body?.reconciliation : body?.exitReview);
      const matches = attempt.command === "check.reconcile"
        ? result && result.participantId === participantId && result.checkId === attempt.payload.checkId && result.id === attempt.commandId &&
          result.action === attempt.payload.action && result.inside === (attempt.payload.action === "IN") && result.everIn === true
        : result && result.participantId === participantId && result.entryId === attempt.payload.entryId && result.exitId === attempt.commandId && result.action === "OUT";
      if (!matches) { uncertain(); return; }
      await finish(attempt);
    } catch (cause) {
      if (statusOnly) setError("서버 처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.");
      else if (!previous && isOrganizationContextBlock(cause)) setError("현재 조직을 확인한 뒤 다시 시도하세요.");
      else uncertain();
    } finally {
      window.clearTimeout(timer); requestRef.current = null;
      if (activeRef.current) setBusy(false);
    }
  }

  return <ConsoleDialog title={isReconcile ? "출입 상태 확인 및 복구" : "확인 후 퇴장 기록"} description={isReconcile ? "최근 출입 기록과 실제 현장 상태가 일치할 때 복구합니다." : "일반 퇴장 처리가 어려운 경우 현장 책임자가 실제 퇴장을 확인합니다."} onClose={onClose} canClose={canClose} busy={busy || (isReconcile && loading)} stickyChrome={isReconcile}
    footer={isReconcile && pending ? undefined : <ConsoleFormActions>{!isReconcile ? <ProductButton type="button" className="button button-secondary" disabled={busy || loading} onClick={() => { if (canClose()) onClose(); }}>닫기</ProductButton> : null}
      {!pending ? <ProductButton type="button" className="button button-primary" disabled={!snapshot || !confirmed || !reason.trim() || busy || dismiss || operator.changed} onClick={() => void execute()}>{busy ? "확인 중…" : isReconcile ? "출입 상태 복구" : "퇴장 기록"}</ProductButton> : null}</ConsoleFormActions>}>
    <div className={`${uiStyles.formStack} ${styles.reviewBody}`}>
      <p>{isReconcile ? "새로운 입·퇴장 기록은 만들지 않으며 참가 승인, 티켓, 결제와 경품은 변경하지 않습니다." : "참가 승인, 티켓, 결제와 경품 상태는 변경하지 않습니다. 실제 퇴장한 경우에만 기록하세요."}</p>
      {operator.changed ? <ConsoleFeedback kind="warning">운영 조직을 확인한 뒤 계속하세요.</ConsoleFeedback> : null}
      {loading ? <p role="status">{isReconcile ? "최신 참가자와 출입 기록을 확인하고 있습니다." : "최신 참가자와 입장 기록을 확인하고 있습니다."}</p> : null}
      {busy ? <p role="status">{isReconcile ? "출입 확인의 처리 결과를 확인하고 있습니다." : "퇴장 기록의 처리 결과를 확인하고 있습니다."}</p> : null}
      {error ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
      {!snapshot && !loading && !pending ? <ProductButton ref={reloadRef} type="button" className="button button-secondary" disabled={operator.changed} onClick={() => void readLatest()}>최신 기록 다시 확인</ProductButton> : null}
      {snapshot ? <>
        <section aria-label={isReconcile ? "확인할 참가자와 출입 기록" : "확인할 참가자와 입장 기록"}>
          <h3>확인할 참가자</h3>
          <p><strong>{snapshot.expected.name}</strong>{snapshot.expected.company ? ` · ${snapshot.expected.company}` : " · 소속 없음"} · <span className={styles.reviewedExitFact}>{maskedPhone(snapshot.expected.phone)}</span></p>
          <p>참가 상태 {statusLabel(snapshot.expected.status)}{!isReconcile ? <> · {paymentLabel(snapshot.expected.paymentStatus)} · <span className={styles.reviewedExitFact}>{({ valid: "티켓 유효", expired: "티켓 만료", revoked: "티켓 철회", cancelled: "티켓 취소" } as Record<string, string>)[snapshot.ticketReview] || "티켓 확인 필요"}</span></> : null}</p>
          {isReconcile ? <dl className={styles.reconciliationFacts}>
            <div><dt>현재 명단</dt><dd>{snapshot.beforeInside === null ? "출입 확인 필요" : snapshot.beforeInside ? "입장 중" : "입장 중 아님"} · 누적 입장 {snapshot.beforeEver === null ? "확인 필요" : snapshot.beforeEver ? "기록됨" : "기록 없음"}</dd></div>
            <div><dt>최근 기록</dt><dd>{snapshot.action === "IN" ? "입장" : "퇴장"} · {formatTime(snapshot.enteredAt)}{snapshot.deskName ? ` · ${snapshot.deskName}` : ""}</dd></div>
            <div><dt>복구 후</dt><dd><strong>{snapshot.action === "IN" ? "입장 중" : "퇴장"}</strong> · 누적 입장에 포함</dd></div>
          </dl> : <p>최근 입장 {formatTime(snapshot.enteredAt)}{snapshot.deskName ? ` · ${snapshot.deskName}` : ""}</p>}
          {snapshot.entryName && snapshot.entryName !== snapshot.expected.name ? <p>{isReconcile ? "출입 기록의 이름" : "입장 기록의 이름"}: {snapshot.entryName}</p> : null}
          {isReconcile ? <p>실제 위치가 최근 기록과 다르면 복구하지 말고 현장 기록을 추가로 확인하세요.</p> : null}
        </section>
        <label htmlFor="reviewed-exit-reason">확인 사유 (필수)</label>
        <textarea id="reviewed-exit-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={300} rows={3} disabled={busy || dismiss || Boolean(pending)} placeholder={isReconcile ? "누가 어떻게 실제 현장 상태를 확인했는지 입력하세요." : "누가 어떻게 실제 퇴장을 확인했는지 입력하세요."} />
        <div className="checkbox-field"><label className={styles.reviewConfirmation} htmlFor="reviewed-exit-confirm"><input id="reviewed-exit-confirm" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || dismiss || Boolean(pending)} /><span className={styles.reviewConfirmationText}>{isReconcile ? snapshot.action === "IN" ? "이 참가자가 현재 행사장 안에 있음을 확인했습니다." : "이 참가자가 현재 행사장 밖에 있음을 확인했습니다." : "이 참가자가 실제로 퇴장한 것을 확인했습니다."}</span></label></div>
      </> : null}
      {pending ? <section aria-label={isReconcile ? "출입 상태 복구 처리 확인" : "퇴장 기록 처리 확인"}><p>원래 대상과 사유를 유지합니다. 서버 확인은 새 기록을 만들지 않습니다.</p>
        <ProductButton ref={recoveryRef} type="button" className="button button-secondary" disabled={busy || dismiss || operator.changed} onClick={() => void execute(true)}>서버 처리 확인</ProductButton>{" "}
        <ProductButton type="button" className="button button-secondary" disabled={busy || dismiss || operator.changed} onClick={() => void execute()}>같은 요청 다시 시도</ProductButton>
      </section> : null}
      {dismiss ? <ConsoleConfirm summary={pending ? (isReconcile ? "출입 확인 결과를 아직 확인하지 못했습니다. 닫은 뒤 처리 결과 확인에서 확인해야 합니다." : "퇴장 기록 결과를 아직 확인하지 못했습니다. 닫은 뒤 처리 결과 확인에서 확인해야 합니다.") : (isReconcile ? "작성한 출입 확인 사유가 사라집니다." : "작성한 퇴장 확인 사유가 사라집니다.")}
        confirmLabel="내용 확인 후 닫기" cancelLabel="계속 작업" onConfirm={onClose} onCancel={() => setDismiss(false)} /> : null}
    </div>
  </ConsoleDialog>;
}
