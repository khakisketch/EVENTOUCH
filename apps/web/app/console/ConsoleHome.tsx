"use client";
import ProductButton from "../ui/ProductButton";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ProductLink from "../ui/ProductLink";
import { loginHrefForLocation } from "../auth-redirect";
import { eventStageClassName, eventStageLabel } from "../event-stage";
import ConsolePage from "./console-ui/ConsolePage";
import ConsoleToolbar from "./console-ui/ConsoleToolbar";
import ConsoleSection from "./console-ui/ConsoleSection";
import ConsoleStatePanel from "./console-ui/ConsoleStatePanel";
import ConsoleFeedback from "./console-ui/ConsoleFeedback";
import ConsoleEmptyState from "./console-ui/ConsoleEmptyState";
import StatusPill from "./console-ui/StatusPill";
import type { StatusPillTone } from "./console-ui/StatusPill";
import { ArrowRightIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "./console-ui/ConsoleIcons";
import { CalendarIcon, RowsIcon } from "./admin-icons";
import CreateEventDialog from "./CreateEventDialog";
import type { CSSProperties } from "react";
import { cardHeaderTheme } from "./event-card-theme";
import styles from "./console-home.module.css";
import CountTabs from "./console-ui/CountTabs";
import { consoleFetch, subscribeConsoleFreshness } from "../../lib/console-api";

type ConsoleEvent = {
  id: string;
  name: string;
  slug: string;
  clientId: string | null;
  date: string;
  start: string;
  end: string;
  stage: string;
  venue: string;
  pending: number;
  capacity: number;
  // Published participant-home background (`#RRGGBB`) or null when the event
  // has no trustworthy published style. Drafts never reach cards; the header
  // falls back to the existing `--soft` surface.
  themeColor: string | null;
};
type EventFilter = "all" | "preparing" | "live" | "closed";
type HomeView = "cards" | "calendar";

type HomeState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; events: ConsoleEvent[]; clients: Map<string, string> };

const FILTERS: Array<{ id: EventFilter; label: string }> = [
  { id: "all", label: "전체" },
  { id: "preparing", label: "준비 중" },
  { id: "live", label: "진행 중" },
  { id: "closed", label: "종료·보관" },
];

const KNOWN_STAGES = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];

// Calendar recency is display-only: it never changes the operational stage.
// Recency is display-only: it never changes the operational stage. Future
// and past dates share one arithmetic (D-70 / D+3) so a past date next to an
// active stage never reads as a contradiction.
function eventRecency(date: string, todayKey: string): string | null {
  if (!date) return null;
  if (date === todayKey) return "오늘";
  if (date > todayKey) {
    const days = Math.round(
      (new Date(`${date}T00:00:00`).getTime() - new Date(`${todayKey}T00:00:00`).getTime()) / 86400000
    );
    if (days === 1) return "내일";
    return `D-${days}`;
  }
  const days = Math.round(
    (new Date(`${todayKey}T00:00:00`).getTime() - new Date(`${date}T00:00:00`).getTime()) / 86400000
  );
  if (days === 1) return "어제";
  return `D+${days}`;
}

function todayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function readHomeFilters(search: string): {
  query: string;
  filter: EventFilter;
  needsWork: boolean;
  view: HomeView;
  selectedDate: string | null;
  month: { year: number; month: number } | null;
} {
  // Home directory state restores from the URL so a return from a work
  // queue (participants?status=PENDING) lands back in context. Values are
  // allowlisted; anything else falls back to the unfiltered cards view.
  // Unrelated params are never touched by the reader.
  try {
    const params = new URLSearchParams(search);
    const rawFilter = params.get("stage") ?? "";
    const filter: EventFilter =
      rawFilter === "preparing" || rawFilter === "live" || rawFilter === "closed"
        ? rawFilter
        : "all";
    const rawView = params.get("view") ?? "";
    const view: HomeView = rawView === "calendar" ? "calendar" : "cards";
    const rawDate = params.get("date") ?? "";
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    const rawMonth = params.get("month") ?? "";
    let month: { year: number; month: number } | null = null;
    const monthMatch = /^(\d{4})-(\d{2})$/.exec(rawMonth);
    if (monthMatch) {
      const year = Number(monthMatch[1]);
      const monthIndex = Number(monthMatch[2]) - 1;
      if (monthIndex >= 0 && monthIndex <= 11) month = { year, month: monthIndex };
    }
    if (!month && selectedDate) {
      const [year, monthNumber] = selectedDate.split("-").map(Number);
      if (Number.isFinite(year) && Number.isFinite(monthNumber)) {
        month = { year, month: monthNumber - 1 };
      }
    }
    return {
      query: params.get("q") ?? params.get("query") ?? "",
      filter,
      needsWork: params.get("needsWork") === "1",
      view,
      selectedDate,
      month,
    };
  } catch {
    return { query: "", filter: "all", needsWork: false, view: "cards", selectedDate: null, month: null };
  }
}

