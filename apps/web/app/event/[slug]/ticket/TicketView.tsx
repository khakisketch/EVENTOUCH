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
}): string {
  if (state.inside) return "입장 중";
  if (state.everIn) return "퇴장 · 재입장 정책 확인";
  return "참가 확정";
}

export default function TicketView({ slug }: { slug: string }) {
  const [state, setState] = useState<TicketState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const query = new URLSearchParams(window.location.search);
      const ticket = query.get("ticket") || "";
      // Consume the bearer once: it must not linger in history or a shared link.
      query.delete("ticket");
      const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", cleaned);
      if (!ticket) {
        if (!cancelled) setState({ kind: "missing" });
        return;
      }
      try {
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/ticket`,
          { headers: { authorization: `Bearer ${ticket}` }, cache: "no-store" }
        );
        const data = (await res.json().catch(() => null)) as {
          error?: unknown;
          event?: { name?: unknown; date?: unknown } | null;
          participant?: Record<string, unknown> | null;
        } | null;
        if (!res.ok || !data?.participant) {
          if (!cancelled) {
            setState({
              kind: "failed",
              message:
                typeof data?.error === "string"
                  ? data.error
                  : "티켓을 확인할 수 없습니다. 운영자에게 새 링크를 요청하세요.",
            });
          }
          return;
        }
        const participant = data.participant;
        const text = (value: unknown): string =>
          typeof value === "string" ? value : "";
        if (!cancelled) {
          setState({
            kind: "ready",
            ticket,
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
  }, [slug]);

  if (state.kind === "loading") {
    return <p>티켓을 확인하고 있습니다.</p>;
  }
  if (state.kind === "missing") {
    return (
      <section>
        <h1>티켓 링크가 필요합니다</h1>
        <p>신청 완료 화면의 링크로 다시 여세요.</p>
        <p>
          <Link href={`/event/${encodeURIComponent(slug)}/register`}>참가 신청하기</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "failed") {
    return (
      <section>
        <h1>티켓을 사용할 수 없습니다</h1>
        <p>{state.message}</p>
        <p>
          <Link href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
        </p>
      </section>
    );
  }
  const usable =
    state.status === "APPROVED" &&
    (state.paymentStatus === "FREE" || state.paymentStatus === "PAID");
  return (
    <section>
      <h1>{state.eventName}</h1>
      <p>{state.eventDate}</p>
      <h2>{state.name}</h2>
      {state.company ? <p>{state.company}</p> : null}
      <p>{entryLabel(state)}</p>
      {usable ? (
        <>
          <div role="img" aria-label={`${state.name}님의 행사 입장 및 퇴장용 QR`}>
            <QRCode value={state.ticket} size={220} />
          </div>
          <p>입장과 퇴장에는 같은 QR을 사용합니다.</p>
        </>
      ) : (
        <p>티켓을 사용할 수 없습니다. 신청 정보를 확인하세요.</p>
      )}
    </section>
  );
}
