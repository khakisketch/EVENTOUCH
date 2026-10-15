"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";

type TicketState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed"; message: string }
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
                    : "티켓을 확인할 수 없습니다. 운영자에게 새 링크를 요청하세요.",
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
      <section className="ticket-card ticket-message">
        <h1>티켓 링크가 필요합니다</h1>
        <p>티켓은 신청 완료 화면이 열린 탭에서만 자동으로 찾을 수 있습니다. 탭을 닫았다면 아래에서 참가 정보를 다시 연결하세요.</p>
        <p>
          <Link className="button button-primary" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>내 참가 정보 다시 연결</Link>
        </p>
        <p>
          <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/register`}>참가 신청하기</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "failed") {
    return (
      <section className="ticket-card ticket-message">
        <h1>티켓을 사용할 수 없습니다</h1>
        <p role="alert">{state.message}</p>
        <p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              setState({ kind: "loading" });
              setReloadTick((tick) => tick + 1);
            }}
          >
            다시 시도
          </button>
        </p>
        <p>
          <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
        </p>
      </section>
    );
  }
  const usable =
    state.status === "APPROVED" &&
    (state.paymentStatus === "FREE" || state.paymentStatus === "PAID");
  return (
    <section className="ticket-card ticket-ready">
      <header className="ticket-heading">
        <span className="ticket-label">입장 티켓</span>
        <h1>{state.eventName}</h1>
        <p>{state.eventDate}</p>
      </header>
      <div className="ticket-attendee">
        <h2>{state.name}</h2>
        {state.company ? <p>{state.company}</p> : null}
        <p className="ticket-entry-state" data-tone={usable ? "good" : state.status === "CANCELLED" ? "bad" : "wait"}><span className="status-dot" aria-hidden="true" />{entryLabel(state)}</p>
      </div>
      {usable ? (
        <>
          <div className="ticket-qr" role="img" aria-label={`${state.name}님의 행사 입장 및 퇴장용 QR`}>
            <QRCode value={state.ticket} size={220} />
          </div>
          <p className="ticket-instruction">입장과 퇴장에는 같은 QR을 사용합니다.</p>
          <p>
            <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/engage`}>참여 프로그램 보기</Link>
          </p>
        </>
      ) : (
        <>
          <p className="ticket-unusable">{unusableCopy(state).text}</p>
          {unusableCopy(state).showRegister ? (
            <p>
              <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/register`}>다시 신청하기</Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
