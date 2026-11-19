"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ProductLink from "../../../ui/ProductLink";
import ProductButton from "../../../ui/ProductButton";
import QRCode from "react-qr-code";
import { useScreenWakeLock } from "../../../../lib/use-screen-wake-lock";
import styles from "./ticket.module.css";
import { isRecoveryBlocked, useVerificationMode } from "../../../../lib/use-verification-mode";
import { forgetRecoveredTicket, readRecoveredTicket } from "./recovered-ticket";
import PublicEventContext from "../PublicEventContext";
import EventBanner from "../EventBanner";
import EventFacts from "../EventFacts";
import AttendeeIcon from "../AttendeeIcons";
import AttendeeStateMessage from "../ui/AttendeeStateMessage";
import BottomAction from "../ui/BottomAction";
import { DEFAULT_ATTENDEE_THEME, type AttendeeTheme } from "../event-theme";
import { readPublicEventContext } from "../../../../lib/public-event-context";
import type { PublicEventContext as EventContext } from "../../../../lib/public-event-context";
import { allowSessionForTab, clearSessionForTab, clearTicketRejected, getAllowedTicketForTab, isTicketRejected, markTicketRejected, REJECTED_TICKET_BEARER, ticketStorageAvailable } from "../../../../lib/attendee-ticket-identity";

type TicketState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed"; message: string; canRecover?: boolean }
  | {
      kind: "ready";
      ticket: string;
      name: string;
      company: string;
      status: string;
      paymentStatus: string;
      inside: boolean;
      everIn: boolean;
      eventName: string;
      eventDate: string;
      eventContext: EventContext;
      application: Array<{ label: string; value: string }>;
      // True only on the navigation that follows a fresh registration: the
      // bearer and this flag arrive together and are cleaned together, so a
      // refresh or a shared link never replays the receipt.
      fresh: boolean;
      recovered: boolean;
    };

function entryLabel(state: {
  inside: boolean;
  everIn: boolean;
  status: string;
  paymentStatus: string;
  ticket: string;
}): string {
  const usable =
    Boolean(state.ticket) &&
    state.status === "APPROVED" &&
    (state.paymentStatus === "FREE" || state.paymentStatus === "PAID");
  if (usable) {
    if (state.inside) return "입장 중";
    if (state.everIn) return "퇴장 · 재입장 정책 확인";
    return "참가 확정";
  }
  if (state.status === "PENDING") return "승인 대기";
  if (state.status === "WAITLIST") return "대기 명단";
  if (state.status === "CANCELLED") return "신청 취소";
  if (state.status === "APPROVED" && (state.paymentStatus === "FREE" || state.paymentStatus === "PAID")) return "티켓 확인 필요";
  if (state.status === "APPROVED") return "결제 확인 필요";
  return "상태 확인 필요";
}

const STORAGE_PREFIX = "eventouch.ticket.";
const TICKET_READ_TIMEOUT_MS = 8000;

type TicketResponse = {
  error?: unknown;
  event?: { name?: unknown; date?: unknown; start?: unknown; end?: unknown; features?: unknown } | null;
  participant?: Record<string, unknown> | null;
  workspace?: unknown;
};

