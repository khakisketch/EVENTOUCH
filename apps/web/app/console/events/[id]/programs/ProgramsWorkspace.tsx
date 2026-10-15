"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePageHeader, { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import styles from "./programs.module.css";

// Operator screen for the engagement bundle. Reads the operator bootstrap
// (modules, responses, questions, photos, posts); every write goes through
// the idempotent event command path. The server re-checks role, membership,
// feature flags, and the response lock, so the UI gates below are display
// only and never a permission decision.

type DrawResult = {
  id: string;
  winners: Array<{ name: string; company: string }>;
  at: string;
  poolCount: number;
  published: boolean;
};

type Module = {
  id: string;
  type: string;
  title: string;
  status: string;
  published: boolean;
  revealed: boolean;
  options: string[];
  answer: string;
  questions: string[];
  drawHistory: DrawResult[];
};

type Response = { id: string; moduleId: string };
type Question = {
  id: string;
  moduleId: string;
  name: string;
  text: string;
  answer: string;
  approved: boolean;
  likes: number;
};
type Photo = { id: string; caption: string; status: string; at: string; name: string; fileId: string };
type Post = { id: string; body: string; status: string; at: string; name: string };

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      eventMeta?: string;
      features: string[];
      canManage: boolean;
      modules: Module[];
      responses: Response[];
      questions: Question[];
      photos: Photo[];
      posts: Post[];
    };

type Failure = { message: string; field: string | null };

type ModuleDraft = {
  id: string;
  type: string;
  title: string;
  optionsText: string;
  answer: string;
  questionsText: string;
};

const EMPTY_DRAFT: ModuleDraft = {
  id: "",
  type: "poll",
  title: "",
  optionsText: "",
  answer: "",
  questionsText: "",
};

const MODULE_TYPES: Array<{ id: string; label: string }> = [
  { id: "poll", label: "투표" },
  { id: "quiz", label: "퀴즈" },
  { id: "qa", label: "Q&A" },
  { id: "draw", label: "추첨" },
  { id: "survey", label: "만족도" },
  { id: "photo", label: "사진" },
  { id: "board", label: "게시판" },
];

function typeLabel(type: string): string {
  return MODULE_TYPES.find((item) => item.id === type)?.label ?? "형식 확인 필요";
}

function statusLabel(module: Module): string {
  switch (module.status) {
    case "DRAFT":
      return "준비 중";
    case "OPEN":
      return "진행 중";
    case "CLOSED":
      return "종료";
    default:
      return "상태 확인 필요";
  }
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseDrawResult(value: unknown): DrawResult | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string") return null;
  const winners = Array.isArray(item.winners)
    ? item.winners.flatMap((winner) => {
        const row = asRecord(winner);
        if (!row) return [];
        return [{ name: text(row.name), company: text(row.company) }];
      })
    : [];
  return {
    id: item.id,
    winners,
    at: text(item.at),
    poolCount: typeof item.poolCount === "number" ? item.poolCount : 0,
    published: item.published === true,
  };
}

