"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./engage.module.css";

// Attendee engagement screen. Reads the public projection (published
// programs only; the server filters drafts, disabled features, and other
// attendees' content) and submits through the guest command path with the
// tab-kept ticket bearer. The bearer travels in the Authorization header
// only: it is never rendered, logged, or written to persistent storage.
// Storage reuses the ticket screen's key (eventouch.ticket.+slug);
// no new keys are introduced here.

type PublicModule = {
  id: string;
  type: string;
  title: string;
  status: string;
  options: string[];
  questions: string[];
  revealed: boolean;
  answer: string;
  counts: number[];
  drawHistory: Array<{ id: string; at: string; winners: Array<{ name: string; company: string }> }>;
};

type PublicQuestion = {
  id: string;
  moduleId: string;
  name: string;
  text: string;
  answer: string;
  approved: boolean;
  likes: number;
};

type PublicPhoto = {
  id: string;
  name: string;
  caption: string;
  status: string;
  fileId: string;
  own: boolean;
};

type PublicPost = {
  id: string;
  name: string;
  body: string;
  status: string;
  own: boolean;
};

type EngageState =
  | { kind: "loading" }
  | { kind: "missing"; eventName: string }
  | { kind: "failed"; message: string; eventName: string; hasTicket: boolean }
  | {
      kind: "ready";
      eventId: string;
      eventName: string;
      hasTicket: boolean;
      approved: boolean;
      modules: PublicModule[];
      questions: PublicQuestion[];
      photos: PublicPhoto[];
      posts: PublicPost[];
      submittedModuleIds: string[];
    };

type FormError = { form: string; field: string | null; message: string };

const STORAGE_PREFIX = "eventouch.ticket.";

function readStoredTicket(slug: string): string {
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + slug) || "";
  } catch {
    return "";
  }
}

function storeTicket(slug: string, ticket: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + slug, ticket);
  } catch {
    // Storage unavailable (private mode): the in-memory bearer still works.
  }
}

function clearStoredTicket(slug: string): void {
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + slug);
  } catch {
    // Nothing to clear.
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function parseModule(value: unknown, responses: Array<{ moduleId: string }>): PublicModule | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  if (item.published !== true || text(item.status) === "DRAFT") return null;
  const options = Array.isArray(item.options)
    ? item.options.filter((option): option is string => typeof option === "string")
    : [];
  const questions = Array.isArray(item.questions)
    ? item.questions.filter((question): question is string => typeof question === "string")
    : [];
  const drawHistory = Array.isArray(item.drawHistory)
    ? item.drawHistory.flatMap((row) => {
        const result = asRecord(row);
        if (!result || typeof result.id !== "string") return [];
        const winners = Array.isArray(result.winners)
          ? result.winners.flatMap((winner) => {
              const entry = asRecord(winner);
              if (!entry) return [];
              return [{ name: text(entry.name), company: text(entry.company) }];
            })
          : [];
        return [{ id: result.id, at: text(result.at), winners }];
      })
    : [];
  return {
    id: item.id,
    type: text(item.type),
    title: text(item.title, "제목 없는 프로그램"),
    status: text(item.status),
    options,
    questions,
    revealed: item.revealed === true,
    answer: text(item.answer),
    counts: Array.isArray(item.counts)
      ? item.counts.map((count) => (typeof count === "number" ? count : 0))
      : [],
    drawHistory,
  };
}

