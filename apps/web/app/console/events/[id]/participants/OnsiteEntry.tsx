"use client";

// 현장 입장 처리 (2026-11-24, owner: 현장 등록한 참가자를 운영자가 콘솔에서 바로 입장 처리).
//
// One operator command, no new server surface: `check.scan` with
// { deskId, participantId, expectedAction: "IN" }. The server already lets an
// operator with the `onsite` grant use it without a staff assignment, and it
// owns every rule (LIVE, open IN desk, APPROVED, payment, ticket, duplicate
// entry, re-entry). This module only decides what the roster shows and keeps
// the write safe: one command id per attempt, replayed unchanged when the
// answer is lost, replaced only after the server rejects.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import ProductButton from "../../../../ui/ProductButton";
import ProductLink from "../../../../ui/ProductLink";
import { consoleFetch } from "../../../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, waitForOperatorReceiptIdle } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import styles from "./participants.module.css";

export type EntryDesk = { id: string; name: string };
export type EntryRecord = { at: string; deskName: string };
export type EntryRecords = Record<string, EntryRecord>;

export type EntryPerson = {
  id: string;
  name: string;
  status: string;
  paymentStatus: string;
  inside: boolean;
  presenceUnknown: boolean;
  attendanceReview: boolean;
  ticketReview: string;
  erased: boolean;
};

export type EntryContext = {
  eventId: string;
  stage: string;
  canScan: boolean;
  /** Open desks whose direction is IN; null when the desk list cannot be read. */
  desks: EntryDesk[] | null;
  /** Latest uncorrected entry per participant; null when the check list cannot be read. */
  records: EntryRecords | null;
};

export type EntryState =
  | { kind: "none" }
  | { kind: "inside"; line: string }
  | { kind: "ready"; desks: EntryDesk[] }
  | { kind: "reason"; text: string; deskLink: boolean };

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";

function deskLabel(desk: Record<string, unknown>): string {
  return text(desk.name).trim() || "입장 데스크";
}

// Desks an operator can scan people in at: open, and set to 입장 (IN). A desk
// list that cannot be read is null, never an empty list, so the roster says
// "cannot check" instead of "no desk".
export function readEntryDesks(workspace: Record<string, unknown>): EntryDesk[] | null {
  if (!Array.isArray(workspace.desks)) return null;
  const desks: EntryDesk[] = [];
  for (const value of workspace.desks) {
    const desk = record(value);
    if (!desk || typeof desk.id !== "string" || !desk.id) continue;
    if (desk.open === false || text(desk.action).trim().toUpperCase() !== "IN") continue;
    desks.push({ id: desk.id, name: deskLabel(desk) });
  }
  return desks;
}

// "입장함 · 시각 · 데스크": the newest uncorrected entry per participant.
export function readEntryRecords(workspace: Record<string, unknown>): EntryRecords | null {
  if (!Array.isArray(workspace.checks) || workspace.checksAvailable === false) return null;
  const names = new Map<string, string>();
  if (Array.isArray(workspace.desks)) {
    for (const value of workspace.desks) {
      const desk = record(value);
      if (desk && typeof desk.id === "string") names.set(desk.id, deskLabel(desk));
    }
  }
  const latest: EntryRecords = {};
  const latestMs = new Map<string, number>();
  for (const value of workspace.checks) {
    const check = record(value);
    if (!check || check.corrected === true || check.action !== "IN" || typeof check.participantId !== "string" || !check.participantId) continue;
    const at = text(check.at);
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) continue;
    if ((latestMs.get(check.participantId) ?? -Infinity) >= ms) continue;
    latestMs.set(check.participantId, ms);
    latest[check.participantId] = { at, deskName: names.get(text(check.deskId)) ?? "" };
  }
  return latest;
}

