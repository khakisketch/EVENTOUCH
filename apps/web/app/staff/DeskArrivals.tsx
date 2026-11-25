"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ProductButton from "../ui/ProductButton";
import NameTagPrint from "../ui/NameTagPrint";
import { abandonOperatorAttempt, operatorFetch } from "../../lib/operator-context";
import { forgetOperatorReceipt } from "../../lib/operator-receipts";
import { randomCommandId } from "../../lib/command-id";
import styles from "./desk-arrivals.module.css";

// The desk's waiting list (owner decision 2026-11-25, layout A). People arrive by scanning the
// desk poster, by a staff line scan or by signing up on site; this laptop prints their name tags
// one at a time, and handing one over is the entry. Every decision is the server's.

const POLL_MS = 3000;
export const STALE_ARRIVAL_MS = 30 * 60_000;
const CLAIM_MS = 60_000;

export type DeskArrival = {
  id: string; participantId: string; name: string; company: string; group: string; source: string; at: string;
  review: null | "PENDING" | "WAITLIST" | "PAYMENT" | "ATTENDANCE" | "REENTRY" | "STATUS" | "EXPIRED";
  namesake?: boolean;
  printedAt: string | null; printFailedAt: string | null; printClaim: { station: string; at: string } | null;
};
export type DeskArrivalView = {
  eventName: string; stage: string; canApprove: boolean; arrivals: DeskArrival[]; entered: number; total: number;
  // Server time when read, and how far this device's clock is from it.
  now?: string; skew: number;
  desk: { id: string; name: string; action: string; open: boolean; nametag: boolean };
};

const REVIEW_TEXT: Record<string, string> = {
  PENDING: "승인 대기", WAITLIST: "대기 명단", PAYMENT: "결제 확인", ATTENDANCE: "출입 기록 확인",
  REENTRY: "재입장 불가", STATUS: "참가 상태 확인", EXPIRED: "티켓 만료",
};

type CommandResult = { ok: true; data: Record<string, unknown> } | { ok: false; message: string; code: string };

// Arrival requests are safe to repeat (the server keeps one open arrival per person), so an
// unconfirmed one is dropped here and the next poll shows what actually happened.
export async function sendDeskCommand(eventId: string, command: string, assignmentId: string, payload: Record<string, unknown>): Promise<CommandResult> {
  const commandId = randomCommandId();
  const forget = () => { abandonOperatorAttempt(commandId); forgetOperatorReceipt(commandId); };
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const res = await operatorFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, command, assignmentId, payload }),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && data) return { ok: true, data };
    forget();
    return { ok: false, message: typeof data?.error === "string" ? data.error : "처리하지 못했습니다. 목록을 확인하세요.", code: typeof data?.code === "string" ? data.code : "" };
  } catch {
    forget();
    return { ok: false, message: "연결을 확인하세요. 목록이 다시 읽히면 처리 여부가 보입니다.", code: "NETWORK" };
  } finally {
    window.clearTimeout(timeout);
  }
}

