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
type BoardModule = {
  id: string;
  type: string;
  title: string;
  options: string[];
  counts: number[];
  revealed: boolean;
  answer: string;
  winners: Array<{ name: string; company: string }>;
};
type BoardQuestion = { id: string; text: string; answer: string; name: string };
type BoardPhoto = { id: string; caption: string; fileId: string; data: string };
type DisplaySelection = {
  type: string;
  moduleId: string | null;
  noticeId: string | null;
};
type BoardData = {
  name: string;
  date: string;
  venueName: string;
  notices: Notice[];
  program: ProgramItem[];
  modules: BoardModule[];
  questions: BoardQuestion[];
  photos: BoardPhoto[];
  display: DisplaySelection;
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

function toBoard(
  slug: string,
  data: {
    event?: { name?: unknown; date?: unknown } | null;
    workspace?: {
      venue?: { name?: unknown } | null;
      notices?: unknown;
      program?: unknown;
      modules?: unknown;
      questions?: unknown;
      photos?: unknown;
      display?: unknown;
    } | null;
  }
): BoardData | null {
  if (!data.event) return null;
  const workspace = data.workspace ?? {};
  const notices = Array.isArray(workspace.notices)
    ? workspace.notices.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const notice = item as Record<string, unknown>;
        if (typeof notice.title !== "string") return [];
        return [{ id: text(notice.id), title: notice.title, body: text(notice.body) }];
      })
    : [];
  const program = Array.isArray(workspace.program)
    ? workspace.program.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const session = item as Record<string, unknown>;
        if (typeof session.title !== "string") return [];
        return [{
          id: text(session.id),
          title: session.title,
          date: text(session.date),
          start: text(session.start),
          end: text(session.end),
          place: text(session.place),
          description: text(session.description),
        }];
      })
    : [];
  const modules = Array.isArray(workspace.modules)
    ? workspace.modules.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const module = item as Record<string, unknown>;
        if (typeof module.id !== "string" || typeof module.type !== "string") return [];
        const type = module.type;
        const drawHistory = Array.isArray(module.drawHistory) ? module.drawHistory : [];
        const winners = type === "draw"
          ? drawHistory
              .filter((entry) => typeof entry === "object" && entry !== null)
              .flatMap((entry) => {
                const wins = (entry as Record<string, unknown>).winners;
                return Array.isArray(wins)
                  ? wins.flatMap((winner) => {
                      if (typeof winner !== "object" || winner === null) return [];
                      const person = winner as Record<string, unknown>;
                      return [{ name: text(person.name), company: text(person.company) }];
                    })
                  : [];
              })
          : [];
        return [{
          id: module.id,
          type,
          title: text(module.title),
          options: Array.isArray(module.options)
            ? module.options.filter((option): option is string => typeof option === "string")
            : [],
          counts: Array.isArray(module.counts)
            ? module.counts.map((count) => Number(count) || 0)
            : [],
          revealed: module.revealed === true,
          answer: text(module.answer),
          winners,
        }];
      })
    : [];
  const questions = Array.isArray(workspace.questions)
    ? workspace.questions.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const question = item as Record<string, unknown>;
        if (typeof question.text !== "string") return [];
        return [{
          id: text(question.id),
          text: question.text,
          answer: text(question.answer),
          name: text(question.name),
        }];
      })
    : [];
  const photos = Array.isArray(workspace.photos)
    ? workspace.photos.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const photo = item as Record<string, unknown>;
        if (typeof photo.id !== "string") return [];
        const image = typeof photo.image === "object" && photo.image !== null
          ? (photo.image as Record<string, unknown>)
          : {};
        const fileId = text(image.fileId);
        const data = text(image.data);
        if (!fileId && !data) return [];
        return [{
          id: photo.id,
          caption: text(photo.caption),
          fileId: fileId
            ? `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`
            : "",
          data,
        }];
      })
    : [];
  const selection = typeof workspace.display === "object" && workspace.display !== null
    ? (workspace.display as Record<string, unknown>)
    : {};
  const display: DisplaySelection = {
    type: text(selection.type) || "idle",
    moduleId: typeof selection.moduleId === "string" ? selection.moduleId : null,
    noticeId: typeof selection.noticeId === "string" ? selection.noticeId : null,
  };
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
    modules,
    questions,
    photos,
    display,
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
        const board = toBoard(slug, (await res.json()) as object);
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
  const module = data.display.moduleId
    ? data.modules.find((item) => item.id === data.display.moduleId)
    : undefined;

  // Operator-selected output wins when it resolves to published content;
  // otherwise the board cycles what exists instead of showing a blank.
  let selected: { key: string; title: string; body: React.ReactNode } | null = null;
  if (data.display.type === "notice") {
    const notice = data.notices.find((item) => item.id === data.display.noticeId)
      ?? (data.notices.length === 1 ? data.notices[0] : undefined);
    if (notice) {
      selected = {
        key: `notice-${notice.id}`,
        title: notice.title,
        body: <p className="preserve-lines">{notice.body}</p>,
      };
    }
  } else if (data.display.type === "poll" && module && module.type === "poll") {
    const total = module.counts.reduce((sum, count) => sum + count, 0);
    selected = {
      key: `poll-${module.id}`,
      title: module.title,
      body: (
        <div className="display-poll">
          <p>응답 {total}표</p>
          {module.options.map((option, index) => {
            const count = module.counts[index] ?? 0;
            const ratio = total ? Math.round((count / total) * 100) : 0;
            return (
              <div className="poll-row" key={option}>
                <div className="poll-label">
                  <span>{option}</span>
                  <strong>{count}표</strong>
                </div>
                <div className="poll-bar"><span style={{ width: `${ratio}%` }} /></div>
              </div>
            );
          })}
        </div>
      ),
    };
  } else if (data.display.type === "quiz" && module && module.type === "quiz" && module.revealed) {
    selected = {
      key: `quiz-${module.id}`,
      title: module.title,
      body: <p className="display-answer">정답 · {module.answer}</p>,
    };
  } else if (data.display.type === "draw" && module && module.type === "draw") {
    selected = {
      key: `draw-${module.id}`,
      title: "당첨을 축하합니다",
      body: (
        <div className="display-winners">
          {module.winners.map((winner, index) => (
            <div className="display-winner" key={`${winner.name}-${index}`}>
              <h3>{winner.name}</h3>
              <p>{winner.company}</p>
            </div>
          ))}
        </div>
      ),
    };
  } else if (data.display.type === "qa" && data.questions.length) {
    selected = {
      key: "qa",
      title: "질문과 답변",
      body: (
        <div className="display-questions">
          {data.questions.slice(0, 4).map((question) => (
            <section className="display-question" key={question.id}>
              <h3>{question.text}</h3>
              {question.answer ? <p>{question.answer}</p> : null}
            </section>
          ))}
        </div>
      ),
    };
  } else if (data.display.type === "photo" && data.photos.length) {
    selected = {
      key: "photo",
      title: "함께한 순간",
      body: (
        <div className="display-photo-grid">
          {data.photos.slice(0, 6).map((photo) => (
            <figure key={photo.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.fileId || photo.data} alt={photo.caption} />
              <figcaption>{photo.caption}</figcaption>
            </figure>
          ))}
        </div>
      ),
    };
  }

  if (selected) {
    return (
      <section className="display-board" aria-live="off">
        <header className="display-header">
          <span className="display-brand">EVENTOUCH</span>
          <p className="display-date">{data.date}</p>
        </header>
        <div className="display-content">
          <h1>{data.name}</h1>
          <article className="display-frame" key={selected.key}>
            <h2>{selected.title}</h2>
            {selected.body}
          </article>
        </div>
        <footer className="display-footer"><span>행사 운영 워크스페이스</span><span>{data.venueName}</span></footer>
      </section>
    );
  }

  const frames: Array<{ key: string; title: string; body: React.ReactNode }> = [];
  for (const notice of data.notices) {
    frames.push({
      key: `notice-${notice.id}`,
      title: notice.title,
      body: <p className="preserve-lines">{notice.body}</p>,
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
