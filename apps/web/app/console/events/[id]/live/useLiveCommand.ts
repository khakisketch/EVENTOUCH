"use client";

// The one command writer for 현장 모드. It sends the same commands, with the
// same payloads, ids and confirmations, as the operations, programs, draws and
// rewards screens (display.set, module.status, module.reveal, draw.run,
// draw.publish, draw.program.run, reward.fulfill), and keeps their recovery
// grammar: a response that cannot be confirmed freezes the exact request and id,
// blocks new writes, and offers 서버 처리 확인 / 같은 요청 다시 시도 / 확인 전
// 그만두기. Nothing here invents a command or a payload.

import { useEffect, useRef, useState } from "react";
import { consoleFetch } from "../../../../../lib/console-api";
import {
  abandonOperatorAttempt,
  acknowledgeOperatorReceipt,
  confirmsDrawRun,
  confirmsOperationsCommand,
  confirmsProgramOperation,
  isOrganizationContextBlock,
} from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, waitForOperatorReceiptIdle } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";

export const LIVE_COMMANDS = ["display.set", "module.status", "module.reveal", "draw.run", "draw.publish", "draw.program.run", "reward.fulfill"] as const;
type LiveCommandName = (typeof LIVE_COMMANDS)[number];

export type LiveAttempt = {
  eventId: string;
  command: LiveCommandName;
  payload: Record<string, unknown>;
  /** Plain words for what this request does, used in recovery copy. */
  label: string;
  successMessage: string;
  fingerprint: string;
  commandId: string;
};

