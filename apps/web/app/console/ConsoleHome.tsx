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
  stage: string;
  venue: string;
  registered: number;
  pendingApproval: number;
  capacity: number;
};
type Client = { id: string; name: string };
type EventFilter = "all" | "preparing" | "live" | "closed";

type HomeState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; events: ConsoleEvent[]; clients: Map<string, string> };

const STAGE_ORDER: Record<string, number> = {
  LIVE: 0,
  READY: 1,
  DRAFT: 2,
  ENDED: 3,
  ARCHIVED: 4,
};

const FILTERS: Array<{ id: EventFilter; label: string }> = [
  { id: "all", label: "전체" },
  { id: "preparing", label: "준비 중" },
  { id: "live", label: "진행 중" },
  { id: "closed", label: "종료·보관" },
];

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
        const countPending = (eventId: string): number => {
          const people = workspaces[eventId]?.participants;
          if (!Array.isArray(people)) return 0;
          return people.filter((person) => {
            if (typeof person !== "object" || person === null) return false;
            return (person as Record<string, unknown>).status === "PENDING";
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
                stage: typeof event.stage === "string" ? event.stage : "",
                venue:
                  typeof venueSource === "object" && venueSource !== null &&
                  typeof (venueSource as Record<string, unknown>).name === "string"
                    ? String((venueSource as Record<string, unknown>).name)
                    : "",
                registered: countRegistered(event.id),
                pendingApproval: countPending(event.id),
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
      const rank = (STAGE_ORDER[a.stage] ?? 5) - (STAGE_ORDER[b.stage] ?? 5);
      return rank || a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "ko-KR");
    });
  }, [filter, query, state]);

  if (state.kind === "loading") return <p className="loading-state" role="status">행사 목록을 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section className={styles.statePanel}>
        <p role="alert">{state.message}</p>
        <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
          다시 불러오기
        </button>
      </section>
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
  const priorityEvents = [...state.events]
    .filter((event) => event.pendingApproval > 0 || event.stage === "LIVE")
    .sort((a, b) => (b.pendingApproval - a.pendingApproval) || a.date.localeCompare(b.date))
    .slice(0, 3);

  return (
    <div className={styles.home}>
      <header className={styles.pageHeader}>
        <div>
          <h1>행사</h1>
          <p>운영할 행사를 찾고, 확인이 필요한 업무부터 이어가세요.</p>
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

      {priorityEvents.length ? (
        <section className={styles.prioritySection} aria-labelledby="priority-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="priority-title">먼저 확인</h2>
              <p>승인 대기와 현재 운영 중인 행사를 모았습니다.</p>
            </div>
            <span className={styles.sectionCount}>{priorityEvents.length}개</span>
          </div>
          <ul className={styles.priorityList}>
            {priorityEvents.map((event) => {
              const hasApprovals = event.pendingApproval > 0;
              const href = hasApprovals
                ? `/console/events/${encodeURIComponent(event.id)}/participants`
                : `/console/events/${encodeURIComponent(event.id)}`;
              return (
                <li key={event.id}>
                  <div className={styles.priorityCopy}>
                    <span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span>
                    <strong>{event.name}</strong>
                    <span className={styles.priorityReason}>
                      {hasApprovals ? `승인 대기 ${event.pendingApproval}명` : `등록 ${event.registered}${event.capacity ? ` / ${event.capacity}명` : "명"}`}
                    </span>
                  </div>
                  <Link className={styles.priorityLink} href={href}>
                    {hasApprovals ? "참가자 확인" : "운영 현황"}
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className={styles.directory} aria-labelledby="events-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="events-title">모든 행사</h2>
            <p>단계와 등록 규모를 비교해 다음 행사로 이동합니다.</p>
          </div>
          <span className={styles.resultCount} role="status" aria-live="polite" aria-atomic="true">
            {filteredEvents.length} / {state.events.length}
          </span>
        </div>

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
          <ul className={styles.eventList}>
            {filteredEvents.map((event) => {
              const clientName = event.clientId ? state.clients.get(event.clientId) : "";
              const percent = event.capacity
                ? Math.min(100, Math.round((event.registered / event.capacity) * 100))
                : null;
              return (
                <li key={event.id}>
                  <Link
                    className={styles.eventRow}
                    href={`/console/events/${encodeURIComponent(event.id)}`}
                  >
                    <span className={styles.eventIdentity}>
                      <span className={styles.eventTitleLine}>
                        <strong>{event.name}</strong>
                        {event.stage ? (
                          <span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span>
                        ) : null}
                      </span>
                      <span className={styles.eventClient}>{clientName || "고객사 미지정"}</span>
                    </span>
                    <span className={styles.eventWhen}>
                      <span>{event.date || "일정 미정"}</span>
                      <span>{event.venue || "장소 미정"}</span>
                    </span>
                    <span className={styles.registration}>
                      <span className={styles.registrationText}>
                        <span>등록</span>
                        <strong>{event.capacity ? `${event.registered} / ${event.capacity}` : `${event.registered}`}</strong>
                        <span>명</span>
                      </span>
                      {percent !== null ? (
                        <span
                          className={styles.progressTrack}
                          role="meter"
                          aria-label={`${event.name} 정원 사용률`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent}
                          aria-valuetext={`${percent}%`}
                        >
                          <span className={styles.progressValue} style={{ width: `${percent}%` }} />
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.rowArrow} aria-hidden="true">→</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