function describeDate(date: string): string {
  if (!date) return "일정 미정";
  const [, month, day] = date.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function formatEventDate(date: string): string {
  if (!date) return "일정 미정";
  const [year, month, day] = date.split("-");
  return year && month && day ? `${year}.${month}.${day}` : date;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// "11월 25일 (수)", with the year only when it is not the current one.
function formatEventDay(date: string, todayKey: string): string {
  if (!date) return "일정 미정";
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  const prefix = String(year) === todayKey.slice(0, 4) ? "" : `${year}년 `;
  return `${prefix}${month}월 ${day}일 (${weekday})`;
}

// One pill says the stage (green running, blue preparing, grey closed); amber
// is kept for work waiting on a person, so a stage never borrows it.
function stageDotTone(stage: string): "live" | "prep" | "done" | "unknown" {
  if (stage === "LIVE") return "live";
  if (stage === "DRAFT" || stage === "READY") return "prep";
  if (stage === "ENDED" || stage === "ARCHIVED") return "done";
  return "unknown";
}

const STAGE_PILL_TONE: Record<ReturnType<typeof stageDotTone>, StatusPillTone> = {
  live: "ok",
  prep: "info",
  done: "neutral",
  unknown: "neutral",
};

// "Needs attention now": a running event, one that is today or tomorrow, or
// one with approvals waiting. Closed events never are, whatever they hold.
function isUrgentEvent(event: ConsoleEvent, todayKey: string): boolean {
  if (event.stage === "ENDED" || event.stage === "ARCHIVED") return false;
  if (event.stage === "LIVE" || event.pending > 0) return true;
  const recency = eventRecency(event.date, todayKey);
  return recency === "오늘" || recency === "내일";
}

// Today first, then tomorrow, then the most approvals waiting, then the date.
function urgencyRank(event: ConsoleEvent, todayKey: string): number {
  const recency = eventRecency(event.date, todayKey);
  if (event.stage === "LIVE") return 0;
  if (recency === "오늘") return 1;
  if (recency === "내일") return 2;
  return 3;
}

function EventRow({
  event,
  clientName,
  todayKey,
  urgent = false,
}: {
  event: ConsoleEvent;
  clientName: string;
  todayKey: string;
  urgent?: boolean;
}) {
  const recency = eventRecency(event.date, todayKey);
  const stageKnown = KNOWN_STAGES.includes(event.stage);
  const stageLabel = stageKnown ? eventStageLabel(event.stage) : "단계 미정";
  const tone = stageDotTone(event.stage);
  const time = event.start || event.end;
  // The date leads in strong type; time, client and venue follow quietly. The
  // stage word lives in the accessible name and the dot, not in the line. An
  // undated event with a time says so instead of showing a bare clock.
  const lead = event.date
    ? formatEventDay(event.date, todayKey)
    : time ? `시간 ${time}` : "일정 미정";
  const rest = [event.date ? time : "", clientName, event.venue].filter(Boolean).join(" · ");
  const theme = cardHeaderTheme(event.themeColor);
  const zoneStyle = theme
    ? ({ "--card-zone": theme.background } as CSSProperties)
    : undefined;
  const [, tileMonth, tileDay] = event.date ? event.date.split("-") : [];
  const soon = recency === "오늘" || recency === "내일";

  return (
    <article className={styles.eventRow} data-tone={tone} data-urgent={urgent || undefined}>
      {/* The row body is one entry into the event home. The approval
          follow-up stays outside this link so there are no nested controls. */}
      <ProductLink
        className={styles.eventRowLink}
        href={`/console/events/${encodeURIComponent(event.id)}`}
      >
        <span className={styles.dateTile} data-tone={tone} data-soon={soon || undefined} aria-hidden="true">
          {tileMonth && tileDay ? (
            <>
              <small>{Number(tileMonth)}월</small>
              <b>{Number(tileDay)}</b>
            </>
          ) : (
            <small>미정</small>
          )}
        </span>
        <div className={styles.eventRowMain}>
          <div className={styles.eventNameRow}>
            <h3 className={styles.eventName} style={zoneStyle}>{event.name}</h3>
            <span aria-hidden="true">
              <StatusPill tone={STAGE_PILL_TONE[tone]} size="sm" dot>{stageLabel}</StatusPill>
            </span>
          </div>
          <p className={styles.eventDateTime}>
            <strong>{lead}</strong>
            {rest ? ` ${rest}` : ""}
          </p>
        </div>
        {recency ? (
          soon
            ? <StatusPill tone="ink" className={styles.eventRecency}>{recency}</StatusPill>
            : <span className={styles.eventRecency}>{recency}</span>
        ) : <span />}
        <span className={styles.rowArrow} aria-hidden="true">
          <ChevronRightIcon />
        </span>
        <span className="sr-only"> {stageLabel} · 열기</span>
      </ProductLink>
      {/* The next action sits at the end of the row only when there is one:
          no permanent footer, no `0명` indicator. */}
      {event.pending > 0 ? (
        <ProductLink
          className={styles.rowAction}
          href={`/console/events/${encodeURIComponent(event.id)}/participants?status=PENDING`}
          aria-label={`${event.name} 승인 대기 ${event.pending}명 처리`}
        >
          <StatusPill tone="wait" className={styles.rowActionPill}>승인 대기 {event.pending}명 처리 ›</StatusPill>
        </ProductLink>
      ) : null}
    </article>
  );
}

export default function ConsoleHome() {
  const router = useRouter();
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [needsWork, setNeedsWork] = useState(false);
  const [view, setView] = useState<HomeView>("cards");
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [receiptNotice, setReceiptNotice] = useState<string | null>(null);
  useEffect(() => subscribeConsoleFreshness(() => {
    if (!createOpen) setReloadTick((tick) => tick + 1);
  }), [createOpen]);
  // URL-synced directory filters (participants-style replaceState, never
  // router navigation): typing must not refetch or reroute. The init effect
  // owns the first read; the sync effect skips it via skipFirstSyncRef.
  const homeFiltersReadyRef = useRef(false);
  const skipFirstHomeSyncRef = useRef(true);

  // An open create/duplicate dialog holds unsent input; the directory list
  // itself is never dirty.

  useEffect(() => {
    try {
      const initial = readHomeFilters(window.location.search);
      setQuery(initial.query);
      setFilter(initial.filter);
      setNeedsWork(initial.needsWork);
      setView(initial.view);
      setSelectedDate(initial.selectedDate);
      if (initial.month) setMonthCursor(initial.month);
      // Scrub invalid allowlisted values so the URL never contradicts the
      // unfiltered view; unrelated params are preserved.
      const params = new URLSearchParams(window.location.search);
      const rawStage = params.get("stage") ?? "";
      if (rawStage && !["preparing", "live", "closed", "all"].includes(rawStage)) {
        params.delete("stage");
      }
      const rawView = params.get("view") ?? "";
      if (rawView && rawView !== "cards" && rawView !== "calendar") {
        params.delete("view");
      }
      const rawDate = params.get("date") ?? "";
      if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        params.delete("date");
      }
      const rawMonth = params.get("month") ?? "";
      if (rawMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth)) {
        params.delete("month");
      }
      const rawWork = params.get("needsWork") ?? "";
      if (rawWork && rawWork !== "1") {
        params.delete("needsWork");
      }
      const scrubbed = params.toString();
      const current = new URLSearchParams(window.location.search).toString();
      if (scrubbed !== current) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${scrubbed ? `?${scrubbed}` : ""}${window.location.hash}`
        );
      }
    } catch {
      // Filtering still works; only the shareable URL keeps the stale value.
    }
    const onPopState = () => {
      try {
        const next = readHomeFilters(window.location.search);
        setQuery(next.query);
        setFilter(next.filter);
        setNeedsWork(next.needsWork);
        setView(next.view);
        setSelectedDate(next.selectedDate);
        if (next.month) setMonthCursor(next.month);
      } catch {
        // Keep the current view.
      }
    };
    window.addEventListener("popstate", onPopState);
    homeFiltersReadyRef.current = true;
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (!homeFiltersReadyRef.current) return;
    // Skip the mount pass: the init effect above owns the first read, so the
    // sync must not strip a shared URL before that state lands.
    if (skipFirstHomeSyncRef.current) {
      skipFirstHomeSyncRef.current = false;
      return;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      if (query.trim()) params.set("q", query.trim());
      else {
        params.delete("q");
        params.delete("query");
      }
      if (filter !== "all") params.set("stage", filter);
      else params.delete("stage");
      if (needsWork) params.set("needsWork", "1");
      else params.delete("needsWork");
      if (view !== "cards") params.set("view", view);
      else params.delete("view");
      if (view === "calendar" && selectedDate) params.set("date", selectedDate);
      else params.delete("date");
      if (view === "calendar") params.set("month", monthKeyOf(monthCursor.year, monthCursor.month));
      else params.delete("month");
      const next = params.toString();
      const current = new URLSearchParams(window.location.search).toString();
      if (next !== current) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`
        );
      }
    } catch {
      // Filtering still works; only shareable URLs lose the sync.
    }
  }, [query, filter, needsWork, view, selectedDate, monthCursor]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await consoleFetch("/api/console/directory", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          directory?: {
            events?: unknown;
            clients?: unknown;
            // Counts stay adjacent to the identity fields; everything else
            // remains server-owned and is read on the event screens.
            workspaces?: Record<string, {
              participants?: unknown;
              venue?: { name?: unknown } | null;
            }>;
          } | null;
        } | null;
        if (!res.ok || !data?.directory) {
          const message = "행사 목록을 불러오지 못했습니다.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
          return;
        }
        const events = Array.isArray(data.directory.events)
          ? data.directory.events.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const event = item as Record<string, unknown>;
              if (typeof event.id !== "string" || !event.id) return [];
              const capacity = Number(event.capacity);
               // Server directory summarizes the same published-only color:
               // no per-card reads or draft preview leaks into A2 cards.
               const themeColor = typeof event.themeColor === "string" && /^#[0-9a-f]{6}$/i.test(event.themeColor)
                 ? event.themeColor : null;
              return [{
                id: event.id,
                name: typeof event.name === "string" ? event.name : event.id,
                slug: typeof event.slug === "string" ? event.slug : "",
                clientId: typeof event.clientId === "string" ? event.clientId : null,
                date: typeof event.date === "string" ? event.date : "",
                start: typeof event.start === "string" ? event.start : "",
                end: typeof event.end === "string" ? event.end : "",
                stage: typeof event.stage === "string" ? event.stage : "",
                 venue: typeof event.venue === "string" ? event.venue : "",
                 pending: typeof event.pending === "number" ? event.pending : 0,
                capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 0,
                themeColor,
              }];
            })
          : [];
        const clients = new Map<string, string>();
        if (Array.isArray(data.directory.clients)) {
          for (const item of data.directory.clients) {
            if (typeof item !== "object" || item === null) continue;
            const client = item as Record<string, unknown>;
            if (typeof client.id === "string" && typeof client.name === "string") {
              clients.set(client.id, client.name);
            }
          }
        }
        setState({ kind: "ready", events, clients });
        setRefreshError(null);
      } catch {
        if (!cancelled) {
          const message = "연결하지 못했습니다. 다시 시도하세요.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [reloadTick, router]);

  const todayKey = todayKeyOf(new Date());

  const stageQueryFiltered = useMemo(() => {
    if (state.kind !== "ready") return [];
    const search = query.trim().toLocaleLowerCase("ko-KR");
    return state.events.filter((event) => {
      const clientName = event.clientId ? state.clients.get(event.clientId) ?? "" : "";
      const matchesQuery = !search || `${event.name} ${clientName} ${event.venue}`.toLocaleLowerCase("ko-KR").includes(search);
      const matchesFilter =
        filter === "all" ||
        (filter === "preparing" && ["DRAFT", "READY"].includes(event.stage)) ||
        (filter === "live" && event.stage === "LIVE") ||
        (filter === "closed" && ["ENDED", "ARCHIVED"].includes(event.stage));
      // Triage first: the pending queue is the operator's Monday-morning
      // question, and calendar order buries it.
      const matchesWork = !needsWork || event.pending > 0;
      return matchesQuery && matchesFilter && matchesWork;
    });
  }, [filter, needsWork, query, state]);

  const visibleEvents = useMemo(() => {
    const dated = selectedDate && view === "calendar"
      ? stageQueryFiltered.filter((event) => event.date === selectedDate)
      : stageQueryFiltered;
    // The calendar is the primary index: today's sessions first, then the
    // nearest future date, recent past events, and finally undated events.
    const bucket = (event: ConsoleEvent) => {
      if (!event.date) return 3;
      if (event.date === todayKey) return 0;
      return event.date > todayKey ? 1 : 2;
    };
    return [...dated].sort((a, b) => {
      // With the triage filter on, urgency outranks the calendar: most
      // pending approvals first.
      if (needsWork && a.pending !== b.pending) return b.pending - a.pending;
      const aBucket = bucket(a);
      const bBucket = bucket(b);
      if (aBucket !== bBucket) return aBucket - bBucket;
      const dateOrder = aBucket === 2 ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
      return dateOrder || a.start.localeCompare(b.start) || a.name.localeCompare(b.name, "ko-KR");
    });
  }, [stageQueryFiltered, selectedDate, view, todayKey, needsWork]);

  const unscheduled = useMemo(
    () => visibleEvents.filter((event) => !event.date),
    [visibleEvents]
  );
  const datedVisible = useMemo(
    () => visibleEvents.filter((event) => event.date),
    [visibleEvents]
  );

  const monthCells = useMemo(() => {
    const firstWeekday = new Date(monthCursor.year, monthCursor.month, 1).getDay();
    const days = new Date(monthCursor.year, monthCursor.month + 1, 0).getDate();
    const cells: Array<{ key: string; day: number | null }> = [];
    for (let i = 0; i < firstWeekday; i += 1) cells.push({ key: `blank-${i}`, day: null });
    for (let day = 1; day <= days; day += 1) {
      cells.push({
        key: `${monthKeyOf(monthCursor.year, monthCursor.month)}-${String(day).padStart(2, "0")}`,
        day,
      });
    }
    return cells;
  }, [monthCursor]);

  const eventDates = useMemo(() => {
    const dates = new Map<string, number>();
    for (const event of stageQueryFiltered) {
      if (!event.date) continue;
      dates.set(event.date, (dates.get(event.date) ?? 0) + 1);
    }
    return dates;
  }, [stageQueryFiltered]);

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="events">
        {/* Page title comes from the ConsolePage registry; this file owns no heading. */}
        <ConsoleStatePanel kind="loading" message="행사 목록을 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="events">
        {/* ConsoleStatePanel dispatches eventouch:shell-reload before the directory retry. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => setReloadTick((tick) => tick + 1)}
        />
      </ConsolePage>
    );
  }
  const clientOptions = [...state.clients.entries()].map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"));
  const counts: Record<EventFilter, number> = {
    all: state.events.length,
    preparing: state.events.filter((event) => ["DRAFT", "READY"].includes(event.stage)).length,
    live: state.events.filter((event) => event.stage === "LIVE").length,
    closed: state.events.filter((event) => ["ENDED", "ARCHIVED"].includes(event.stage)).length,
  };
  const clearAll = () => {
    // needsWork is a narrowing filter too: leaving it set makes the
    // pending-approval queue look uncleared after "필터 초기화".
    setQuery("");
    setFilter("all");
    setNeedsWork(false);
    setSelectedDate(null);
  };
  const dateFilterActive = view === "calendar" && selectedDate !== null;
  const hasNarrowing = query.trim() !== "" || filter !== "all" || needsWork || dateFilterActive;
  const pendingQueueCount = state.events.filter((event) => event.pending > 0).length;
  // The directory count lives in the section header description so the list
  // needs no extra 44px count row on first paint. The narrowing-only row
  // below keeps just the reset action; the sr-only status keeps the full
  // context for assistive technology.
  const directoryDescription =
    filter === "all" && !needsWork && !query.trim() && !dateFilterActive
      ? `전체 ${state.events.length}개 행사`
      : `검색 결과 ${visibleEvents.length}개 / 전체 ${state.events.length}개${needsWork ? " · 승인 대기 있는 행사만" : ""}`;
  const viewSwitch = (
    <div className={styles.viewSwitch} role="group" aria-label="목록 보기 방식">
      <button
        type="button"
        className={`${styles.viewButton}${view === "cards" ? ` ${styles.viewActive}` : ""}`}
        aria-pressed={view === "cards"}
        onClick={() => setView("cards")}
      >
        <RowsIcon />
        콜시트
      </button>
      <button
        type="button"
        className={`${styles.viewButton}${view === "calendar" ? ` ${styles.viewActive}` : ""}`}
        aria-pressed={view === "calendar"}
        onClick={() => setView("calendar")}
      >
        <CalendarIcon />
        달력
      </button>
    </div>
  );
  const stageTabs = (
    <CountTabs
      ariaLabel="진행 단계"
      value={filter}
      onChange={(key) => setFilter(key as EventFilter)}
      dots={{ live: "live" }}
      items={FILTERS.map((item) => ({ key: item.id, label: item.label, count: counts[item.id] }))}
    />
  );
  // Four groups, in this order: the running event as the page's one card, the
  // events that need attention now (running, today, tomorrow, approvals
  // waiting), then upcoming and past. Closed events are never "urgent".
  const renderGroups = (list: ConsoleEvent[]) => {
    const clientOf = (event: ConsoleEvent) => event.clientId ? state.clients.get(event.clientId) ?? "" : "";
    const live = list.filter((event) => event.stage === "LIVE")[0] ?? null;
    const rest = live ? list.filter((event) => event.id !== live.id) : list;
    const urgent = rest
      .filter((event) => isUrgentEvent(event, todayKey))
      .sort((a, b) =>
        urgencyRank(a, todayKey) - urgencyRank(b, todayKey)
        || b.pending - a.pending
        || a.date.localeCompare(b.date)
        || a.start.localeCompare(b.start)
        || a.name.localeCompare(b.name, "ko-KR"));
    const urgentIds = new Set(urgent.map((event) => event.id));
    const calm = rest.filter((event) => !urgentIds.has(event.id));
    const upcoming = calm.filter((event) => !event.date || event.date >= todayKey);
    const past = calm.filter((event) => event.date && event.date < todayKey);
    const renderRows = (rows: ConsoleEvent[], rowUrgent = false) => (
      <ul className={styles.eventGrid}>
        {rows.map((event) => (
          <li key={event.id}>
            <EventRow event={event} clientName={clientOf(event)} todayKey={todayKey} urgent={rowUrgent} />
          </li>
        ))}
      </ul>
    );
    return (
      <>
        {live ? (
          <section className={styles.liveCard} aria-labelledby="console-live-event">
            <div className={styles.liveBody}>
              <p className={styles.liveKicker}>진행 중</p>
              <h3 id="console-live-event" className={styles.liveName}>{live.name}</h3>
              <p className={styles.liveMeta}>
                {[eventRecency(live.date, todayKey) === "오늘" ? "오늘" : formatEventDay(live.date, todayKey), [live.start, live.end].filter(Boolean).join("–"), clientOf(live), live.venue].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className={styles.liveActions}>
              <ProductLink className={styles.liveLink} href={`/console/events/${encodeURIComponent(live.id)}`}>
                운영 현황 열기
                <ArrowRightIcon />
              </ProductLink>
              {live.pending > 0 ? (
                <ProductLink
                  className={styles.liveQueue}
                  href={`/console/events/${encodeURIComponent(live.id)}/participants?status=PENDING`}
                  aria-label={`${live.name} 승인 대기 ${live.pending}명 처리`}
                >
                  승인 대기 {live.pending}명 처리 ›
                </ProductLink>
              ) : null}
            </div>
          </section>
        ) : null}
        {urgent.length ? (
          <>
            <h3 className={styles.groupTitle} data-urgent="true">지금 챙길 행사 <span className={styles.groupCount}>{urgent.length}</span></h3>
            {renderRows(urgent, true)}
          </>
        ) : null}
        {upcoming.length ? (
          <>
            <h3 className={styles.groupTitle}>다가오는 행사 <span className={styles.groupCount}>{upcoming.length}</span></h3>
            {renderRows(upcoming)}
          </>
        ) : null}
        {past.length ? (
          <>
            <h3 className={styles.groupTitle}>지난 행사 <span className={styles.groupCount}>{past.length}</span></h3>
            {renderRows(past)}
          </>
        ) : null}
      </>
    );
  };
  return (
    <ConsolePage
      pageId="events"
      headerActions={
        <ProductButton
          type="button"
          className={`button button-primary ${styles.createTrigger}`}
          onClick={() => setCreateOpen(true)}
          icon={<PlusIcon />}
        >
          새 행사 만들기
        </ProductButton>
      }
      feedback={refreshError || receiptNotice ? <>
        {refreshError ? <ConsoleFeedback kind="error">{refreshError} 이전 목록은 유지됩니다. <ProductButton className="button button-secondary" type="button" onClick={() => setReloadTick((tick) => tick + 1)}>다시 불러오기</ProductButton></ConsoleFeedback> : null}
        {receiptNotice ? <ConsoleFeedback kind="success">{receiptNotice}</ConsoleFeedback> : null}
      </> : undefined}
    >

      {createOpen ? (
        <CreateEventDialog
          clients={clientOptions}
          duplicateSources={state.events.map((event) => ({
            id: event.id,
            name: event.name,
            slug: event.slug,
            clientName: event.clientId ? state.clients.get(event.clientId) ?? "" : "",
            date: event.date,
            start: event.start,
            end: event.end,
            capacity: event.capacity,
            stage: event.stage,
          }))}
          onClose={() => { setCreateOpen(false); setReloadTick((tick) => tick + 1); }}
          onConfirmedWithoutDetails={() => {
            setCreateOpen(false);
            setReloadTick((tick) => tick + 1);
            setReceiptNotice("행사 생성이 서버에 반영된 것을 확인했습니다. 목록에서 행사를 확인하세요.");
          }}
          onClientRegistered={(client) => setState((current) => current.kind === "ready"
            ? { ...current, clients: new Map(current.clients).set(client.id, client.name) }
            : current)}
          onCreated={(eventId) => {
            setCreateOpen(false);
            router.push(`/console/events/${encodeURIComponent(eventId)}`);
          }}
        />
      ) : null}

      <ConsoleSection headingId="console-event-directory" title="행사 목록" description={directoryDescription} surface="plain" width="full" className={styles.directorySection}>
        <div className={styles.tabsRow}>{stageTabs}</div>
        <ConsoleToolbar
          filters={
            <div className={styles.homeFilters} data-toolbar-span="full">
              <label className={`${styles.searchField} ${styles.homeSearch}`}>
                <span className="sr-only">행사명·고객사·장소 검색</span>
                <span className={styles.searchGlyph} aria-hidden="true"><SearchIcon /></span>
                <input
                  type="search"
                  placeholder="행사 검색"
                  aria-label="행사명·고객사·장소 검색"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className={`${styles.workFilter} ${styles.homeWork}`} data-alert={pendingQueueCount > 0 ? "true" : undefined}>
                <input
                  type="checkbox"
                  checked={needsWork}
                  onChange={(event) => setNeedsWork(event.target.checked)}
                  aria-label={`승인 대기 있는 행사만 보기 (${pendingQueueCount}건)`}
                />
                <span aria-hidden="true">승인 대기만 <b>{pendingQueueCount}</b></span>
              </label>
              {viewSwitch}
            </div>
          }
        />
        <div className={styles.directory}>
        <p className="sr-only" role="status">
          {filter === "all" && !needsWork && !query.trim() && !dateFilterActive
            ? `전체 ${state.events.length}개 행사`
            : `검색 결과 ${visibleEvents.length}개 / 전체 ${state.events.length}개${needsWork ? " · 승인 대기 있는 행사만" : ""}`}
        </p>

        {view === "calendar" ? (
          <div className={styles.calendarPanel}>
            <div className={styles.monthBar}>
              <ProductButton
                type="button"
                className="button button-secondary"
                onClick={() => setMonthCursor((cursor) => cursor.month === 0
                  ? { year: cursor.year - 1, month: 11 }
                  : { year: cursor.year, month: cursor.month - 1 })}
                aria-label="이전 달"
              >
                ‹
              </ProductButton>
              <strong>{monthCursor.year}년 {monthCursor.month + 1}월</strong>
              <ProductButton
                type="button"
                className="button button-secondary"
                onClick={() => setMonthCursor((cursor) => cursor.month === 11
                  ? { year: cursor.year + 1, month: 0 }
                  : { year: cursor.year, month: cursor.month + 1 })}
                aria-label="다음 달"
              >
                ›
              </ProductButton>
              {selectedDate ? (
                <ProductButton
                  type="button"
                  className="button button-secondary"
                  onClick={() => setSelectedDate(null)}
                >
                  {describeDate(selectedDate)} 해제
                </ProductButton>
              ) : null}
            </div>
            <div className={styles.monthGrid} role="group" aria-label="날짜 선택">
              {["일", "월", "화", "수", "목", "금", "토"].map((weekday) => (
                <span key={weekday} className={styles.weekday} aria-hidden="true">{weekday}</span>
              ))}
              {monthCells.map((cell) => {
                if (cell.day === null) return <span key={cell.key} aria-hidden="true" />;
                const count = eventDates.get(cell.key) ?? 0;
                const selected = selectedDate === cell.key;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    className={`${styles.dayCell}${selected ? ` ${styles.daySelected}` : ""}${cell.key === todayKey ? ` ${styles.dayToday}` : ""}`}
                    aria-pressed={selected}
                    aria-label={`${describeDate(cell.key)}${count ? `, 행사 ${count}건` : ", 행사 없음"}`}
                    onClick={() => setSelectedDate(selected ? null : cell.key)}
                  >
                    <span className={styles.dayNumber}>{cell.day}</span>
                    {count ? <span className={styles.dayCount}>{count}건</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {hasNarrowing && visibleEvents.length > 0 ? (
          <div className={styles.resultsMeta}>
            <ProductButton type="button" className="button button-secondary" onClick={clearAll}>
              필터 초기화
            </ProductButton>
          </div>
        ) : null}

        {!state.events.length ? (
          <ConsoleEmptyState
            titleAs="h3"
            title="아직 등록된 행사가 없습니다"
            description="새 행사를 만들면 일정과 참가 접수 준비를 시작할 수 있습니다."
          />
        ) : !visibleEvents.length ? (
          <ConsoleEmptyState
            kind="filtered"
            titleAs="h3"
            title="조건에 맞는 행사가 없습니다"
            description="검색어를 바꾸거나 다른 진행 단계·날짜에서 찾아보세요."
            action={
              <ProductButton
                type="button"
                className="button button-secondary"
                onClick={clearAll}
              >
                필터 초기화
              </ProductButton>
            }
          />
        ) : (
          <>
            {view === "calendar" && selectedDate ? (
              <h3 className={styles.sectionTitle}>{describeDate(selectedDate)} 행사</h3>
            ) : null}
            {renderGroups(view === "calendar" && selectedDate ? datedVisible : visibleEvents.filter((event) => view === "cards" || event.date))}
            {view === "calendar" && !selectedDate && unscheduled.length ? (
              <>
                <h3 className={styles.sectionTitle}>일정 미정 {unscheduled.length}건</h3>
                <ul className={styles.eventGrid}>
                  {unscheduled.map((event) => (
                    <li key={event.id}>
                      <EventRow
                        event={event}
                        clientName={event.clientId ? state.clients.get(event.clientId) ?? "" : ""}
                        todayKey={todayKey}
                      />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
        </div>
      </ConsoleSection>
    </ConsolePage>
  );
}
