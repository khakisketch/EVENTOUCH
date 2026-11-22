"use client";

/*
 * 참가자 화면 허브 (2026-11-21, 사용자 선택 C안: 상단 탭 + 게시 상태 줄).
 *
 * Only the frame: one tab row that joins the three screens attendees' phones
 * are made of (디자인 = 참가자 페이지, 공지·안내, 참여 이벤트), plus a read-only
 * line saying which of them still wait to be published. Every screen keeps
 * its own route, layout, preview, editing, save and publish behaviour; this
 * component is rendered above each of them and touches none of it. Tabs are
 * ordinary same-tab links, so the console draft guard still asks before an
 * unsaved screen is left.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import StatusPill from "../../console-ui/StatusPill";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../lib/console-api";
import { drawEventsSnapshot } from "../../../../lib/participation-events";
import { attendeeScreenStatuses, firstPendingTab, hasParticipationFeature, type ScreenStatus, type ScreenTab } from "../../../../lib/attendee-screen-status";
import { consolePageHref, type ConsolePageId } from "../../console-navigation";
import styles from "./attendee-screen-hub.module.css";

const TABS: ReadonlyArray<{ tab: ScreenTab; label: string; pageId: ConsolePageId }> = [
  { tab: "design", label: "디자인", pageId: "attendeePage" },
  { tab: "content", label: "공지·안내", pageId: "content" },
  { tab: "programs", label: "참여 이벤트", pageId: "programs" },
];

type Summary = { statuses: ScreenStatus[]; participation: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function readSummary(eventId: string, signal?: AbortSignal): Promise<Summary | null> {
  try {
    const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal });
    if (!response.ok) return null;
    const body = record(await response.json().catch(() => null));
    const state = record(body?.state);
    const events = Array.isArray(state?.events) ? state.events : [];
    const event = events.find((item) => record(item)?.id === eventId);
    const workspace = record(record(state?.workspaces)?.[eventId]);
    if (!event || !workspace) return null;
    const drawStatuses = drawEventsSnapshot(workspace).events.map((draw) => String(draw.status));
    return { statuses: attendeeScreenStatuses(event, workspace, drawStatuses), participation: hasParticipationFeature(event) };
  } catch {
    // A failed read only hides the status line; the screen below reports its own load errors.
    return null;
  }
}

export default function AttendeeScreenHub({ eventId, active }: { eventId: string; active: ScreenTab }) {
  const [summary, setSummary] = useState<Summary | null>(null);

  // Only the newest read may write: a freshness refresh and the first load can overlap,
  // and a slow older answer must not replace a newer one (or outlive this event).
  const latest = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const ticket = ++latest.current;
    const next = await readSummary(eventId, signal);
    if (next && !signal?.aborted && ticket === latest.current) setSummary(next);
  }, [eventId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const unsubscribe = subscribeConsoleFreshness(() => { void refresh(); });
    return () => {
      controller.abort();
      latest.current += 1;
      unsubscribe();
    };
  }, [refresh]);

  // 참여 이벤트 is a destination only for events with a participation feature,
  // like the rail. The tab you are on always stays. It is the last tab, so when it
  // appears after the first read nothing the operator may be aiming at moves.
  const tabs = TABS.filter(({ tab }) => tab !== "programs" || active === "programs" || summary?.participation);
  const statuses = summary?.statuses ?? [];
  const pending = firstPendingTab(statuses);
  const pendingTab = pending ? TABS.find(({ tab }) => tab === pending.tab) : undefined;
  const pendingHref = pendingTab ? consolePageHref(pendingTab.pageId, eventId) : undefined;
  // The link opens one tab. When more is waiting elsewhere, name that tab and its own count
  // so the number promised matches what the page shows.
  const pendingText = pending && pendingTab
    ? pending.count > pending.tabCount ? `게시 전 ${pending.count}건 · ${pendingTab.label} ${pending.tabCount}건부터 확인` : `게시 전 ${pending.count}건 확인`
    : "";

  return (
    <div className={styles.hub} data-attendee-screen-hub="">
      <nav className={styles.tabs} aria-label="참가자 화면">
        <span className={styles.title}>참가자 화면</span>
        {tabs.map(({ tab, label, pageId }) => {
          const href = consolePageHref(pageId, eventId);
          const status = statuses.find((item) => item.tab === tab);
          const waiting = Boolean(status && status.pending > 0);
          return (
            <Link key={tab} className={styles.tab} href={href ?? "#"} aria-current={tab === active ? "page" : undefined}>
              {label}
              {waiting ? <span className={styles.dot} role="img" aria-label="게시 전 항목 있음" /> : null}
            </Link>
          );
        })}
      </nav>
      {statuses.length ? (
        // Phones get one line instead of the chips (CSS toggles which is shown),
        // so the hub no longer pushes the screen's own content down the page.
        pending && pendingHref ? (
          <Link className={styles.summary} href={pendingHref}>게시 상태 · {pendingText} <span aria-hidden="true">→</span></Link>
        ) : (
          <p className={styles.summary}>게시 상태 · 모두 게시됨</p>
        )
      ) : null}
      {statuses.length ? (
        <div className={styles.status} role="group" aria-label="게시 상태">
          <span className={styles.statusLabel}>게시 상태</span>
          <span className={styles.chips}>
            {statuses.map((status) => (
              <StatusPill key={status.tab} tone={status.tone} size="sm">{status.label}</StatusPill>
            ))}
          </span>
          {pending && pendingHref ? (
            <Link className={styles.review} href={pendingHref}>{pendingText}</Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
