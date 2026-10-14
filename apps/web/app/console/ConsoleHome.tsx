"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { eventStageClassName, eventStageLabel } from "../event-stage";
import CreateEventDialog from "./CreateEventDialog";
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
  registered: number;
  pending: number;
  inside: number;
  capacity: number;
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
// A past date with an active stage reads as "지난 일정" next to the badge,
// so the two dimensions stay visibly distinct.
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
  return "지난 일정";
}

function todayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

// The card's single next action: the most urgent unfinished work for that
// event, so the grid answers "what do I touch next" without a separate list.
function nextAction(event: ConsoleEvent): { label: string; href: string } {
  const base = `/console/events/${encodeURIComponent(event.id)}`;
  if (event.pending > 0) return { label: "승인 처리하기", href: `${base}/participants` };
  if (event.stage === "DRAFT") return { label: "이어서 만들기", href: `${base}/settings` };
  if (event.stage === "READY") return { label: "현장 준비하기", href: `${base}/operations` };
  if (event.stage === "LIVE") return { label: "현장 보기", href: `${base}/operations` };
  return { label: "행사 열기", href: base };
}

function describeDate(date: string): string {
  if (!date) return "일정 미정";
  const [year, month, day] = date.split("-");
  return `${Number(month)}월 ${Number(day)}일${year ? "" : ""}`;
}