export function formatEntryTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("ko-KR", sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

export function deskPhrase(name: string): string {
  return /데스크$/.test(name) ? name : `${name} 데스크`;
}

// What the sheet (and the post-registration notice) may offer for one person.
// Mirrors the server rules only to explain them in advance; the server stays
// the authority and re-checks every one of them.
export function entryState(person: EntryPerson, context: EntryContext): EntryState {
  const status = person.status.toUpperCase();
  if (!context.canScan || person.erased || !["APPROVED", "PENDING", "WAITLIST"].includes(status)) return { kind: "none" };
  if (person.inside) {
    const found = context.records?.[person.id];
    return { kind: "inside", line: ["입장함", found ? formatEntryTime(found.at) : "", found?.deskName ?? ""].filter(Boolean).join(" · ") };
  }
  if (context.stage.toUpperCase() !== "LIVE") return { kind: "reason", text: "행사가 진행 중일 때 입장 처리할 수 있습니다.", deskLink: false };
  if (status === "PENDING") return { kind: "reason", text: "승인한 뒤 입장 처리할 수 있습니다.", deskLink: false };
  if (status === "WAITLIST") return { kind: "reason", text: "참가 확정한 뒤 입장 처리할 수 있습니다.", deskLink: false };
  if (person.presenceUnknown || person.attendanceReview) return { kind: "reason", text: "출입 기록을 확인한 뒤 입장 처리할 수 있습니다.", deskLink: false };
  if (["expired", "revoked", "cancelled"].includes(person.ticketReview)) return { kind: "reason", text: "티켓 상태를 확인한 뒤 입장 처리할 수 있습니다.", deskLink: false };
  if (!["FREE", "PAID"].includes(person.paymentStatus.toUpperCase())) return { kind: "reason", text: "결제가 완료된 뒤 입장 처리할 수 있습니다.", deskLink: false };
  if (context.desks === null) return { kind: "reason", text: "입장 데스크를 확인할 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.", deskLink: false };
  if (!context.desks.length) return { kind: "reason", text: "열려 있는 입장 데스크가 없습니다 — 입장·스태프에서 데스크를 만들고 가동하세요.", deskLink: true };
  return { kind: "ready", desks: context.desks };
}

const REMEMBER_KEY = (eventId: string) => `eventouch.onsite-entry-desk.${eventId}`;
export function readRememberedDesk(eventId: string): string {
  try { return window.sessionStorage.getItem(REMEMBER_KEY(eventId)) ?? ""; } catch { return ""; }
}
export function rememberDesk(eventId: string, deskId: string): void {
  try { window.sessionStorage.setItem(REMEMBER_KEY(eventId), deskId); } catch { /* storage may be blocked; the choice only lasts this visit */ }
}

type Attempt = { commandId: string; participantId: string; name: string; deskId: string; deskName: string };
type Outcome = { participantId: string; kind: "error" | "uncertain"; message: string };
export type EntryDone = { participantId: string; name: string; deskName: string };

// The server rejects with a sentence the operator can read; add what to do next.
const NEXT_STEP: Record<string, string> = {
  ALREADY_CHECKED_IN: "명단에서 입장 상태를 확인하세요.",
  DESK_CLOSED: "다른 데스크를 선택하거나 입장·스태프에서 데스크를 가동하세요.",
  DESK_ACTION_CHANGED: "데스크 목록을 새로 불러왔습니다. 입장 데스크를 다시 선택하세요.",
  CHECK_ATTENDANCE_REVIEW_REQUIRED: "참가자 상세의 출입 상태 확인에서 먼저 정리하세요.",
  CHECK_SOURCE_UNAVAILABLE: "목록을 새로고침한 뒤 다시 시도하세요. 계속되면 조직 관리자에게 문의하세요.",
  TICKET_STATUS_CONFLICT: "신청 상태와 취소 기록을 먼저 확인하세요.",
};
const RECORD_STATUS_NOTICE: Record<string, string> = {
  CORRECTED: "이 입장 기록은 이미 정정됐습니다.",
  SUPERSEDED: "이 요청 이후 다른 출입이 기록됐습니다.",
  PARTICIPANT_CHANGED: "이 요청 이후 참가 상태가 바뀌었습니다.",
  UNAVAILABLE: "이 기록이 현재 출입 상태에 해당하는지 확인할 수 없습니다.",
};

function newCommandId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type OnsiteEntryApi = {
  busy: boolean;
  blocked: boolean;
  pending: Attempt | null;
  outcome: Outcome | null;
  done: (EntryDone & { message: string }) | null;
  chosenDeskId: string;
  chooseDesk: (deskId: string) => void;
  pickDesk: (desks: EntryDesk[]) => EntryDesk | null;
  begin: (target: { id: string; name: string }, desk: EntryDesk | null) => void;
  retry: () => void;
};

export function useOnsiteEntry({ eventId, gate, onRefresh, onDone }: {
  eventId: string;
  /** Shared in-flight flag of the roster: status, group, reward and entry writes never overlap. */
  gate: MutableRefObject<boolean>;
  onRefresh: () => Promise<boolean>;
  onDone: (info: EntryDone) => void;
}): OnsiteEntryApi {
  const operator = useOperatorContextSnapshot();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [done, setDone] = useState<(EntryDone & { message: string }) | null>(null);
  const [chosenDeskId, setChosenDeskId] = useState("");
  const attemptRef = useRef<Attempt | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const callbacksRef = useRef({ onRefresh, onDone });
  callbacksRef.current = { onRefresh, onDone };
  useConsoleDraftGuard(busy || Boolean(pending), "입장 처리의 결과를 아직 확인하지 못했습니다. 화면을 벗어나면 같은 요청으로 다시 확인할 수 없습니다.");
  useEffect(() => pending ? manageOperatorReceipt(pending.commandId) : undefined, [pending]);
  // A new event starts clean: a pending attempt or message never follows the operator across events.
  useEffect(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    attemptRef.current = null;
    setPending(null); setOutcome(null); setDone(null); setBusy(false);
    setChosenDeskId(readRememberedDesk(eventId));
    return () => { generationRef.current += 1; requestRef.current?.abort(); };
  }, [eventId]);

  function chooseDesk(deskId: string) {
    setChosenDeskId(deskId);
    rememberDesk(eventId, deskId);
  }
  // The operator's choice when it is still a candidate, else the last one used
  // in this tab, else the first open IN desk.
  function pickDesk(desks: EntryDesk[]): EntryDesk | null {
    return desks.find((desk) => desk.id === chosenDeskId) ?? desks.find((desk) => desk.id === readRememberedDesk(eventId)) ?? desks[0] ?? null;
  }

  async function finish(attempt: Attempt, generation: number) {
    const live = () => generation === generationRef.current;
    if (!await callbacksRef.current.onRefresh()) {
      attemptRef.current = attempt;
      if (live()) { setPending(attempt); setOutcome({ participantId: attempt.participantId, kind: "uncertain", message: "입장 처리는 기록됐지만 명단을 갱신하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요." }); }
      return;
    }
    await waitForOperatorReceiptIdle(attempt.commandId);
    if (!live()) return;
    if (!forgetOperatorReceipt(attempt.commandId)) {
      attemptRef.current = attempt;
      setPending(attempt); setOutcome({ participantId: attempt.participantId, kind: "uncertain", message: "입장 처리는 기록됐지만 처리 확인 항목을 정리하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요." });
      return;
    }
    acknowledgeOperatorReceipt(attempt.commandId);
    attemptRef.current = null;
    setPending(null); setOutcome(null);
    const info = { participantId: attempt.participantId, name: attempt.name, deskName: attempt.deskName };
    setDone({ ...info, message: `${info.name}님을 입장 처리했습니다 · ${info.deskName}` });
    callbacksRef.current.onDone(info);
  }

  async function execute(attempt: Attempt, replay: boolean) {
    if (requestRef.current || gate.current || operator.changed) return;
    const generation = generationRef.current;
    const live = () => generation === generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    gate.current = true;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setBusy(true); setOutcome(null); setDone(null);
    const uncertain = () => {
      attemptRef.current = attempt;
      if (!live()) return;
      setPending(attempt);
      setOutcome({ participantId: attempt.participantId, kind: "uncertain", message: "처리 결과를 확인하지 못했습니다. 이미 입장 처리됐을 수 있으니 같은 요청으로 결과를 다시 확인하세요." });
    };
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, command: "check.scan",
          payload: { deskId: attempt.deskId, participantId: attempt.participantId, expectedAction: "IN" } }),
      });
      const body = record(await response.json().catch(() => null));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        // The server reads the receipt before every other rule, so a request
        // that was applied can only come back as 200. Any other 4xx therefore
        // proves nothing was recorded; only a server fault or timeout is unknown.
        if (response.status >= 500 || [408, 425, 429].includes(response.status)) { uncertain(); return; }
        abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
        attemptRef.current = null;
        const code = text(body?.code);
        const reason = text(body?.error) || "입장 처리하지 못했습니다.";
        if (live()) {
          setPending(null);
          setOutcome({ participantId: attempt.participantId, kind: "error", message: [reason, NEXT_STEP[code]].filter(Boolean).join(" ") });
        }
        void callbacksRef.current.onRefresh();
        return;
      }
      if (!body || body.id !== attempt.participantId || body.action !== "IN" || body.checkId !== attempt.commandId) { uncertain(); return; }
      const status = text(body.recordStatus);
      if (status) {
        // A replay of an old entry whose record no longer matches the roster: settle it and say why.
        abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
        attemptRef.current = null;
        if (live()) {
          setPending(null);
          setOutcome({ participantId: attempt.participantId, kind: "error", message: `${RECORD_STATUS_NOTICE[status] ?? RECORD_STATUS_NOTICE.UNAVAILABLE} 참가자 상태를 확인해 주세요.` });
        }
        void callbacksRef.current.onRefresh();
        return;
      }
      rememberDesk(eventId, attempt.deskId);
      await finish(attempt, generation);
    } catch (cause) {
      if (!replay && isOrganizationContextBlock(cause)) {
        if (live()) setOutcome({ participantId: attempt.participantId, kind: "error", message: "현재 조직을 확인한 뒤 다시 시도하세요. 요청은 보내지 않았습니다." });
        attemptRef.current = null;
      } else uncertain();
    } finally {
      window.clearTimeout(timer);
      requestRef.current = null;
      gate.current = false;
      if (live()) setBusy(false);
    }
  }

  function begin(target: { id: string; name: string }, desk: EntryDesk | null) {
    if (!desk || busy || attemptRef.current) return;
    void execute({ commandId: newCommandId(), participantId: target.id, name: target.name, deskId: desk.id, deskName: deskPhrase(desk.name) }, false);
  }
  function retry() {
    const attempt = attemptRef.current;
    if (attempt) void execute(attempt, true);
  }

  return { busy, blocked: operator.changed, pending, outcome, done, chosenDeskId, chooseDesk, pickDesk, begin, retry };
}

