"use client";

import QRCode from "react-qr-code";
import { useCallback, useEffect, useRef, useState, type SubmitEvent } from "react";
import ProductButton from "../../../ui/ProductButton";
import ProductLink from "../../../ui/ProductLink";
import { postAttendeeRequest } from "../attendee-request";
import { randomCommandId } from "../../../../lib/command-id";
import { readStoredTicket } from "../../../../lib/attendee-ticket-storage";
import styles from "./arrive.module.css";

type Known = { name: string; company: string; state: "inside" | "waiting" | "review" | "notInside" | null };
type Desk = { eventName: string; deskName: string; open: boolean; action?: "IN" | "OUT"; nametag: boolean; known: Known | null };
type Outcome = { result: "waiting" | "review" | "inside" | "left" | "notInside"; name: string; company: string; deskName: string };
type ArrivalResponse = Partial<Desk> & Partial<Outcome> & { error?: unknown; code?: unknown; field?: unknown };

const UNKNOWN = "접수 결과를 확인하지 못했습니다. 같은 버튼을 다시 눌러 주세요.";

function Pass({ outcome, ticket, nametag }: { outcome: Outcome; ticket: string; nametag: boolean }) {
  const tone = outcome.result === "waiting" || outcome.result === "left" ? "good" : outcome.result === "review" || outcome.result === "notInside" ? "wait" : "in";
  const head = { waiting: "접수됐습니다", review: "확인이 필요합니다", inside: "이미 입장하셨어요", left: "퇴장했습니다", notInside: "입장 기록이 없습니다" }[outcome.result];
  const next = outcome.result === "waiting" ? `${outcome.deskName}에서 ${nametag ? "명찰을 받으세요" : "입장 확인을 받으세요"}`
    : outcome.result === "left" ? "안녕히 가세요"
    : outcome.result === "review" || outcome.result === "notInside" ? `${outcome.deskName}에 말씀해 주세요` : "그대로 들어가셔도 됩니다";
  return (
    <section className={styles.pass} aria-live="polite">
      <div className={styles.band} data-tone={tone}>
        <p className={styles.bandHead}>{head}</p>
        <h1 className={styles.bandName}>{outcome.name}</h1>
        {outcome.company ? <p className={styles.bandSub}>{outcome.company}</p> : null}
      </div>
      <div className={styles.passBody}>
        {/* The desk scanner reads this to hand the name tag over. Only the browser that holds the ticket shows it. */}
        {ticket && outcome.result === "waiting" ? (
          <figure className={styles.qr}>
            <QRCode value={ticket} size={220} title="입장 QR" />
            <figcaption>이 화면을 데스크에 보여 주세요</figcaption>
          </figure>
        ) : null}
        <p className={styles.next}>{next}</p>
      </div>
    </section>
  );
}

