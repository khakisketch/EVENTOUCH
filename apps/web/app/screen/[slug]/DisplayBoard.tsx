"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Notice = { id: string; title: string; body: string };
type ProgramItem = {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  place: string;
  description: string;
};
type BoardData = {
  name: string;
  date: string;
  venueName: string;
  notices: Notice[];
  program: ProgramItem[];
};

type BoardState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; data: BoardData; frame: number };

const POLL_MS = 5000;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toBoard(data: {
  event?: { name?: unknown; date?: unknown } | null;
  workspace?: {
    venue?: { name?: unknown } | null;
    notices?: unknown;
    program?: unknown;
  } | null;
}): BoardData | null {
  if (!data.event) return null;
  const workspace = data.workspace ?? {};
  const notices = Array.isArray(workspace.notices)
    ? workspace.notices.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const notice = item as Record<string, unknown>;
        if (typeof notice.title !== "string") return [];
        return [{
          id: typeof notice.id === "string" ? notice.id : "",
          title: notice.title,
          body: typeof notice.body === "string" ? notice.body : "",
        }];
      })
    : [];
  const program = Array.isArray(workspace.program)
    ? workspace.program.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const session = item as Record<string, unknown>;
        if (typeof session.title !== "string") return [];
        return [{
          id: typeof session.id === "string" ? session.id : "",
          title: session.title,
          date: text(session.date),
          start: text(session.start),
          end: text(session.end),
          place: text(session.place),
          description: text(session.description),
        }];
      })
    : [];
  const venue =
    typeof workspace.venue === "object" && workspace.venue !== null
      ? (workspace.venue as Record<string, unknown>)
      : {};
  return {
    name: text(data.event.name),
    date: text(data.event.date),
    venueName: text(venue.name),
    notices,
    program,
  };
}

export default function DisplayBoard({ slug }: { slug: string }) {
  const [state, setState] = useState<BoardState>({ kind: "loading" });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function refresh() {
      try {
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}`,
          { cache: "no-store" }
        );
        if (stopped) return;
        if (res.status === 404) {
          setState({ kind: "missing" });
          return;
        }
        if (!res.ok) {
          setState((prev) =>
            prev.kind === "ready"
              ? prev
              : { kind: "failed", message: "화면 정보를 불러오지 못했습니다." }
          );
          return;
        }
        const board = toBoard((await res.json()) as object);
        if (!board) {
          setState({ kind: "missing" });
          return;
        }
        setState((prev) => ({
          kind: "ready",
          data: board,
          frame: prev.kind === "ready" ? prev.frame + 1 : 0,
        }));
      } catch {
        if (!stopped) {
          // A failed poll keeps the last good frame: a venue screen must
          // never go blank on a transient network drop.
          setState((prev) =>
            prev.kind === "ready"
              ? prev
              : { kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." }
          );
        }
      }
    }
    refresh();
    timer = setInterval(refresh, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [slug]);

  if (state.kind === "loading") return <p className="display-status" role="status">화면을 준비하고 있습니다.</p>;
  if (state.kind === "missing") {
    return (
      <section className="display-state">
        <h1>행사를 찾을 수 없습니다</h1>
        <p>출력 주소를 확인하세요.</p>
        <p>
          <Link href="/">처음으로</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "failed") return <p className="display-status" role="alert">{state.message}</p>;

  const { data, frame } = state;
  const frames: Array<{ key: string; title: string; body: React.ReactNode }> = [];
  for (const notice of data.notices) {
    frames.push({
      key: `notice-${notice.id}`,
      title: notice.title,
      body: <p>{notice.body}</p>,
    });
  }
  if (data.program.length) {
    frames.push({
      key: "program",
      title: "프로그램",
      body: (
        <ul>
          {data.program.map((session) => (
            <li className="program-item" key={session.id}>
              <span className="program-title">{session.title}</span>
              {[session.date, session.start && session.end
                ? `${session.start} ~ ${session.end}`
                : session.start, session.place].filter(Boolean).length ? (
                  <span className="program-meta">
                    {[session.date, session.start && session.end
                      ? `${session.start} ~ ${session.end}`
                      : session.start, session.place].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (data.venueName) {
    frames.push({
      key: "venue",
      title: "오시는 길",
      body: <p>{data.venueName}</p>,
    });
  }
  if (!frames.length) {
    return (
      <section className="display-board display-idle">
        <p>EVENTOUCH</p>
        <h1>{data.name}</h1>
        <p>{data.date}</p>
        <p>화면 준비 중</p>
      </section>
    );
  }
  const current = frames[frame % frames.length];
  return (
    <section className="display-board" aria-live="off">
      <header className="display-header">
        <span className="display-brand">EVENTOUCH</span>
        <p className="display-date">{data.date}</p>
      </header>
      <div className="display-content">
        <h1>{data.name}</h1>
        <article className="display-frame" key={current.key}>
          <h2>{current.title}</h2>
          {current.body}
        </article>
      </div>
      <footer className="display-footer"><span>행사 운영 워크스페이스</span><span>{data.venueName}</span></footer>
    </section>
  );
}