export function useDeskArrivals(eventId: string, deskId: string, assignmentId: string, enabled: boolean) {
  const [view, setView] = useState<DeskArrivalView | null>(null);
  const [error, setError] = useState("");
  const request = useRef<symbol | null>(null);
  const key = `${eventId}/${deskId}`;
  const refresh = useCallback(async () => {
    if (!enabled || !deskId) return;
    const mine = Symbol("arrivals");
    request.current = mine;
    try {
      const res = await operatorFetch(`/api/events/${encodeURIComponent(eventId)}/desks/${encodeURIComponent(deskId)}/arrivals?assignmentId=${encodeURIComponent(assignmentId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as (DeskArrivalView & { error?: string }) | null;
      if (request.current !== mine) return;
      if (!res.ok || !data || !Array.isArray(data.arrivals)) {
        setError(data?.error || "도착 목록을 불러오지 못했습니다.");
        return;
      }
      const read = data.now ? Date.parse(data.now) : NaN;
      setView({ ...data, skew: Number.isFinite(read) ? read - Date.now() : 0 });
      setError("");
    } catch {
      if (request.current === mine) setError("도착 목록을 불러오지 못했습니다. 연결을 확인하세요.");
    }
  }, [eventId, deskId, assignmentId, enabled]);
  useEffect(() => {
    setView(null);
    setError("");
    if (!enabled || !deskId) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => { window.clearInterval(timer); request.current = null; };
  }, [key, enabled, deskId, refresh]);
  return { view: view && view.desk.id === deskId ? view : null, error, refresh };
}

const ago = (at: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  return minutes < 1 ? "방금" : `${minutes}분 전`;
};
const stale = (arrival: DeskArrival, now: number) => now - Date.parse(arrival.at) > STALE_ARRIVAL_MS;
const affiliation = (arrival: DeskArrival) => [arrival.company, arrival.group].filter(Boolean).join(" · ");

function stateOf(arrival: DeskArrival, now: number, nametag: boolean): { tone: string; label: string } {
  if (arrival.review) return { tone: "wait", label: REVIEW_TEXT[arrival.review] || "확인 필요" };
  if (arrival.printFailedAt) return { tone: "bad", label: "출력 실패" };
  if (stale(arrival, now)) return { tone: "old", label: "30분 지남" };
  if (!nametag) return { tone: "good", label: "도착" };
  if (arrival.printedAt) return { tone: "good", label: "출력함" };
  return { tone: "info", label: arrival.printClaim ? "출력 중" : "출력 대기" };
}

// The person to serve next: the chosen row, else the one already on screen, else the longest
// waiting one that is still fresh. `replaced` means the card changed by itself (handled on
// another device), so its buttons stay off for a moment.
export function useCurrentArrival(view: DeskArrivalView | null, selected: string) {
  const [pin, setPin] = useState({ id: "", replaced: false });
  const now = Date.now() + (view?.skew ?? 0);
  const chosen = view?.arrivals.find((item) => item.id === selected);
  const arrival = chosen ?? view?.arrivals.find((item) => item.id === pin.id) ??
    view?.arrivals.find((item) => !stale(item, now)) ?? null;
  if (view && (arrival?.id ?? "") !== pin.id) {
    setPin({ id: arrival?.id ?? "", replaced: Boolean(pin.id && arrival && !chosen) });
  }
  // Called when this screen finished with the card, so the next one is not a surprise.
  const release = useCallback(() => setPin({ id: "", replaced: false }), []);
  return { arrival, replaced: pin.replaced && arrival?.id === pin.id, release };
}

const SETTLE_MS = 1500;

export function ArrivalNow({ view, arrival, replaced, busy: working, message, onHand, onApprove, onPrint, onCancel }: {
  view: DeskArrivalView; arrival: DeskArrival; replaced: boolean; busy: boolean; message: string;
  onHand: () => void; onApprove: () => void; onPrint: () => void; onCancel: () => void;
}) {
  const [settled, setSettled] = useState("");
  const settling = replaced && settled !== arrival.id;
  useEffect(() => {
    if (!replaced) return;
    const timer = window.setTimeout(() => setSettled(arrival.id), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [arrival.id, replaced]);
  const busy = working || settling;
  const now = Date.now() + view.skew;
  const { nametag } = view.desk;
  const review = arrival.review;
  const approvable = (review === "PENDING" || review === "WAITLIST") && view.canApprove;
  const kicker = review ? `${REVIEW_TEXT[review]} · 명찰 출력 안 함`
    : arrival.printFailedAt ? "도착 · 명찰 출력 실패"
      : stale(arrival, now) ? "도착한 지 30분이 지났습니다"
        : !nametag ? "도착" : arrival.printedAt ? "도착 · 명찰 출력함" : "도착 · 명찰 출력 전";
  return (
    <section className={styles.now} data-tone={review || arrival.printFailedAt ? "wait" : "good"} aria-label="지금 처리할 참가자">
      <p className={styles.kicker}>{kicker}</p>
      <h2 className={styles.name}>{arrival.name}</h2>
      <p className={styles.affiliation}>{affiliation(arrival) || "소속 없음"}</p>
      {arrival.namesake ? <p className={styles.problem}>이름과 소속이 같은 사람이 있습니다. 휴대폰의 접수 화면을 확인하세요.</p> : null}
      {replaced ? <p className={styles.changed} role="status">앞 사람은 처리되어 다음 사람으로 바뀌었습니다.</p> : null}
      {message ? <p className={styles.problem} role="alert">{message}</p> : null}
      {!review ? (
        <ProductButton type="button" variant="primary" className={styles.hand} disabled={busy} onClick={onHand}>{nametag ? "건넸어요 · 입장" : "입장 처리"}</ProductButton>
      ) : approvable ? (
        <ProductButton type="button" variant="primary" className={styles.hand} disabled={busy} onClick={onApprove}>승인하고 입장</ProductButton>
      ) : (
        <p className={styles.problem}>현장 책임자에게 확인을 요청하세요.</p>
      )}
      <div className={styles.nowActions}>
        {nametag && !review ? <ProductButton type="button" variant="ghost" disabled={busy} onClick={onPrint}>{arrival.printedAt || arrival.printFailedAt ? "다시 출력" : "지금 출력"}</ProductButton> : null}
        <ProductButton type="button" variant="ghost" disabled={busy} onClick={onCancel}>{review ? "돌려보내기" : "취소"}</ProductButton>
      </div>
    </section>
  );
}

export function ArrivalList({ view, error, selected, titled = true, onSelect }: {
  view: DeskArrivalView | null; error: string; selected: string; titled?: boolean; onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const now = Date.now() + (view?.skew ?? 0);
  const wanted = query.trim().toLocaleLowerCase();
  const rows = (view?.arrivals ?? []).filter((item) => !wanted || `${item.name} ${item.company}`.toLocaleLowerCase().includes(wanted));
  return (
    <div className={styles.listBlock}>
      {titled ? <h2 className={styles.listHead}><span>기다리는 사람</span><b>{view?.arrivals.length ?? 0}</b></h2> : null}
      {(view?.arrivals.length ?? 0) > 5 ? (
        <input type="search" className={styles.search} aria-label="기다리는 사람에서 찾기" placeholder="기다리는 사람에서 찾기" value={query} onChange={(event) => setQuery(event.target.value)} />
      ) : null}
      {error ? <p className={styles.problem} role="status">{error}</p> : null}
      {rows.length ? (
        <ul className={styles.list} aria-label="도착한 참가자">
          {rows.map((item) => {
            const state = stateOf(item, now, view!.desk.nametag);
            return (
              <li key={item.id}>
                <button type="button" className={styles.row} aria-current={item.id === selected || undefined} data-old={state.tone === "old" || undefined} onClick={() => onSelect(item.id)}>
                  <span className={styles.rowText}><strong>{item.name}</strong><small>{[affiliation(item), ago(item.at, now)].filter(Boolean).join(" · ")}</small></span>
                  <span className={styles.pill} data-tone={state.tone}>{state.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className={styles.empty}>{wanted ? "찾는 사람이 목록에 없습니다." : "아직 도착한 사람이 없습니다."}</p>}
    </div>
  );
}

// Prints waiting tags in order, one at a time. A claim on the server keeps a second laptop at
// the same desk from printing the same one.
export function ArrivalPrinter({ eventId, assignmentId, view, enabled, station, forced, onForcedHandled, onDone }: {
  eventId: string; assignmentId: string; view: DeskArrivalView | null; enabled: boolean; station: string;
  forced: string; onForcedHandled: () => void; onDone: (participantId: string) => void;
}) {
  const [job, setJob] = useState<DeskArrival | null>(null);
  const busy = useRef(false);
  // Tags this screen already sent to the printer, so a lost report never prints them again.
  const printed = useRef(new Map<string, boolean>());
  const report = useCallback((deskId: string, arrivalId: string, ok: boolean) =>
    sendDeskCommand(eventId, "arrival.print-result", assignmentId, { deskId, arrivalId, station, ok }), [eventId, assignmentId, station]);
  useEffect(() => {
    if (!view || !view.desk.nametag || job || busy.current) return;
    const now = Date.now() + view.skew;
    const unreported = view.arrivals.find((item) => printed.current.has(item.id) &&
      !item.printedAt && !item.printFailedAt && item.printClaim?.station === station);
    if (unreported && !forced) {
      busy.current = true;
      void report(view.desk.id, unreported.id, printed.current.get(unreported.id)!).finally(() => { busy.current = false; });
      return;
    }
    const wanted = forced ? view.arrivals.find((item) => item.id === forced) : enabled
      ? view.arrivals.find((item) => !item.review && !item.printedAt && !item.printFailedAt && !stale(item, now) &&
        !printed.current.has(item.id) &&
        (!item.printClaim || item.printClaim.station === station || now - Date.parse(item.printClaim.at) > CLAIM_MS))
      : undefined;
    if (forced) onForcedHandled();
    if (!wanted) return;
    busy.current = true;
    void sendDeskCommand(eventId, "arrival.claim-print", assignmentId, { deskId: view.desk.id, arrivalId: wanted.id, station, force: Boolean(forced) })
      .then((result) => {
        if (result.ok && result.data.claimed === true) setJob(wanted);
        else busy.current = false;
      });
  }, [view, enabled, forced, job, eventId, assignmentId, station, onForcedHandled, report]);

  if (!job || !view) return null;
  const settle = (ok: boolean) => {
    onDone(job.participantId);
    printed.current.set(job.id, ok);
    void report(view.desk.id, job.id, ok)
      // Keep the print output mounted until the report returns, then take the next person.
      .finally(() => { busy.current = false; setJob(null); });
  };
  return (
    <div className={styles.offstage} inert>
      <NameTagPrint key={job.id} identity={{ name: job.name, company: job.company, eventName: view.eventName, context: view.desk.name }} onAutoSettled={settle} />
    </div>
  );
}
