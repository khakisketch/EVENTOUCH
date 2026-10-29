"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import styles from "./ticket.module.css";
import { isRecoveryBlocked, useVerificationMode } from "../../../../lib/use-verification-mode";

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
      // True only on the navigation that follows a fresh registration: the
      // bearer and this flag arrive together and are cleaned together, so a
      // refresh or a shared link never replays the receipt.
      fresh: boolean;
    };

function entryLabel(state: {
  inside: boolean;
  everIn: boolean;
  status: string;
  paymentStatus: string;
}): string {
  const usable =
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
  if (state.status === "APPROVED") return "결제 확인 필요";
  return "상태 확인 필요";
}

const STORAGE_PREFIX = "eventouch.ticket.";

function unusableCopy(state: { status: string; paymentStatus?: string }): { text: string; showRegister: boolean } {
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
          ? "신청이 접수되었습니다. 운영자 승인과 결제 확인이 끝나면 이 화면에 입장 QR이 표시됩니다."
          : "신청이 접수되었습니다. 운영자가 승인하면 이 화면에 입장 QR이 표시됩니다.",
        showRegister: false,
      };
    case "WAITLIST":
      return {
        text: paymentGate
          ? "대기 명단에 등록되어 있습니다. 자리가 나면 운영자가 승인할 수 있고, 승인과 결제 확인이 끝나면 이 화면에 입장 QR이 표시됩니다."
          : "대기 명단에 등록되어 있습니다. 자리가 나면 운영자가 승인할 수 있고, 승인되면 이 화면에 입장 QR이 표시됩니다.",
        showRegister: false,
      };
    case "CANCELLED":
      return { text: "신청이 취소된 상태입니다. 다시 참가하려면 새로 신청하세요.", showRegister: true };
    case "APPROVED":
      return { text: "참가 확정까지 결제 확인이 남았습니다. 안내받은 방법으로 결제를 마친 뒤 다시 여세요.", showRegister: false };
    default:
      return { text: "신청 정보를 확인하세요. 상태가 바뀌지 않으면 운영자에게 문의하세요.", showRegister: false };
  }
}

function readStoredTicket(slug: string): string {
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + slug) || "";
  } catch {
    return "";
  }
}

function storeTicket(slug: string, ticket: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + slug, ticket);
  } catch {
    // Storage unavailable (private mode): the URL pass-through still works.
  }
}

function clearStoredTicket(slug: string): void {
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + slug);
  } catch {
    // Nothing to clear.
  }
}

