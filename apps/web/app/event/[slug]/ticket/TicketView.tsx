"use client";

import { useEffect, useState } from "react";
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

function unusableCopy(state: { status: string }): { text: string; showRegister: boolean } {
  // A submitted application must read as a receipt, never as a broken
  // ticket. Each state names what happens next.
  switch (state.status) {
    case "PENDING":
      return { text: "신청이 접수되었습니다. 운영자가 승인하면 이 화면에 입장 QR이 표시됩니다.", showRegister: false };
    case "WAITLIST":
      return { text: "대기 명단에 등록되어 있습니다. 자리가 나면 이 화면에 입장 QR이 표시됩니다.", showRegister: false };
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
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const query = new URLSearchParams(window.location.search);
      const fromLink = query.get("ticket") || "";
      // Consume the bearer once: it must not linger in history or a shared
      // link. The tab keeps it (sessionStorage, gone when the tab closes)
      // so a venue refresh or a dropped connection does not lose the ticket.
      if (fromLink) storeTicket(slug, fromLink);
      query.delete("ticket");
      const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", cleaned);
      const ticket = fromLink || readStoredTicket(slug);
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
          // normal "come back" state, not an error.
          if (res.status === 404 && ticket) clearStoredTicket(slug);
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
        // tab memory only, exactly like the link-consumed bearer.
        const resolvedTicket = ticket || text(participant.ticket);
        if (resolvedTicket && !fromLink) storeTicket(slug, resolvedTicket);
        if (!cancelled) {
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
    };
  }, [slug, reloadTick]);

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
        <p>
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
          <p>
            <Link className={styles.buttonPrimary} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>연락처 인증으로 티켓 다시 찾기</Link>
          </p>
        ) : null}
        {!state.canRecover ? (
          <p>
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
        <p>
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
      <header className={styles.ticketHeading}>
        <span className={styles.ticketLabel}>입장 티켓</span>
        <h1>{state.eventName}</h1>
        <p>{state.eventDate}</p>
      </header>
      <div className={styles.ticketAttendee}>
        <h2>{state.name}</h2>
        {state.company ? <p>{state.company}</p> : null}
        <p className={styles.ticketEntryState} data-tone={usable ? "good" : state.status === "CANCELLED" ? "bad" : "wait"}>
          <span className={styles.statusDot} aria-hidden="true" />
          {entryLabel(state)}
        </p>
      </div>
      {usable ? (
        <>
          <div className={styles.ticketQrWrapper}>
            <div className={styles.ticketQr} role="img" aria-label={`${state.name}님의 행사 입장 및 퇴장용 QR`}>
              <QRCode value={state.ticket} size={220} />
            </div>
            <p className={styles.ticketInstruction}>입장할 때 이 QR을 보여 주세요. 퇴장할 때도 같은 QR을 사용합니다.</p>
          </div>
          <div className={styles.ticketActions}>
            {/* Secondary on purpose: the QR above is what the attendee
                shows at the desk, not this link. */}
            <Link className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}/engage`}>참여 프로그램 보기</Link>
          </div>
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
          {unusableCopy(state).showRegister ? (
            <p>
              <Link className={styles.buttonSecondary} href={`/event/${encodeURIComponent(slug)}/register`}>다시 신청하기</Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
