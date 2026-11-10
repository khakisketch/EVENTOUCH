"use client";

import { useEffect, useRef, useState } from "react";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { cancellationProofMatches } from "../../../../../lib/bulk-cancel-proof";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import styles from "./participants.module.css";

type Target = { id: string; name: string; status: string; inside: boolean; company: string; phone: string };
type ReviewedTarget = Target & { paidPaymentIds: string[] };
type Attempt = { commandId: string; targets: ReviewedTarget[] };
type Conflict = { before: Array<Target & { paidPaymentIds: string[] | null }>; latest: ReviewedTarget[] | null };
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function id() { return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
function statusLabel(value: string): string {
  return ({ APPROVED: "참가 확정", PENDING: "승인 대기", WAITLIST: "대기 명단", CANCELLED: "신청 취소" } as Record<string, string>)[value] ?? "상태 확인 필요";
}
function maskPhone(value: unknown): string {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length >= 8 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : "연락처 확인 필요";
}
function expectedTargets(targets: ReviewedTarget[]) {
  return targets.map(({ id, status, inside, paidPaymentIds }) => ({ id, status, inside, paidPaymentIds: [...paidPaymentIds].sort() }));
}
async function boundedJson(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    const request = (async () => {
      const response = await consoleFetch(url, { ...init, signal: controller.signal });
      return { response, body: record(await response.json().catch(() => null)) };
    })();
    return await Promise.race([request, aborted]);
  } finally { window.clearTimeout(timer); }
}