export default function TicketView({ slug }: { slug: string }) {
  const [state, setState] = useState<TicketState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  // Manual re-check for an already-usable ticket: the open screen can go
  // stale when the server revokes the ticket (operator cancellation) or
  // reinstates it, and a blind reload is the only other path. The QR stays
  // mounted while checking; only a definitive 404 clears the bearer and
  // ends the stale QR here, exactly like the loading path. Transient
  // failures keep the visible QR and offer another try. No new persistence,
  // no polling, no server change.
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  // In-tab bearer memory: sessionStorage can refuse ticket keys (private or
  // restricted modes) while this tab still holds a valid ticket. The ref
  // carries the current bearer across status retries without persisting it
  // anywhere new: no persistent DOM store, no cookie, no URL. It is scoped to this
  // slug and cleared the moment the server definitively rejects the bearer.
  const ticketRef = useRef<{ slug: string; ticket: string }>({ slug: "", ticket: "" });
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // A newer load owns the screen: invalidate in-flight manual
      // re-checks, clear their checking/error voice, and never let their
      // late responses write afterwards.
      recheckSeqRef.current += 1;
      setRechecking(false);
      setRecheckError(null);
      // A new slug never inherits another event's bearer.
      if (ticketRef.current.slug !== slug) ticketRef.current = { slug, ticket: "" };
      const query = new URLSearchParams(window.location.search);
      const fromLink = query.get("ticket") || "";
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
        storeTicket(slug, fromLink);
        ticketRef.current = { slug, ticket: fromLink };
      }
      query.delete("ticket");
      query.delete("registered");
      const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", cleaned);
      const ticket = fromLink || ticketRef.current.ticket || readStoredTicket(slug);
      try {
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/ticket`,
          ticket
            ? { headers: { authorization: `Bearer ${ticket}` }, cache: "no-store" }
            : { cache: "no-store" }
        );
        const data = (await res.json().catch(() => null)) as {
          error?: unknown;
          event?: { name?: unknown; date?: unknown } | null;
          participant?: Record<string, unknown> | null;
        } | null;
        if (!res.ok || !data?.participant) {
          // The server says this link is not usable; stop replaying it.
          // Without any credential (fresh tab, cleared storage) this is the
          // normal "come back" state, not an error. Late responses from a
          // superseded load must not clobber the current tab's bearer or
          // storage: only the mounted load owns those writes.
          if (res.status === 404 && ticket && !cancelled) {
            clearStoredTicket(slug);
            ticketRef.current = { slug, ticket: "" };
          }
          if (!cancelled) {
            if (!ticket) setState({ kind: "missing" });
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
          if (resolvedTicket) ticketRef.current = { slug, ticket: resolvedTicket };
          if (resolvedTicket && !fromLink) storeTicket(slug, resolvedTicket);
          setState({
            kind: "ready",
            ticket: resolvedTicket,
            name: text(participant.name),
            company: text(participant.company),
            status: text(participant.status) || "APPROVED",
            paymentStatus: text(participant.paymentStatus),
            inside: participant.inside === true,
            everIn: participant.everIn === true,
            eventName: text(data.event?.name),
            eventDate: text(data.event?.date),
            fresh: justRegistered,
          });
        }
      } catch {
        if (!cancelled) {
          setState({
            kind: "failed",
            message: "연결하지 못했습니다. 다시 시도하세요.",
          });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
      // An unmounted screen must not receive the manual re-check's late
      // writes either (state, bearer, or storage).
      recheckSeqRef.current += 1;
    };
  }, [slug, reloadTick]);

  // Manual re-check for an already-usable ticket. Reuses the in-tab bearer
  // and the same endpoint as the loading path, but keeps the QR mounted:
  // only a definitive 404 ends the stale QR here (bearer cleared, failed
  // state shown); transient failures keep the visible ticket and offer
  // another try. A re-check invalidated by a newer slug or load never
  // writes: the sequence + slug guard below drops late responses instead
  // of letting them overwrite another event or bearer. No new persistence,
  // no polling, no server change.
  const recheckSeqRef = useRef(0);
  const liveSlugRef = useRef(slug);
  liveSlugRef.current = slug;
  async function recheckUsableTicket() {
    if (rechecking || state.kind !== "ready") return;
    const requestSlug = slug;
    const bearer = ticketRef.current.ticket || state.ticket;
    const seq = ++recheckSeqRef.current;
    const live = () => recheckSeqRef.current === seq && liveSlugRef.current === requestSlug;
    setRechecking(true);
    setRecheckError(null);
    try {
      const res = await fetch(
        `/api/public/events/${encodeURIComponent(requestSlug)}/ticket`,
        bearer
          ? { headers: { authorization: `Bearer ${bearer}` }, cache: "no-store" }
          : { cache: "no-store" }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        event?: { name?: unknown; date?: unknown } | null;
        participant?: Record<string, unknown> | null;
      } | null;
      // A newer slug or a superseding load owns the screen now: drop this
      // late response instead of writing another event's state or bearer.
      if (!live()) return;
      if (!res.ok || !data?.participant) {
        if (res.status === 404 && bearer) {
          clearStoredTicket(requestSlug);
          if (ticketRef.current.slug === requestSlug) ticketRef.current = { slug: requestSlug, ticket: "" };
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
          setRecheckError("최신 상태를 확인하지 못했습니다. 이 QR의 입장 가능 여부는 확정되지 않았습니다. 다시 시도하세요.");
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
        storeTicket(requestSlug, resolvedTicket);
      }
      setState({
        kind: "ready",
        ticket: resolvedTicket,
        name: text(participant.name),
        company: text(participant.company),
        status: text(participant.status) || "APPROVED",
        paymentStatus: text(participant.paymentStatus),
        inside: participant.inside === true,
        everIn: participant.everIn === true,
        eventName: text(data.event?.name),
        eventDate: text(data.event?.date),
        fresh: false,
      });
    } catch {
      if (!live()) return;
      setRecheckError("연결하지 못했습니다. 이 QR의 입장 가능 여부는 확정되지 않았습니다. 다시 시도하세요.");
    } finally {
      if (live()) setRechecking(false);
    }
  }

  if (state.kind === "loading") {
    return <p className="ticket-state" role="status">티켓을 확인하고 있습니다.</p>;
  }
  if (state.kind === "missing") {
    return (
      <section className={`${styles.ticketCard} ${styles.ticketMessage}`}>
        {/* Same state, same words as the home entries: the attendee has no
            ticket here, and the way forward is the same everywhere. */}
        <h1>티켓이 확인되지 않습니다</h1>
        {recoveryBlocked ? (
          <p>이 브라우저에 티켓이 보관되어 있지 않습니다. 이 행사에서는 문자로 티켓을 다시 연결할 수 없어 신청한 기기에서만 열 수 있습니다. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.</p>
        ) : (
          <p>이 브라우저에 티켓이 보관되어 있지 않습니다. 신청할 때 쓴 연락처를 인증하면 다시 열 수 있습니다.</p>
        )}
        {!recoveryBlocked ? (
          <p className={styles.ticketMessageActions}>
            <Link className={styles.buttonPrimary} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>연락처 인증으로 티켓 다시 찾기</Link>
          </p>
        ) : null}
        <p className={styles.ticketMessageActions}>
          <Link className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}/register`}>참가 신청하기</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "failed") {
    // A 404 ticket with no SMS route behind it cannot be reconnected: the
    // recover screen would only repeat that verdict, so it steps aside for
    // device + operator guidance.
    const showRecover = state.canRecover && !recoveryBlocked;
    return (
      <section className={`${styles.ticketCard} ${styles.ticketMessage}`}>
        <h1>티켓을 사용할 수 없습니다</h1>
        <p role="alert">{state.message}</p>
        {state.canRecover && recoveryBlocked ? (
          <p>이 행사에서는 문자로 티켓을 다시 연결할 수 없어 신청한 기기에서만 열 수 있습니다. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.</p>
        ) : null}
        {showRecover ? (
          <p className={styles.ticketMessageActions}>
            <Link className={styles.buttonPrimary} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>연락처 인증으로 티켓 다시 찾기</Link>
          </p>
        ) : null}
        {!state.canRecover ? (
          <p className={styles.ticketMessageActions}>
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={() => {
                setState({ kind: "loading" });
                setReloadTick((tick) => tick + 1);
              }}
            >
              다시 시도
            </button>
          </p>
        ) : null}
        <p className={styles.ticketMessageActions}>
          <Link className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
        </p>
      </section>
    );
  }
  const usable =
    state.status === "APPROVED" &&
    (state.paymentStatus === "FREE" || state.paymentStatus === "PAID");
  return (
    <section className={styles.ticketCard}>
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
      <header className={styles.ticketHeading}>
        <span className={styles.ticketLabel}>입장 티켓</span>
        <h1 className={styles.ticketEventName}>{state.eventName}</h1>
        <p>{state.eventDate}</p>
      </header>
      <div className={styles.ticketAttendee}>
        <h2 className={styles.ticketAttendeeName}>{state.name}</h2>
        {state.company ? <p>{state.company}</p> : null}
        <p className={styles.ticketEntryState} data-tone={usable ? "good" : state.status === "CANCELLED" ? "bad" : "wait"}>
          <span className={styles.statusDot} aria-hidden="true" />
          {entryLabel(state)}
        </p>
      </div>
      {usable ? (
        <>
          <div className={styles.ticketQrWrapper}>
            <div className={styles.ticketPassDivider} aria-hidden="true" />
            <div className={styles.ticketQr} role="img" aria-label={`${state.name}님의 행사 입장 및 퇴장용 QR`}>
              <QRCode value={state.ticket} size={220} />
            </div>
            <p className={styles.ticketInstruction}>입장할 때 이 QR을 보여 주세요. 퇴장할 때도 같은 QR을 사용합니다.</p>
          </div>
          <div className={`${styles.ticketActions} ${styles.ticketActionsStack}`}>
            {/* Secondary on purpose: the QR above is what the attendee
                shows at the desk, not this link. */}
            <Link className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}/engage`}>참여 프로그램 보기</Link>
            <button
              type="button"
              className={styles.buttonSecondary}
              disabled={rechecking}
              onClick={() => void recheckUsableTicket()}
            >
              {rechecking ? "확인 중입니다" : "상태 다시 확인"}
            </button>
          </div>
          {rechecking ? (
            <p role="status" className={styles.ticketRecovery}>최신 상태를 확인하고 있습니다. 확인이 끝날 때까지 이 QR의 입장 가능 여부는 확정되지 않습니다.</p>
          ) : null}
          {recheckError ? (
            <p role="alert" className={styles.ticketRecheckError}>{recheckError}</p>
          ) : null}
          {recoveryBlocked ? (
            <p className={styles.ticketRecovery}>
              이 티켓은 현재 탭에만 보관됩니다. 이 행사에서는 문자로 티켓을 다시 연결할 수 없어
              다른 기기에서 열 수 없습니다. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.
            </p>
          ) : (
            <p className={styles.ticketRecovery}>
              이 티켓은 현재 탭에만 보관됩니다. 다른 기기에서 열 때는{" "}
              <Link href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>연락처 인증으로 다시 연결</Link>
              하세요.
            </p>
          )}
        </>
      ) : (
        <>
          <p className={styles.ticketUnusable}>{unusableCopy(state).text}</p>
          {/* Any non-admitted state can change server-side without the
              attendee acting (operator approval, a freed seat, a confirmed
              payment, a reinstated application), but this screen loads once:
              without a re-check the receipt goes stale and the attendee has
              no way to see the QR except a blind browser reload. The in-tab
              bearer (ref, then sessionStorage) survives the retry. */}
          <p className={styles.ticketMessageActions}>
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={() => {
                setState({ kind: "loading" });
                setReloadTick((tick) => tick + 1);
              }}
            >
              상태 다시 확인
            </button>
          </p>
          {unusableCopy(state).showRegister ? (
            <p className={styles.ticketMessageActions}>
              <Link className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}/register`}>다시 신청하기</Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
