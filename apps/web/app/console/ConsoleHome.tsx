"use client";

import { useEffect, useState } from "react";
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
};
type Client = { id: string; name: string };

type HomeState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; events: ConsoleEvent[]; clients: Map<string, string> };

export default function ConsoleHome() {
  const router = useRouter();
  const [state, setState] = useState<HomeState>({ kind: "loading" });

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
          } | null;
        } | null;
        if (!res.ok || !data?.state) {
          setState({ kind: "failed", message: "행사 목록을 불러오지 못했습니다." });
          return;
        }
        const events = Array.isArray(data.state.events)
          ? data.state.events.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const event = item as Record<string, unknown>;
              if (typeof event.id !== "string" || !event.id) return [];
              return [{
                id: event.id,
                name: typeof event.name === "string" ? event.name : event.id,
                slug: typeof event.slug === "string" ? event.slug : "",
                clientId: typeof event.clientId === "string" ? event.clientId : null,
                date: typeof event.date === "string" ? event.date : "",
                stage: typeof event.stage === "string" ? event.stage : "",
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

  if (state.kind === "loading") return <p className="loading-state" role="status">행사 목록을 불러오고 있습니다.</p>;
  if (state.kind === "failed") return <p className="state-error" role="alert">{state.message}</p>;
  if (!state.events.length) return <p className="empty-state">진행 중인 행사가 없습니다.</p>;
  return (
    <ul className="event-list">
      {state.events.map((event) => (
        <li className="console-event-card" key={event.id}>
          <Link className="console-event-title" href={`/console/events/${encodeURIComponent(event.id)}`}>
            {event.name}
          </Link>
          <div className="console-event-meta">
            {event.clientId && state.clients.get(event.clientId) ? (
              <span>{state.clients.get(event.clientId)}</span>
            ) : null}
            {event.date ? <span>{event.date}</span> : null}
            {event.stage ? <span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span> : null}
          </div>
          <span className="event-card-arrow" aria-hidden="true">↗</span>
        </li>
      ))}
    </ul>
  );
}
