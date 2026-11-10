"use client";

import { useEffect, useRef, useState } from "react";
import { consoleFetch } from "../../../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, waitForOperatorReceiptIdle } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./participants.module.css";

type Snapshot = { id: string; name: string; company: string; phone: string; status: string; paymentStatus: string; inside: boolean | null; fingerprint: string };
type Attempt = { commandId: string; payload: { id: string; fingerprint: string; reason: string; confirmed: true } };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";
const statusLabel = (value: string) => ({ APPROVED: "참가 확정", PENDING: "승인 대기", WAITLIST: "대기 명단" } as Record<string, string>)[value] || "확인 필요";
const paymentLabel = (value: string) => ({ FREE: "무료", PAID: "결제 완료", PENDING: "결제 대기", REFUND_REQUESTED: "환불 요청" } as Record<string, string>)[value] || "확인 필요";
const maskPhone = (value: string) => { const d = value.replace(/\D/g, ""); return d.length >= 9 && d.length <= 15 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : "연락처 확인 필요"; };

export default function CancellationConflictReview({ eventId, participantId, onRefresh, onClose, onDone }: {
  eventId: string; participantId: string; onRefresh: () => Promise<boolean>; onClose: () => void; onDone: () => void;
}) {
  const operator = useOperatorContextSnapshot();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Attempt | null>(null);
  const [dismiss, setDismiss] = useState(false);
  const active = useRef(true), request = useRef<AbortController | null>(null), attemptRef = useRef<Attempt | null>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  useConsoleDraftGuard(Boolean(reason.trim()) || Boolean(pending) || busy, pending || busy ? "참가 취소 기록 확인의 처리 결과를 아직 확인하지 못했습니다." : "작성한 확인 사유가 있습니다.");
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  useEffect(() => pending ? manageOperatorReceipt(pending.commandId) : undefined, [pending]);
  useEffect(() => { if (!busy && pending) retryRef.current?.focus(); }, [busy, pending]);

  async function readLatest() {
    if (request.current || operator.changed) return;
    const controller = new AbortController(); request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setLoading(true); setError(""); setSnapshot(null); setConfirmed(false);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const body = record(await response.json().catch(() => null));
      const state = record(body?.state), workspace = record(record(state?.workspaces)?.[eventId]);
      const people = Array.isArray(workspace?.participants) ? workspace.participants.map(record).filter(person => person?.id === participantId) : [];
      const person = people[0], fingerprint = text(person?.cancellationConflictReview);
      if (!response.ok || people.length !== 1 || !person || person.cancelled !== true ||
          !["APPROVED", "PENDING", "WAITLIST"].includes(text(person.status)) || !/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw new Error("취소 기록이나 참가자 정보를 확인할 수 없습니다. 최신 명단을 확인하거나 시스템 관리자에게 문의하세요.");
      }
      if (!active.current || controller.signal.aborted) return;
      setSnapshot({ id: participantId, name: text(person.name), company: text(person.company), phone: text(person.phone),
        status: text(person.status), paymentStatus: text(person.paymentStatus), inside: typeof person.inside === "boolean" ? person.inside : null, fingerprint });
    } catch (cause) {
      if (active.current) setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "최신 참가자 정보를 불러오지 못했습니다. 다시 확인하세요.");
    } finally { window.clearTimeout(timer); request.current = null; if (active.current) setLoading(false); }
  }
  useEffect(() => { void readLatest(); /* the mounted dialog owns this event and participant */ }, [eventId, participantId]);

  function canClose() {
    if (busy || loading || request.current) return false;
    if (pending || reason.trim()) { setDismiss(true); return false; }
    return true;
  }
  async function finish(attempt: Attempt) {
    if (!await onRefresh() || !active.current) {
      if (active.current) { attemptRef.current = attempt; setPending(attempt); setError("처리는 확인됐지만 최신 명단을 불러오지 못했습니다. 같은 요청을 다시 확인하세요."); }
      return;
    }
    await waitForOperatorReceiptIdle(attempt.commandId);
    if (!active.current) return;
    if (!forgetOperatorReceipt(attempt.commandId)) {
      attemptRef.current = attempt; setPending(attempt); setError("처리 확인 항목을 정리하지 못했습니다. 같은 요청을 다시 확인하세요."); return;
    }
    acknowledgeOperatorReceipt(attempt.commandId);
    attemptRef.current = null; setPending(null); onDone();
  }
  async function submit() {
    if (busy || request.current || operator.changed) return;
    const prior = attemptRef.current;
    if (!prior && (!snapshot || !confirmed || !reason.trim())) { setError("참가 의사를 확인하고 확인 사유를 입력하세요."); return; }
    const attempt = prior ?? { commandId: crypto.randomUUID(), payload: { id: participantId, fingerprint: snapshot!.fingerprint, reason: reason.trim(), confirmed: true as const } };
    const controller = new AbortController(); request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setBusy(true); setError("");
    const uncertain = () => { attemptRef.current = attempt; setPending(attempt); setError("처리 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요."); };
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, command: "participant.resolve-cancellation-conflict", payload: attempt.payload }) });
      const body = record(await response.json().catch(() => null));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        const definite = response.status === 409 && ["CANCELLATION_CONFLICT_REVIEW_CHANGED", "CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE"].includes(text(body?.code));
        if ((!definite && prior) || response.status >= 500 || [408, 425, 429].includes(response.status)) { uncertain(); return; }
        abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
        attemptRef.current = null; setPending(null);
        if (definite) { setSnapshot(null); setConfirmed(false); }
        setError(response.status === 400 && (body?.field === "command" || body?.error === "지원하지 않는 참가자 작업입니다")
          ? "현재 서버에서는 취소 기록을 확인할 수 없습니다. 시스템 관리자에게 서버 업데이트를 문의하세요."
          : text(body?.error) || "참가 취소 기록을 확인하지 못했습니다."); return;
      }
      const review = record(body?.review);
      if (!review || review.participantId !== participantId || review.resolutionId !== attempt.commandId || review.ticketRevoked !== true || review.status !== snapshot?.status ||
          review.reviewedName !== snapshot?.name.trim().slice(0, 60) || review.reviewedCompany !== snapshot?.company.trim().slice(0, 100) || review.reviewedMaskedPhone !== maskPhone(snapshot?.phone ?? "")) { uncertain(); return; }
      await finish(attempt);
    } catch (cause) {
      if (!prior && isOrganizationContextBlock(cause)) setError("현재 조직을 확인한 뒤 다시 시도하세요.");
      else uncertain();
    } finally { window.clearTimeout(timer); request.current = null; if (active.current) setBusy(false); }
  }

  return <ConsoleDialog title="참가 취소 기록 확인" description="참가자의 실제 의사를 확인한 뒤 기록을 정리합니다." onClose={onClose} canClose={canClose} busy={busy || loading}
    footer={<ConsoleFormActions><button type="button" className="button button-secondary" disabled={busy || loading} onClick={() => { if (canClose()) onClose(); }}>닫기</button>
      {!pending ? <button type="button" className="button button-primary" disabled={!snapshot || snapshot.inside !== false || !confirmed || !reason.trim() || busy || dismiss || operator.changed} onClick={() => void submit()}>{busy ? "저장 중…" : "확인 내용 저장"}</button> : null}</ConsoleFormActions>}>
    <div className={`${uiStyles.formStack} ${styles.reviewBody}`}>
      <p>취소하지 않고 참가하기로 확인된 경우에만 진행하세요. 기존 티켓과 QR은 사용할 수 없으며, 필요하면 확인 후 새 티켓을 발급해 전달해야 합니다.</p>
      <p>확인 사유와 담당자는 운영 활동에 기록됩니다.</p>
      {operator.changed ? <ConsoleFeedback kind="warning">운영 조직을 확인한 뒤 계속하세요.</ConsoleFeedback> : null}
      {loading ? <p role="status">최신 참가자 정보를 확인하고 있습니다.</p> : null}
      {busy ? <p role="status">확인 내용을 저장하고 있습니다.</p> : null}
      {error ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
      {!snapshot && !loading && !pending ? <button type="button" className="button button-secondary" disabled={operator.changed} onClick={() => void readLatest()}>최신 정보 다시 확인</button> : null}
      {snapshot ? <>
        <section aria-label="확인할 참가자"><h3>확인할 참가자</h3>
          <p><strong>{snapshot.name}</strong> · {snapshot.company || "소속 없음"} · {maskPhone(snapshot.phone)}</p>
          <p>신청 상태 {statusLabel(snapshot.status)} · {paymentLabel(snapshot.paymentStatus)} · {snapshot.inside === null ? "출입 확인 필요" : snapshot.inside ? "입장 중" : "입장 중 아님"}</p>
          <p>취소 기록이 남아 있어 기존 티켓을 사용할 수 없습니다.</p>
          {snapshot.inside !== false ? <p role="note">출입 상태를 확인하고 입장 중이면 퇴장 기록을 먼저 처리하세요.</p> : null}
        </section>
        {!pending ? <><label htmlFor="cancellation-conflict-reason">확인 사유 (필수)</label>
          <textarea id="cancellation-conflict-reason" rows={3} maxLength={300} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} style={{ resize: "none" }} placeholder="언제 누구에게 참가 의사를 확인했는지 입력하세요." />
          <div className="checkbox-field"><label className={styles.reviewConfirmation} htmlFor="cancellation-conflict-confirm"><input id="cancellation-conflict-confirm" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} /><span className={styles.reviewConfirmationText}>참가자가 취소하지 않고 참가하기로 확인했습니다.</span></label></div></> : null}
      </> : null}
      {pending ? <section aria-label="처리 결과 확인"><p>처음 확인한 대상과 사유를 유지해 같은 요청을 확인합니다.</p>
        <button ref={retryRef} type="button" className="button button-primary" disabled={busy || operator.changed} onClick={() => void submit()}>같은 요청 다시 확인</button></section> : null}
      {dismiss ? <ConsoleConfirm summary={pending ? "닫은 뒤 처리 결과 확인에서 요청 기록을 확인할 수 있습니다. 참가자 명단도 다시 확인하세요." : "작성한 확인 사유가 사라집니다. 닫을까요?"} confirmLabel="닫기" onConfirm={onClose} onCancel={() => setDismiss(false)} /> : null}
    </div>
  </ConsoleDialog>;
}
