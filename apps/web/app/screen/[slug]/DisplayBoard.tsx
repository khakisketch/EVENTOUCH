"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import drawStyles from "./draw-stage.module.css";

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
type DrawWinner = {
  name: string;
  company: string;
  kind?: "PERSON" | "COMPANY";
  luckyNumber?: number | null;
  tier?: string;
};
type DrawOutcome = { id: string; at: string; programName: string; winners: DrawWinner[] };
type BoardModule = {
  id: string;
  type: string;
  title: string;
  options: string[];
  counts: number[];
  revealed: boolean;
  answer: string;
  drawHistory: DrawOutcome[];
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
  | { kind: "ready"; data: BoardData; frame: number; stale: boolean };

const POLL_MS = 5000;
const ACTIVE_DRAW_POLL_MS = 1000;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
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
        const drawHistory: DrawOutcome[] = type === "draw" && Array.isArray(module.drawHistory)
          ? module.drawHistory.flatMap((entry) => {
              if (typeof entry !== "object" || entry === null) return [];
              const record = entry as Record<string, unknown>;
              if (typeof record.id !== "string" || !Array.isArray(record.winners)) return [];
              const winners = record.winners.flatMap((winner) => {
                if (typeof winner !== "object" || winner === null) return [];
                const person = winner as Record<string, unknown>;
                if (typeof person.name !== "string" && typeof person.company !== "string") return [];
                const kind: DrawWinner["kind"] =
                  person.kind === "PERSON" || person.kind === "COMPANY" ? person.kind : undefined;
                const luckyNumber = Number.isSafeInteger(person.luckyNumber) && Number(person.luckyNumber) >= 0
                  ? Number(person.luckyNumber)
                  : person.luckyNumber === null ? null : undefined;
                return [{
                  name: text(person.name),
                  company: text(person.company),
                  ...(kind ? { kind } : {}),
                  ...(luckyNumber !== undefined ? { luckyNumber } : {}),
                  ...(typeof person.tier === "string" && person.tier ? { tier: person.tier } : {}),
                }];
              });
              return [{ id: record.id, at: text(record.at), programName: text(record.programName), winners }];
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
          drawHistory,
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

function DrawReveal({
  outcome,
  moduleTitle,
  animate,
  onRevealComplete,
}: {
  outcome: DrawOutcome | null;
  moduleTitle: string;
  animate: boolean;
  onRevealComplete: (id: string) => void;
}) {
  const [completedOutcomeId, setCompletedOutcomeId] = useState<string | null>(null);
  const [reduceMotion] = useState(prefersReducedMotion);
  const revealing = Boolean(outcome && animate && !reduceMotion && completedOutcomeId !== outcome.id);
  useEffect(() => {
    if (!outcome || !animate || completedOutcomeId === outcome.id) {
      return;
    }
    if (reduceMotion) {
      onRevealComplete(outcome.id);
      return;
    }
    const timer = window.setTimeout(() => {
      setCompletedOutcomeId(outcome.id);
      onRevealComplete(outcome.id);
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [outcome?.id, animate, completedOutcomeId, reduceMotion, onRevealComplete]);

  const title = outcome?.programName || moduleTitle || "추첨";
  const singleWinner = outcome?.winners.length === 1 ? outcome.winners[0] : null;
  const luckyNumber = singleWinner?.kind === "PERSON" && Number.isSafeInteger(singleWinner.luckyNumber)
    ? singleWinner.luckyNumber as number
    : null;
  const luckyDigits = luckyNumber === null ? [] : String(luckyNumber).split("");

  if (!outcome) {
    return (
      <div className={drawStyles.awaitingResult} role="status">
        <NeutralRouletteWheel className={drawStyles.waitingWheel} />
        <strong>추첨 결과를 기다리고 있습니다</strong>
      </div>
    );
  }

  if (revealing) {
    if (singleWinner?.kind === "PERSON" && luckyNumber !== null) {
      return (
        <div className={drawStyles.revealMoment} role="status" aria-live="polite">
          <p className={drawStyles.revealLabel}>럭키번호</p>
          <div
            className={`${drawStyles.slotWindow} ${drawStyles.slotWindowRevealing}`}
            style={{ maxWidth: `${luckyDigits.length * 390}px`, gridTemplateColumns: `repeat(${luckyDigits.length}, minmax(0, 1fr))` }}
            aria-hidden="true"
          >
            {luckyDigits.map((_, index) => <span className={drawStyles.slotBlank} key={`${outcome.id}-blank-${index}`}>—</span>)}
            <span className={drawStyles.slotSweep} />
          </div>
          <span className={drawStyles.visuallyHidden}>{title} 럭키번호를 공개합니다.</span>
        </div>
      );
    }

    return (
      <div className={drawStyles.revealMoment} role="status" aria-live="polite">
        <NeutralRouletteWheel spinning />
        <span className={drawStyles.visuallyHidden}>{title} 당첨 결과를 공개합니다.</span>
      </div>
    );
  }

  if (singleWinner?.kind === "PERSON" && luckyNumber !== null) {
    return (
      <div className={drawStyles.resultStage} key={outcome.id}>
        <section className={drawStyles.personNumberOutcome} aria-label="당첨 참가자">
          <p className={drawStyles.numberLabel}>럭키번호</p>
          <div
            className={drawStyles.slotWindow}
            style={{ maxWidth: `${luckyDigits.length * 390}px`, gridTemplateColumns: `repeat(${luckyDigits.length}, minmax(0, 1fr))` }}
            role="img"
            aria-label={`럭키번호 ${luckyNumber}`}
          >
            {luckyDigits.map((digit, index) => (
              <span className={drawStyles.slotDigit} key={`${outcome.id}-${index}`}>{digit}</span>
            ))}
            <span className={drawStyles.slotSweep} aria-hidden="true" />
          </div>
          <div className={drawStyles.personIdentity}>
            <span className={drawStyles.winnerKind}>당첨 참가자</span>
            <strong className={drawStyles.personName}>{singleWinner.name || "이름 정보 없음"}</strong>
            {singleWinner.company ? <span className={drawStyles.winnerCompany}>{singleWinner.company}</span> : null}
            {singleWinner.tier ? <span className={drawStyles.winnerTier}>{singleWinner.tier}</span> : null}
          </div>
        </section>
      </div>
    );
  }

  if (singleWinner?.kind === "PERSON") {
    return (
      <div className={drawStyles.resultStage} key={outcome.id}>
        <section className={drawStyles.personNameOutcome} aria-label="당첨 참가자">
          <span className={drawStyles.winnerKind}>당첨 참가자</span>
          <strong className={drawStyles.fallbackPersonName}>{singleWinner.name || "이름 정보 없음"}</strong>
          {singleWinner.company ? <span className={drawStyles.winnerCompany}>{singleWinner.company}</span> : null}
          {singleWinner.luckyNumber === null ? <span className={drawStyles.numberUnavailable}>럭키번호 미발급</span> : null}
          {singleWinner.tier ? <span className={drawStyles.winnerTier}>{singleWinner.tier}</span> : null}
        </section>
      </div>
    );
  }

  if (singleWinner?.kind === "COMPANY") {
    return (
      <div className={drawStyles.resultStage} key={outcome.id}>
        <section className={drawStyles.companyOutcome} aria-label="당첨 업체">
          <NeutralRouletteWheel className={drawStyles.companyWheel} />
          <div className={drawStyles.companyIdentity}>
            <span className={drawStyles.winnerKind}>당첨 업체</span>
            <strong className={drawStyles.companyName}>{singleWinner.company || singleWinner.name || "업체 정보 없음"}</strong>
            {singleWinner.tier ? <span className={drawStyles.companyTier}>{singleWinner.tier}</span> : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={drawStyles.resultStage} key={outcome.id}>
      {outcome.winners.length ? (
        <ol className={drawStyles.winnerGrid}>
          {outcome.winners.map((winner, index) => {
            const isCompany = winner.kind === "COMPANY";
            const number = winner.kind === "PERSON" && Number.isSafeInteger(winner.luckyNumber)
              ? winner.luckyNumber as number
              : null;
            const winnerDisplayName = isCompany
              ? winner.company || winner.name || "업체 정보 없음"
              : winner.kind === "PERSON"
                ? winner.name || "이름 정보 없음"
                : winner.name || winner.company || "당첨 정보 없음";
            return (
              <li
                className={`${drawStyles.winnerCard} ${isCompany ? drawStyles.winnerCardCompany : number !== null ? drawStyles.winnerCardNumber : ""}`}
                key={`${outcome.id}-${index}`}
              >
                <span className={drawStyles.winnerKind}>
                  {isCompany ? "당첨 업체" : winner.kind === "PERSON" ? "당첨 참가자" : "당첨 결과"}
                </span>
                {number !== null ? <strong className={drawStyles.gridLuckyNumber}>{number}</strong> : null}
                <strong className={drawStyles.winnerName}>{winnerDisplayName}</strong>
                {winner.kind === "PERSON" && winner.company ? <span className={drawStyles.winnerCompany}>{winner.company}</span> : null}
                {winner.kind === "PERSON" && winner.luckyNumber === null ? <span className={drawStyles.numberUnavailable}>럭키번호 미발급</span> : null}
                {winner.tier ? <span className={drawStyles.winnerTier}>{winner.tier}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={drawStyles.emptyOutcome}>이번 추첨 결과가 없습니다.</p>
      )}
    </div>
  );
}

function NeutralRouletteWheel({ className, spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <div className={`${drawStyles.rouletteWheel} ${spinning ? drawStyles.rouletteWheelSpinning : ""} ${className ?? ""}`} aria-hidden="true">
      <span className={drawStyles.wheelPointer} />
      <span className={drawStyles.wheelHub} />
    </div>
  );
}

export default function DisplayBoard({ slug }: { slug: string }) {
  const [state, setState] = useState<BoardState>({ kind: "loading" });
  const [revealId, setRevealId] = useState<string | null>(null);
  // Manual recovery trigger: the poll loop already retries on its own, but a
  // staffer standing in front of the venue screen needs a visible control
  // that fetches now instead of waiting out the next interval.
  const [retryTick, setRetryTick] = useState(0);
  function refreshNow() {
    setRetryTick((tick) => tick + 1);
  }
  const seenDrawIdsRef = useRef<Map<string, string> | null>(null);
  const visibleDrawReady = state.kind === "ready" && (
    state.data.display.type === "draw" || state.data.modules.some((module) => module.type === "draw")
  );
  const pollDelay = visibleDrawReady
    ? ACTIVE_DRAW_POLL_MS
    : POLL_MS;
  const onRevealComplete = useCallback((id: string) => {
    setRevealId((current) => current === id ? null : current);
  }, []);

  useEffect(() => {
    seenDrawIdsRef.current = null;
    setRevealId(null);
  }, [slug]);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let backoff = false;
    function scheduleNext() {
      if (stopped) return;
      const visible = document.visibilityState === "visible";
      const delay = visible && !backoff ? pollDelay : POLL_MS;
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, delay);
    }
    async function refresh() {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        scheduleNext();
        return;
      }
      let failed = false;
      try {
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}`,
          { cache: "no-store" }
        );
        if (stopped) return;
        if (res.status === 404) {
          failed = true;
          setState({ kind: "missing" });
          return;
        }
        if (!res.ok) {
          failed = true;
          setState((prev) =>
            prev.kind === "ready"
              ? { ...prev, stale: true }
              : { kind: "failed", message: "화면 정보를 불러오지 못했습니다." }
          );
          return;
        }
        const board = toBoard(slug, (await res.json()) as object);
        if (!board) {
          failed = true;
          setState({ kind: "missing" });
          return;
        }
        const seen = seenDrawIdsRef.current;
        const currentIds = new Map<string, string>();
        const newlyArrived: string[] = [];
        for (const drawModule of board.modules) {
          if (drawModule.type !== "draw") continue;
          const latest = drawModule.drawHistory[0];
          if (!latest?.id) continue;
          currentIds.set(drawModule.id, latest.id);
          if (seen && seen.has(drawModule.id) && seen.get(drawModule.id) !== latest.id) {
            newlyArrived.push(latest.id);
          } else if (seen && !seen.has(drawModule.id)) {
            newlyArrived.push(latest.id);
          }
        }
        if (seen === null) {
          seenDrawIdsRef.current = currentIds;
        } else {
          for (const [moduleId, id] of currentIds) seen.set(moduleId, id);
          if (newlyArrived.length) setRevealId(newlyArrived[newlyArrived.length - 1]);
        }
        setState((prev) => ({
          kind: "ready",
          data: board,
          frame: prev.kind === "ready" ? prev.frame + 1 : 0,
          stale: false,
        }));
      } catch {
        failed = true;
        if (!stopped) {
          // A failed poll keeps the last good frame: a venue screen must
          // never go blank on a transient network drop.
          setState((prev) =>
            prev.kind === "ready"
              ? { ...prev, stale: true }
              : { kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." }
          );
        }
      } finally {
        if (!stopped) {
          backoff = failed;
          scheduleNext();
        }
      }
    }
    function onVisibilityChange() {
      if (document.visibilityState !== "visible" || timer === null) return;
      window.clearTimeout(timer);
      timer = null;
      void refresh();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [slug, pollDelay, retryTick]);

  if (state.kind === "loading") return <p className="display-status" role="status">화면을 준비하고 있습니다.</p>;
  if (state.kind === "missing") {
    return (
      <section className="display-state">
        <h1>행사를 찾을 수 없습니다</h1>
        <p>출력 주소를 확인하세요.</p>
        <p>
          <Link className="button button-secondary" href="/">처음으로</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "failed") {
    // First load never produced a frame, so there is nothing to keep: the
    // poll loop retries on its own, and this button fetches now for the
    // staffer standing in front of the screen.
    return (
      <section className="display-state" aria-label="화면 오류">
        <p role="alert">{state.message}</p>
        <p>
          <button type="button" className="button button-secondary" onClick={refreshNow}>
            다시 시도
          </button>
        </p>
      </section>
    );
  }

  const { data, frame, stale } = state;
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
    const shownOptions = module.options.slice(0, 8);
    selected = {
      key: `poll-${module.id}`,
      title: module.title,
      body: (
        <div className="display-poll">
          <p>응답 {total}표</p>
          {shownOptions.map((option, index) => {
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
          {module.options.length > shownOptions.length ? (
            <p>외 {module.options.length - shownOptions.length}개 항목</p>
          ) : null}
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
    const outcome = module.drawHistory[0] ?? null;
    selected = {
      key: `draw-${module.id}`,
      title: outcome?.programName || module.title || "추첨",
      body: (
        <DrawReveal
          outcome={outcome}
          moduleTitle={module.title}
          animate={Boolean(outcome && revealId === outcome.id)}
          onRevealComplete={onRevealComplete}
        />
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
    const drawSelected = data.display.type === "draw";
    return (
      <section className={`display-board ${drawSelected ? drawStyles.cinematicBoard : ""}`} aria-live="off">
        <header className="display-header">
          {!drawSelected ? <span className="display-brand">EVENTOUCH</span> : null}
          {stale ? <p className="display-stale" role="status">연결 확인 중 · 마지막 화면입니다</p> : null}
          {stale ? (
            <button type="button" className="button button-secondary" onClick={refreshNow}>
              새로고침
            </button>
          ) : null}
          <p className="display-date">{data.date}</p>
        </header>
        <div className={`display-content ${drawSelected ? drawStyles.cinematicContent : ""}`}>
          <h1>{data.name}</h1>
          <article className={`display-frame ${drawSelected ? drawStyles.cinematicFrame : ""}`} key={selected.key}>
            <h2 className={drawSelected ? drawStyles.cinematicHeading : undefined}>{selected.title}</h2>
            {selected.body}
          </article>
        </div>
        {drawSelected
          ? data.venueName ? <footer className="display-footer"><span>{data.venueName}</span></footer> : null
          : <footer className="display-footer"><span>행사 운영 워크스페이스</span><span>{data.venueName}</span></footer>}
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
    const shownSessions = data.program.slice(0, 10);
    frames.push({
      key: "program",
      title: "프로그램",
      body: (
        <ul>
          {shownSessions.map((session) => (
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
          {data.program.length > shownSessions.length ? (
            <li className="program-item">
              <span className="program-title">외 {data.program.length - shownSessions.length}개 프로그램</span>
            </li>
          ) : null}
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
    // Idle keeps the same footer as a selected board: the venue stays
    // visible while waiting, and the idle→selected switch adds content
    // without shifting the frame.
    return (
      <section className="display-board display-idle">
        <p>EVENTOUCH</p>
        <h1>{data.name}</h1>
        <p>{data.date}</p>
        {stale ? <p className="display-stale" role="status">연결 확인 중 · 마지막 화면입니다</p> : null}
        {stale ? (
          <p>
            <button type="button" className="button button-secondary" onClick={refreshNow}>
              새로고침
            </button>
          </p>
        ) : null}
        <p>화면 준비 중</p>
        <footer className="display-footer"><span>행사 운영 워크스페이스</span><span>{data.venueName}</span></footer>
      </section>
    );
  }
  const current = frames[frame % frames.length];
  return (
    <section className="display-board" aria-live="off">
      <header className="display-header">
        <span className="display-brand">EVENTOUCH</span>
        {stale ? <p className="display-stale" role="status">연결 확인 중 · 마지막 화면입니다</p> : null}
        {stale ? (
          <button type="button" className="button button-secondary" onClick={refreshNow}>
            새로고침
          </button>
        ) : null}
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
