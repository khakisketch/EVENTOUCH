"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleToolbar from "../../../console-ui/ConsoleToolbar";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { UNCONFIRMED_WRITE_CLOSE_MESSAGE, useConsoleDraftGuard } from "../../../console-draft-guard";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import consoleUiStyles from "../../../console-ui/console-ui.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import styles from "./rewards.module.css";

// Reward handout desk: registration happens on the participant row
// (경품 등록), and this screen is where staff/operators mark handout or
// cancel. GIFT fulfilment is honest about v1: the code is a DEMO- placeholder
// and the status records NEEDS_CONNECTION instead of pretending a coupon
// was issued.

type Reward = {
  id: string;
  participantId: string;
  name: string;
  method: string;
  status: string;
  at: string;
  code: string;
  participantName: string;
  company: string;
  programTitle: string;
  drawProgramId: string;
  pendingAssignee: boolean;
  participantIssue: "" | "missing" | "cancelled" | "conflict" | "unapproved";
};

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; eventName: string; eventMeta?: string; eventStage: string; featureOn: boolean; role: string; userId: string; memberships: Array<{ accountId: string; eventId: string; write?: unknown }>; rewards: Reward[] };

type RewardCommand = "reward.fulfill" | "reward.cancel";
type RewardAttempt = { eventId: string; id: string; command: RewardCommand; commandId: string; label: string; method: string; uncertain: boolean; applied: boolean };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function participantIdentifier(value: unknown): string {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
}

