"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../auth-redirect";
import { eventStageClassName, eventStageLabel } from "../event-stage";
import ConsolePage from "./console-ui/ConsolePage";
import ConsoleToolbar from "./console-ui/ConsoleToolbar";
import ConsoleSection from "./console-ui/ConsoleSection";
import ConsoleStatePanel from "./console-ui/ConsoleStatePanel";
import CreateEventDialog from "./CreateEventDialog";
import type { CSSProperties } from "react";
import { cardHeaderTheme, readPublishedCardColor } from "./event-card-theme";
import styles from "./console-home.module.css";

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

function EventCard({
  event,
  clientName,
  todayKey,
}: {
  event: ConsoleEvent;
  clientName: string;
  todayKey: string;
}) {
  const recency = eventRecency(event.date, todayKey);
  // Only the countdown at hand earns the filled voice: today and tomorrow.
  // Far-future (D-86) and past (D+N) counts stay quiet so the
  // name and stage lead. Same strings, same position — tone only.
  const recencySoon = recency === "오늘" || recency === "내일";
  const stageKnown = KNOWN_STAGES.includes(event.stage);
  const stageLabel = stageKnown ? eventStageLabel(event.stage) : "단계 미정";
  const time = event.start && event.end
    ? `${event.start}–${event.end}`
    : event.start || event.end;
  // One grouped date·time line in the tinted header: full date with time,
  // time-only when the date is unknown, and an explicit unknown label —
  // never an empty or inferred date.
  const dateTime = event.date
    ? time ? `${formatEventDate(event.date)} · ${time}` : formatEventDate(event.date)
    : time ? `시간 ${time}` : "일정 미정";
  const clientAndVenue = [clientName, event.venue].filter(Boolean).join(" · ");
  // Published theme tints the header only; status badges keep semantic
  // tokens. Null falls back to the existing `--soft` + brand-text CSS.
  const theme = cardHeaderTheme(event.themeColor);
  const zoneStyle = theme
    ? ({ "--card-zone": theme.background, "--card-zone-ink": theme.color } as CSSProperties)
    : undefined;

  return (
    <article className={styles.eventCard}>
      {/* The whole card body is one entry into the event home. The optional
          approval follow-up stays outside this link so there are no nested
          controls; duplication lives in the create dialog, not on cards.
          The accessible name comes from the card contents (plus a visually
          hidden "열기" affordance) so visible text always stays inside the
          name instead of an aria-label that would orphan it. */}
      <Link
        className={styles.eventCardLink}
        href={`/console/events/${encodeURIComponent(event.id)}`}
      >
        <div className={styles.eventCardZone} style={zoneStyle}>
          <h3 className={styles.eventName}>{event.name}</h3>
          <p className={styles.eventDateTime}>{dateTime}</p>
        </div>
        <div className={styles.eventCardBody}>
          <p className={styles.eventClient}>
            {clientAndVenue || "고객사·장소 미지정"}
          </p>
          <div className={styles.eventCardFoot}>
            {stageKnown ? (
              <span className={eventStageClassName(event.stage)}>{stageLabel}</span>
            ) : <span className="stage-badge">{stageLabel}</span>}
            {recency ? (
              <span className={recencySoon ? `${styles.eventRecency} ${styles.eventRecencySoon}` : styles.eventRecency}>{recency}</span>
            ) : null}
            <svg className={styles.cardArrow} viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M4 10h11m-5-5 5 5-5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="sr-only"> 열기</span>
          </div>
        </div>
      </Link>
      {/* Follow-up only when a queue exists: no permanent footer, no `0명`
          indicator, no per-card duplicate. */}
      {event.pending > 0 ? (
        <div className={styles.eventCardActions}>
          <Link
            className={styles.approvalLink}
            href={`/console/events/${encodeURIComponent(event.id)}/participants?status=PENDING`}
            aria-label={`${event.name} 승인 대기 ${event.pending}명 처리`}
          >
            승인 대기 {event.pending}명 처리
          </Link>
        </div>
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
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
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
        if (!res.ok || !data?.state) {
          setState({ kind: "failed", message: "행사 목록을 불러오지 못했습니다." });
          return;
        }
        const workspaces = data.state.workspaces ?? {};
        const countPending = (eventId: string): number => {          const people = workspaces[eventId]?.participants;
          if (!Array.isArray(people)) return 0;
          let pending = 0;
          for (const item of people) {
            if (typeof item !== "object" || item === null) continue;
            const person = item as Record<string, unknown>;
            if (person.status === "PENDING") pending += 1;
          }
          return pending;
        };
        const events = Array.isArray(data.state.events)
          ? data.state.events.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const event = item as Record<string, unknown>;
              if (typeof event.id !== "string" || !event.id) return [];
              const venueSource = workspaces[event.id]?.venue;
              const capacity = Number(event.capacity);
              // Published-only card theme from the same bootstrap read: no
              // per-card fetch, no draft leak. STAFF projections carry no
              // pageExperience, so those cards fall back to `--soft`.
              const themeColor = readPublishedCardColor(workspaces[event.id]);
              return [{
                id: event.id,
                name: typeof event.name === "string" ? event.name : event.id,
                slug: typeof event.slug === "string" ? event.slug : "",
                clientId: typeof event.clientId === "string" ? event.clientId : null,
                date: typeof event.date === "string" ? event.date : "",
                start: typeof event.start === "string" ? event.start : "",
                end: typeof event.end === "string" ? event.end : "",
                stage: typeof event.stage === "string" ? event.stage : "",
                venue:
                  typeof venueSource === "object" && venueSource !== null &&
                  typeof (venueSource as Record<string, unknown>).name === "string"
                    ? String((venueSource as Record<string, unknown>).name)
                    : "",
                 pending: countPending(event.id),
                capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 0,
                themeColor,
              }];
            })
          : [];
        const clients = new Map<string, string>();
        if (Array.isArray(data.state.clients)) {
          for (const item of data.state.clients) {
            if (typeof item !== "object" || item === null) continue;
            const client = item as Record<string, unknown>;
            if (typeof client.id === "string" && typeof client.name === "string") {
              clients.set(client.id, client.name);
            }
          }
        }
        setState({ kind: "ready", events, clients });
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
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
        카드
      </button>
      <button
        type="button"
        className={`${styles.viewButton}${view === "calendar" ? ` ${styles.viewActive}` : ""}`}
        aria-pressed={view === "calendar"}
        onClick={() => setView("calendar")}
      >
        달력
      </button>
    </div>
  );
  return (
    <ConsolePage
      pageId="events"
      toolbar={
        <ConsoleToolbar
          filters={
            <div className={styles.homeFilters} data-toolbar-span="full">
              <label className={`${styles.searchField} ${styles.homeSearch}`}>
                <span className="sr-only">행사명·고객사·장소 검색</span>
                <input
                  type="search"
                  placeholder="행사 검색"
                  aria-label="행사명·고객사·장소 검색"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className={`${styles.stageFilter} ${styles.homeStage}`}>
                <span>진행 단계</span>
                <select
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as EventFilter)}
                >
                  {FILTERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} ({counts[item.id]})
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${styles.workFilter} ${styles.homeWork}`}>
                <input
                  type="checkbox"
                  checked={needsWork}
                  onChange={(event) => setNeedsWork(event.target.checked)}
                  aria-label={`승인 대기 있는 행사만 보기 (${pendingQueueCount}건)`}
                />
                <span aria-hidden="true">승인 대기만 ({pendingQueueCount})</span>
              </label>
            </div>
          }
          actions={
            <button
              type="button"
              className={`button button-primary ${styles.createTrigger}`}
              onClick={() => setCreateOpen(true)}
            >
              새 행사 만들기
            </button>
          }
        />
      }
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
          onClose={() => setCreateOpen(false)}
          onClientRegistered={(client) => setState((current) => current.kind === "ready"
            ? { ...current, clients: new Map(current.clients).set(client.id, client.name) }
            : current)}
          onCreated={(eventId) => {
            setCreateOpen(false);
            router.push(`/console/events/${encodeURIComponent(eventId)}`);
          }}
        />
      ) : null}

      <ConsoleSection headingId="console-event-directory" title="행사 목록" description={directoryDescription} action={viewSwitch} surface="plain" width="full" className={styles.directorySection}>
        <div className={styles.directory}>
        <p className="sr-only" role="status">
          {filter === "all" && !needsWork && !query.trim() && !dateFilterActive
            ? `전체 ${state.events.length}개 행사`
            : `검색 결과 ${visibleEvents.length}개 / 전체 ${state.events.length}개${needsWork ? " · 승인 대기 있는 행사만" : ""}`}
        </p>

        {view === "calendar" ? (
          <div className={styles.calendarPanel}>
            <div className={styles.monthBar}>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setMonthCursor((cursor) => cursor.month === 0
                  ? { year: cursor.year - 1, month: 11 }
                  : { year: cursor.year, month: cursor.month - 1 })}
                aria-label="이전 달"
              >
                ‹
              </button>
              <strong>{monthCursor.year}년 {monthCursor.month + 1}월</strong>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setMonthCursor((cursor) => cursor.month === 11
                  ? { year: cursor.year + 1, month: 0 }
                  : { year: cursor.year, month: cursor.month + 1 })}
                aria-label="다음 달"
              >
                ›
              </button>
              {selectedDate ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setSelectedDate(null)}
                >
                  {describeDate(selectedDate)} 해제
                </button>
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
            <button type="button" className="button button-secondary" onClick={clearAll}>
              필터 초기화
            </button>
          </div>
        ) : null}

        {!state.events.length ? (
          <div className={styles.emptyState}>
            <h3>아직 등록된 행사가 없습니다</h3>
            <p>새 행사를 만들면 일정과 참가 접수 준비를 시작할 수 있습니다.</p>
          </div>
        ) : !visibleEvents.length ? (
          <div className={styles.emptyState}>
            <h3>조건에 맞는 행사가 없습니다</h3>
            <p>검색어를 바꾸거나 다른 진행 단계·날짜에서 찾아보세요.</p>
            <button
              type="button"
              className="button button-secondary"
              onClick={clearAll}
            >
              필터 초기화
            </button>
          </div>
        ) : (
          <>
            {view === "calendar" && selectedDate ? (
              <h3 className={styles.sectionTitle}>{describeDate(selectedDate)} 행사</h3>
            ) : null}
            <ul className={styles.eventGrid}>
              {(view === "calendar" && selectedDate ? datedVisible : visibleEvents.filter((event) => view === "cards" || event.date)).map((event) => (
                <li key={event.id}>
                  <EventCard
                    event={event}
                    clientName={event.clientId ? state.clients.get(event.clientId) ?? "" : ""}
                    todayKey={todayKey}
                  />
                </li>
              ))}
            </ul>
            {view === "calendar" && !selectedDate && unscheduled.length ? (
              <>
                <h3 className={styles.sectionTitle}>일정 미정 {unscheduled.length}건</h3>
                <ul className={styles.eventGrid}>
                  {unscheduled.map((event) => {
                    return (
                      <li key={event.id}>
                        <EventCard
                          event={event}
                          clientName={event.clientId ? state.clients.get(event.clientId) ?? "" : ""}
                          todayKey={todayKey}
                        />
                      </li>
                    );
                  })}
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