export default function ArriveView({ slug, deskId }: { slug: string; deskId: string }) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loadError, setLoadError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [failure, setFailure] = useState("");
  const [sending, setSending] = useState(false);
  const [ticket, setTicket] = useState("");
  // One command id per intent, kept while the result is unknown so a retry cannot arrive twice.
  const attempt = useRef<{ key: string; commandId: string } | null>(null);
  const gate = useRef(false);
  const url = `/api/public/events/${encodeURIComponent(slug)}/arrival`;

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const { res, data } = await postAttendeeRequest<ArrivalResponse>(url, { action: "view", deskId });
      if (!res.ok || !data || typeof data.deskName !== "string") {
        setLoadError(typeof data?.error === "string" ? data.error : "접수 화면을 불러오지 못했습니다.");
        return;
      }
      setDesk(data as Desk);
      const known = (data as Desk).known;
      if (known?.state && known.state !== "notInside") setOutcome({ result: known.state, name: known.name, company: known.company, deskName: data.deskName });
    } catch {
      setLoadError("접수 화면을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }, [url, deskId]);

  useEffect(() => { void load(); }, [load]);

  // The ticket for the desk scanner: this tab's own, or the one this browser's session holds.
  useEffect(() => {
    if (outcome?.result !== "waiting" || !desk?.known || typing) return;
    const stored = readStoredTicket(slug);
    const controller = new AbortController();
    fetch(`/api/public/events/${encodeURIComponent(slug)}/ticket`, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then((res) => res.ok ? res.json() : null)
      .then((data: { participant?: { ticket?: unknown; name?: unknown } } | null) => {
        const own = data?.participant;
        // Never show one person's QR under another person's name.
        if (own && own.name === outcome.name && typeof own.ticket === "string") setTicket(own.ticket);
        else if (!own && stored) setTicket(stored);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [outcome, desk, typing, slug]);

  async function arrive(identity: { name: string; phone: string } | null) {
    if (gate.current) return;
    gate.current = true;
    setSending(true);
    setFailure("");
    const key = JSON.stringify(identity);
    if (attempt.current?.key !== key) attempt.current = { key, commandId: randomCommandId() };
    try {
      const { res, data } = await postAttendeeRequest<ArrivalResponse>(url, {
        action: "arrive", deskId, commandId: attempt.current.commandId, ...(identity ?? {}),
      });
      if (!res.ok || !data?.result) {
        const settled = res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        if (settled) attempt.current = null;
        setFailure(typeof data?.error === "string" && (settled || res.status === 429) ? data.error : UNKNOWN);
        return;
      }
      attempt.current = null;
      setOutcome(data as Outcome);
    } catch {
      setFailure(UNKNOWN);
    } finally {
      gate.current = false;
      setSending(false);
    }
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || phone.replace(/\D/g, "").length < 9) {
      setFailure("이름과 휴대폰 번호를 확인해 주세요.");
      return;
    }
    void arrive({ name: name.trim(), phone: phone.trim() });
  }

  if (!desk) {
    return (
      <section className={styles.sheet}>
        {loadError ? (
          <>
            <p role="alert" className={styles.alert}>{loadError}</p>
            <ProductButton type="button" variant="primary" className={styles.cta} onClick={() => void load()}>다시 불러오기</ProductButton>
            <ProductLink className={styles.quiet} href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</ProductLink>
          </>
        ) : <p role="status">접수 화면을 불러오고 있습니다.</p>}
      </section>
    );
  }
  if (outcome) {
    return (
      <>
        <Pass outcome={outcome} ticket={typing ? "" : ticket} nametag={desk.nametag} />
        {outcome.result === "waiting" || outcome.result === "review" ? <p className={styles.foot}><ProductLink variant="ghost" href={`/event/${encodeURIComponent(slug)}/home`}>참가자 홈으로</ProductLink></p> : null}
      </>
    );
  }
  const form = typing || !desk.known;
  const leaving = desk.action === "OUT";
  const press = sending ? "처리 중" : leaving ? "퇴장" : "도착 접수";
  return (
    <section className={styles.sheet} aria-labelledby="arrive-title">
      <p className={styles.where}><strong>{desk.deskName}</strong><span>{desk.eventName}</span></p>
      {!desk.open ? (
        <>
          <h1 id="arrive-title" className={styles.title}>지금은 접수를 받지 않습니다</h1>
          <p>{desk.deskName}에 말씀해 주세요.</p>
          <ProductButton type="button" variant="primary" className={styles.cta} onClick={() => void load()}>다시 확인</ProductButton>
        </>
      ) : form ? (
        <form className={styles.form} onSubmit={submit} noValidate>
          <h1 id="arrive-title" className={styles.title}>{leaving ? "퇴장하실 분을 확인할게요" : "신청하신 분인지 확인할게요"}</h1>
          <label className={styles.field}>
            <span>이름</span>
            <input id="arrive-name" type="text" autoComplete="name" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span>휴대폰 번호</span>
            <input id="arrive-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={20} value={phone} onChange={(event) => setPhone(event.target.value)} />
          </label>
          {failure ? <p role="alert" className={styles.alert}>{failure}</p> : null}
          <ProductButton type="submit" variant="primary" className={styles.cta} disabled={sending}>{press}</ProductButton>
          {leaving ? null : <ProductLink className={styles.quiet} href={`/event/${encodeURIComponent(slug)}/register?desk=${encodeURIComponent(deskId)}`}>신청하지 않았어요 · 현장 신청</ProductLink>}
        </form>
      ) : (
        <div className={styles.knownBlock}>
          <p className={styles.knownLead}>신청하신 휴대폰이에요</p>
          <h1 id="arrive-title" className={styles.knownName}>{desk.known!.name} 님</h1>
          {desk.known!.company ? <p className={styles.knownSub}>{desk.known!.company}</p> : null}
          {failure ? <p role="alert" className={styles.alert}>{failure}</p> : null}
          <ProductButton type="button" variant="primary" className={styles.cta} disabled={sending} onClick={() => void arrive(null)}>{press}</ProductButton>
          <button type="button" className={styles.quiet} onClick={() => { setTyping(true); setFailure(""); }}>내가 아니에요</button>
        </div>
      )}
    </section>
  );
}