function rewardRecordMatches(value: unknown, id: string, statuses: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.id === id && typeof record.status === "string" && statuses.includes(record.status);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function methodLabel(method: string): string {
  return method === "GIFT" ? "기프티콘 (모의)" : "현장 수령";
}

function statusLabel(status: string): string {
  switch (status) {
    case "READY":
      return "지급 대기";
    case "RECEIVED":
      return "수령 완료";
    case "NEEDS_CONNECTION":
      return "연결 필요 (기프티콘 미연동)";
    case "CANCELLED":
      return "취소";
    case "FAILED":
      return "지급 실패";
    case "PENDING":
      return "수령자 지정 대기";
    default:
      return "상태 확인 필요";
  }
}

function formatTime(value: string): string {
  if (!value) return "시각 확인 중";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

// Irreversible-step summaries, moved verbatim from the previous native
// confirms (target naming + no-undo notice). Newlines render as breaks so
// no information is dropped inside the single-paragraph confirm region.
function confirmLines(message: string): ReactNode {
  const parts = message.split("\n");
  return parts.flatMap((line, index) => (index === 0 ? [line] : [<br key={index} />, line]));
}

function rewardTargetName(reward: Reward): string {
  return reward.company && reward.pendingAssignee
    ? `${reward.company} 업체 당첨 경품`
    : `${reward.participantName}님의 경품`;
}

function fulfillSummary(reward: Reward): string {
  return `${rewardTargetName(reward)}을 처리할까요? 처리한 뒤에는 취소할 수 없습니다.`;
}

function cancelSummary(reward: Reward): string {
  return `${rewardTargetName(reward)}을 취소할까요?`;
}

export default function RewardsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One in-place confirm at a time: the trigger stays, and the confirm
  // renders inside the same row. Confirming runs the existing command and
  // clears the pending slot; cancelling only clears it.
  const [rewardPending, setRewardPending] = useState<{
    id: string;
    command: "reward.fulfill" | "reward.cancel";
  } | null>(null);
  // Local-only desk filters over the loaded list: free-text search across
  // participant/company/경품명/추첨명 plus a status bucket. Never a new fetch.
  const [rewardQuery, setRewardQuery] = useState("");
  const [rewardStatusFilter, setRewardStatusFilter] = useState("");
  // Same-turn in-flight gate: `busy` state flips only on re-render.
  const busyGateRef = useRef(false);
  const pendingRewardActionRef = useRef<RewardAttempt | null>(null);
  const [pendingAction, setPendingAction] = useState<RewardAttempt | null>(null);
  const [checking, setChecking] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [abandonConfirm, setAbandonConfirm] = useState(false);
  const [loadedEventId, setLoadedEventId] = useState<string | null>(null);
  const activeEventRef = useRef(eventId);
  const loadSequenceRef = useRef(0);
  const actionRef = useRef<symbol | null>(null);
  const hadOtherReceiptRef = useRef(false);
  const recoveryFocusOriginRef = useRef<Element | null>(null);
  activeEventRef.current = eventId;
  const receipts = useEventReceipts(eventId);
  const otherReceipt = receipts.some((item) => ["reward.fulfill", "reward.cancel"].includes(item.command) && item.commandId !== pendingAction?.commandId);
  const writeLocked = Boolean(loadedEventId !== eventId || busy || pendingAction || otherReceipt || needsRefresh || (hadOtherReceiptRef.current && !otherReceipt));
  useConsoleDraftGuard(Boolean(busy || pendingAction || otherReceipt || needsRefresh), UNCONFIRMED_WRITE_CLOSE_MESSAGE);
  useEffect(() => pendingAction && state.kind === "ready" ? manageOperatorReceipt(pendingAction.commandId) : undefined, [pendingAction?.commandId, state.kind]);
  useEffect(() => {
    if (!pendingAction || busy) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== recoveryFocusOriginRef.current && active.isConnected) return;
      document.getElementById("reward-recovery-heading")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingAction?.commandId, busy]);

  // Event switch resets explicit local banners (never a key remount).
  useEffect(() => {
    setBusy(null);
    setFailure(null);
    setNotice(null);
    setRewardPending(null);
    setPendingAction(null);
    pendingRewardActionRef.current = null;
    actionRef.current = null;
    busyGateRef.current = false;
    hadOtherReceiptRef.current = false;
    setChecking(false);
    setNeedsRefresh(false);
    setAbandonConfirm(false);
    setLoadedEventId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function load(silent = false): Promise<boolean> {
      const requestEventId = eventId;
      const sequence = ++loadSequenceRef.current;
      const current = () => activeEventRef.current === requestEventId && loadSequenceRef.current === sequence;
      const fail = (message: string) => {
        if (current()) {
          if (silent && state.kind === "ready" && loadedEventId === requestEventId) setFailure(message);
          else setState({ kind: "failed", message });
        }
        return false;
      };
      try {
        const [meRes, bootRes] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
        ]);
        if (!current()) return false;
        if (meRes.status === 401 || bootRes.status === 401) {
          if (silent) return fail("최신 경품 목록을 불러오지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return false;
        }
        const me = (await meRes.json().catch(() => null)) as {
          user?: { id?: unknown; role?: unknown } | null;
        } | null;
        const data = (await bootRes.json().catch(() => null)) as {
          state?: { events?: unknown; clients?: unknown; workspaces?: unknown; memberships?: unknown } | null;
        } | null;
        if (!current()) return false;
        const bootstrap = data?.state;
        if (!meRes.ok || !bootRes.ok || !me?.user || typeof me.user.id !== "string" || !me.user.id ||
            typeof me.user.role !== "string" || !me.user.role || !bootstrap) {
          return fail(silent ? "최신 경품 목록을 불러오지 못했습니다. 다시 확인하세요." : "경품 정보를 불러오지 못했습니다.");
        }
        const role = typeof me.user.role === "string" ? me.user.role : "";
        const myId = typeof me.user.id === "string" ? me.user.id : "";
        // Raw membership grants ride along untouched (omitted write is full
        // access, [] is read-only); the results probe below re-checks the
        // reward lifecycle through the capability helper.
        const memberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const membership = item as Record<string, unknown>;
              if (typeof membership.accountId !== "string") return [];
              if (typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
            })
          : [];

        const event = (Array.isArray(bootstrap.events) ? bootstrap.events : [])
          .map(record)
          .find((item) => item?.id === eventId);
        const workspace = record((bootstrap.workspaces ?? {})[eventId as keyof object]);
        if (!event || !workspace) {
          return fail(silent ? "최신 경품 목록을 확인하지 못했습니다. 현재 행사 접근 권한을 확인하세요." : "행사를 찾을 수 없습니다.");
        }
        if (!Array.isArray(workspace.rewards)) {
          return fail(silent ? "최신 경품 목록을 불러오지 못했습니다. 다시 확인하세요." : "경품 정보를 불러오지 못했습니다.");
        }
        const clients = Array.isArray(bootstrap.clients) ? bootstrap.clients.map(record) : [];
        const clientName = clients.find((client) => client?.id === event.clientId)?.name;
        const venue = record(workspace.venue);
        const names = new Map<string, string>();
        const people = new Map<string, Array<Record<string, unknown>>>();
        if (Array.isArray(workspace.participants)) {
          for (const item of workspace.participants) {
            const person = record(item);
            const id = participantIdentifier(person?.id);
            if (person && id) {
              names.set(id, text(person.name, "이름 미등록"));
              people.set(id, [...(people.get(id) ?? []), person]);
            }
          }
        }
        // A draw reward points at a draw program (source.programId), not at a
        // participation module: looking the name up in the module list made
        // every draw prize read as "연결 추첨 확인 필요".
        const drawTitles = new Map<string, string>();
        if (Array.isArray(workspace.drawPrograms)) {
          for (const item of workspace.drawPrograms) {
            const program = record(item);
            if (program && typeof program.id === "string") {
              drawTitles.set(program.id, text(program.name, "제목 없는 추첨"));
            }
          }
        }
        const rewards: Reward[] = Array.isArray(workspace.rewards)
          ? workspace.rewards.flatMap((item) => {
              const reward = record(item);
              if (!reward || typeof reward.id !== "string") return [];
              const source = record(reward.source);
              const programId = text(source?.programId);
              const company = text(reward.company);
              const recipientId = participantIdentifier(reward.participantId);
              const matches = people.get(recipientId) ?? [];
              const person = matches.length === 1 ? matches[0] : null;
              const participantStatus = text(person?.status).toUpperCase();
              const participantIssue: Reward["participantIssue"] = !person ? "missing"
                : participantStatus === "CANCELLED" ? "cancelled"
                : person.cancelled === true || person.ticketReview === "cancelled" ? "conflict"
                : participantStatus !== "APPROVED" ? "unapproved" : "";
              return [{
                id: reward.id,
                participantId: recipientId,
                name: text(reward.name, "경품명 미등록"),
                method: text(reward.method, "ONSITE"),
                status: text(reward.status),
                at: text(reward.at),
                code: text(reward.code),
                participantName: names.get(recipientId) ?? (company || "참가자 확인 필요"),
                company,
                programTitle: programId ? drawTitles.get(programId) ?? "연결 추첨 확인 필요" : "",
                drawProgramId: programId,
                pendingAssignee: reward.status === "PENDING"
                  && recipientId === ""
                  && source?.kind === "draw",
                participantIssue,
              }];
            })
          : [];
        if (!current()) return false;
        setState({
          kind: "ready",
          eventName: text(event.name, eventId),
          eventMeta: formatConsoleEventMeta({
            clientName: text(clientName),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue: text(venue?.name),
          }),
          // Domain writes stop at ARCHIVED on the server; the desk mirrors
          // that below while the list itself stays readable on every stage.
          eventStage: text(event.stage),
          featureOn: Array.isArray(event.features) && event.features.includes("reward"),
          role,
          userId: myId,
          memberships,
          rewards,
        });
        setLoadedEventId(requestEventId);
        return true;
      } catch {
        return fail(silent ? "최신 경품 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요." : "연결하지 못했습니다. 다시 시도하세요.");
      }
  }

  useEffect(() => {
    void load();
    return () => {
      loadSequenceRef.current += 1;
    };
    // The request is restarted only when the event or explicit retry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, reloadTick, router]);

  function keepAttempt(attempt: RewardAttempt | null) {
    pendingRewardActionRef.current = attempt;
    setPendingAction(attempt);
  }

  async function refreshAndSettle(attempt: RewardAttempt): Promise<boolean> {
    if (!await load(true)) return false;
    if (activeEventRef.current !== attempt.eventId || pendingRewardActionRef.current?.commandId !== attempt.commandId) return false;
    acknowledgeOperatorReceipt(attempt.commandId);
    forgetOperatorReceipt(attempt.commandId);
    keepAttempt(null);
    setFailure(null);
    setNotice(attempt.command === "reward.fulfill" ? "경품 처리를 확인하고 최신 목록을 불러왔습니다." : "경품 취소를 확인하고 최신 목록을 불러왔습니다.");
    return true;
  }

  async function sendAttempt(attempt: RewardAttempt) {
    if (busyGateRef.current || activeEventRef.current !== attempt.eventId) return;
    busyGateRef.current = true;
    const running = Symbol("reward-action");
    actionRef.current = running;
    setBusy(attempt.id);
    setFailure(null);
    setNotice(null);
    keepAttempt(attempt);
    const stillCurrent = () => activeEventRef.current === attempt.eventId && actionRef.current === running;
    try {
      const res = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, command: attempt.command, payload: { id: attempt.id } }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown; reward?: unknown } | null;
      if (!stillCurrent()) return;
      if (!res.ok) {
        const participantChanged = res.status === 409 && data?.code === "REWARD_PARTICIPANT_CHANGED";
        if ((!attempt.uncertain || participantChanged) && res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status)) {
          acknowledgeOperatorReceipt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          keepAttempt(null);
          setFailure(typeof data?.error === "string" ? data.error : "경품을 처리하지 못했습니다.");
          if (participantChanged) setNeedsRefresh(true);
        } else {
          keepAttempt({ ...attempt, uncertain: true });
          setFailure("경품 처리 결과를 확인하지 못했습니다. 원래 요청의 서버 처리 여부를 확인하세요.");
        }
        return;
      }
      const expected = attempt.command === "reward.fulfill" ? [attempt.method === "GIFT" ? "NEEDS_CONNECTION" : "RECEIVED"] : ["CANCELLED"];
      if (!rewardRecordMatches(data?.reward, attempt.id, expected)) {
        keepAttempt({ ...attempt, uncertain: true });
        setFailure("경품 처리 결과를 확인하지 못했습니다. 원래 요청의 서버 처리 여부를 확인하세요.");
        return;
      }
      const applied = { ...attempt, applied: true, uncertain: false };
      keepAttempt(applied);
      await refreshAndSettle(applied);
    } catch (error) {
      if (!stillCurrent()) return;
      if (isOrganizationContextBlock(error) && !attempt.uncertain) {
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        keepAttempt(null);
        setFailure("현재 운영사와 행사 권한을 확인한 뒤 다시 시도하세요.");
      } else {
        keepAttempt({ ...attempt, uncertain: true });
        setFailure("경품 처리 결과를 확인하지 못했습니다. 원래 요청의 서버 처리 여부를 확인하세요.");
      }
    } finally {
      if (stillCurrent()) { actionRef.current = null; busyGateRef.current = false; setBusy(null); }
    }
  }

  function runCommand(id: string, command: RewardCommand) {
    if (writeLocked || busyGateRef.current || state.kind !== "ready") return;
    const reward = state.rewards.find((item) => item.id === id);
    if (!reward) return;
    recoveryFocusOriginRef.current = document.activeElement;
    void sendAttempt({ eventId, id, command, commandId: randomCommandId(), label: reward.name, method: reward.method, uncertain: false, applied: false });
  }

  async function recoverAttempt(mode: "status" | "retry" | "refresh") {
    const attempt = pendingRewardActionRef.current;
    if (!attempt || busyGateRef.current || checking || activeEventRef.current !== attempt.eventId) return;
    if (mode === "retry" && (state.kind !== "ready" || !state.featureOn || state.eventStage.toUpperCase() === "ARCHIVED" ||
        !canWriteEvent({ role: state.role, userId: state.userId, memberships: state.memberships, eventId }, "reward.create"))) {
      setFailure("현재 행사 상태나 권한에서는 다시 처리할 수 없습니다. 서버 처리 확인을 이용하세요.");
      return;
    }
    if (mode === "retry") { await sendAttempt(attempt); return; }
    busyGateRef.current = true;
    const running = Symbol("reward-recovery");
    actionRef.current = running;
    setChecking(true);
    setFailure(null);
    const stillCurrent = () => activeEventRef.current === attempt.eventId && actionRef.current === running;
    try {
      let applied = attempt;
      if (mode === "status" && !attempt.applied) {
        const res = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { status?: unknown; command?: unknown } | null;
        if (!stillCurrent()) return;
        if (!(res.ok && body?.status === "APPLIED" && body.command === attempt.command)) {
          setFailure(res.ok && body?.status === "UNCONFIRMED"
            ? "아직 경품 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요."
            : "서버 처리 결과를 확인하지 못했습니다. 연결과 현재 행사 접근 권한을 확인하세요.");
          return;
        }
        applied = { ...attempt, applied: true, uncertain: false };
        keepAttempt(applied);
      }
      if (stillCurrent()) await refreshAndSettle(applied);
    } catch {
      if (stillCurrent()) setFailure("서버 처리 결과를 확인하지 못했습니다. 요청은 다시 보내지 않았습니다.");
    } finally {
      if (stillCurrent()) { actionRef.current = null; busyGateRef.current = false; setChecking(false); }
    }
  }

  async function refreshAfterReceipt() {
    if (checking || busyGateRef.current) return;
    const requestEventId = eventId;
    busyGateRef.current = true;
    setChecking(true);
    try {
      if (await load(true) && activeEventRef.current === requestEventId) {
        setNeedsRefresh(false);
        setFailure(null);
        setNotice("최신 경품 목록을 확인했습니다.");
      }
    } finally {
      if (activeEventRef.current === requestEventId) { busyGateRef.current = false; setChecking(false); }
    }
  }

  function abandonAttempt() {
    const attempt = pendingRewardActionRef.current;
    if (!attempt || busyGateRef.current || checking) return;
    abandonOperatorAttempt(attempt.commandId);
    forgetOperatorReceipt(attempt.commandId);
    keepAttempt(null);
    setAbandonConfirm(false);
    setNeedsRefresh(true);
    setFailure(null);
    void refreshAfterReceipt();
  }

  useEffect(() => {
    if (hadOtherReceiptRef.current && !otherReceipt && !pendingRewardActionRef.current) {
      setNeedsRefresh(true);
      void refreshAfterReceipt();
    }
    hadOtherReceiptRef.current = otherReceipt;
    // A scoped shared status check or explicit discard requires a fresh list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherReceipt]);

  if (state.kind === "loading" || (state.kind === "ready" && loadedEventId !== eventId)) {
    return (
      <ConsolePage pageId="rewards" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="경품 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="rewards" eventId={eventId}>
        {/* ConsoleStatePanel dispatches eventouch:shell-reload before its "다시 불러오기" callback. */}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }

  const archived = state.eventStage.toUpperCase() === "ARCHIVED";
  // Reward lifecycle (register/assign/fulfill/cancel) is results scope on
  // the server. Neither gate invents access; the server re-checks every
  // command, and the list itself stays readable on every stage.
  const canWriteRewards = canWriteEvent({ role: state.role, userId: state.userId, memberships: state.memberships, eventId }, "reward.create");
  const canAct = canWriteRewards && !archived;
  const rewardSearch = rewardQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleRewards = state.rewards.filter((reward) => {
    if (rewardStatusFilter === "action") {
      if (reward.status !== "READY" && reward.status !== "FAILED") return false;
    } else if (rewardStatusFilter === "assignee") {
      if (reward.status !== "PENDING") return false;
    } else if (rewardStatusFilter === "connection") {
      if (reward.status !== "NEEDS_CONNECTION") return false;
    } else if (rewardStatusFilter === "received") {
      if (reward.status !== "RECEIVED") return false;
    }
    if (!rewardSearch) return true;
    return `${reward.participantName} ${reward.company} ${reward.name} ${reward.programTitle}`
      .toLocaleLowerCase("ko-KR")
      .includes(rewardSearch);
  });
  const hasRewardFilter = rewardSearch !== "" || rewardStatusFilter !== "";
  function clearRewardFilters(): void {
    setRewardQuery("");
    setRewardStatusFilter("");
  }

  return (
    <ConsolePage
      pageId="rewards"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      headerActions={(
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자로</Link>
      )}
      toolbar={
        <ConsoleToolbar
          filters={
            <>
              <label>
                <span className="sr-only" id="reward-search-label">경품 검색</span>
                <input
                  aria-labelledby="reward-search-label"
                  type="search"
                  placeholder="참가자·소속·경품명·추첨명 검색"
                  value={rewardQuery}
                  onChange={(event) => setRewardQuery(event.target.value)}
                />
              </label>
              <label>
                <span className="sr-only" id="reward-status-label">상태별 보기</span>
                <select aria-labelledby="reward-status-label" value={rewardStatusFilter} onChange={(event) => setRewardStatusFilter(event.target.value)}>
                  <option value="">전체</option>
                  <option value="action">지급 대기·실패</option>
                  <option value="assignee">수령자 지정 대기</option>
                  <option value="connection">연결 필요</option>
                  <option value="received">수령 완료</option>
                </select>
              </label>
            </>
          }
        />
      }
      feedback={
        <>
          {failure && !pendingAction ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {pendingAction ? (
            <section className={styles.recovery} aria-labelledby="reward-recovery-heading">
              <h2 id="reward-recovery-heading" tabIndex={-1}>경품 처리 확인 필요</h2>
              <p><strong>{pendingAction.label}</strong> · {pendingAction.command === "reward.fulfill" ? "수령 처리" : "경품 취소"}</p>
              {failure ? <p className={styles.recoveryError} role="alert">{failure}</p> : null}
              <p>{busy ? "요청을 확인하고 있습니다." : pendingAction.applied
                ? "서버 처리는 확인됐습니다. 최신 경품 목록을 불러온 뒤 계속할 수 있습니다."
                : "처리됐을 수 있습니다. 서버 처리 확인은 요청을 다시 보내지 않습니다."}</p>
              <div className={styles.recoveryActions}>
                {pendingAction.applied ? (
                  <button type="button" className="button button-primary" disabled={Boolean(busy) || checking || abandonConfirm} onClick={() => void recoverAttempt("refresh")}>최신 목록 다시 확인</button>
                ) : <>
                  <button type="button" className="button button-primary" disabled={Boolean(busy) || checking || abandonConfirm} onClick={() => void recoverAttempt("status")}>서버 처리 확인</button>
                  <button type="button" className="button button-secondary" disabled={Boolean(busy) || checking || abandonConfirm || !canAct || !state.featureOn} onClick={() => void recoverAttempt("retry")}>같은 요청 다시 시도</button>
                </>}
                <button type="button" className="button button-secondary" disabled={Boolean(busy) || checking || abandonConfirm} onClick={() => setAbandonConfirm(true)}>확인 전 그만두기</button>
              </div>
              {abandonConfirm ? <ConsoleConfirm
                summary="이미 처리된 경품은 되돌아가지 않습니다. 확인을 그만두고 최신 목록을 볼까요?"
                confirmLabel="확인 그만두기"
                onConfirm={abandonAttempt}
                onCancel={() => setAbandonConfirm(false)}
              /> : null}
            </section>
          ) : null}
          {otherReceipt && !pendingAction ? <ConsoleFeedback kind="warning">이전 경품 처리 결과를 화면 위의 ‘처리 결과 확인’에서 먼저 확인하세요.</ConsoleFeedback> : null}
          {needsRefresh && !pendingAction ? <ConsoleFeedback kind="warning">
            최신 경품 목록을 확인한 뒤 다시 처리할 수 있습니다.{" "}
            <button type="button" className="button button-secondary" disabled={checking} onClick={() => void refreshAfterReceipt()}>경품 목록 다시 확인</button>
          </ConsoleFeedback> : null}
          {!canAct && !archived ? (
            <ConsoleFeedback kind="warning">지급 처리 권한이 없습니다. 처리가 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {canWriteRewards && archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 변경할 수 없습니다. 경품 목록 확인은 계속할 수 있습니다.</ConsoleFeedback>
          ) : null}
          {!state.featureOn ? (
            <ConsoleFeedback kind="warning">
              경품 기능이 꺼져 있습니다.{" "}
              <Link href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</Link>에서 먼저 켜세요.
            </ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <ConsoleSection
        headingId="rewards-list"
        title="경품 목록"
        description="경품 등록은 참가자 화면에서, 지급 처리는 여기서 합니다. 참가 확정자에게만 등록할 수 있습니다."
        surface="plain"
        width="full"
      >
        <p className="participant-count" role="status">
          {hasRewardFilter
            ? `${visibleRewards.length}개 / 전체 ${state.rewards.length}개`
            : `전체 ${state.rewards.length}개`}
          {hasRewardFilter ? (
            <>
              {" "}
              <button type="button" className="button button-secondary" onClick={clearRewardFilters}>
                검색·필터 지우기
              </button>
            </>
          ) : null}
        </p>
        {!state.rewards.length ? (
          <div className={consoleUiStyles.empty}>
            <h3>등록된 경품이 없습니다.</h3>
            <p>참가자 화면에서 참가 확정자에게 경품을 등록하세요.</p>
          </div>
        ) : !visibleRewards.length ? (
          <div className={consoleUiStyles.empty}>
            <h3>조건에 맞는 경품이 없습니다.</h3>
            <p>검색어·상태 조건을 바꾸거나 지우고 다시 찾아보세요.</p>
            <p>
              <button type="button" className="button button-secondary" onClick={clearRewardFilters}>
                검색·필터 지우기
              </button>
            </p>
          </div>
        ) : (
          <ul className={consoleUiStyles.collection} aria-label="경품 목록">
            {visibleRewards.map((reward) => (
              <li className={consoleUiStyles.recordRow} key={reward.id}>
                <div className={consoleUiStyles.recordMain}>
                  <strong>{reward.name}</strong>
                  <p className={consoleUiStyles.recordMeta}>
                    {reward.participantName} · {methodLabel(reward.method)} · {statusLabel(reward.status)}
                  </p>
                  {(reward.status === "READY" || reward.status === "FAILED") && reward.participantIssue ? <p id={`reward-participant-${reward.id}`} className={consoleUiStyles.recordMeta} role="note">
                    {reward.participantIssue === "conflict" ? "신청 상태와 취소 기록이 일치하지 않습니다."
                      : reward.participantIssue === "cancelled" ? "참가가 취소되어 수령을 처리할 수 없습니다."
                      : reward.participantIssue === "unapproved" ? "참가 확정 후 수령을 처리할 수 있습니다."
                      : "수령자의 참가자 정보를 확인할 수 없습니다."}{" "}
                    <Link href={`/console/events/${encodeURIComponent(eventId)}/participants${reward.participantIssue === "conflict" ? "?ticket=review" : ""}`}>참가자 명단에서 확인</Link>
                  </p> : null}
                  {reward.pendingAssignee ? (
                    <p className={consoleUiStyles.recordMeta}>
                      {reward.company ? `${reward.company} 업체 당첨` : "업체 당첨"}
                      {reward.programTitle ? ` · ${reward.programTitle}` : ""} · 수령자를 지정한 뒤 지급할 수 있습니다.
                      {canAct && state.featureOn ? (
                        <>
                          {" "}
                          <Link
                            href={reward.drawProgramId
                              ? `/console/events/${encodeURIComponent(eventId)}/draws#draw-program-${encodeURIComponent(reward.drawProgramId)}`
                              : `/console/events/${encodeURIComponent(eventId)}/draws#draws-programs`}
                          >
                            추첨에서 수령자 지정
                          </Link>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  <p className={consoleUiStyles.recordMeta}>
                    등록 {formatTime(reward.at)}
                    {reward.code ? ` · 코드 ${reward.code}` : ""}
                  </p>
                </div>
                <div className={consoleUiStyles.recordActions}>
                  {state.featureOn && canAct && (reward.status === "READY" || reward.status === "FAILED") ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={writeLocked || Boolean(reward.participantIssue)}
                      aria-describedby={reward.participantIssue ? `reward-participant-${reward.id}` : undefined}
                      onClick={() => {
                        // The server refuses a cancel once the prize is
                        // received, so the one irreversible step asks first —
                        // in place, with the same summary as before.
                        if (!writeLocked) setRewardPending({ id: reward.id, command: "reward.fulfill" });
                      }}
                    >
                      {busy === reward.id ? "처리 중…" : reward.method === "GIFT" ? "기프티콘 지급(모의)" : "수령 처리"}
                    </button>
                  ) : null}
                  {state.featureOn && canAct && reward.status !== "RECEIVED" && reward.status !== "CANCELLED" ? (
                    <button
                      type="button"
                      className="button button-danger"
                      disabled={writeLocked}
                      onClick={() => {
                        if (!writeLocked) setRewardPending({ id: reward.id, command: "reward.cancel" });
                      }}
                    >
                      취소
                    </button>
                  ) : null}
                </div>
                {rewardPending?.id === reward.id ? (
                  <ConsoleConfirm
                    summary={confirmLines(
                      rewardPending.command === "reward.fulfill" ? fulfillSummary(reward) : cancelSummary(reward)
                    )}
                    confirmLabel={rewardPending.command === "reward.fulfill" ? "처리한다" : "취소한다"}
                    busy={busy === reward.id}
                    onConfirm={() => {
                      const pending = rewardPending;
                      setRewardPending(null);
                      void runCommand(pending.id, pending.command);
                    }}
                    onCancel={() => setRewardPending(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}