function parseModule(value: unknown): Module | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  return {
    id: item.id,
    type: text(item.type),
    title: text(item.title, "제목 없는 프로그램"),
    status: text(item.status, "DRAFT"),
    published: item.published === true,
    revealed: item.revealed === true,
    options: stringList(item.options),
    answer: text(item.answer),
    questions: stringList(item.questions),
    drawHistory: Array.isArray(item.drawHistory)
      ? item.drawHistory.flatMap((row) => {
          const parsed = parseDrawResult(row);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

class CommandFailure extends Error {
  field: string | null;

  constructor(failure: Failure) {
    super(failure.message);
    this.field = failure.field;
  }
}

export default function ProgramsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ModuleDraft>(EMPTY_DRAFT);
  const [dialogFailure, setDialogFailure] = useState<Failure | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogFieldError, setDialogFieldError] = useState<{ field: string; message: string } | null>(null);
  const [drawCounts, setDrawCounts] = useState<Record<string, string>>({});
  const [drawFailure, setDrawFailure] = useState<{ id: string; message: string; field: string | null } | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answerFailure, setAnswerFailure] = useState<{ id: string; message: string; field: string | null } | null>(null);

  async function load(silent = false) {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
      }
      const me = (await meRes.json().catch(() => null)) as {
        user?: { id?: unknown; role?: unknown } | null;
      } | null;
      const boot = (await bootRes.json().catch(() => null)) as {
        state?: {
          events?: unknown;
          clients?: unknown;
          memberships?: unknown;
          workspaces?: Record<string, unknown>;
        } | null;
      } | null;
      const bootstrap = boot?.state;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        setState({ kind: "failed", message: "참여 프로그램 정보를 불러오지 못했습니다." });
        return;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      const memberships: Array<{ accountId: string; eventId: string }> = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            const membership = asRecord(item);
            if (!membership || typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId }];
          })
        : [];
      const canManage =
        role === "AGENCY" ||
        (role === "MANAGER" &&
          memberships.some((membership) => membership.accountId === myId && membership.eventId === eventId));
      const event = Array.isArray(bootstrap.events)
        ? bootstrap.events.flatMap((item) => {
            const record = asRecord(item);
            return record && record.id === eventId ? [record] : [];
          })[0]
        : undefined;
      const workspace = asRecord(bootstrap.workspaces?.[eventId]);
      if (!event || !workspace) {
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return;
      }
      const clientName = Array.isArray(bootstrap.clients)
        ? bootstrap.clients
            .map(asRecord)
            .find((client) => client?.id === event.clientId)?.name
        : "";
      const venue = asRecord(workspace.venue);
      const modules = Array.isArray(workspace.modules)
        ? workspace.modules.flatMap((value) => {
            const parsed = parseModule(value);
            return parsed ? [parsed] : [];
          })
        : [];
      const responses: Response[] = Array.isArray(workspace.responses)
        ? workspace.responses.flatMap((value) => {
            const item = asRecord(value);
            if (!item || typeof item.id !== "string" || typeof item.moduleId !== "string") return [];
            return [{ id: item.id, moduleId: item.moduleId }];
          })
        : [];
      const questions: Question[] = Array.isArray(workspace.questions)
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
      const photos: Photo[] = Array.isArray(workspace.photos)
        ? workspace.photos.flatMap((value) => {
            const item = asRecord(value);
            if (!item || typeof item.id !== "string") return [];
            const image = asRecord(item.image);
            return [{
              id: item.id,
              caption: text(item.caption),
              status: text(item.status, "PENDING"),
              at: text(item.at),
              name: text(item.name, "이름 미등록"),
              fileId: image ? text(image.fileId) : "",
            }];
          })
        : [];
      const posts: Post[] = Array.isArray(workspace.posts)
        ? workspace.posts.flatMap((value) => {
            const item = asRecord(value);
            if (!item || typeof item.id !== "string") return [];
            return [{
              id: item.id,
              body: text(item.body),
              status: text(item.status, "PENDING"),
              at: text(item.at),
              name: text(item.name, "이름 미등록"),
            }];
          })
        : [];
      setState({
        kind: "ready",
        eventName: text(event.name, eventId),
        eventMeta: formatConsoleEventMeta({
          clientName: text(clientName),
          date: text(event.date),
          start: text(event.start),
          end: text(event.end),
          venue: text(venue?.name),
        }),
        features: Array.isArray(event.features)
          ? event.features.filter((feature): feature is string => typeof feature === "string")
          : [],
        canManage,
        modules,
        responses,
        questions,
        photos,
        posts,
      });
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function postCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: randomCommandId(), command, payload }),
    });
    const data = (await response.json().catch(() => null)) as {
      error?: unknown;
      field?: unknown;
    } & Record<string, unknown> | null;
    if (!response.ok) {
      throw new CommandFailure({
        message: typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.",
        field: typeof data?.field === "string" ? data.field : null,
      });
    }
    return data ?? {};
  }

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogOpen(true);
  }

  function openEdit(module: Module) {
    setDraft({
      id: module.id,
      type: module.type,
      title: module.title === "제목 없는 프로그램" ? "" : module.title,
      optionsText: module.options.join("\n"),
      answer: module.answer,
      questionsText: module.questions.join("\n"),
    });
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogOpen(true);
  }

  async function saveModule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogBusy(true);
    try {
      const payload: Record<string, unknown> = {
        type: draft.type,
        title: draft.title,
      };
      if (draft.id) payload.id = draft.id;
      if (draft.type === "poll") payload.options = draft.optionsText.split(/\r?\n/);
      if (draft.type === "quiz") payload.answer = draft.answer;
      if (draft.type === "survey") payload.questions = draft.questionsText.split(/\r?\n/);
      await postCommand("module.save", payload);
      setDialogOpen(false);
      setNotice(draft.id ? "프로그램을 저장했습니다." : "프로그램을 만들었습니다.");
      setFailure(null);
      await load(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      if (field) setDialogFieldError({ field, message });
      else setDialogFailure({ message, field });
    } finally {
      setDialogBusy(false);
    }
  }

  async function changeStatus(module: Module, status: "DRAFT" | "OPEN" | "CLOSED") {
    const action = status === "OPEN" ? "시작" : status === "CLOSED" ? "종료" : "준비로 되돌리기";
    if (!window.confirm(`“${module.title}” 프로그램을 ${action}할까요?`)) return;
    setBusy(`status:${module.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("module.status", { id: module.id, status });
      setNotice(`프로그램을 ${action}했습니다.`);
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "상태를 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function revealQuiz(module: Module) {
    if (!window.confirm(`“${module.title}” 퀴즈 정답을 공개할까요? 공개하면 프로그램이 종료됩니다.`)) return;
    setBusy(`reveal:${module.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("module.reveal", { id: module.id });
      setNotice("퀴즈 정답을 공개했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "정답을 공개하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function runDraw(module: Module) {
    const count = Number(drawCounts[module.id] ?? "1");
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      setDrawFailure({ id: module.id, message: "당첨 인원은 1~20명으로 입력하세요.", field: "count" });
      return;
    }
    if (!window.confirm(`“${module.title}” 추첨을 ${count}명으로 실행할까요? 이미 당첨된 참가자는 제외됩니다.`)) return;
    setBusy(`draw:${module.id}`);
    setDrawFailure(null);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.run", { id: module.id, count });
      setNotice("추첨을 실행했습니다. 결과를 확인하고 공개하세요.");
      await load(true);
    } catch (error) {
      setDrawFailure({
        id: module.id,
        message: error instanceof Error ? error.message : "추첨을 실행하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
    }
  }

  async function publishDraw(module: Module) {
    if (!window.confirm("최신 추첨 결과를 참가자에게 공개할까요?")) return;
    setBusy(`publish:${module.id}`);
    setDrawFailure(null);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.publish", { id: module.id });
      setNotice("추첨 결과를 공개했습니다.");
      await load(true);
    } catch (error) {
      setDrawFailure({
        id: module.id,
        message: error instanceof Error ? error.message : "결과를 공개하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
    }
  }

  async function manageQuestion(question: Question, approved: boolean) {
    const answer = (answerDrafts[question.id] ?? question.answer).trim();
    if (approved && !answer) {
      setAnswerFailure({ id: question.id, message: "답변을 입력한 뒤 공개하세요.", field: "answer" });
      return;
    }
    setBusy(`question:${question.id}`);
    setAnswerFailure(null);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("question.manage", { id: question.id, answer, approved });
      setNotice(approved ? "질문을 공개했습니다." : "질문을 저장했습니다.");
      await load(true);
    } catch (error) {
      setAnswerFailure({
        id: question.id,
        message: error instanceof Error ? error.message : "질문을 처리하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
    }
  }

  async function moderatePhoto(photo: Photo, status: "APPROVED" | "HIDDEN") {
    const action = status === "APPROVED" ? "승인" : "반려";
    if (!window.confirm(`이 사진을 ${action}할까요?`)) return;
    setBusy(`photo:${photo.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("photo.moderate", { id: photo.id, status });
      setNotice(`사진을 ${action}했습니다.`);
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "사진을 처리하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function moderatePost(post: Post, status: "APPROVED" | "HIDDEN") {
    const action = status === "APPROVED" ? "승인" : "반려";
    if (!window.confirm(`이 게시글을 ${action}할까요?`)) return;
    setBusy(`post:${post.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("post.moderate", { id: post.id, status });
      setNotice(`게시글을 ${action}했습니다.`);
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "게시글을 처리하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  const pageHeader = (
    <ConsolePageHeader
      title={state.kind === "ready" ? state.eventName : "행사"}
      back={{ href: `/console/events/${encodeURIComponent(eventId)}`, label: "← 운영 현황" }}
      meta={state.kind === "ready" ? state.eventMeta : undefined}
      actions={<Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</Link>}
    />
  );
  if (state.kind === "loading") {
    return (
      <div className={styles.page}>
        {pageHeader}
        <ConsoleStatePanel kind="loading" message="참여 프로그램 정보를 불러오고 있습니다." onRetry={() => {}} />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className={styles.page}>
        {pageHeader}
        {/* ConsoleStatePanel renders "다시 불러오기" and dispatches eventouch:shell-reload before retrying. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void load(); }}
          actions={<Link className="button button-secondary" href="/console">행사 목록으로</Link>}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {pageHeader}
      <p className={styles.intro}>투표·퀴즈·Q&A·추첨·만족도·사진·게시판을 만들고 진행 상태를 관리합니다.</p>

      {!state.canManage ? (
        <p className="state-error" role="alert">참여 프로그램을 관리할 운영 권한이 없습니다.</p>
      ) : (
        <>
          {notice ? <p className="state-success" role="status">{notice}</p> : null}
          {failure ? <p className="state-error" role="alert">{failure}</p> : null}
          <ConsoleSection headingId="program-module-list" title="참여 프로그램">
            <div className={styles.toolbar}>
              <button type="button" className="button button-primary" onClick={openCreate}>
                프로그램 만들기
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy !== null}
                onClick={() => void load(true)}
              >
                새로고침
              </button>
            </div>
            {state.modules.length ? (
              <ul className={styles.moduleList}>
                {state.modules.map((module) => (
                  <ModuleCard
                    key={module.id}
                    module={module}
                    featureOn={state.features.includes(module.type)}
                    eventId={eventId}
                    busy={busy}
                    responses={state.responses.filter((response) => response.moduleId === module.id).length}
                    questions={state.questions.filter((question) => question.moduleId === module.id)}
                    photos={state.photos}
                    posts={state.posts}
                    drawCounts={drawCounts}
                    setDrawCounts={setDrawCounts}
                    drawFailure={drawFailure?.id === module.id ? drawFailure : null}
                    answerDrafts={answerDrafts}
                    setAnswerDrafts={setAnswerDrafts}
                    answerFailure={answerFailure}
                    onEdit={() => openEdit(module)}
                    onStatus={(status) => void changeStatus(module, status)}
                    onReveal={() => void revealQuiz(module)}
                    onRunDraw={() => void runDraw(module)}
                    onPublishDraw={() => void publishDraw(module)}
                    onManageQuestion={(question, approved) => void manageQuestion(question, approved)}
                    onModeratePhoto={(photo, status) => void moderatePhoto(photo, status)}
                    onModeratePost={(post, status) => void moderatePost(post, status)}
                  />
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>등록된 프로그램이 없습니다. 위에서 첫 프로그램을 만드세요.</p>
            )}
          </ConsoleSection>
        </>
      )}

      {dialogOpen && state.kind === "ready" ? (
        <ModuleDialog
          draft={draft}
          busy={dialogBusy}
          failure={dialogFailure}
          fieldError={dialogFieldError}
          onChange={setDraft}
          onClose={() => {
            if (!dialogBusy) setDialogOpen(false);
          }}
          onSubmit={saveModule}
        />
      ) : null}
    </div>
  );
}

function countSummary(module: Module, responseCount: number, questions: Question[], photos: Photo[], posts: Post[]): string {
  switch (module.type) {
    case "poll":
    case "quiz":
      return `응답 ${responseCount}건`;
    case "survey":
      return `응답 ${responseCount}건`;
    case "qa": {
      const approved = questions.filter((question) => question.approved).length;
      return `질문 ${questions.length}건(공개 ${approved}건)`;
    }
    case "draw": {
      const winners = module.drawHistory.reduce((total, result) => total + result.winners.length, 0);
      return `추첨 ${module.drawHistory.length}회(당첨 ${winners}명)`;
    }
    case "photo": {
      const pending = photos.filter((photo) => photo.status === "PENDING").length;
      return `사진 ${photos.length}장(대기 ${pending}건)`;
    }
    case "board": {
      const pending = posts.filter((post) => post.status === "PENDING").length;
      return `글 ${posts.length}건(대기 ${pending}건)`;
    }
    default:
      return `응답 ${responseCount}건`;
  }
}

// A module whose content attendees already touched keeps its questions
// locked: the server rejects module.save with 409, so the UI disables
// editing with the same guidance instead of letting the save fail.
function editLockReason(module: Module, responseCount: number, questions: Question[]): string | null {
  if (module.type === "qa") {
    return questions.length
      ? "질문이 있어 문제를 수정할 수 없습니다. 새 프로그램을 만드세요."
      : null;
  }
  if (module.type === "draw") {
    return module.drawHistory.length
      ? "추첨 기록이 있어 문제를 수정할 수 없습니다. 새 프로그램을 만드세요."
      : null;
  }
  if (module.type === "photo" || module.type === "board") return null;
  return responseCount > 0
    ? "응답이 있어 문제를 수정할 수 없습니다. 새 프로그램을 만드세요."
    : null;
}

function ModuleCard(props: {
  module: Module;
  featureOn: boolean;
  eventId: string;
  busy: string | null;
  responses: number;
  questions: Question[];
  photos: Photo[];
  posts: Post[];
  drawCounts: Record<string, string>;
  setDrawCounts: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  drawFailure: { id: string; message: string; field: string | null } | null;
  answerDrafts: Record<string, string>;
  setAnswerDrafts: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  answerFailure: { id: string; message: string; field: string | null } | null;
  onEdit: () => void;
  onStatus: (status: "DRAFT" | "OPEN" | "CLOSED") => void;
  onReveal: () => void;
  onRunDraw: () => void;
  onPublishDraw: () => void;
  onManageQuestion: (question: Question, approved: boolean) => void;
  onModeratePhoto: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onModeratePost: (post: Post, status: "APPROVED" | "HIDDEN") => void;
}) {
  const { module } = props;
  const lockReason = editLockReason(module, props.responses, props.questions);
  const latestDraw = module.drawHistory[0] ?? null;
  return (
    <li className={styles.moduleCard}>
      <div className={styles.moduleTop}>
        <div className={styles.moduleTitle}>
          <h3>{module.title}</h3>
          <p className={styles.moduleMeta}>
            <span className={styles.typeBadge}>{typeLabel(module.type)}</span>
            <span className={`${styles.status} ${module.status === "OPEN" ? styles.statusOpen : module.status === "CLOSED" ? styles.statusClosed : styles.statusDraft}`}>
              {statusLabel(module)}
            </span>
            <span>{countSummary(module, props.responses, props.questions, props.photos, props.posts)}</span>
          </p>
          {!props.featureOn ? (
            <p className={styles.featureOff} role="note">
              이 유형이 꺼져 있습니다.{" "}
              <Link href={`/console/events/${encodeURIComponent(props.eventId)}/settings`}>행사 설정</Link>에서
              기능을 먼저 켜세요.
            </p>
          ) : null}
        </div>
        <div className={styles.moduleActions}>
          <button
            type="button"
            className="button button-secondary"
            disabled={lockReason !== null}
            title={lockReason ?? undefined}
            onClick={props.onEdit}
          >
            편집
          </button>
          {module.status === "DRAFT" ? (
            <button type="button" className="button button-secondary" disabled={props.busy !== null} onClick={() => props.onStatus("OPEN")}>시작</button>
          ) : null}
          {module.status === "OPEN" ? (
            <button type="button" className="button button-secondary" disabled={props.busy !== null} onClick={() => props.onStatus("CLOSED")}>종료</button>
          ) : null}
          {module.status === "CLOSED" ? (
            <button type="button" className="button button-secondary" disabled={props.busy !== null} onClick={() => props.onStatus("OPEN")}>다시 열기</button>
          ) : null}
        </div>
      </div>
      {lockReason ? <p className={styles.lockNote}>{lockReason}</p> : null}
      {module.type === "poll" && module.options.length ? (
        <p className={styles.detail}>선택지: {module.options.join(" · ")}</p>
      ) : null}
      {module.type === "quiz" && module.revealed ? (
        <p className={styles.detail}>공개된 정답: {module.answer || "정답 확인 필요"}</p>
      ) : null}
      {module.type === "quiz" && module.published && !module.revealed && (module.status === "OPEN" || module.status === "CLOSED") ? (
        <p>
          <button
            type="button"
            className="button button-secondary"
            disabled={props.busy !== null}
            onClick={props.onReveal}
          >
            {props.busy === `reveal:${module.id}` ? "공개 중…" : "퀴즈 정답 공개"}
          </button>
        </p>
      ) : null}
      {module.type === "draw" ? (
        <div className={styles.drawBox}>
          <div className={styles.drawControls}>
            <label htmlFor={`draw-count-${module.id}`}>당첨 인원(1~20명)</label>
            <input
              id={`draw-count-${module.id}`}
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              value={props.drawCounts[module.id] ?? "1"}
              aria-invalid={props.drawFailure?.field === "count"}
              aria-describedby={props.drawFailure ? `draw-count-${module.id}-error` : undefined}
              onChange={(event) =>
                props.setDrawCounts((current) => ({ ...current, [module.id]: event.target.value }))
              }
            />
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || module.status !== "OPEN"}
              onClick={props.onRunDraw}
            >
              {props.busy === `draw:${module.id}` ? "실행 중…" : "추첨 실행"}
            </button>
            {latestDraw && !latestDraw.published ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={props.busy !== null}
                onClick={props.onPublishDraw}
              >
                {props.busy === `publish:${module.id}` ? "공개 중…" : "최신 결과 공개"}
              </button>
            ) : null}
          </div>
          {module.status !== "OPEN" ? (
            <p className={styles.help}>진행 중인 추첨만 실행할 수 있습니다. 먼저 시작하세요.</p>
          ) : null}
          {props.drawFailure ? (
            <p className={styles.fieldError} id={`draw-count-${module.id}-error`} role="alert">{props.drawFailure.message}</p>
          ) : null}
          {latestDraw ? (
            <p className={styles.detail}>
              최신 결과: {latestDraw.winners.map((winner) => winner.name || "이름 미등록").join(", ") || "당첨자 없음"}
              {latestDraw.published ? " · 공개됨" : " · 미공개"}
            </p>
          ) : (
            <p className={styles.help}>아직 추첨 기록이 없습니다.</p>
          )}
        </div>
      ) : null}
      {module.type === "qa" ? (
        <QuestionList
          questions={props.questions}
          busy={props.busy}
          answerDrafts={props.answerDrafts}
          setAnswerDrafts={props.setAnswerDrafts}
          answerFailure={props.answerFailure}
          onManage={props.onManageQuestion}
        />
      ) : null}
      {module.type === "photo" ? (
        <PhotoList photos={props.photos} busy={props.busy} eventId={props.eventId} onModerate={props.onModeratePhoto} />
      ) : null}
      {module.type === "board" ? (
        <PostList posts={props.posts} busy={props.busy} onModerate={props.onModeratePost} />
      ) : null}
    </li>
  );
}

function QuestionList(props: {
  questions: Question[];
  busy: string | null;
  answerDrafts: Record<string, string>;
  setAnswerDrafts: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  answerFailure: { id: string; message: string; field: string | null } | null;
  onManage: (question: Question, approved: boolean) => void;
}) {
  if (!props.questions.length) return <p className={styles.help}>등록된 질문이 없습니다.</p>;
  return (
    <ul className={styles.itemList}>
      {props.questions.map((question) => {
        const failure = props.answerFailure?.id === question.id ? props.answerFailure : null;
        return (
          <li key={question.id} className={styles.itemRow}>
            <p className={styles.itemText}><strong>{question.name}</strong> · {question.text}</p>
            <p className={styles.itemMeta}>
              {question.approved ? "공개됨" : "대기 중"} · 좋아요 {question.likes}개
              {question.answer ? ` · 답변: ${question.answer}` : " · 답변 없음"}
            </p>
            <label htmlFor={`answer-${question.id}`}>답변</label>
            <textarea
              id={`answer-${question.id}`}
              rows={2}
              maxLength={500}
              value={props.answerDrafts[question.id] ?? question.answer}
              aria-invalid={failure?.field === "answer"}
              aria-describedby={failure ? `answer-${question.id}-error` : undefined}
              onChange={(event) =>
                props.setAnswerDrafts((current) => ({ ...current, [question.id]: event.target.value }))
              }
            />
            {failure ? <p className={styles.fieldError} id={`answer-${question.id}-error`} role="alert">{failure.message}</p> : null}
            <div className={styles.itemActions}>
              <button
                type="button"
                className="button button-secondary"
                disabled={props.busy !== null}
                onClick={() => props.onManage(question, false)}
              >
                답변 저장
              </button>
              {question.approved ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={props.busy !== null}
                  onClick={() => props.onManage(question, false)}
                >
                  공개 취소
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={props.busy !== null}
                  onClick={() => props.onManage(question, true)}
                >
                  승인·공개
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function photoStatusLabel(status: string): string {
  switch (status) {
    case "APPROVED":
      return "승인됨";
    case "HIDDEN":
      return "반려됨";
    case "PENDING":
      return "대기 중";
    default:
      return "상태 확인 필요";
  }
}

function PhotoList(props: {
  photos: Photo[];
  busy: string | null;
  eventId: string;
  onModerate: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
}) {
  if (!props.photos.length) return <p className={styles.help}>공유된 사진이 없습니다.</p>;
  return (
    <ul className={styles.itemList}>
      {props.photos.map((photo) => (
        <li key={photo.id} className={styles.itemRow}>
          {photo.fileId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/events/${encodeURIComponent(props.eventId)}/files/${encodeURIComponent(photo.fileId)}`}
              alt={photo.caption || "참가자가 공유한 사진"}
              className={styles.photoThumb}
              loading="lazy"
            />
          ) : null}
          <p className={styles.itemText}><strong>{photo.name}</strong> · {photo.caption || "설명 없음"}</p>
          <p className={styles.itemMeta}>{photoStatusLabel(photo.status)}</p>
          <div className={styles.itemActions}>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || photo.status === "APPROVED"}
              onClick={() => props.onModerate(photo, "APPROVED")}
            >
              승인
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || photo.status === "HIDDEN"}
              onClick={() => props.onModerate(photo, "HIDDEN")}
            >
              반려
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PostList(props: {
  posts: Post[];
  busy: string | null;
  onModerate: (post: Post, status: "APPROVED" | "HIDDEN") => void;
}) {
  if (!props.posts.length) return <p className={styles.help}>작성된 게시글이 없습니다.</p>;
  return (
    <ul className={styles.itemList}>
      {props.posts.map((post) => (
        <li key={post.id} className={styles.itemRow}>
          <p className={styles.itemText}><strong>{post.name}</strong> · {post.body}</p>
          <p className={styles.itemMeta}>{post.status === "APPROVED" ? "승인됨" : post.status === "HIDDEN" ? "반려됨" : "대기 중"}</p>
          <div className={styles.itemActions}>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || post.status === "APPROVED"}
              onClick={() => props.onModerate(post, "APPROVED")}
            >
              승인
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || post.status === "HIDDEN"}
              onClick={() => props.onModerate(post, "HIDDEN")}
            >
              반려
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ModuleDialog(props: {
  draft: ModuleDraft;
  busy: boolean;
  failure: Failure | null;
  fieldError: { field: string; message: string } | null;
  onChange: (draft: ModuleDraft) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const { draft, busy, failure, fieldError, onChange, onClose, onSubmit } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled), input, select, textarea, a[href]")
      ?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select, textarea, a[href]"
        )
      ).filter((item) => item.tabIndex >= 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);
  function fieldMessage(field: string): string | null {
    return fieldError?.field === field ? fieldError.message : null;
  }
  return (
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="program-dialog-title">
        <h2 id="program-dialog-title">{draft.id ? "프로그램 편집" : "프로그램 만들기"}</h2>
        <form className={styles.form} onSubmit={onSubmit}>
          <div>
            <label htmlFor="program-title">제목</label>
            <input
              id="program-title"
              maxLength={100}
              required
              value={draft.title}
              aria-invalid={fieldError?.field === "title"}
              aria-describedby={fieldMessage("title") ? "program-title-error" : undefined}
              onChange={(event) => onChange({ ...draft, title: event.target.value })}
            />
            {fieldMessage("title") ? <p className={styles.fieldError} id="program-title-error" role="alert">{fieldMessage("title")}</p> : null}
          </div>
          <div>
            <label htmlFor="program-type">유형</label>
            <select
              id="program-type"
              value={draft.type}
              aria-invalid={fieldError?.field === "type"}
              aria-describedby={fieldMessage("type") ? "program-type-error" : undefined}
              onChange={(event) => onChange({ ...draft, type: event.target.value })}
            >
              {MODULE_TYPES.map((type) => (
                <option key={type.id} value={type.id}>{type.label}</option>
              ))}
            </select>
            {fieldMessage("type") ? <p className={styles.fieldError} id="program-type-error" role="alert">{fieldMessage("type")}</p> : null}
          </div>
          {draft.type === "poll" ? (
            <div>
              <label htmlFor="program-options">투표 선택지 · 한 줄에 하나씩, 두 개 이상</label>
              <textarea
                id="program-options"
                rows={4}
                value={draft.optionsText}
                aria-invalid={fieldError?.field === "options"}
                aria-describedby={fieldMessage("options") ? "program-options-error" : undefined}
                onChange={(event) => onChange({ ...draft, optionsText: event.target.value })}
              />
              {fieldMessage("options") ? <p className={styles.fieldError} id="program-options-error" role="alert">{fieldMessage("options")}</p> : null}
            </div>
          ) : null}
          {draft.type === "quiz" ? (
            <div>
              <label htmlFor="program-answer">퀴즈 정답</label>
              <input
                id="program-answer"
                maxLength={500}
                required
                value={draft.answer}
                aria-invalid={fieldError?.field === "answer"}
                aria-describedby={fieldMessage("answer") ? "program-answer-error" : undefined}
                onChange={(event) => onChange({ ...draft, answer: event.target.value })}
              />
              {fieldMessage("answer") ? <p className={styles.fieldError} id="program-answer-error" role="alert">{fieldMessage("answer")}</p> : null}
            </div>
          ) : null}
          {draft.type === "survey" ? (
            <div>
              <label htmlFor="program-questions">만족도 질문 · 한 줄에 하나씩</label>
              <textarea
                id="program-questions"
                rows={5}
                value={draft.questionsText}
                placeholder={"전반적인 만족도\n프로그램 구성\n현장 운영\n행사장 편의성\n재참석 의향"}
                aria-invalid={fieldError?.field === "questions"}
                aria-describedby={fieldMessage("questions") ? "program-questions-error" : undefined}
                onChange={(event) => onChange({ ...draft, questionsText: event.target.value })}
              />
              {fieldMessage("questions") ? <p className={styles.fieldError} id="program-questions-error" role="alert">{fieldMessage("questions")}</p> : null}
            </div>
          ) : null}
          {failure ? <p className={styles.fieldError} role="alert">{failure.message}</p> : null}
          <div className={styles.actions}>
            <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "저장 중…" : draft.id ? "저장" : "만들기"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
