"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { eventStageClassName, eventStageLabel } from "../event-stage";

type ConsoleEvent = {
  id: string;
  name: string;
  slug: string;
  clientId: string | null;
  date: string;
  stage: string;
  venue: string;
  registered: number;
  capacity: number;
};
type Client = { id: string; name: string };

type HomeState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; events: ConsoleEvent[]; clients: Map<string, string> };

const STAGES = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];

export default function ConsoleHome() {
  const router = useRouter();
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("");

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
  }, [router]);

  const filteredEvents = useMemo(() => {
    if (state.kind !== "ready") return [];
    const search = query.trim().toLocaleLowerCase("ko-KR");
    return state.events.filter((event) => {
      const clientName = event.clientId ? state.clients.get(event.clientId) ?? "" : "";
      const matchesQuery = !search || `${event.name} ${clientName}`.toLocaleLowerCase("ko-KR").includes(search);
      return matchesQuery && (!stage || event.stage === stage);
    });
  }, [query, stage, state]);

  if (state.kind === "loading") return <p className="loading-state" role="status">행사 목록을 불러오고 있습니다.</p>;
  if (state.kind === "failed") return <p className="state-error" role="alert">{state.message}</p>;
  return (
    <section className="event-list-section" aria-label="행사 목록">
      <div className="event-filters" role="search" aria-label="행사 검색 및 필터">
        <div className="event-filter">
          <label htmlFor="event-query">행사 검색</label>
          <input
            id="event-query"
            type="search"
            placeholder="행사명·고객사 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="event-filter">
          <label htmlFor="event-stage">진행 상태</label>
          <select id="event-stage" value={stage} onChange={(event) => setStage(event.target.value)}>
            <option value="">모든 상태</option>
            {STAGES.map((value) => (
              <option value={value} key={value}>{eventStageLabel(value)}</option>
            ))}
          </select>
        </div>
      </div>

      <p className="event-list-count" role="status" aria-live="polite" aria-atomic="true">
        {filteredEvents.length}개 행사
      </p>

      {!state.events.length ? (
        <p className="empty-state">진행 중인 행사가 없습니다.</p>
      ) : !filteredEvents.length ? (
        <p className="empty-state">검색 결과가 없습니다.</p>
      ) : (
        <ul className="event-list" aria-label="행사 목록">
          {filteredEvents.map((event) => (
            <li key={event.id}>
              <article className="console-event-row">
                <div className="console-event-head">
                  <Link className="console-event-title" href={`/console/events/${encodeURIComponent(event.id)}`}>
                    {event.name}
                  </Link>
                  {event.stage ? (
                    <span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span>
                  ) : null}
                </div>
                <dl className="console-event-meta">
                  {event.clientId && state.clients.get(event.clientId) ? (
                    <div>
                      <dt>고객사</dt>
                      <dd>{state.clients.get(event.clientId)}</dd>
                    </div>
                  ) : null}
                  {event.date ? (
                    <div>
                      <dt>일정</dt>
                      <dd>{event.date}</dd>
                    </div>
                  ) : null}
                  {event.venue ? (
                    <div>
                      <dt>장소</dt>
                      <dd>{event.venue}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>등록</dt>
                    <dd>
                      {event.capacity
                        ? `${event.registered} / ${event.capacity}명`
                        : `${event.registered}명`}
                    </dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