// Result of an entry attempt: a rejection with what to do next, or an unknown
// outcome with the one safe way forward (the same request again).
export function EntryOutcome({ entry, participantId }: { entry: OnsiteEntryApi; participantId?: string }) {
  const outcome = entry.outcome;
  if (!outcome || (participantId !== undefined && outcome.participantId !== participantId)) return null;
  return <ConsoleFeedback kind={outcome.kind === "error" ? "error" : "warning"}>
    {outcome.message}
    {outcome.kind === "uncertain" && entry.pending ? <>{" "}<ProductButton type="button" variant="ghost" className={styles.entryRetry} disabled={entry.busy || entry.blocked} onClick={entry.retry}>
      {entry.busy ? "확인 중…" : "같은 요청으로 다시 확인"}</ProductButton></> : null}
  </ConsoleFeedback>;
}

// The one primary action of the sheet for an approved, not-yet-inside person.
export function EntrySheetBlock({ person, state, entry, eventId, locked }: {
  person: EntryPerson; state: EntryState; entry: OnsiteEntryApi; eventId: string; locked: boolean;
}) {
  if (state.kind === "none") return null;
  const done = entry.done?.participantId === person.id ? entry.done.message : "";
  return <div className={styles.entryBlock} role="group" aria-label="입장 처리">
    {done ? <p className="sr-only" role="status">{done}</p> : null}
    {state.kind === "inside" ? <p className={styles.entryDone}>{state.line}</p> : null}
    {state.kind === "reason" ? <p className={styles.entryReason}>{state.text}{state.deskLink ? <>{" "}
      <ProductLink variant="ghost" className={styles.entryLink} href={`/console/events/${encodeURIComponent(eventId)}/operations`}>입장·스태프 열기</ProductLink></> : null}</p> : null}
    {state.kind === "ready" ? (() => {
      const desk = entry.pickDesk(state.desks);
      const otherPending = Boolean(entry.pending && entry.pending.participantId !== person.id);
      return <>
        <ProductButton type="button" variant="primary" className={styles.entryAction} aria-label={`${person.name} 입장 처리`}
          disabled={locked || entry.busy || entry.blocked || otherPending || !desk || Boolean(entry.pending)}
          onClick={() => entry.begin({ id: person.id, name: person.name }, desk)}>
          {entry.busy ? "입장 처리 중…" : "입장 처리"}
        </ProductButton>
        {state.desks.length > 1 ? <label className={styles.entryDeskPick}>
          <span>입장 데스크</span>
          <select value={desk?.id ?? ""} disabled={entry.busy || Boolean(entry.pending)} onChange={(event) => entry.chooseDesk(event.target.value)}>
            {state.desks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label> : desk ? <p className={styles.entryDeskNote}>{deskPhrase(desk.name)}에서 처리</p> : null}
        {otherPending ? <p className={styles.entryReason}>다른 참가자의 입장 처리 결과를 먼저 확인해 주세요.</p> : null}
      </>;
    })() : null}
    <EntryOutcome entry={entry} participantId={person.id} />
  </div>;
}

// Inside the "등록했습니다" notice: the same entry for the person just added.
export function EntryNoticeButton({ person, state, entry, locked }: {
  person: EntryPerson; state: EntryState; entry: OnsiteEntryApi; locked: boolean;
}) {
  if (state.kind !== "ready") return null;
  const desk = entry.pickDesk(state.desks);
  if (!desk) return null;
  return <>{" "}<ProductButton type="button" variant="secondary" className={styles.entryNoticeAction} aria-label={`${person.name} 바로 입장 처리`}
    disabled={locked || entry.busy || entry.blocked || Boolean(entry.pending)}
    onClick={() => entry.begin({ id: person.id, name: person.name }, desk)}>
    {entry.busy ? "입장 처리 중…" : "바로 입장 처리"}
  </ProductButton><small className={styles.entryNoticeDesk}> {deskPhrase(desk.name)}에서 처리</small></>;
}