export type LiveRequest = { command: LiveCommandName; payload: Record<string, unknown>; label: string; successMessage: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function confirms(attempt: LiveAttempt, data: unknown): boolean {
  switch (attempt.command) {
    case "display.set": return confirmsOperationsCommand(attempt.command, attempt.payload, data);
    case "draw.program.run": return confirmsDrawRun(attempt.payload, data, attempt.commandId);
    case "reward.fulfill": {
      const reward = typeof data === "object" && data !== null ? (data as Record<string, unknown>).reward : null;
      const row = typeof reward === "object" && reward !== null ? reward as Record<string, unknown> : null;
      return Boolean(row && row.id === attempt.payload.id && (row.status === "RECEIVED" || row.status === "NEEDS_CONNECTION"));
    }
    default: return confirmsProgramOperation(attempt.command, attempt.commandId, attempt.payload, data);
  }
}

export function useLiveCommand(eventId: string, onApplied: () => void, onStale: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<LiveAttempt | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const pendingRef = useRef<LiveAttempt | null>(null);
  const gate = useRef(false);
  const activeEvent = useRef(eventId);
  activeEvent.current = eventId;
  const issued = useRef(new Map<string, string>());
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;

  const receipts = useEventReceipts(eventId);
  const otherReceipt = receipts.some((item) => (LIVE_COMMANDS as readonly string[]).includes(item.command)
    && item.commandId !== pending?.commandId && ![...issued.current.values()].includes(item.commandId));
  const locked = busy || checking || Boolean(pending) || otherReceipt;

  // The shared recovery notice stays quiet while this screen owns the pointer.
  useEffect(() => (pending ? manageOperatorReceipt(pending.commandId) : undefined), [pending]);

  // A new event never inherits the previous event's frozen request.
  useEffect(() => {
    pendingRef.current = null;
    setPending(null);
    setRecoveryError(null);
    setAbandoning(false);
    setFailure(null);
    setNotice(null);
    issued.current.clear();
  }, [eventId]);

  function hold(attempt: LiveAttempt) {
    pendingRef.current = attempt;
    setPending(attempt);
    setRecoveryError("처리 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.");
  }

  function settle(attempt: LiveAttempt) {
    issued.current.delete(attempt.fingerprint);
    acknowledgeOperatorReceipt(attempt.commandId);
    forgetOperatorReceipt(attempt.commandId);
    pendingRef.current = null;
    setPending(null);
    setRecoveryError(null);
    setAbandoning(false);
  }

  async function send(request: LiveRequest, retry?: LiveAttempt): Promise<boolean> {
    if (gate.current) return false;
    const held = pendingRef.current;
    if ((held && (!retry || retry.commandId !== held.commandId)) || (otherReceipt && !retry)) {
      setFailure("이전 요청의 처리 결과를 먼저 확인하세요.");
      return false;
    }
    gate.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    const payload = retry?.payload ?? JSON.parse(JSON.stringify(request.payload)) as Record<string, unknown>;
    const fingerprint = retry?.fingerprint ?? `${request.command}:${JSON.stringify(payload)}`;
    const commandId = retry?.commandId ?? issued.current.get(fingerprint) ?? randomCommandId();
    issued.current.set(fingerprint, commandId);
    const attempt: LiveAttempt = retry ?? { eventId, command: request.command, payload, label: request.label, successMessage: request.successMessage, fingerprint, commandId };
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command: attempt.command, payload: attempt.payload }),
      });
      const data = (await response.json().catch(() => null)) as (Record<string, unknown> & { error?: unknown; code?: unknown }) | null;
      if (activeEvent.current !== attempt.eventId) return false;
      if (!response.ok) {
        // A guard that runs after the locked receipt lookup proves nothing was committed.
        const changed = response.status === 409 && (data?.code === "DRAW_PROGRAM_CHANGED" || data?.code === "REWARD_PARTICIPANT_CHANGED");
        const uncertain = !changed && (Boolean(retry) || response.status >= 500 || [408, 425, 429].includes(response.status));
        if (uncertain) { hold(attempt); return false; }
        issued.current.delete(fingerprint);
        if (retry) settle(attempt);
        abandonOperatorAttempt(commandId);
        forgetOperatorReceipt(commandId);
        setFailure(changed ? "다른 곳에서 먼저 바뀌어 실행하지 않았습니다. 최신 내용을 불러왔으니 확인한 뒤 다시 진행하세요."
          : typeof data?.error === "string" ? data.error : "처리하지 못했습니다.");
        if (changed || attempt.command === "display.set") onStaleRef.current();
        return false;
      }
      if (!confirms(attempt, data)) { hold(attempt); return false; }
      // The response observer may still be deciding about this pointer; release it only after it is idle.
      await waitForOperatorReceiptIdle(commandId);
      if (activeEvent.current !== attempt.eventId) return false;
      settle(attempt);
      setNotice(attempt.successMessage);
      onAppliedRef.current();
      return true;
    } catch (error) {
      if (activeEvent.current !== attempt.eventId) return false;
      if (!retry && isOrganizationContextBlock(error)) {
        issued.current.delete(fingerprint);
        setFailure("현재 조직을 확인한 뒤 다시 시도하세요.");
      } else hold(attempt);
      return false;
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }

  async function check() {
    const attempt = pendingRef.current;
    if (!attempt || attempt.eventId !== activeEvent.current || gate.current) return;
    gate.current = true;
    setChecking(true);
    setRecoveryError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { status?: unknown; command?: unknown } | null;
      if (activeEvent.current !== attempt.eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === attempt.command) {
        await waitForOperatorReceiptIdle(attempt.commandId);
        settle(attempt);
        setFailure(null);
        setNotice("처리가 서버에 반영된 것을 확인했습니다. 최신 내용을 불러옵니다.");
        onAppliedRef.current();
      } else {
        setRecoveryError(response.ok && data?.status === "UNCONFIRMED"
          ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요."
          : "처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인한 뒤 다시 확인하세요.");
      }
    } catch {
      if (activeEvent.current === attempt.eventId) setRecoveryError("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다.");
    } finally {
      gate.current = false;
      setChecking(false);
    }
  }

  async function retry() {
    const attempt = pendingRef.current;
    if (!attempt || checking || attempt.eventId !== activeEvent.current) return;
    setRecoveryError(null);
    await send({ command: attempt.command, payload: attempt.payload, label: attempt.label, successMessage: attempt.successMessage }, attempt);
  }

  function abandon() {
    const attempt = pendingRef.current;
    if (!attempt) return;
    issued.current.delete(attempt.fingerprint);
    abandonOperatorAttempt(attempt.commandId);
    forgetOperatorReceipt(attempt.commandId);
    pendingRef.current = null;
    setPending(null);
    setRecoveryError(null);
    setAbandoning(false);
    setFailure("이전 처리가 반영됐을 수 있습니다. 최신 내용을 확인한 뒤 다시 진행하세요.");
    onStaleRef.current();
  }

  return {
    send, check, retry, abandon, setAbandoning, setFailure, setNotice,
    busy, checking, abandoning, pending, recoveryError, failure, notice, otherReceipt, locked,
  };
}