export default function EngageClient({ slug }: { slug: string }) {
  const [state, setState] = useState<EngageState>({ kind: "loading" });
  // The ticket bearer lives in tab memory only for the session lifetime.
  const ticketRef = useRef<string>("");
  const commandIdsRef = useRef<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollChoices, setPollChoices] = useState<Record<string, string>>({});
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [ratings, setRatings] = useState<Record<string, Record<string, number>>>({});
  const [surveyComments, setSurveyComments] = useState<Record<string, string>>({});
  const [questionTexts, setQuestionTexts] = useState<Record<string, string>>({});
  const [postBodies, setPostBodies] = useState<Record<string, string>>({});
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  function commandIdFor(key: string): string {
    if (!commandIdsRef.current[key]) commandIdsRef.current[key] = randomCommandId();
    return commandIdsRef.current[key];
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const query = new URLSearchParams(window.location.search);
      const fromLink = query.get("ticket") || "";
      // Consume a linked bearer once, exactly like the ticket screen: it
      // must not linger in history. Tab-kept afterwards.
      if (fromLink) storeTicket(slug, fromLink);
      if (fromLink) {
        query.delete("ticket");
        const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", cleaned);
      }
      const ticket = fromLink || readStoredTicket(slug);
      ticketRef.current = ticket;
      try {
        const publicRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        const publicData = (await publicRes.json().catch(() => null)) as {
          event?: { id?: unknown; name?: unknown } | null;
          workspace?: Record<string, unknown> | null;
        } | null;
        const eventName = text(publicData?.event?.name);
        if (!publicRes.ok || !publicData?.event) {
          if (!cancelled) setState({ kind: "failed", message: "행사 정보를 불러오지 못했습니다.", eventName, hasTicket: Boolean(ticket) });
          return;
        }
        if (!ticket) {
          if (!cancelled) {
            setState({
              kind: "missing",
              eventName,
            });
          }
          return;
        }
        const ticketRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}/ticket`, {
          headers: { authorization: `Bearer ${ticket}` },
          cache: "no-store",
        });
        const ticketData = (await ticketRes.json().catch(() => null)) as {
          error?: unknown;
          event?: { id?: unknown; name?: unknown } | null;
          participant?: Record<string, unknown> | null;
          workspace?: Record<string, unknown> | null;
        } | null;
        if (!ticketRes.ok || !ticketData?.participant || !ticketData.workspace) {
          if (ticketRes.status === 404) clearStoredTicket(slug);
          if (!cancelled) {
            setState({
              kind: "failed",
              message:
                typeof ticketData?.error === "string"
                  ? ticketData.error
                  : "티켓을 확인할 수 없습니다. 운영자에게 새 링크를 요청하세요.",
              eventName,
              hasTicket: true,
            });
          }
          return;
        }
        const workspace = ticketData.workspace;
        const eventId = typeof ticketData.event?.id === "string" ? ticketData.event.id : "";
        const participant = ticketData.participant;
        const ownResponses: Array<{ moduleId: string }> = Array.isArray(workspace.responses)
          ? workspace.responses.flatMap((value) => {
              const item = asRecord(value);
              return item && typeof item.moduleId === "string" ? [{ moduleId: item.moduleId }] : [];
            })
          : [];
        const submittedModuleIds = [...new Set(ownResponses.map((response) => response.moduleId))];
        const modules: PublicModule[] = Array.isArray(workspace.modules)
          ? workspace.modules.flatMap((value) => {
              const parsed = parseModule(value, ownResponses);
              return parsed ? [parsed] : [];
            })
          : [];
        const questions: PublicQuestion[] = Array.isArray(workspace.questions)
          ? workspace.questions.flatMap((value) => {
              const item = asRecord(value);
              if (!item || typeof item.id !== "string") return [];
              return [{
                id: item.id,
                moduleId: text(item.moduleId),
                name: text(item.name, "이름 미등록"),
                text: text(item.text),
                answer: text(item.answer),
                approved: item.approved === true,
                likes: Array.isArray(item.likes) ? item.likes.length : 0,
              }];
            })
          : [];
        const photos: PublicPhoto[] = Array.isArray(workspace.photos)
          ? workspace.photos.flatMap((value) => {
              const item = asRecord(value);
              if (!item || typeof item.id !== "string") return [];
              const image = asRecord(item.image);
              if (!image) return [];
              return [{
                id: item.id,
                name: text(item.name, "이름 미등록"),
                caption: text(item.caption),
                status: text(item.status, "PENDING"),
                fileId: text(image.fileId),
                own: typeof item.participantId === "string" && item.participantId !== "",
              }];
            })
          : [];
        const posts: PublicPost[] = Array.isArray(workspace.posts)
          ? workspace.posts.flatMap((value) => {
              const item = asRecord(value);
              if (!item || typeof item.id !== "string") return [];
              return [{
                id: item.id,
                name: text(item.name, "이름 미등록"),
                body: text(item.body),
                status: text(item.status, "PENDING"),
                own: typeof item.participantId === "string" && item.participantId !== "",
              }];
            })
          : [];
        if (!cancelled) {
          setState({
            kind: "ready",
            eventId,
            eventName: text(ticketData.event?.name, eventName),
            hasTicket: true,
            approved: text(participant.status) === "APPROVED",
            modules,
            questions,
            photos,
            posts,
            submittedModuleIds,
          });
        }
      } catch {
        if (!cancelled) setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요.", eventName: "", hasTicket: Boolean(ticketRef.current) });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, reloadTick]);

  async function postGuestCommand(
    eventId: string,
    formKey: string,
    command: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ticketRef.current}`,
      },
      body: JSON.stringify({ commandId: commandIdFor(formKey), command, payload }),
    });
    const data = (await response.json().catch(() => null)) as {
      error?: unknown;
      field?: unknown;
    } & Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.";
      const field = typeof data?.field === "string" ? data.field : null;
      throw { message, field } as FormError & { message: string };
    }
    return data ?? {};
  }

  async function submitGuestForm(
    eventId: string,
    formKey: string,
    command: string,
    payload: Record<string, unknown>,
    successMessage: string
  ) {
    // One in-flight submission at a time and one command id per form: a
    // lost response replays the same request instead of double-submitting.
    if (submitting !== null) return;
    setSubmitting(formKey);
    setFormError(null);
    setNotice(null);
    try {
      await postGuestCommand(eventId, formKey, command, payload);
      delete commandIdsRef.current[formKey];
      setNotice(successMessage);
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      const failure = error as { message?: unknown; field?: unknown };
      const message = typeof failure?.message === "string" ? failure.message : "요청을 처리하지 못했습니다.";
      const field = typeof failure?.field === "string" ? failure.field : null;
      setFormError({ form: formKey, field, message });
    } finally {
      setSubmitting(null);
    }
  }

  function formMessage(formKey: string, field: string | null): string | null {
    if (formError?.form !== formKey) return null;
    if (formError.field !== field) return null;
    return formError.message;
  }

  function generalMessage(formKey: string): string | null {
    if (formError?.form !== formKey) return null;
    if (formError.field !== null) return null;
    return formError.message;
  }

  async function submitPhoto(eventId: string, moduleKey: string, file: File) {
    if (submitting !== null || uploadingPhoto) return;
    const caption = (captions[moduleKey] ?? "").trim();
    if (!caption) {
      setFormError({ form: `photo:${moduleKey}`, field: "caption", message: "사진 설명을 입력하세요." });
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFormError({ form: `photo:${moduleKey}`, field: "image", message: "사진 형식을 확인하세요." });
      return;
    }
    if (file.size > 600000) {
      setFormError({ form: `photo:${moduleKey}`, field: "image", message: "600KB 이하 사진을 올려주세요." });
      return;
    }
    setSubmitting(`photo:${moduleKey}`);
    setUploadingPhoto(true);
    setFormError(null);
    setNotice(null);
    try {
      const uploadRes = await fetch(
        `/api/public/events/${encodeURIComponent(slug)}/files?name=${encodeURIComponent(file.name)}&commandId=${encodeURIComponent(commandIdFor(`upload:${moduleKey}`))}`,
        {
          method: "POST",
          headers: {
            "content-type": file.type,
            authorization: `Bearer ${ticketRef.current}`,
          },
          body: file,
        }
      );
      const uploadData = (await uploadRes.json().catch(() => null)) as {
        error?: unknown;
        file?: { fileId?: unknown } | null;
      } | null;
      const fileId = typeof uploadData?.file?.fileId === "string" ? uploadData.file.fileId : "";
      if (!uploadRes.ok || !fileId) {
        setFormError({
          form: `photo:${moduleKey}`,
          field: "image",
          message: typeof uploadData?.error === "string" ? uploadData.error : "사진을 저장하지 못했습니다.",
        });
        return;
      }
      await postGuestCommand(eventId, `photo:${moduleKey}`, "photo.submit", {
        image: { fileId },
        caption,
      });
      delete commandIdsRef.current[`photo:${moduleKey}`];
      delete commandIdsRef.current[`upload:${moduleKey}`];
      setCaptions((current) => ({ ...current, [moduleKey]: "" }));
      setNotice("사진을 공유했습니다. 운영자 승인 후 공개됩니다.");
      setReloadTick((tick) => tick + 1);
    } catch {
      setFormError({ form: `photo:${moduleKey}`, field: null, message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setUploadingPhoto(false);
      setSubmitting(null);
    }
  }

  if (state.kind === "loading") {
    return <p className={styles.state} role="status">참여 프로그램을 불러오고 있습니다.</p>;
  }

  if (state.kind === "missing") {
    return (
      <main id="main-content" className={styles.page}>
        <header className={styles.pageHeader}>
          <span className={styles.wordmark}>EVENTOUCH</span>
          <span className="eyebrow">참여 프로그램</span>
          {state.eventName ? <h1>{state.eventName}</h1> : null}
        </header>
        <section className={styles.noticeCard}>
          <h2>티켓 링크가 필요합니다</h2>
          <p>참여 프로그램은 티켓 링크로 연 참가자만 이용할 수 있습니다. 신청 완료 화면의 링크로 다시 여세요.</p>
          <p className={styles.actions}>
            <Link className="button button-primary" href={`/event/${encodeURIComponent(slug)}/ticket`}>내 티켓으로 이동</Link>
            <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
          </p>
        </section>
      </main>
    );
  }

  if (state.kind === "failed") {
    return (
      <main id="main-content" className={styles.page}>
        <header className={styles.pageHeader}>
          <span className={styles.wordmark}>EVENTOUCH</span>
          <span className="eyebrow">참여 프로그램</span>
          {state.eventName ? <h1>{state.eventName}</h1> : null}
        </header>
        <section className={styles.noticeCard}>
          <h2>참여 프로그램을 열 수 없습니다</h2>
          <p role="alert">{state.message}</p>
          <p className={styles.actions}>
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                setState({ kind: "loading" });
                setReloadTick((tick) => tick + 1);
              }}
            >
              다시 시도
            </button>
            {state.hasTicket ? null : (
              <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket`}>내 티켓으로 이동</Link>
            )}
            <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
          </p>
        </section>
      </main>
    );
  }

  return (
    <main id="main-content" className={styles.page}>
      <header className={styles.pageHeader}>
        <span className={styles.wordmark}>EVENTOUCH</span>
        <span className="eyebrow">참여 프로그램</span>
        <h1>{state.eventName}</h1>
      </header>

      {notice ? <p className={styles.success} role="status">{notice}</p> : null}
      {!state.approved ? (
        <p className={styles.warning} role="note">참가 확정 후 참여할 수 있습니다. 프로그램 목록은 미리 확인할 수 있습니다.</p>
      ) : null}

      {state.modules.length ? (
        <ul className={styles.moduleList}>
          {state.modules.map((module) => (
            <li key={module.id} className={styles.moduleCard}>
              <ModuleSection
                module={module}
                canSubmit={state.approved}
                submitted={state.submittedModuleIds.includes(module.id)}
                questions={state.questions.filter((question) => question.moduleId === module.id)}
                photos={state.photos}
                posts={state.posts}
                slug={slug}
                eventId={state.eventId}
                submitting={submitting}
                pollChoice={pollChoices[module.id] ?? ""}
                setPollChoice={(value) => setPollChoices((current) => ({ ...current, [module.id]: value }))}
                quizAnswer={quizAnswers[module.id] ?? ""}
                setQuizAnswer={(value) => setQuizAnswers((current) => ({ ...current, [module.id]: value }))}
                ratings={ratings[module.id] ?? {}}
                setRating={(question, value) =>
                  setRatings((current) => ({ ...current, [module.id]: { ...(current[module.id] ?? {}), [question]: value } }))
                }
                surveyComment={surveyComments[module.id] ?? ""}
                setSurveyComment={(value) => setSurveyComments((current) => ({ ...current, [module.id]: value }))}
                questionText={questionTexts[module.id] ?? ""}
                setQuestionText={(value) => setQuestionTexts((current) => ({ ...current, [module.id]: value }))}
                postBody={postBodies[module.id] ?? ""}
                setPostBody={(value) => setPostBodies((current) => ({ ...current, [module.id]: value }))}
                caption={captions[module.id] ?? ""}
                setCaption={(value) => setCaptions((current) => ({ ...current, [module.id]: value }))}
                formMessage={(field) => formMessage(module.id, field)}
                generalMessage={generalMessage(module.id)}
                onSubmit={(command, payload, successMessage) =>
                  void submitGuestForm(state.eventId, module.id, command, payload, successMessage)
                }
                onLike={(questionId) =>
                  void submitGuestForm(state.eventId, `like:${questionId}`, "question.like", { id: questionId }, "좋아요를 반영했습니다.")
                }
                onPhoto={(file) => void submitPhoto(state.eventId, module.id, file)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.state} role="status">게시된 프로그램이 없습니다.</p>
      )}

      <footer className={styles.pageFooter}>
        <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket`}>내 티켓으로 이동</Link>
        <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
      </footer>
    </main>
  );
}

function typeLabel(type: string): string {
  switch (type) {
    case "poll":
      return "투표";
    case "quiz":
      return "퀴즈";
    case "qa":
      return "Q&A";
    case "draw":
      return "추첨";
    case "survey":
      return "만족도";
    case "photo":
      return "사진 공유";
    case "board":
      return "게시판";
    default:
      return "프로그램";
  }
}

function ModuleSection(props: {
  module: PublicModule;
  canSubmit: boolean;
  submitted: boolean;
  questions: PublicQuestion[];
  photos: PublicPhoto[];
  posts: PublicPost[];
  slug: string;
  eventId: string;
  submitting: string | null;
  pollChoice: string;
  setPollChoice: (value: string) => void;
  quizAnswer: string;
  setQuizAnswer: (value: string) => void;
  ratings: Record<string, number>;
  setRating: (question: string, value: number) => void;
  surveyComment: string;
  setSurveyComment: (value: string) => void;
  questionText: string;
  setQuestionText: (value: string) => void;
  postBody: string;
  setPostBody: (value: string) => void;
  caption: string;
  setCaption: (value: string) => void;
  formMessage: (field: string | null) => string | null;
  generalMessage: string | null;
  onSubmit: (command: string, payload: Record<string, unknown>, successMessage: string) => void;
  onLike: (questionId: string) => void;
  onPhoto: (file: File) => void;
}) {
  const { module } = props;
  const busy = props.submitting !== null;
  return (
    <section aria-labelledby={`engage-${module.id}`}>
      <p className={styles.typeKicker}>{typeLabel(module.type)}{module.status === "CLOSED" ? " · 종료됨" : ""}</p>
      <h2 id={`engage-${module.id}`}>{module.title}</h2>

      {module.type === "poll" ? (
        props.submitted ? (
          <p className={styles.submitted} role="status">이미 제출했습니다. 참여해 주셔서 감사합니다.</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.pollChoice || !props.canSubmit || busy) return;
              props.onSubmit("response.submit", { moduleId: module.id, answer: props.pollChoice }, "투표를 제출했습니다.");
            }}
          >
            <fieldset className={styles.fieldset} disabled={!props.canSubmit || busy}>
              <legend>투표 항목 선택</legend>
              {module.options.map((option, index) => (
                <label key={`${option}-${index}`} className={styles.choiceRow}>
                  <input
                    type="radio"
                    name={`poll-${module.id}`}
                    value={option}
                    checked={props.pollChoice === option}
                    onChange={() => props.setPollChoice(option)}
                  />
                  <span>{option} · {module.counts[index] ?? 0}표</span>
                </label>
              ))}
            </fieldset>
            {props.formMessage("answer") ? <p className={styles.fieldError} role="alert">{props.formMessage("answer")}</p> : null}
            {props.generalMessage ? <p className={styles.fieldError} role="alert">{props.generalMessage}</p> : null}
            <button type="submit" className="button button-primary" disabled={!props.pollChoice || !props.canSubmit || busy}>
              {props.submitting === module.id ? "제출 중…" : "투표하기"}
            </button>
          </form>
        )
      ) : null}

      {module.type === "quiz" ? (
        <>
          {module.revealed && module.answer ? <p className={styles.revealed}>공개된 정답: {module.answer}</p> : null}
          {props.submitted ? (
            <p className={styles.submitted} role="status">이미 제출했습니다. 참여해 주셔서 감사합니다.</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!props.quizAnswer.trim() || !props.canSubmit || busy) return;
                props.onSubmit("response.submit", { moduleId: module.id, answer: props.quizAnswer.trim() }, "퀴즈 답안을 제출했습니다.");
              }}
            >
              <div>
                <label htmlFor={`quiz-${module.id}`}>내 답안</label>
                <input
                  id={`quiz-${module.id}`}
                  maxLength={200}
                  value={props.quizAnswer}
                  aria-invalid={Boolean(props.formMessage("answer"))}
                  aria-describedby={props.formMessage("answer") ? `quiz-${module.id}-error` : undefined}
                  onChange={(event) => props.setQuizAnswer(event.target.value)}
                />
                {props.formMessage("answer") ? <p className={styles.fieldError} id={`quiz-${module.id}-error`} role="alert">{props.formMessage("answer")}</p> : null}
              </div>
              {props.generalMessage ? <p className={styles.fieldError} role="alert">{props.generalMessage}</p> : null}
              <button type="submit" className="button button-primary" disabled={!props.quizAnswer.trim() || !props.canSubmit || busy}>
                {props.submitting === module.id ? "제출 중…" : "답안 제출"}
              </button>
            </form>
          )}
        </>
      ) : null}

      {module.type === "survey" ? (
        props.submitted ? (
          <p className={styles.submitted} role="status">이미 제출했습니다. 참여해 주셔서 감사합니다.</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.canSubmit || busy) return;
              props.onSubmit(
                "response.submit",
                { moduleId: module.id, ratings: props.ratings, comment: props.surveyComment },
                "만족도를 제출했습니다."
              );
            }}
          >
            {module.questions.map((question) => (
              <fieldset key={question} className={styles.fieldset}>
                <legend>{question}</legend>
                <div className={styles.scoreRow} role="radiogroup" aria-label={`${question} 점수`}>
                  {[1, 2, 3, 4, 5].map((score) => (
                    <label key={score} className={styles.scoreChoice}>
                      <input
                        type="radio"
                        name={`survey-${module.id}-${question}`}
                        value={score}
                        checked={props.ratings[question] === score}
                        disabled={!props.canSubmit || busy}
                        onChange={() => props.setRating(question, score)}
                      />
                      <span>{score}점</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <div>
              <label htmlFor={`survey-comment-${module.id}`}>의견 · 선택</label>
              <textarea
                id={`survey-comment-${module.id}`}
                rows={3}
                maxLength={1000}
                value={props.surveyComment}
                onChange={(event) => props.setSurveyComment(event.target.value)}
              />
            </div>
            {props.formMessage("ratings") ? <p className={styles.fieldError} role="alert">{props.formMessage("ratings")}</p> : null}
            {props.generalMessage ? <p className={styles.fieldError} role="alert">{props.generalMessage}</p> : null}
            <button type="submit" className="button button-primary" disabled={!props.canSubmit || busy}>
              {props.submitting === module.id ? "제출 중…" : "만족도 제출"}
            </button>
          </form>
        )
      ) : null}

      {module.type === "qa" ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.questionText.trim() || !props.canSubmit || busy) return;
              props.onSubmit("question.submit", { moduleId: module.id, text: props.questionText.trim() }, "질문을 등록했습니다. 운영자 승인 후 공개됩니다.");
            }}
          >
            <div>
              <label htmlFor={`question-${module.id}`}>질문하기</label>
              <textarea
                id={`question-${module.id}`}
                rows={3}
                maxLength={500}
                value={props.questionText}
                aria-invalid={Boolean(props.formMessage("text"))}
                aria-describedby={props.formMessage("text") ? `question-${module.id}-error` : undefined}
                onChange={(event) => props.setQuestionText(event.target.value)}
              />
              {props.formMessage("text") ? <p className={styles.fieldError} id={`question-${module.id}-error`} role="alert">{props.formMessage("text")}</p> : null}
            </div>
            {props.generalMessage ? <p className={styles.fieldError} role="alert">{props.generalMessage}</p> : null}
            <button type="submit" className="button button-primary" disabled={!props.questionText.trim() || !props.canSubmit || busy}>
              질문 등록
            </button>
          </form>
          {props.questions.length ? (
            <ul className={styles.entryList}>
              {props.questions.map((question) => (
                <li key={question.id}>
                  <p><strong>{question.name}</strong> · {question.text}</p>
                  {question.answer ? <p className={styles.answer}>답변: {question.answer}</p> : null}
                  <p className={styles.entryMeta}>
                    {question.approved ? "공개됨" : "승인 대기 중"} · 좋아요 {question.likes}개
                    {question.approved && props.canSubmit ? (
                      <button
                        type="button"
                        className={styles.inlineButton}
                        disabled={busy}
                        onClick={() => props.onLike(question.id)}
                      >
                        좋아요
                      </button>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>아직 공개된 질문이 없습니다.</p>
          )}
        </>
      ) : null}

      {module.type === "photo" ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const file = (event.currentTarget.elements.namedItem(`photo-file-${module.id}`) as HTMLInputElement | null)?.files?.[0];
              if (!file || !props.canSubmit) return;
              props.onPhoto(file);
            }}
          >
            <div>
              <label htmlFor={`photo-file-${module.id}`}>사진 선택 · 600KB 이하</label>
              <input id={`photo-file-${module.id}`} name={`photo-file-${module.id}`} type="file" accept="image/png,image/jpeg,image/webp" disabled={!props.canSubmit || busy} />
              {props.formMessage("image") ? <p className={styles.fieldError} role="alert">{props.formMessage("image")}</p> : null}
            </div>
            <div>
              <label htmlFor={`photo-caption-${module.id}`}>사진 설명</label>
              <input
                id={`photo-caption-${module.id}`}
                maxLength={300}
                value={props.caption}
                aria-invalid={Boolean(props.formMessage("caption"))}
                aria-describedby={props.formMessage("caption") ? `photo-caption-${module.id}-error` : undefined}
                onChange={(event) => props.setCaption(event.target.value)}
              />
              {props.formMessage("caption") ? <p className={styles.fieldError} id={`photo-caption-${module.id}-error`} role="alert">{props.formMessage("caption")}</p> : null}
            </div>
            {props.generalMessage ? <p className={styles.fieldError} role="alert">{props.generalMessage}</p> : null}
            <button type="submit" className="button button-primary" disabled={!props.canSubmit || busy}>
              사진 공유
            </button>
          </form>
          {props.photos.length ? (
            <ul className={styles.photoGrid}>
              {props.photos.map((photo) => (
                <li key={photo.id}>
                  {photo.fileId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/public/events/${encodeURIComponent(props.slug)}/files/${encodeURIComponent(photo.fileId)}`}
                      alt={photo.caption || "참가자가 공유한 사진"}
                      loading="lazy"
                    />
                  ) : null}
                  <p><strong>{photo.name}</strong> · {photo.caption}</p>
                  {photo.status !== "APPROVED" ? <p className={styles.entryMeta}>승인 대기 중</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>아직 공유된 사진이 없습니다.</p>
          )}
        </>
      ) : null}

      {module.type === "board" ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.postBody.trim() || !props.canSubmit || busy) return;
              props.onSubmit("post.submit", { body: props.postBody.trim() }, "게시글을 등록했습니다. 운영자 승인 후 공개됩니다.");
            }}
          >
            <div>
              <label htmlFor={`post-${module.id}`}>게시글 작성</label>
              <textarea
                id={`post-${module.id}`}
                rows={3}
                maxLength={500}
                value={props.postBody}
                aria-invalid={Boolean(props.formMessage("body"))}
                aria-describedby={props.formMessage("body") ? `post-${module.id}-error` : undefined}
                onChange={(event) => props.setPostBody(event.target.value)}
              />
              {props.formMessage("body") ? <p className={styles.fieldError} id={`post-${module.id}-error`} role="alert">{props.formMessage("body")}</p> : null}
            </div>
            {props.generalMessage ? <p className={styles.fieldError} role="alert">{props.generalMessage}</p> : null}
            <button type="submit" className="button button-primary" disabled={!props.postBody.trim() || !props.canSubmit || busy}>
              게시글 등록
            </button>
          </form>
          {props.posts.length ? (
            <ul className={styles.entryList}>
              {props.posts.map((post) => (
                <li key={post.id}>
                  <p><strong>{post.name}</strong> · {post.body}</p>
                  {post.status !== "APPROVED" ? <p className={styles.entryMeta}>승인 대기 중</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>아직 작성된 게시글이 없습니다.</p>
          )}
        </>
      ) : null}

      {module.type === "draw" ? (
        module.drawHistory.length ? (
          <ul className={styles.entryList}>
            {module.drawHistory.map((result) => (
              <li key={result.id}>
                <p>당첨자: {result.winners.map((winner) => winner.name || "이름 미등록").join(", ") || "당첨자 없음"}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.help}>아직 공개된 추첨 결과가 없습니다.</p>
        )
      ) : null}

      {!props.canSubmit && ["poll", "quiz", "survey", "qa", "photo", "board"].includes(module.type) ? (
        <p className={styles.help}>참가 확정 후 제출할 수 있습니다.</p>
      ) : null}
    </section>
  );
}