export default function BulkCancelDialog({ eventId, targets, onClose, onRefresh, onResolved }: {
  eventId: string; targets: Target[]; onClose: () => void; onRefresh: () => Promise<boolean>; onResolved: (ids: string[]) => void;
}) {
  const [reviewed, setReviewed] = useState<ReviewedTarget[] | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const pendingRef = useRef<Attempt | null>(null);
  const readRef = useRef<AbortController | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [dismiss, setDismiss] = useState(false);
  const active = useRef(true);
  const operator = useOperatorContextSnapshot();
  useConsoleDraftGuard(Boolean(pending) || busy, "선택한 참가자의 취소 처리 결과가 아직 확인되지 않았습니다.");
  useEffect(() => {
    active.current = true;
    void readReview(true);
    return () => { active.current = false; readRef.current?.abort(); readRef.current = null; };
  }, [eventId]);
  useEffect(() => pending ? manageOperatorReceipt(pending.commandId) : undefined, [pending]);

  function canClose() { if (busyRef.current) return false; if (pendingRef.current) { setDismiss(true); return false; } return true; }
  async function readReview(first = false) {
    if (readRef.current || busyRef.current || operator.changed) return;
    const controller = new AbortController(); readRef.current = controller; setReading(true); setError("");
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
      const read = (async () => {
        const [meResponse, bootResponse] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store", signal: controller.signal }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [me, boot] = await Promise.all([meResponse.json(), bootResponse.json()]);
        return { meResponse, bootResponse, me: record(me), boot: record(boot) };
      })();
      const { meResponse, bootResponse, me, boot } = await Promise.race([read, aborted]);
      const user = record(me?.user), state = record(boot?.state), workspaces = record(state?.workspaces), workspace = record(workspaces?.[eventId]);
      const event = Array.isArray(state?.events) ? state.events.map(record).find((entry) => entry?.id === eventId) : null;
      const memberships = Array.isArray(state?.memberships) ? state.memberships.flatMap((value) => {
        const item = record(value); return item && typeof item.accountId === "string" && typeof item.eventId === "string"
          ? [{ accountId: item.accountId, eventId: item.eventId, write: item.write }] : [];
      }) : null;
      if (!meResponse.ok || !bootResponse.ok || !user || typeof user.id !== "string" || typeof user.role !== "string" || !memberships ||
          !event || typeof event.stage !== "string" || ["ENDED", "ARCHIVED"].includes(event.stage.toUpperCase()) ||
          !canWriteEvent({ role: user.role, userId: user.id, memberships, eventId }, "participant.bulk-cancel") ||
          !workspace || workspace.paymentReviewAvailable !== true || !Array.isArray(workspace.participants) || !Array.isArray(workspace.payments)) throw new Error("incomplete");
      const payments = workspace.payments.map(record);
      if (payments.some((payment) => !payment || typeof payment.participantId !== "string" || !payment.participantId ||
          typeof payment.status !== "string" || !payment.status || (payment.status === "PAID" && (typeof payment.id !== "string" || !payment.id || payment.id.length > 120)))) throw new Error("incomplete payment");
      const latest = targets.map((target): ReviewedTarget => {
        const matches = (workspace.participants as unknown[]).map(record).filter((person) => person?.id === target.id);
        const person = matches.length === 1 ? matches[0] : null;
        if (!person || typeof person.name !== "string" || typeof person.status !== "string" ||
            !["PENDING", "APPROVED", "WAITLIST", "CANCELLED"].includes(person.status.toUpperCase()) || typeof person.inside !== "boolean") throw new Error("incomplete participant");
        return { id: target.id, name: person.name, status: person.status.toUpperCase(), inside: person.inside,
          company: typeof person.company === "string" ? person.company : "", phone: maskPhone(person.phone),
          paidPaymentIds: payments.filter((payment) => payment?.participantId === target.id && payment.status === "PAID").map((payment) => payment!.id as string).sort() };
      });
      if (!active.current || controller.signal.aborted || readRef.current !== controller) return;
      if ((first && !reviewed && !conflict && !latest.some((person, index) => person.status !== targets[index].status || person.inside !== targets[index].inside)) ||
          (!first && !conflict && reviewed && JSON.stringify(expectedTargets(latest)) === JSON.stringify(expectedTargets(reviewed)))) {
        setReviewed(latest); setConflict(null);
      } else {
        const before = conflict?.before ?? reviewed ?? targets.map((target) => ({ ...target, paidPaymentIds: null }));
        setConflict({ before, latest });
      }
    } catch {
      if (active.current && readRef.current === controller) setError("최신 참가자와 결제 내역을 확인하지 못했습니다. 연결과 행사 접근 권한을 확인한 뒤 다시 시도하세요.");
    } finally {
      window.clearTimeout(timeout);
      if (readRef.current === controller) { readRef.current = null; if (active.current) setReading(false); }
    }
  }
  async function finish(attempt: Attempt) {
    let refreshed = false;
    let timer = 0;
    try { refreshed = await Promise.race([onRefresh(), new Promise<false>((resolve) => { timer = window.setTimeout(() => resolve(false), 12000); })]); }
    finally { window.clearTimeout(timer); }
    if (!refreshed || !active.current) {
      if (active.current) { pendingRef.current = attempt; setPending(attempt); setError("처리는 확인됐지만 목록을 갱신하지 못했습니다. 다시 확인하세요."); }
      return;
    }
    acknowledgeOperatorReceipt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
    pendingRef.current = null; setPending(null); onResolved(attempt.targets.map((target) => target.id));
  }
  async function execute(retry: boolean) {
    if (busyRef.current || operator.changed || reading || conflict) return;
    const attempt = retry ? pendingRef.current : reviewed ? { commandId: id(), targets: reviewed.map((target) => ({ ...target, paidPaymentIds: [...target.paidPaymentIds] })) } : null;
    if (!attempt || !attempt.targets.length || (!retry && attempt.targets.some((target) => target.inside || target.status === "CANCELLED"))) return;
    const uncertainBefore = retry && pendingRef.current?.commandId === attempt.commandId;
    const mark = () => { pendingRef.current = attempt; setPending(attempt); setError("처리 결과를 확인하지 못했습니다. 서버 확인 또는 같은 요청 다시 시도를 선택하세요."); };
    busyRef.current = true; setBusy(true); setError("");
    try {
      const payload = { ids: attempt.targets.map((target) => target.id), status: "CANCELLED", expectedCancellations: expectedTargets(attempt.targets), requireRosterRefresh: true };
      const { response, body } = await boundedJson(`/api/events/${encodeURIComponent(eventId)}/commands`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, command: "participant.bulk-cancel", payload }) });
      if (!active.current) return;
      if (!response.ok) {
        if (response.status === 409 && body?.code === "CANCELLATION_REVIEW_CHANGED") {
          abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
          pendingRef.current = null; setPending(null); setReviewed(null);
          setConflict({ before: attempt.targets, latest: null });
          setError(""); window.requestAnimationFrame(() => document.getElementById("cancel-conflict-heading")?.focus());
          return;
        }
        if (uncertainBefore || response.status >= 500 || [408, 425, 429].includes(response.status)) { mark(); return; }
        setError(typeof body?.error === "string" ? body.error : "선택한 참가자를 취소하지 못했습니다."); return;
      }
      if (!cancellationProofMatches(payload, body)) { mark(); return; }
      pendingRef.current = attempt; await finish(attempt);
    } catch (failure) {
      if (!active.current) return;
      if (!uncertainBefore && !pendingRef.current && isOrganizationContextBlock(failure)) setError("현재 조직을 확인한 뒤 다시 시도하세요. 요청은 보내지 않았습니다.");
      else mark();
    } finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  async function check() {
    const attempt = pendingRef.current; if (!attempt || busyRef.current || operator.changed) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const { response, body } = await boundedJson(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      if (!active.current) return;
      if (response.ok && body?.status === "APPLIED" && body.command === "participant.bulk-cancel") setError("서버에 취소 요청 기록이 있습니다. 같은 요청을 다시 시도해 원래 대상의 처리 결과를 확인하세요.");
      else setError(response.ok && body?.status === "UNCONFIRMED" ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요." : "서버 처리 결과를 확인하지 못했습니다. 접근 권한과 연결을 확인하세요.");
    } catch { if (active.current) setError("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다."); }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  const show = conflict?.latest ?? reviewed;
  const canProceed = Boolean(reviewed && !conflict && !reading && !pending && !error && reviewed.every((target) => target.status !== "CANCELLED" && !target.inside));
  const paidCount = show?.reduce((count, target) => count + target.paidPaymentIds.length, 0) ?? 0;
  const paidPeople = show?.filter((target) => target.paidPaymentIds.length > 0).length ?? 0;
  const entries = (list: ReviewedTarget[]) => list.map((target) => <li key={target.id}><strong>{target.name}</strong>{target.company ? ` · ${target.company}` : ""} · {target.phone} · {statusLabel(target.status)}{target.inside ? " · 입장 중" : ""}{target.paidPaymentIds.length ? ` · 환불 요청 ${target.paidPaymentIds.length}건` : ""}</li>);
  return <ConsoleDialog title="선택한 신청 취소" description={`현재 필터에서 선택한 ${targets.length}명의 신청을 취소합니다.`} onClose={onClose} busy={busy} canClose={canClose} footer={<ConsoleFormActions>
    <button type="button" className="button button-secondary" disabled={busy} onClick={() => { if (canClose()) onClose(); }}>닫기</button>
    {!pending ? <button type="button" className="button button-primary" disabled={busy || operator.changed || !canProceed} onClick={() => void execute(false)}>신청 취소</button> : null}
  </ConsoleFormActions>}>
    {reading ? <p role="status">선택한 참가자와 결제 내역을 확인하고 있습니다.</p> : null}
    {conflict ? <section className={styles.editRecovery} aria-labelledby="cancel-conflict-heading"><h3 id="cancel-conflict-heading" tabIndex={-1}>선택한 참가자 정보가 변경됐습니다</h3>
      <p>아직 취소하지 않았습니다. 선택한 {targets.length}명을 유지하며 최신 상태를 확인하세요.</p>
      {conflict.latest ? <>
        <ul>{conflict.latest.filter((target, index) => {
          const before = conflict.before[index]; return before.status !== target.status || before.inside !== target.inside ||
            (before.paidPaymentIds !== null && JSON.stringify([...before.paidPaymentIds].sort()) !== JSON.stringify(target.paidPaymentIds));
        }).map((target) => { const before = conflict.before.find((item) => item.id === target.id)!; return <li key={target.id}><strong>{target.name}</strong> · {statusLabel(before.status)} → {statusLabel(target.status)}{before.inside !== target.inside ? ` · ${before.inside ? "입장 중" : "입장 중 아님"} → ${target.inside ? "입장 중" : "입장 중 아님"}` : ""}{before.paidPaymentIds !== null && JSON.stringify([...before.paidPaymentIds].sort()) !== JSON.stringify(target.paidPaymentIds) ? ` · 환불 요청 대상 ${before.paidPaymentIds.length}건 → ${target.paidPaymentIds.length}건` : ""}</li>; })}</ul>
        <p>확인만으로 취소하지 않습니다.</p>
        {conflict.latest.some((target) => target.status === "CANCELLED") ? <p>이미 취소된 참가자가 있습니다. 명단으로 돌아가 대상을 다시 선택하세요.</p> :
          <button type="button" className="button button-secondary" disabled={busy || reading} onClick={() => { setReviewed(conflict.latest); setConflict(null); setError(""); }}>최신 상태로 다시 검토</button>}
      </> : <button type="button" className="button button-secondary" disabled={reading || busy} onClick={() => void readReview()}>{reading ? "최신 명단 확인 중…" : "최신 명단 확인"}</button>}
    </section> : null}
    {show ? <>
      <p><strong>취소 대상 {show.length}명</strong> · 환불 요청으로 바뀔 결제 {paidCount}건 ({paidPeople}명)</p>
      <ul>{entries(show.slice(0, 5))}</ul>
      {show.length > 5 ? <details><summary>나머지 {show.length - 5}명 보기</summary><ul>{entries(show.slice(5))}</ul></details> : null}
      {show.some((target) => target.inside) ? <div role="note"><p>입장 중인 참가자가 있습니다. 먼저 퇴장 처리한 뒤 최신 명단을 다시 확인하세요.</p>{!conflict ? <button type="button" className="button button-secondary" disabled={busy || reading} onClick={() => void readReview()}>최신 명단 확인</button> : null}</div> : null}
    </> : null}
    <p>발급된 티켓은 무효화되며 결제 완료 건은 환불 요청 상태로 바뀝니다.</p>
    {error && !pending ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
    {error && !pending && !conflict && !reading ? <button type="button" className="button button-secondary" onClick={() => void readReview(true)}>대상 다시 확인</button> : null}
    {conflict?.latest?.some((target) => target.status === "CANCELLED") ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => { void onRefresh().then((ok) => { if (ok && active.current) onClose(); else if (active.current) setError("최신 명단을 불러오지 못했습니다. 다시 시도하세요."); }); }}>명단에서 다시 선택</button> : null}
    {pending ? <section className={styles.editRecovery} aria-labelledby="bulk-cancel-recovery"><h3 id="bulk-cancel-recovery">신청 취소 처리 확인 필요</h3>
      <p>원래 선택한 {pending.targets.length}명의 요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className={styles.editActions}><button type="button" className="button button-secondary" disabled={busy || operator.changed} onClick={() => void check()}>서버 처리 확인</button>
      <button type="button" className="button button-secondary" disabled={busy || operator.changed} onClick={() => void execute(true)}>같은 요청 다시 시도</button></div>
    </section> : null}
    {dismiss ? <ConsoleConfirm summary="신청 취소가 이미 반영됐을 수 있습니다. 닫은 뒤 화면의 처리 결과 확인에서 확인하세요." confirmLabel="닫기" onConfirm={onClose} onCancel={() => setDismiss(false)} /> : null}
  </ConsoleDialog>;
}
