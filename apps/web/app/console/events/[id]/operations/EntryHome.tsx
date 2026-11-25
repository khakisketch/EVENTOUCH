"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import OperationsWorkspace from "./OperationsWorkspace";
import DeskPoster from "./DeskPoster";
import StaffEventWork from "../../../../staff/StaffEventWork";
import { readStaffBootstrap, staffReadErrorMessage } from "../../../../staff/staff-bootstrap";
import { sendDeskCommand } from "../../../../staff/DeskArrivals";
import ProductButton from "../../../../ui/ProductButton";
import ProductLink from "../../../../ui/ProductLink";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import styles from "./entry-home.module.css";

// 입장 관리 (owner decision 2026-11-25): the menu opens straight onto the screen people are
// received on. Before the event it holds one next step; desks, booths and staff accounts are
// a separate setup view (`?setup=1`, any `#ops-` link, or a 팀·권한 assignment handoff).

type Desk = { id: string; name: string; action: string; open: boolean; nametag: boolean; mode: string };
type Snapshot = {
  stage: string; name: string; slug: string; desks: Desk[];
  canRun: boolean; canStart: boolean; canPrepare: boolean;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

async function readSnapshot(eventId: string, signal: AbortSignal): Promise<Snapshot | string> {
  const { status, state } = await readStaffBootstrap(new AbortController(), signal);
  if (status === 401) return "로그인이 필요합니다. 다시 로그인해 주세요.";
  const event = (Array.isArray(state?.events) ? state.events : []).find((item) => item?.id === eventId) as Record<string, unknown> | undefined;
  if (!state || !event) return "행사 정보를 불러오지 못했습니다.";
  const viewer = (state.viewer ?? {}) as { id?: unknown; role?: unknown };
  const may = (command: string) => canWriteEvent({ role: viewer.role, userId: viewer.id, memberships: state.memberships, eventId }, command);
  const raw = state.workspaces?.[eventId]?.desks;
  const desks = (Array.isArray(raw) ? raw as Array<Record<string, unknown>> : []).filter((desk) => desk && text(desk.id)).map((desk) => ({
    id: text(desk.id), name: text(desk.name), action: text(desk.action), open: desk.open !== false,
    nametag: desk.nametag !== false, mode: text(desk.mode) || "desk",
  }));
  return {
    stage: text(event.stage), name: text(event.name), slug: text(event.slug), desks,
    canRun: may("check.scan"), canStart: may("event.stage"), canPrepare: may("desk.save"),
  };
}

const wantsSetup = (query: URLSearchParams, hash: string) =>
  query.has("setup") || query.has("assignAccount") || hash.startsWith("#ops-");

export default function EntryHome({ eventId, publicBase = null }: { eventId: string; publicBase?: string | null }) {
  const query = useSearchParams();
  const [setup, setSetup] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const setupHref = `${base}/operations?setup=1`;

  // The address decides which view shows. The setup view removes a 팀·권한 handoff from the
  // address once it has read it; that removal alone must not close the view.
  const handoff = useRef(false);
  useEffect(() => {
    const apply = () => {
      const now = new URLSearchParams(window.location.search);
      const consumed = handoff.current && !now.has("assignAccount");
      handoff.current = now.has("assignAccount");
      setSetup((current) => wantsSetup(now, window.location.hash) || (current === true && consumed));
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [query]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      const next = await readSnapshot(eventId, signal ?? new AbortController().signal);
      if (signal?.aborted) return;
      if (typeof next === "string") setError(next);
      else setSnapshot(next);
    } catch (problem) {
      if (!signal?.aborted) setError(staffReadErrorMessage(problem));
    }
  }, [eventId]);

  useEffect(() => {
    if (setup !== false) return;
    const controller = new AbortController();
    setSnapshot(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [setup, load]);

  const desk = snapshot ? snapshot.desks.find((item) => item.action === "IN" && item.open) ?? snapshot.desks.find((item) => item.action === "IN") ?? null : null;

  async function run(work: () => Promise<{ ok: boolean; message?: string }>) {
    if (busy) return;
    setBusy(true);
    setError("");
    const outcome = await work();
    await load();
    if (!outcome.ok) setError(outcome.message ?? "처리하지 못했습니다.");
    setBusy(false);
  }
  // The desk behind the screen: made once, reopened if it was stopped.
  async function prepareDesk() {
    if (!desk) return sendDeskCommand(eventId, "desk.save", "", { name: "입장", action: "IN", mode: "desk", open: true, nametag: true });
    if (desk.open) return { ok: true as const };
    return sendDeskCommand(eventId, "desk.set-open", "", { id: desk.id, open: true, expectedOpen: false });
  }
  const start = () => run(async () => {
    const ready = await prepareDesk();
    if (!ready.ok) return ready;
    return sendDeskCommand(eventId, "event.stage", "", { stage: "LIVE" });
  });

  if (setup === null) return <p className={styles.loading} role="status">입장 관리를 불러오고 있습니다.</p>;
  if (setup) {
    return (
      <>
        <p className={styles.back}><ProductLink variant="ghost" href={`${base}/operations`}>← 접수 화면으로</ProductLink></p>
        <OperationsWorkspace eventId={eventId} publicBase={publicBase} />
      </>
    );
  }
  if (!snapshot) {
    return error ? (
      <section className={styles.panel}>
        <p role="alert">{error}</p>
        <ProductButton type="button" variant="primary" onClick={() => void load()}>다시 불러오기</ProductButton>
      </section>
    ) : <p className={styles.loading} role="status">입장 관리를 불러오고 있습니다.</p>;
  }

  const over = snapshot.stage === "ENDED" || snapshot.stage === "ARCHIVED";
  // Without field permission there is nothing to receive with: show the read-only setup view.
  if (!snapshot.canRun && !over) return <OperationsWorkspace eventId={eventId} publicBase={publicBase} />;
  const running = snapshot.desks.some((item) => item.open && (item.action === "IN" || item.action === "OUT"));
  if (snapshot.stage === "LIVE" && running) {
    return (
      <>
        <h1 className="sr-only">입장 관리</h1>
        <StaffEventWork eventId={eventId} embedded={{ slug: snapshot.slug, publicBase, setupHref }} />
      </>
    );
  }

  const paused = snapshot.stage === "LIVE";
  const ready = snapshot.stage === "READY";
  const title = over ? "끝난 행사입니다" : paused ? "입장을 받지 않고 있습니다" : ready ? "아직 행사 시작 전입니다" : "행사 준비를 먼저 마쳐 주세요";
  const lead = over ? "출입 기록은 결과 보고서에서 확인합니다." : paused ? "다시 받으면 이 화면에서 바로 처리합니다." : ready ? "시작하면 이 화면에서 바로 입장을 받습니다." : "남은 준비를 마치면 이 화면에서 행사를 시작할 수 있습니다.";
  return (
    <>
      <h1 className="sr-only">입장 관리</h1>
      <section id="ops-entry" className={styles.panel} aria-labelledby="ops-entry-title">
        <h2 id="ops-entry-title" className={styles.title}>{title}</h2>
        <p className={styles.lead}>{lead}</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {confirming ? (
          <ConsoleConfirm summary="행사를 시작할까요? 시작하면 준비 단계로 되돌릴 수 없습니다." confirmLabel="행사 시작" busy={busy}
            onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); void start(); }} />
        ) : over ? (
          <ProductLink variant="primary" href={`${base}/reports`}>결과 보고서 보기</ProductLink>
        ) : paused ? (
          <ProductButton type="button" variant="primary" className={styles.cta} disabled={busy || !snapshot.canPrepare} onClick={() => void run(prepareDesk)}>다시 받기</ProductButton>
        ) : ready ? (
          snapshot.canStart && (desk?.open || snapshot.canPrepare) ? (
            <ProductButton type="button" variant="primary" className={styles.cta} disabled={busy} onClick={() => setConfirming(true)}>{busy ? "시작하는 중" : "행사 시작"}</ProductButton>
          ) : <p className={styles.lead}>행사 설정 권한이 있는 사람이 시작할 수 있습니다.</p>
        ) : (
          <ProductLink variant="primary" href={base}>남은 준비 보기</ProductLink>
        )}
        {!over ? (
          <div className={styles.quiet}>
            {desk ? (
              <DeskPoster eventName={snapshot.name} slug={snapshot.slug} deskId={desk.id} deskName={desk.name || "입장"} nametag={desk.nametag} publicBase={publicBase}
                trigger={(open) => <ProductButton type="button" variant="ghost" onClick={open}>안내판 인쇄</ProductButton>} />
            ) : snapshot.canPrepare ? (
              <ProductButton type="button" variant="ghost" disabled={busy} onClick={() => void run(prepareDesk)}>안내판 준비</ProductButton>
            ) : null}
            <ProductLink variant="ghost" href={setupHref}>여러 곳 · 부스 · 스태프 설정</ProductLink>
          </div>
        ) : null}
      </section>
    </>
  );
}
