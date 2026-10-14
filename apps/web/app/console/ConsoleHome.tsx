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
  capacity: number;
};
type Client = { id: string; name: string };
type EventFilter = "all" | "preparing" | "live" | "closed";

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

export default function ConsoleHome() {
  const router = useRouter();
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EventFilter>("all");
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
            // Keep each event's calendar time adjacent to its date in the
            // schedule-first home; all other fields remain server-owned.
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
        const countRegistered = (eventId: string): number => {
          const people = workspaces[eventId]?.participants;
          if (!Array.isArray(people)) return 0;
          return people.filter((person) => {
            if (typeof person !== "object" || person === null) return false;
            const status = (person as Record<string, unknown>).status;
            return status !== "CANCELLED";
          }).length;
        };
        const events = Array.isArray(data.state.events)
          ? data.state.events.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const event = item as Record<string, unknown>;
              if (typeof event.id !== "string" || !event.id) return [];
              const venueSource = workspaces[event.id]?.venue;
              const capacity = Number(event.capacity);
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
                registered: countRegistered(event.id),
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

  const filteredEvents = useMemo(() => {
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
    }).sort((a, b) => {
      // The calendar is the primary index: today's sessions first, then the
      // nearest future date, recent past events, and finally undated events.
      const bucket = (event: ConsoleEvent) => {
        if (!event.date) return 3;
        if (event.date === todayKey) return 0;
        return event.date > todayKey ? 1 : 2;
      };
      const aBucket = bucket(a);
      const bBucket = bucket(b);
      if (aBucket !== bBucket) return aBucket - bBucket;
      const dateOrder = aBucket === 2 ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
      return dateOrder || a.start.localeCompare(b.start) || a.name.localeCompare(b.name, "ko-KR");
    });
  }, [filter, query, state, todayKey]);

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
  return (
    <div className={styles.home}>
      <header className={styles.pageHeader}>
        <div>
          <h1>행사</h1>
          <p>오늘과 가까운 일정부터 날짜순으로 표시합니다.</p>
        </div>
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
          {filter === "all" && !query.trim()
            ? `전체 ${state.events.length}개 행사`
            : `검색 결과 ${filteredEvents.length}개 / 전체 ${state.events.length}개`}
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

        {!state.events.length ? (
          <div className={styles.emptyState}>
            <h3>아직 등록된 행사가 없습니다</h3>
            <p>새 행사를 만들면 일정과 참가 접수 준비를 시작할 수 있습니다.</p>
          </div>
        ) : !filteredEvents.length ? (
          <div className={styles.emptyState}>
            <h3>조건에 맞는 행사가 없습니다</h3>
            <p>검색어를 바꾸거나 다른 진행 단계에서 찾아보세요.</p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => { setQuery(""); setFilter("all"); }}
            >
              필터 초기화
            </button>
          </div>
        ) : (
          <>
          <div className={styles.listHeader} aria-hidden="true">
            <span>일정</span>
            <span>행사 · 고객사 · 장소</span>
            <span>상태</span>
            <span>참가자</span>
            <span />
          </div>
          <ul className={styles.eventList}>
            {filteredEvents.map((event) => {
              const clientName = event.clientId ? state.clients.get(event.clientId) : "";
              const recency = eventRecency(event.date, todayKey);
              const stageKnown = KNOWN_STAGES.includes(event.stage);
              return (
                <li key={event.id}>
                  <Link
                    className={styles.eventRow}
                    href={`/console/events/${encodeURIComponent(event.id)}`}
                  >
                    <span className={styles.eventDate}>
                      <strong>{event.date || "일정 미정"}</strong>
                      {event.start || event.end ? (
                        <span>{event.start}{event.end ? `–${event.end}` : ""}</span>
                      ) : null}
                      {recency ? (
                        <span className={styles.eventRecency}>{recency}</span>
                      ) : null}
                    </span>
                    <span className={styles.eventIdentity}>
                      <span className={styles.eventTitleLine}>
                        <strong>{event.name}</strong>
                      </span>
                      <span className={styles.eventClient}>
                        {[clientName, event.venue].filter(Boolean).join(" · ") || "고객사·장소 미지정"}
                      </span>
                    </span>
                    <span className={styles.eventStatus}>
                      {stageKnown ? (
                        <span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span>
                      ) : <span className="stage-badge">단계 미정</span>}
                    </span>
                    <span className={styles.registration}>
                      <span className={styles.registrationText}>
                        <strong>{event.registered}</strong>
                        <span>명 등록{event.capacity ? ` · 정원 ${event.capacity}명` : ""}</span>
                      </span>
                    </span>
                    <span className={styles.rowArrow} aria-hidden="true">→</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          </>
        )}
      </section>
    </div>
  );
}