export default function ConsoleHome() {
  const router = useRouter();
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [view, setView] = useState<HomeView>("cards");
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push("/staff/login");
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
        const countParticipants = (eventId: string): { registered: number; pending: number; inside: number } => {
          const people = workspaces[eventId]?.participants;
          if (!Array.isArray(people)) return { registered: 0, pending: 0, inside: 0 };
          let registered = 0;
          let pending = 0;
          let inside = 0;
          for (const item of people) {
            if (typeof item !== "object" || item === null) continue;
            const person = item as Record<string, unknown>;
            if (person.status === "CANCELLED") continue;
            registered += 1;
            if (person.status === "PENDING") pending += 1;
            if (person.inside === true) inside += 1;
          }
          return { registered, pending, inside };
        };
        const events = Array.isArray(data.state.events)
          ? data.state.events.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const event = item as Record<string, unknown>;
              if (typeof event.id !== "string" || !event.id) return [];
              const venueSource = workspaces[event.id]?.venue;
              const capacity = Number(event.capacity);
              const counts = countParticipants(event.id);
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
                registered: counts.registered,
                pending: counts.pending,
                inside: counts.inside,
                capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 0,
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
      return matchesQuery && matchesFilter;
    });
  }, [filter, query, state]);

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
      const aBucket = bucket(a);
      const bBucket = bucket(b);
      if (aBucket !== bBucket) return aBucket - bBucket;
      const dateOrder = aBucket === 2 ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
      return dateOrder || a.start.localeCompare(b.start) || a.name.localeCompare(b.name, "ko-KR");
    });
  }, [stageQueryFiltered, selectedDate, view, todayKey]);

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
      <div className={styles.home}>
        <header className={styles.pageHeader}>
          <h1>행사</h1>
        </header>
        <p className="loading-state" role="status">행사 목록을 불러오고 있습니다.</p>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className={styles.home}>
        <header className={styles.pageHeader}>
          <h1>행사</h1>
        </header>
        <section className={styles.statePanel}>
          <p role="alert">{state.message}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setReloadTick((tick) => tick + 1);
              // The shell owns its own bootstrap fetch; without this the
              // navigation stays empty while only the list recovers.
              window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
            }}
          >
            다시 불러오기
          </button>
        </section>
      </div>
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
    setQuery("");
    setFilter("all");
    setSelectedDate(null);
  };
  const hasNarrowing = query.trim() !== "" || filter !== "all" || selectedDate !== null;
  return (
    <div className={styles.home}>
      <header className={styles.pageHeader}>
        <h1>행사</h1>
        <button
          type="button"
          className={`button button-primary ${styles.createTrigger}`}
          onClick={() => setCreateOpen(true)}
        >
          새 행사 만들기
        </button>
      </header>

      {createOpen ? (
        <CreateEventDialog
          clients={clientOptions}
          onClose={() => setCreateOpen(false)}
          onCreated={(eventId) => {
            setCreateOpen(false);
            router.push(`/console/events/${encodeURIComponent(eventId)}`);
          }}
        />
      ) : null}

      <section className={styles.directory} aria-label="행사 목록">
        <p className="sr-only" role="status">
          {filter === "all" && !query.trim() && !selectedDate
            ? `전체 ${state.events.length}개 행사`
            : `검색 결과 ${visibleEvents.length}개 / 전체 ${state.events.length}개`}
        </p>

        <div className={styles.toolbar}>
          <div className={styles.filters} role="group" aria-label="행사 단계">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`${styles.filterButton}${filter === item.id ? ` ${styles.filterActive}` : ""}`}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                <span>{item.label}</span>
                <span className={styles.filterCount}>{counts[item.id]}</span>
              </button>
            ))}
          </div>
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
          <label className={styles.searchField}>
            <span className="sr-only">행사명·고객사·장소 검색</span>
            <input
              type="search"
              placeholder="행사명·고객사·장소 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

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
              <h2 className={styles.sectionTitle}>{describeDate(selectedDate)} 행사 {datedVisible.length}건</h2>
            ) : null}
            <ul className={styles.eventGrid}>
              {(view === "calendar" && selectedDate ? datedVisible : visibleEvents.filter((event) => view === "cards" || event.date)).map((event) => {
                const clientName = event.clientId ? state.clients.get(event.clientId) : "";
                const recency = eventRecency(event.date, todayKey);
                const stageKnown = KNOWN_STAGES.includes(event.stage);
                const action = nextAction(event);
                return (
                  <li key={event.id}>
                    <article className={styles.eventCard}>
                      <p className={styles.eventDate}>
                        <strong>{event.date || "일정 미정"}</strong>
                        {event.start || event.end ? (
                          <span>{event.start}{event.end ? `–${event.end}` : ""}</span>
                        ) : null}
                        {recency ? (
                          <span className={styles.eventRecency}>{recency}</span>
                        ) : null}
                      </p>
                      <h3 className={styles.eventName}>
                        <Link href={`/console/events/${encodeURIComponent(event.id)}`}>
                          {event.name}
                        </Link>
                      </h3>
                      <p className={styles.eventClient}>
                        {[clientName, event.venue].filter(Boolean).join(" · ") || "고객사·장소 미지정"}
                      </p>
                      <p className={styles.eventStatus}>
                        {stageKnown ? (
                          <span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span>
                        ) : <span className="stage-badge">단계 미정</span>}
                        {event.pending > 0 ? (
                          <span className={styles.pendingBadge}>승인대기 {event.pending}</span>
                        ) : null}
                      </p>
                      <dl className={styles.eventMetrics}>
                        <div>
                          <dt>등록</dt>
                          <dd>{event.registered}{event.capacity ? <span>/{event.capacity}</span> : null}</dd>
                        </div>
                        <div>
                          <dt>승인대기</dt>
                          <dd>{event.pending}</dd>
                        </div>
                        <div>
                          <dt>현재입장</dt>
                          <dd>{event.inside}</dd>
                        </div>
                      </dl>
                      <p className={styles.eventAction}>
                        <Link
                          className="button button-secondary"
                          href={action.href}
                        >
                          {action.label}
                        </Link>
                      </p>
                    </article>
                  </li>
                );
              })}
            </ul>
            {view === "calendar" && !selectedDate && unscheduled.length ? (
              <>
                <h2 className={styles.sectionTitle}>일정 미정 {unscheduled.length}건</h2>
                <ul className={styles.eventGrid}>
                  {unscheduled.map((event) => {
                    const action = nextAction(event);
                    return (
                      <li key={event.id}>
                        <article className={`${styles.eventCard} ${styles.eventCardCompact}`}>
                          <h3 className={styles.eventName}>
                            <Link href={`/console/events/${encodeURIComponent(event.id)}`}>
                              {event.name}
                            </Link>
                          </h3>
                          <p className={styles.eventAction}>
                            <Link className="button button-secondary" href={action.href}>
                              {action.label}
                            </Link>
                          </p>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {hasNarrowing && visibleEvents.length > 0 ? (
              <p className={styles.resetRow}>
                <button type="button" className="button button-secondary" onClick={clearAll}>
                  필터 초기화
                </button>
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