async function readTicket(slug: string, bearer: string, controller: AbortController, allowSession = true) {
  const timeout = window.setTimeout(() => controller.abort(), TICKET_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/ticket`, {
      cache: "no-store",
      credentials: allowSession ? "same-origin" : "omit",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as TicketResponse | null;
    // A 404 header is already a definite verdict even if its body stalls.
    if (res.status !== 404 && controller.signal.aborted) throw controller.signal.reason;
    return { res, data };
  } finally {
    window.clearTimeout(timeout);
  }
}

// Only the authenticated participant and the currently published field
// definitions may contribute to this view. Never enumerate unknown answers.
function applicationRows(participant: Record<string, unknown>, workspace: unknown): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const [key, label] of [["name", "이름"], ["company", "소속"], ["phone", "연락처"], ["email", "이메일"]] as const) {
    const value = participant[key];
    if (typeof value === "string" && value.trim()) rows.push({ label, value });
  }
  const source = workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : {};
  const answers = participant.answers && typeof participant.answers === "object" && !Array.isArray(participant.answers)
    ? participant.answers as Record<string, unknown> : {};
  if (Array.isArray(source.publishedFields)) for (const item of source.publishedFields) {
    if (!item || typeof item !== "object") continue;
    const field = item as Record<string, unknown>;
    if (typeof field.id !== "string" || typeof field.label !== "string" || !field.label.trim()) continue;
    if (!Object.hasOwn(answers, field.id)) continue;
    const answer = answers[field.id];
    const value = typeof answer === "string" ? answer : typeof answer === "boolean" ? (answer ? "예" : "아니요") : typeof answer === "number" && Number.isFinite(answer) ? String(answer) : Array.isArray(answer) ? answer.filter((v): v is string => typeof v === "string").join(", ") : "";
    if (value.trim()) rows.push({ label: field.label, value });
  }
  return rows;
}

// The receipt copy reads as a bold first sentence and the rest as the explanation.
function firstSentence(text: string): { head: string; rest: string } {
  const cut = text.indexOf(". ");
  return cut < 0 ? { head: text, rest: "" } : { head: text.slice(0, cut + 1), rest: text.slice(cut + 2) };
}

function unusableCopy(state: { status: string; paymentStatus?: string; ticket: string }): { text: string; showRegister: boolean } {
  // A submitted application must read as a receipt, never as a broken
  // ticket. Each state names what happens next.
  // The server marks payment PENDING even while approval is still pending,
  // so an approval-only promise would be false on a paid event: name both
  // gates when the payment flag is explicitly set. Records without the flag
  // keep the old wording.
  const paymentGate = state.paymentStatus === "PENDING";
  switch (state.status) {
    case "PENDING":
      return {
        text: paymentGate
          ? "신청이 접수되었습니다. 운영자 승인과 결제 확인 후 상태를 다시 확인하면 입장 QR을 볼 수 있습니다."
          : "신청이 접수되었습니다. 운영자 승인 후 상태를 다시 확인하면 입장 QR을 볼 수 있습니다.",
        showRegister: false,
      };
    case "WAITLIST":
      return {
        text: paymentGate
          ? "대기 명단에 등록되어 있습니다. 자리가 나면 운영자가 확정할 수 있습니다. 확정과 결제 확인 후 상태를 다시 확인하세요."
          : "대기 명단에 등록되어 있습니다. 자리가 나면 운영자가 확정할 수 있습니다. 확정 안내를 받았다면 상태를 다시 확인하세요.",
        showRegister: false,
      };
    case "CANCELLED":
      return { text: "신청이 취소된 상태입니다. 다시 참가하려면 새로 신청하세요.", showRegister: true };
    case "APPROVED":
      if ((state.paymentStatus === "FREE" || state.paymentStatus === "PAID") && !state.ticket) {
        return { text: "입장 QR을 확인할 수 없습니다. 상태를 다시 확인하고, 계속되면 행사 운영자에게 문의하세요.", showRegister: false };
      }
      if (state.paymentStatus === "PENDING") return { text: "참가 확정까지 결제 확인이 남았습니다. 안내받은 방법으로 결제를 마친 뒤 다시 여세요.", showRegister: false };
      return { text: "결제 상태를 확인할 수 없습니다. 상태를 다시 확인하고, 계속되면 행사 운영자에게 문의하세요.", showRegister: false };
    default:
      return { text: "신청 상태를 확인할 수 없습니다. 상태를 다시 확인하고, 계속되면 행사 운영자에게 문의하세요.", showRegister: false };
  }
}

function readStoredTicket(slug: string): string {
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + slug) || "";
  } catch {
    return "";
  }
}

function storeTicket(slug: string, ticket: string): boolean {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + slug, ticket);
    return true;
  } catch {
    return false;
  }
}

function clearStoredTicket(slug: string): void {
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + slug);
  } catch {
    // Nothing to clear.
  }
}

function rememberRejectedTicket(slug: string): void {
  markTicketRejected(slug);
}

export default function TicketView({ slug, initialTicket = "", mode = "ticket", theme = DEFAULT_ATTENDEE_THEME }: { slug: string; initialTicket?: string; mode?: "ticket" | "application"; theme?: AttendeeTheme }) {
  // The ticket screen is a pass on the event's own ground. Inside the attendee
  // home (application mode) the surrounding page already owns the look.
  const pass = mode === "ticket";
  const [state, setState] = useState<TicketState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  // Keep the last confirmed receipt or QR visible while refreshing.
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const recheckRequestRef = useRef<AbortController | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  // In-tab bearer memory: sessionStorage can refuse ticket keys (private or
  // restricted modes) while this tab still holds a valid ticket. The ref
  // carries the current bearer across status retries without persisting it
  // anywhere new: no persistent DOM store, no cookie, no URL. It is scoped to this
  // slug and cleared the moment the server definitively rejects the bearer.
  const ticketRef = useRef<{ slug: string; ticket: string }>({ slug: "", ticket: "" });
  // Retain a recovery handoff across a cancelled/restarted load without
  // letting an older ticketRef stand in for the newly verified person.
  const recoveryRef = useRef<{ slug: string; ticket: string }>({ slug: "", ticket: "" });
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      // A newer load owns the screen: invalidate in-flight manual
      // re-checks, clear their checking/error voice, and never let their
      // late responses write afterwards.
      recheckSeqRef.current += 1;
      setRechecking(false);
      setRecheckError(null);
      // A new slug never inherits another event's bearer.
      if (ticketRef.current.slug !== slug) ticketRef.current = { slug, ticket: "" };
      if (recoveryRef.current.slug !== slug) recoveryRef.current = { slug, ticket: "" };
      const query = new URLSearchParams(window.location.search);
      const storageUsable = ticketStorageAvailable(slug);
      setStorageAvailable(storageUsable);
      const fromLink = query.get("ticket") || "";
      const recoveryMode = query.get("recovered");
      const fromRecovery = recoveryMode === "stored" || recoveryMode === "memory"
        ? readRecoveredTicket(slug) || recoveryRef.current.ticket || (recoveryMode === "stored" ? readStoredTicket(slug) : "")
        : "";
      const hasRecovery = recoveryMode === "stored" || recoveryMode === "memory";
      if (hasRecovery && fromRecovery) recoveryRef.current = { slug, ticket: fromRecovery };
      // Recovery is an explicit request to open the session's attendee,
      // even if this tab still contains a different participant's bearer.
      const preferSession = !fromLink && query.get("session") === "1";
      const rejected = !fromLink && !hasRecovery && !preferSession &&
        (query.get("ticket-error") === "1" || isTicketRejected(slug));
      // A fresh registration arrives with registered=1 on the same
      // navigation as the bearer; it reads as a completion receipt once.
      const justRegistered = query.get("registered") === "1" && Boolean(fromLink);
      // Consume the bearer once: it must not linger in history or a shared
      // link. The tab keeps it in sessionStorage when available, otherwise
      // in this tab's memory only. A venue refresh or a dropped connection
      // restores from sessionStorage (or the verified session); when both
      // are unavailable a full reload loses the ticket and this screen
      // falls back to the missing state with the recovery guidance below.
      // No offline persistence is added: the bearer never outlives the tab.
      if (fromLink) {
        clearSessionForTab(slug);
        clearTicketRejected(slug);
        setStorageAvailable(storeTicket(slug, fromLink));
        ticketRef.current = { slug, ticket: fromLink };
      }
      query.delete("ticket");
      query.delete("registered");
      if (fromLink || hasRecovery || preferSession) query.delete("ticket-error");
      if (!preferSession) query.delete("session");
      const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", cleaned);
      // Explicit recovery must never fall through to an older tab bearer or
      // the browser's shared session if its per-tab handoff has disappeared.
      const ticket = rejected ? REJECTED_TICKET_BEARER : hasRecovery ? fromRecovery : preferSession ? "" : fromLink || ticketRef.current.ticket || initialTicket || getAllowedTicketForTab(slug) || (storageUsable ? readStoredTicket(slug) : "");
      if (hasRecovery && !ticket) {
        if (!cancelled) setState({ kind: "failed", message: "인증한 티켓을 이 탭에서 확인하지 못했습니다. 연락처를 다시 인증하세요.", canRecover: true });
        return;
      }
      try {
        const { res, data } = await readTicket(slug, ticket, controller, preferSession || Boolean(ticket) || storageUsable);
        if (!res.ok || !data?.participant) {
          // The server says this link is not usable; stop replaying it.
          // Without any credential (fresh tab, cleared storage) this is the
          // normal "come back" state, not an error. Late responses from a
          // superseded load must not clobber the current tab's bearer or
          // storage: only the mounted load owns those writes.
          if (res.status === 404 && ticket && !cancelled) {
            if (!(hasRecovery && recoveryMode === "memory")) clearStoredTicket(slug);
            ticketRef.current = { slug, ticket: "" };
            rememberRejectedTicket(slug);
          }
          if (!cancelled) {
            if (!ticket && (res.status === 401 || res.status === 404)) setState({ kind: "missing" });
            else {
              setState({
                kind: "failed",
                message:
                  typeof data?.error === "string"
                    ? data.error
                    : "티켓을 확인할 수 없습니다. 신청 연락처 인증으로 다시 연결하세요.",
                canRecover: res.status === 404,
              });
            }
          }
          return;
        }
        const participant = data.participant;
        const text = (value: unknown): string =>
          typeof value === "string" ? value : "";
        // Session restores carry the token inside the payload; keep it in
        // tab memory (ref, plus sessionStorage when available), exactly
        // like the link-consumed bearer.
        const resolvedTicket = ticket || text(participant.ticket);
        if (!cancelled) {
          clearTicketRejected(slug);
          if (resolvedTicket) {
            ticketRef.current = { slug, ticket: resolvedTicket };
            const stored = storeTicket(slug, resolvedTicket);
            setStorageAvailable(stored && storageUsable);
            // The verified identity replaces an earlier in-memory ticket,
            // even if storage became available during recovery. If the
            // write fails, retain only the newly verified ticket in memory.
            if (stored && storageUsable) clearSessionForTab(slug);
            else allowSessionForTab(slug, resolvedTicket);
            if (!fromLink && (preferSession || (hasRecovery && stored))) {
              if (hasRecovery && stored) forgetRecoveredTicket(slug);
              query.delete("session");
              query.delete("recovered");
              const destination = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
              window.history.replaceState(null, "", destination);
            }
          }
          // A session may return a status-only record with no ticket. Do
          // not let the next reload silently select a different session.
          if (!resolvedTicket && !ticket) rememberRejectedTicket(slug);
          setState({
            kind: "ready",
            ticket: resolvedTicket,
            name: text(participant.name),
            company: text(participant.company),
            status: text(participant.status),
            paymentStatus: text(participant.paymentStatus),
            inside: participant.inside === true,
            everIn: participant.everIn === true,
            eventName: text(data.event?.name),
            eventDate: text(data.event?.date),
            eventContext: readPublicEventContext(data.event, data.workspace),
            application: applicationRows(participant, data.workspace),
            fresh: justRegistered,
            recovered: preferSession || hasRecovery,
          });
        }
      } catch {
        if (!cancelled) {
          setState({
            kind: "failed",
            message: controller.signal.aborted
              ? "티켓 응답이 지연되고 있습니다. 다시 시도하세요."
              : "연결하지 못했습니다. 다시 시도하세요.",
          });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
      // An unmounted screen must not receive the manual re-check's late
      // writes either (state, bearer, or storage).
      recheckSeqRef.current += 1;
      recheckRequestRef.current?.abort();
    };
  }, [slug, reloadTick, initialTicket]);

  const usable = state.kind === "ready" && Boolean(state.ticket) && state.status === "APPROVED" &&
    (state.paymentStatus === "FREE" || state.paymentStatus === "PAID");
  const showingQr = usable && mode === "ticket";
  // The attendee holds this screen up at the desk: do not let it dim there.
  useScreenWakeLock(showingQr);
  const recheckSeqRef = useRef(0);
  const liveSlugRef = useRef(slug);
  liveSlugRef.current = slug;
  const recheckTicket = useCallback(async () => {
    if (recheckRequestRef.current || state.kind !== "ready") return;
    const requestSlug = slug;
    const bearer = ticketRef.current.ticket || state.ticket;
    const seq = ++recheckSeqRef.current;
    const live = () => recheckSeqRef.current === seq && liveSlugRef.current === requestSlug;
    const controller = new AbortController();
    recheckRequestRef.current = controller;
    const retryMessage = showingQr
      ? "최신 상태를 확인하지 못했습니다. 이 QR의 입장 가능 여부는 확정되지 않았습니다. 다시 시도하세요."
      : "최신 상태를 확인하지 못했습니다. 마지막으로 확인한 신청 정보입니다. 다시 시도하세요.";
    setRechecking(true);
    setRecheckError(null);
    try {
      const { res, data } = await readTicket(requestSlug, bearer, controller);
      // A newer slug or a superseding load owns the screen now: drop this
      // late response instead of writing another event's state or bearer.
      if (!live()) return;
      if (!res.ok || !data?.participant) {
        if (res.status === 404 && bearer) {
          clearStoredTicket(requestSlug);
          if (ticketRef.current.slug === requestSlug) ticketRef.current = { slug: requestSlug, ticket: "" };
          rememberRejectedTicket(requestSlug);
        }
        if (res.status === 404) {
          setState({
            kind: "failed",
            message:
              typeof data?.error === "string"
                ? data.error
                : "티켓을 확인할 수 없습니다.",
            canRecover: true,
          });
        } else {
          setRecheckError(retryMessage);
        }
        return;
      }
      const participant = data.participant;
      const text = (value: unknown): string =>
        typeof value === "string" ? value : "";
      const resolvedTicket = bearer || text(participant.ticket);
      if (!live()) return;
      if (resolvedTicket) {
        ticketRef.current = { slug: requestSlug, ticket: resolvedTicket };
        setStorageAvailable(storeTicket(requestSlug, resolvedTicket));
      }
      setState({
        kind: "ready",
        ticket: resolvedTicket,
        name: text(participant.name),
        company: text(participant.company),
        status: text(participant.status),
        paymentStatus: text(participant.paymentStatus),
        inside: participant.inside === true,
        everIn: participant.everIn === true,
        eventName: text(data.event?.name),
        eventDate: text(data.event?.date),
        eventContext: readPublicEventContext(data.event, data.workspace),
        application: applicationRows(participant, data.workspace),
        fresh: false,
        recovered: false,
      });
    } catch {
      if (!live()) return;
      setRecheckError(retryMessage);
    } finally {
      if (recheckRequestRef.current === controller) recheckRequestRef.current = null;
      if (live()) setRechecking(false);
    }
  }, [showingQr, slug, state]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const recheckVisibleTicket = () => {
      if (document.visibilityState === "visible") void recheckTicket();
    };
    const recheckRestoredTicket = (event: PageTransitionEvent) => {
      if (event.persisted) recheckVisibleTicket();
    };
    document.addEventListener("visibilitychange", recheckVisibleTicket);
    window.addEventListener("pageshow", recheckRestoredTicket);
    return () => {
      document.removeEventListener("visibilitychange", recheckVisibleTicket);
      window.removeEventListener("pageshow", recheckRestoredTicket);
    };
  }, [recheckTicket, state.kind]);

  if (state.kind === "loading") {
    return <div className={`ticket-state${pass ? ` ${styles.passMessage}` : ""}`}>
      <AttendeeStateMessage kind="info" icon="clock" title="티켓을 확인하고 있습니다.">
        확인이 오래 걸리면 인터넷 연결을 확인해 주세요.
      </AttendeeStateMessage>
      {/* Native reload still works if hydration fails; once hydrated, retry
          in place so a memory-only bearer survives without entering markup. */}
      <a className={styles.ticketLoadingRetry} href="" onClick={(event) => {
        event.preventDefault();
        setReloadTick((value) => value + 1);
      }}>다시 불러오기</a>
    </div>;
  }
  // The next step of a message screen: the first action is the strong one fixed
  // to the bottom, the second sits beside it, any more stay as quiet links.
  type StateAction = { label: string; href?: string; onClick?: () => void };
  const stateActions = (actions: StateAction[]) => (
    <>
      {actions.slice(2).length ? (
        <p className={styles.ticketMessageActions}>
          {actions.slice(2).map((action) => (
            <ProductLink key={action.label} variant="ghost" href={action.href ?? "#"} onClick={action.onClick}>{action.label}</ProductLink>
          ))}
        </p>
      ) : null}
      <BottomAction label="다음 행동" primary={actions[0]} secondary={actions[1]} />
    </>
  );
  if (state.kind === "missing") {
    const ticketBase = `/event/${encodeURIComponent(slug)}`;
    const actions: StateAction[] = [];
    if (recoveryBlocked) actions.push({ label: "처음 신청하기", href: `${ticketBase}/register` }, { label: "행사 안내 확인", href: ticketBase });
    else actions.push({ label: "연락처 인증으로 티켓 다시 찾기", href: `${ticketBase}/ticket/recover` }, { label: "처음 신청하기", href: `${ticketBase}/register` });
    return (
      <section className={`${styles.ticketCard} ${styles.ticketMessage}${pass ? ` ${styles.passMessage}` : ""}`}>
        {pass ? <span className={styles.messageIcon} data-tone="wait"><AttendeeIcon name="ticket" size={26} /></span> : null}
        {/* Same state, same words as the home entries: the attendee has no
            ticket here, and the way forward is the same everywhere. */}
        <h1>티켓이 확인되지 않습니다</h1>
        <AttendeeStateMessage kind="info" icon="ticket" className={styles.messageInline} title={!storageAvailable ? "이 탭에서 티켓이 확인되지 않습니다." : "이 브라우저에 티켓이 보관되어 있지 않습니다."}>
          {!storageAvailable ? null : recoveryBlocked
            ? "이 행사는 문자로 다시 연결할 수 없으므로 신청을 완료한 브라우저 탭을 확인하세요. 탭을 찾을 수 없다면 행사 주최 측에 문의하세요."
            : "신청할 때 쓴 연락처를 인증하면 다시 열 수 있습니다."}
        </AttendeeStateMessage>
        {!storageAvailable ? <p className={styles.ticketIdentityNotice}>브라우저 저장소를 사용할 수 없어 자동으로 티켓을 불러오지 않았습니다. 확인하면 이 브라우저에서 마지막으로 인증한 참가자의 티켓이 열립니다.</p> : null}
        {/* A plain link on purpose: the document reloads with ?session=1 so the ticket is read again from the verified session. */}
        {!storageAvailable ? <p className={styles.ticketMessageActions}><a className={styles.sessionCheck} href={`${ticketBase}/ticket?session=1`}>이 브라우저에서 인증된 티켓 확인</a></p> : null}
        {stateActions(actions)}
      </section>
    );
  }
  if (state.kind === "failed") {
    // A 404 ticket with no SMS route behind it cannot be reconnected: the
    // recover screen would only repeat that verdict, so it steps aside for
    // device + operator guidance.
    const showRecover = state.canRecover && !recoveryBlocked;
    const actions: StateAction[] = [];
    if (showRecover) actions.push({ label: "연락처 인증으로 티켓 다시 찾기", href: `/event/${encodeURIComponent(slug)}/ticket/recover` });
    if (!state.canRecover) actions.push({ label: "다시 시도", onClick: () => { setState({ kind: "loading" }); setReloadTick((tick) => tick + 1); } });
    actions.push({ label: "행사 안내로", href: `/event/${encodeURIComponent(slug)}` });
    return (
      <section className={`${styles.ticketCard} ${styles.ticketMessage}${pass ? ` ${styles.passMessage}` : ""}`}>
        {pass ? <span className={styles.messageIcon} data-tone="bad"><AttendeeIcon name="info" size={26} /></span> : null}
        <h1>티켓을 사용할 수 없습니다</h1>
        <AttendeeStateMessage kind="error" className={styles.messageInline} title={state.message}>
          {state.canRecover
            ? `새 티켓 안내 링크를 확인하세요. ${recoveryBlocked
              ? "새 티켓을 받지 못했다면 행사 주최 측에 문의하세요."
              : "링크가 없다면 신청 연락처를 인증해 티켓을 다시 찾을 수 있습니다."}`
            : null}
        </AttendeeStateMessage>
        {stateActions(actions)}
      </section>
    );
  }
  // The status re-check is the pass's utility action: the strong one when there is no QR yet
  // (and in the application view), the quiet one beside "참여 콘텐츠 보기" once the QR is in hand.
  const recheckAction = {
    label: rechecking ? "확인 중입니다" : "상태 다시 확인",
    onClick: () => void recheckTicket(),
    disabled: rechecking,
  };
  const recheckFeedback = (
    <>
      {rechecking ? (
        <AttendeeStateMessage kind="info" icon="refresh" className={styles.ticketRecovery}
          title={showingQr ? "최신 상태를 확인하고 있습니다." : "최신 신청 상태를 확인하고 있습니다."}>
          {showingQr ? "확인이 끝날 때까지 이 QR의 입장 가능 여부는 확정되지 않습니다." : null}
        </AttendeeStateMessage>
      ) : null}
      {recheckError ? <AttendeeStateMessage kind="error" className={styles.ticketRecheckError} title={recheckError} /> : null}
    </>
  );
  if (mode === "application") {
    return (
      <section className={`${styles.ticketCard} ${styles.application}`}>
        <header className={styles.ticketHeading}>
          <h1>내 신청 정보</h1>
          <p className={styles.ticketEventName}>{state.eventName}</p>
          <PublicEventContext slug={slug} context={state.eventContext} showDate={false} />
          <p className={styles.ticketEntryState} aria-live="polite" data-tone={usable ? "good" : state.status === "CANCELLED" ? "bad" : "wait"}>{entryLabel(state)}</p>
        </header>
        <p>신청한 정보를 확인할 수 있습니다. 변경이 필요하면 행사 운영자에게 문의하세요.</p>
        {state.application.length ? <dl className={styles.applicationList}>
          {state.application.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl> : <p>표시할 신청 정보가 없습니다.</p>}
        {recheckFeedback}
        <BottomAction label="다음 행동" primary={recheckAction} />
      </section>
    );
  }
  const statusUnconfirmed = showingQr && (rechecking || Boolean(recheckError));
  const tone = usable && !statusUnconfirmed
    ? (state.inside ? "in" : "good")
    : state.status === "CANCELLED" ? "bad" : "wait";
  const facts = (
    <div className={styles.ticketEvent}>
      <EventFacts slug={slug} context={state.eventContext} fallbackDate={state.eventDate} />
    </div>
  );
  const recoveryNote = state.ticket ? !storageAvailable ? (
    <p className={styles.ticketRecovery}>이 브라우저에서 탭 보관이 차단되어 있습니다. 이 화면을 벗어나거나 새로고침하면 티켓을 다시 확인해야 할 수 있습니다. 인증된 세션이 없다면 행사 주최 측에 문의하세요.</p>
  ) : recoveryBlocked ? (
    <p className={styles.ticketRecovery}>
      이 탭에서 티켓을 확인할 수 있습니다. 이 행사에서는 문자로 티켓을 다시 연결할 수 없어
      다른 탭이나 기기에서는 열리지 않을 수 있습니다. 탭을 찾을 수 없다면 행사 주최 측에 문의하세요.
    </p>
  ) : (
    <p className={styles.ticketRecovery}>
      이 탭에서 티켓을 확인할 수 있습니다. 다른 기기에서 열 때는{" "}
      <ProductLink className={styles.inlineLink} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>연락처 인증으로 다시 연결</ProductLink>
      하세요.
    </p>
  ) : null;
  return (
    <div className={styles.ticketStack}>
      {state.recovered ? <p className={styles.ticketSuccess} role="status">연결된 티켓입니다. 참가자 이름이 맞는지 확인하세요.</p> : null}
      {/* Fresh registration lands here directly: the receipt is this banner,
          not a separate screen, and it shows exactly once per signup. It
          must not claim admission before the QR exists: a pending or unpaid
          application gets a receipt, only a usable ticket gets the entry claim. */}
      {state.fresh ? (
        usable ? (
          <p className={styles.ticketSuccess} role="status">신청이 완료되었습니다. 이 화면이 입장권입니다.</p>
        ) : (
          <p className={styles.ticketSuccess} role="status">신청이 접수되었습니다. 아래에서 진행 상태를 확인하세요.</p>
        )
      ) : null}
      <section className={`${styles.ticketCard} ${styles.pass}`}>
        {/* The pass: the event's own banner first, then the band that carries
            the state and the name read at a glance. */}
        <EventBanner theme={theme} title={state.eventName} kicker={<h1>내 티켓</h1>} compact={!usable} />
        <header className={styles.ticketBand} data-tone={tone} data-compact={!usable || undefined}>
          <p className={styles.ticketEntryState} aria-live="polite" data-tone={tone}>
            {statusUnconfirmed ? rechecking ? "상태 확인 중" : "상태 확인 필요" : entryLabel(state)}
          </p>
          <h2 className={styles.ticketAttendeeName}>{state.name}</h2>
          {state.company ? <p className={styles.ticketCompany}>{state.company}</p> : null}
        </header>
        {usable ? (
          <>
            <div className={styles.ticketQrWrapper}>
              <span className={styles.tear} aria-hidden="true"><i /><i /></span>
              {recheckFeedback}
              <div className={styles.ticketQr} role="img" aria-label={`${state.name}님의 행사 입장 및 퇴장용 QR`}>
                <QRCode value={state.ticket} size={220} />
              </div>
              <p className={styles.ticketInstruction}>{statusUnconfirmed
                ? "입장 가능 여부는 현장 데스크에서 확인할 수 있습니다."
                : "입장할 때 이 QR을 보여 주세요. 퇴장할 때도 같은 QR을 사용합니다."}</p>
              <p className={styles.ticketBrightness}><AttendeeIcon name="sun" size={16} />화면을 밝게 하면 더 잘 읽혀요</p>
            </div>
            {facts}
            {/* The next step once the QR is in hand is the event's content, fixed to
                the bottom; the recheck beside it is a quiet utility. */}
            <BottomAction label="다음 행동" primary={{ label: "참여 콘텐츠 보기", href: `/event/${encodeURIComponent(slug)}/engage` }} secondary={recheckAction} />
          </>
        ) : (
          <>
            <div className={styles.ticketPending}>
              <AttendeeStateMessage kind={state.status === "CANCELLED" ? "error" : "info"} icon="info" title={firstSentence(unusableCopy(state).text).head}>
                {firstSentence(unusableCopy(state).text).rest || null}
              </AttendeeStateMessage>
              {recheckFeedback}
              <BottomAction label="다음 행동" primary={recheckAction} />
              {unusableCopy(state).showRegister ? (
                <p className={styles.ticketMessageActions}>
                  <ProductLink className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}/register`}>다시 신청하기</ProductLink>
                </p>
              ) : null}
            </div>
            {facts}
          </>
        )}
        {recoveryNote}
      </section>
    </div>
  );
}
