"use client";
import ProductButton from "../../../../ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import { consoleFetch } from "../../../../../lib/console-api";
import { acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, waitForOperatorReceiptIdle } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./participants.module.css";

// 참가자 개인정보 삭제(익명화). 삭제 요청을 처리하는 도구라 행사가 끝난 뒤에도
// 쓴다. 되돌릴 수 없으므로 참가자 이름을 직접 입력해야 버튼이 켜진다.
// 서버 명령 participant.erase { id, expectedName }는 같은 commandId로 다시 보내도
// 한 번만 처리되고, 응답은 개인정보 없이 { participant: { id, erased: true } }를 돌려준다.

type Attempt = { commandId: string; payload: { id: string; expectedName: string } };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";
const sameName = (typed: string, name: string) => typed.normalize("NFC").trim() === name.normalize("NFC").trim();

export default function PersonErase({ eventId, person, onRefresh, onClose, onDone }: {
  eventId: string;
  person: { id: string; name: string };
  onRefresh: () => Promise<boolean>;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const operator = useOperatorContextSnapshot();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Attempt | null>(null);
  const [dismiss, setDismiss] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const activeRef = useRef(true);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const matches = sameName(typed, person.name);
  useConsoleDraftGuard(busy || Boolean(pending) || Boolean(typed.trim()),
    pending || busy ? "개인정보 삭제의 처리 결과를 아직 확인하지 못했습니다." : "입력 중인 삭제 확인이 있습니다.");
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; requestRef.current?.abort(); }; }, []);
  useEffect(() => pending ? manageOperatorReceipt(pending.commandId) : undefined, [pending]);
  useEffect(() => { if (!busy && pending && error) recoveryRef.current?.focus(); }, [busy, pending, error]);

  function canClose() {
    if (busy || requestRef.current) return false;
    if (pending || typed.trim()) { setDismiss(true); return false; }
    return true;
  }

  async function finish(attempt: Attempt) {
    if (!await onRefresh() || !activeRef.current) {
      if (activeRef.current) {
        attemptRef.current = attempt; setPending(attempt);
        setError("삭제는 확인됐지만 명단을 갱신하지 못했습니다. 서버 처리 확인을 다시 선택하세요.");
      }
      return;
    }
    await waitForOperatorReceiptIdle(attempt.commandId);
    if (!activeRef.current) return;
    if (!forgetOperatorReceipt(attempt.commandId)) {
      attemptRef.current = attempt; setPending(attempt);
      setError("삭제는 확인됐지만 처리 확인 항목을 정리하지 못했습니다. 서버 처리 확인을 다시 선택하세요.");
      return;
    }
    acknowledgeOperatorReceipt(attempt.commandId);
    attemptRef.current = null; setPending(null);
    onDone(person.name);
  }

  async function execute(statusOnly = false) {
    if (busy || requestRef.current || operator.changed) return;
    const previous = attemptRef.current;
    if (statusOnly && !previous) return;
    if (!previous && !matches) { setError("삭제할 참가자의 이름을 정확히 입력하세요."); return; }
    const attempt: Attempt = previous ?? {
      commandId: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `erase-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: { id: person.id, expectedName: person.name },
    };
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setBusy(true); setError("");
    const uncertain = () => {
      attemptRef.current = attempt; setPending(attempt);
      setError("처리 결과를 확인하지 못했습니다. 서버 처리 확인이나 같은 요청 다시 시도를 선택하세요.");
    };
    try {
      const base = `/api/events/${encodeURIComponent(eventId)}`;
      const response = statusOnly
        ? await consoleFetch(`${base}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { signal: controller.signal })
        : await consoleFetch(`${base}/commands`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
            body: JSON.stringify({ commandId: attempt.commandId, command: "participant.erase", payload: attempt.payload }) });
      const body = record(await response.json().catch(() => null));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (statusOnly) {
        if (response.ok && body?.status === "APPLIED" && body.command === "participant.erase") await finish(attempt);
        else setError("서버 처리 결과를 아직 확인하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.");
        return;
      }
      if (!response.ok) {
        if (previous || response.status >= 500 || [408, 425, 429].includes(response.status)) { uncertain(); return; }
        forgetOperatorReceipt(attempt.commandId);
        attemptRef.current = null; setPending(null);
        const code = text(body?.code);
        setError(code === "PARTICIPANT_ALREADY_ERASED" ? "이미 개인정보가 삭제된 참가자입니다. 명단을 새로고침해 확인하세요."
          : code === "PARTICIPANT_CHANGED" ? "참가자 정보가 바뀌었습니다. 닫고 최신 명단을 확인한 뒤 다시 시도하세요."
          : text(body?.error) || "개인정보를 삭제하지 못했습니다.");
        return;
      }
      const erased = record(body?.participant);
      if (!erased || erased.id !== attempt.payload.id || erased.erased !== true) { uncertain(); return; }
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

  return <ConsoleDialog title="개인정보 삭제" description={person.name} onClose={onClose} canClose={canClose} busy={busy}
    footer={<ConsoleFormActions>
      <ProductButton type="button" variant="ghost" disabled={busy} onClick={() => { if (canClose()) onClose(); }}>닫기</ProductButton>
      {!pending ? <ProductButton type="button" variant="destructive" disabled={!matches || busy || dismiss || operator.changed} onClick={() => void execute()}>{busy ? "삭제 중…" : "개인정보 삭제"}</ProductButton> : null}
    </ConsoleFormActions>}>
    <div className={`${uiStyles.formStack} ${styles.reviewBody}`}>
      <p>참가자가 삭제를 요청했을 때 처리합니다. <strong>되돌릴 수 없습니다.</strong></p>
      <ul className={styles.eraseList}>
        <li>이름이 ‘삭제된 참가자’로 바뀌고 연락처·이메일·소속·신청 답변이 지워집니다.</li>
        <li>티켓을 쓸 수 없게 되고 신청 상태는 ‘신청 취소’가 됩니다.</li>
        <li>경품·메시지·추첨 기록 등 다른 기록에 남은 이름과 연락처 사본도 함께 지웁니다.</li>
        <li>입장 기록과 집계 숫자는 남지만 개인정보는 남지 않습니다.</li>
        <li>참가자가 올린 사진은 화면에서 숨겨지며, 파일은 별도의 삭제 절차 전까지 서버에 남을 수 있습니다.</li>
      </ul>
      {operator.changed ? <ConsoleFeedback kind="warning">운영 조직을 확인한 뒤 계속하세요.</ConsoleFeedback> : null}
      {busy ? <p role="status">개인정보 삭제의 처리 결과를 확인하고 있습니다.</p> : null}
      {error ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
      {!pending ? <>
        <label htmlFor="person-erase-name">삭제를 확인하려면 참가자 이름 ‘{person.name}’을 입력하세요</label>
        <input id="person-erase-name" type="text" autoComplete="off" value={typed} disabled={busy || dismiss}
          onChange={(event) => { setTyped(event.target.value); if (error) setError(""); }} />
      </> : <section aria-label="개인정보 삭제 처리 확인">
        <p>원래 요청을 그대로 유지합니다. 서버 확인은 새 삭제를 만들지 않습니다.</p>
        <ProductButton ref={recoveryRef} type="button" variant="ghost" disabled={busy || dismiss || operator.changed} onClick={() => void execute(true)}>서버 처리 확인</ProductButton>{" "}
        <ProductButton type="button" variant="ghost" disabled={busy || dismiss || operator.changed} onClick={() => void execute()}>같은 요청 다시 시도</ProductButton>
      </section>}
      {dismiss ? <ConsoleConfirm summary={pending ? "삭제 결과를 아직 확인하지 못했습니다. 닫은 뒤 처리 결과 확인에서 확인해야 합니다." : "입력한 삭제 확인이 사라집니다."}
        confirmLabel="확인 후 닫기" cancelLabel="계속 작업" onConfirm={onClose} onCancel={() => setDismiss(false)} /> : null}
    </div>
  </ConsoleDialog>;
}
