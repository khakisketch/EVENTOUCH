"use client";
import ProductButton from "../../../../ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import { consoleFetch } from "../../../../../lib/console-api";
import { acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, operatorReceipts, subscribeOperatorReceipts } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import styles from "./participants.module.css";

export default function TicketReissue({ eventId, slug, person, resumeCommandId, onRefresh, onIssued, onClose }: {
  eventId: string; slug: string; person: { id: string; name: string; ticketRevision: number };
  resumeCommandId?: string;
  onRefresh: () => Promise<boolean>; onIssued: (ticketRevision: number) => void; onClose: () => void;
}) {
  const operator = useOperatorContextSnapshot();
  const [phase, setPhase] = useState<"confirm" | "pending" | "applied" | "issued" | "superseded" | "changed">(resumeCommandId ? "applied" : "confirm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [recoverable, setRecoverable] = useState(false);
  const [dismiss, setDismiss] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const attempt = useRef<string | null>(resumeCommandId ?? null);
  const request = useRef<AbortController | null>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const recoveryAction = useRef<HTMLButtonElement>(null);
  const manualCopy = useRef<HTMLDetailsElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const unresolved = phase === "pending" || phase === "applied";
  const reviewRequired = phase === "changed" || phase === "superseded";
  useConsoleDraftGuard((busy && !reviewRequired) || unresolved || (phase === "issued" && !recoverable && !copied),
    phase === "issued" ? "티켓 링크를 아직 보관하지 못했습니다." : "티켓 재발급 결과를 아직 확인하지 못했습니다.");
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => (unresolved || phase === "issued") && attempt.current ? manageOperatorReceipt(attempt.current) : undefined, [phase, unresolved]);
  useEffect(() => {
    if (phase !== "issued") return;
    const update = () => setRecoverable(Boolean(attempt.current && operatorReceipts().some((item) => item.commandId === attempt.current)));
    update();
    return subscribeOperatorReceipts(update);
  }, [phase]);
  useEffect(() => {
    if (busy) return;
    if (phase === "issued") copyButton.current?.focus();
    else if (unresolved || reviewRequired) recoveryAction.current?.focus();
  }, [busy, phase, unresolved, reviewRequired]);

  function canClose() {
    if (busy || request.current) return false;
    if (!unresolved && !(phase === "issued" && !recoverable && !copied)) return true;
    setDismiss(true);
    return false;
  }

  async function run(statusOnly = false) {
    if (request.current || operator.changed) return;
    const prior = attempt.current;
    if (statusOnly && !prior) return;
    const commandId = prior ?? (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const base = `/api/events/${encodeURIComponent(eventId)}`;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const uncertain = () => {
      attempt.current = commandId;
      setPhase("pending");
      setError("재발급 결과를 확인하지 못했습니다. 서버 처리 여부를 확인하거나 같은 요청으로 링크를 받아 보세요.");
    };
    try {
      const response = statusOnly
        ? await consoleFetch(`${base}/command-receipts/${encodeURIComponent(commandId)}`, { signal: controller.signal })
        : await consoleFetch(`${base}/commands`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
            body: JSON.stringify({ commandId, command: "ticket.reissue-reviewed", payload: { id: person.id, expectedTicketRevision: person.ticketRevision } }) });
      const body = await response.json().catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (statusOnly) {
        if (response.ok && body?.status === "APPLIED" && body.command === "ticket.reissue-reviewed") setPhase("applied");
        else setError("서버의 처리 결과를 아직 확인하지 못했습니다.");
        return;
      }
      if (response.status === 409 && (body?.code === "TICKET_RESULT_SUPERSEDED" || body?.code === "TICKET_REVISION_CHANGED" || body?.code === "TICKET_STATUS_CONFLICT")) {
        forgetOperatorReceipt(commandId);
        attempt.current = null;
        setPhase(body.code === "TICKET_RESULT_SUPERSEDED" ? "superseded" : "changed");
        return;
      }
      if (!response.ok) {
        if (prior && response.status === 403) {
          uncertain();
          setError("현재 권한으로 링크를 확인할 수 없습니다. 원래 요청은 확인 목록에 보관됩니다. 행사 담당자에게 권한을 확인하세요.");
        }
        else if (prior || response.status >= 500 || [408, 425, 429].includes(response.status)) uncertain();
        else if (response.status === 400 && (body?.field === "command" || body?.error === "지원하지 않는 참가자 작업입니다")) {
          setError("현재 서버에서는 티켓 상태를 확인해 재발급할 수 없습니다. 시스템 관리자에게 업데이트를 문의하세요.");
        }
        else setError(typeof body?.error === "string" ? body.error : "티켓을 재발급하지 못했습니다.");
        return;
      }
      const ticket = body?.participant?.ticket;
      const prefix = `ET:${eventId}:T-`;
      if (body?.ticketRevision !== person.ticketRevision + 1 || body?.participant?.id !== person.id ||
          typeof ticket !== "string" || !ticket.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(ticket.slice(prefix.length))) {
        uncertain();
        return;
      }
      const publicBase = typeof body.ticketPublicBase === "string" ? body.ticketPublicBase : window.location.origin;
      const url = new URL(`${publicBase}/event/${encodeURIComponent(slug)}/ticket`);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
        uncertain();
        return;
      }
      url.searchParams.set("ticket", ticket);
      setLink(url.toString());
      acknowledgeOperatorReceipt(commandId);
      attempt.current = commandId;
      setRecoverable(operatorReceipts().some((item) => item.commandId === commandId));
      onIssued(body.ticketRevision);
      setPhase("issued");
    } catch (cause) {
      if (statusOnly) setError("서버 처리 결과를 확인하지 못했습니다. 같은 요청으로 링크를 받을 수 있습니다.");
      else if (!prior && isOrganizationContextBlock(cause)) setError("현재 조직을 확인한 뒤 다시 시도하세요.");
      else uncertain();
    } finally {
      window.clearTimeout(timeout);
      request.current = null;
      setBusy(false);
    }
  }

  async function showLatest() {
    if (busy || operator.changed) return;
    setBusy(true);
    setError("");
    try {
      if (await onRefresh()) onClose();
      else setError("최신 참가자 정보를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      if (manualCopy.current) manualCopy.current.open = true;
      linkInput.current?.select();
    }
  }

  function complete() {
    if (operator.changed) return;
    const commandId = attempt.current;
    if (commandId && !forgetOperatorReceipt(commandId)) {
      setError("확인 목록을 정리하지 못했습니다. 브라우저 저장 상태를 확인하거나 닫은 뒤 목록에서 다시 확인하세요.");
      return;
    }
    attempt.current = null;
    onClose();
  }

  function finish() {
    if (operator.changed) return;
    if (!copied) { setConfirmFinish(true); return; }
    complete();
  }

  return (
    <ConsoleDialog title="티켓 재발급" description={person.name} busy={busy} onClose={onClose} canClose={canClose}
      footer={phase !== "confirm" ? <>
        <ProductButton type="button" className="button button-secondary" disabled={busy} onClick={() => { if (canClose()) onClose(); }}>{phase === "issued" && recoverable ? "나중에 확인" : "닫기"}</ProductButton>
        {phase === "issued" && recoverable ? <ProductButton type="button" className="button button-secondary" disabled={operator.changed} onClick={finish}>링크 확인 완료</ProductButton> : null}
        {reviewRequired ? <ProductButton ref={recoveryAction} type="button" className="button button-primary" disabled={busy || operator.changed} onClick={() => void showLatest()}>
          {busy ? "참가자 정보 불러오는 중" : "최신 참가자 정보 보기"}
        </ProductButton> : null}
      </> : null}>
      {error ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
      {phase === "confirm" ? <ConsoleConfirm summary={<span className={styles.ticketReissueCopy}>새 티켓을 발급하면 기존 링크와 QR은 사용할 수 없게 됩니다. 발급 후 새 링크를 복사해 참가자에게 전달하세요.</span>}
        confirmLabel="기존 티켓 무효화 및 재발급" busy={busy || operator.changed} onConfirm={() => void run()} onCancel={onClose} /> : null}
      {unresolved ? <div className={styles.editRecovery}>
        {phase === "applied" ? <ConsoleFeedback kind="success">재발급이 확인됐습니다. 같은 요청으로 발급된 링크를 가져오세요.</ConsoleFeedback> : null}
        <div className={styles.editActions}>
          <ProductButton type="button" className="button button-secondary" disabled={busy || operator.changed} onClick={() => void run(true)}>서버 처리 확인</ProductButton>
          <ProductButton ref={recoveryAction} type="button" className="button button-primary" disabled={busy || operator.changed} onClick={() => void run()}>같은 요청으로 링크 받기</ProductButton>
        </div>
      </div> : null}
      {reviewRequired && !error ? <ConsoleFeedback kind="warning">{phase === "changed"
        ? "티켓이나 참가 상태가 바뀌어 이 재발급 요청을 중단했습니다."
        : "이 요청으로 발급한 티켓이 바뀌었거나 만료됐습니다."}</ConsoleFeedback> : null}
      {phase === "issued" && !operator.changed ? <div className={styles.editRecovery}>
        <ConsoleFeedback kind="success">새 티켓을 발급했습니다. 링크를 복사해 해당 참가자에게 전달하세요.</ConsoleFeedback>
        {recoverable ? <p>닫은 뒤에도 처리 결과 확인에서 링크를 다시 확인할 수 있습니다.</p> : <ConsoleFeedback kind="warning">복구 기록을 확인할 수 없습니다. 창을 닫거나 새로고침하기 전에 링크를 복사하세요.</ConsoleFeedback>}
        <ProductButton ref={copyButton} type="button" className="button button-primary" onClick={() => void copy()}>새 티켓 링크 복사</ProductButton>
        {copied ? <p role="status">새 티켓 링크를 복사했습니다.</p> : null}
        <details ref={manualCopy}>
          <summary>링크 직접 복사</summary>
          <div className="form-field">
            <label htmlFor="reissued-ticket-link">새 티켓 링크</label>
            <input id="reissued-ticket-link" ref={linkInput} type="text" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          </div>
        </details>
      </div> : null}
      {operator.changed ? <ConsoleFeedback kind="warning">조직 변경을 확인한 뒤 계속하세요.</ConsoleFeedback> : null}
    {confirmFinish && phase === "issued" && !operator.changed ? <ConsoleConfirm summary={<span className={styles.ticketReissueCopy}>링크를 복사하거나 보관했나요? 확인을 완료하면 처리 결과 확인에서 이 링크를 다시 찾을 수 없습니다.</span>}
        confirmLabel="확인 완료" onConfirm={complete} onCancel={() => setConfirmFinish(false)} /> : null}
    {dismiss ? <ConsoleConfirm summary={<span className={styles.ticketReissueCopy}>{phase === "issued" ? "복구 기록을 확인할 수 없어 닫으면 이 링크를 다시 확인하기 어려울 수 있습니다. 링크를 복사했나요?" : "닫은 뒤 처리 결과 확인에서 재발급 여부를 조회할 수 있습니다. 이 화면에서 같은 요청의 링크를 가져오는 작업은 종료됩니다."}</span>}
        confirmLabel="닫기" onConfirm={onClose} onCancel={() => setDismiss(false)} /> : null}
    </ConsoleDialog>
  );
}
