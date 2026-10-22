"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleToolbar from "../../../console-ui/ConsoleToolbar";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
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

type Response = { id: string; moduleId: string; answer: string; ratings: Record<string, unknown> };
type Question = {
  id: string;
  moduleId: string;
  name: string;
  text: string;
  answer: string;
  approved: boolean;
  likes: number;
};
type Photo = { id: string; caption: string; status: string; at: string; name: string; fileId: string; fileName: string };
type Post = { id: string; body: string; status: string; at: string; name: string };

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      eventMeta?: string;
      archived: boolean;
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

// Long-list paging: reveal the first page only, then grow incrementally.
// Plain slicing only; creation/edit/status affordances stay above the
// fold and the existing empty states are untouched.
const MODULE_PAGE_SIZE = 12;

// Survey average reuses the reports snapshot math (one decimal, null on empty).
function averageLabel(values: number[]): string | null {
  if (!values.length) return null;
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

// Quiz responses are free text (creation sends only the correct `answer`,
// submitResponse requires any non-empty 답변). Grading compares each loaded
// answer against the stored correct answer: non-empty match is 정답,
// non-empty mismatch is 오답, blank is 미채점. Without a stored answer
// everything is 미채점. The distribution groups identical trimmed answers
// with counts; blank answers collapse to 무응답. Aggregate-only: no new API,
// no identities.
function quizGradeSummary(correctAnswer: string, answers: string[]): string {
  const correct = correctAnswer.trim();
  if (!correct) return `정답 0 · 오답 0 · 미채점 ${answers.length}`;
  let right = 0;
  let empty = 0;
  for (const answer of answers) {
    const trimmed = answer.trim();
    if (!trimmed) empty += 1;
    else if (trimmed === correct) right += 1;
  }
  return `정답 ${right} · 오답 ${answers.length - right - empty} · 미채점 ${empty}`;
}

function quizAnswerGroups(answers: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const answer of answers) {
    const trimmed = answer.trim();
    const key = trimmed || "무응답";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko"));
}

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
  const pendingCommandsRef = useRef(new Map<string, string>());
  const sendingRef = useRef(false);
  // Tracks a dialog save whose outcome is still unknown (ambiguous failure
  // kept its idempotent key). Dismissal must warn that it may already have
  // applied instead of claiming a cancel.
  const dialogUnresolvedRef = useRef(false);
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
  // In-place confirmations for irreversible/outward-facing commands. One open
  // at a time: each holds only its target (draw also snapshots the count at
  // trigger time). Dialog dismissal gates stay on window.confirm via
  // confirmDialogClose and are unrelated to these.
  const [statusPending, setStatusPending] = useState<{ id: string; status: "DRAFT" | "OPEN" | "CLOSED" } | null>(null);
  const [revealPendingId, setRevealPendingId] = useState<string | null>(null);
  const [drawPending, setDrawPending] = useState<{ id: string; count: number } | null>(null);
  const [publishPendingId, setPublishPendingId] = useState<string | null>(null);
  const [photoPending, setPhotoPending] = useState<{ id: string; status: "APPROVED" | "HIDDEN" } | null>(null);
  const [postPending, setPostPending] = useState<{ id: string; status: "APPROVED" | "HIDDEN" } | null>(null);
  const [moduleLimit, setModuleLimit] = useState(MODULE_PAGE_SIZE);
  // Client-side list filters only (경품·고객사 목록과 같은 문법): the server
  // contract is untouched, filtering reads the already-loaded modules.
  const [programQuery, setProgramQuery] = useState("");
  const [programStatusFilter, setProgramStatusFilter] = useState("");
  // Create lands appended at the end of the server list, so a 13th+ module
  // would hide behind 더 보기. A successful create reveals the full list and
  // parks a focus request for the new card heading (effect below).
  const createdFocusRef = useRef<string | null>(null);
  // 더 보기 inserts rows before the focused button: park the first newly
  // revealed index at click time, then focus its card heading after render.
  const programRevealRef = useRef<number | null>(null);
  // Client-side filter snapshot for the reveal focus: the index parks
  // against the filtered list, so focus lands on the filtered card instead
  // of the unfiltered position. Assigned during render below.
  const visibleModulesRef = useRef<Module[]>([]);

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 읽기·내보내기만 둡니다. 역할·멤버십 게이트는 그대로 둡니다.
  const writeLocked = state.kind === "ready" && state.archived;

  // Display-only feature gate mirror: the server rejects every module write
  // with 409 when the module type is off, so writes are pre-blocked with the
  // same reason instead of sent for a predictable rejection. Reads stay open.
  function isTypeEnabled(type: string): boolean {
    return state.kind !== "ready" || state.features.includes(type);
  }

  function revealMoreModules() {
    programRevealRef.current = moduleLimit;
    setModuleLimit((limit) => limit + MODULE_PAGE_SIZE);
  }

  function moduleInitialDraft(module: Module): ModuleDraft {
    return {
      id: module.id,
      type: module.type,
      title: module.title === "제목 없는 프로그램" ? "" : module.title,
      optionsText: module.options.join("\n"),
      answer: module.answer,
      questionsText: module.questions.join("\n"),
    };
  }

  // Cross-route guard predicates: actual diffs plus retained idempotent
  // keys (an ambiguous outcome whose same-request retry is still available).
  // Pristine dialogs and clean saves register nothing: the baseline compare
  // is false on open, and success paths delete their keys.
  const dialogBaseline = state.kind === "ready" && dialogOpen
    ? (() => {
        const editing = draft.id ? state.modules.find((module) => module.id === draft.id) ?? null : null;
        return editing ? moduleInitialDraft(editing) : EMPTY_DRAFT;
      })()
    : null;
  const dialogDirty = dialogBaseline !== null && JSON.stringify(draft) !== JSON.stringify(dialogBaseline);
  const answerDirty = state.kind === "ready" && Object.entries(answerDrafts).some(([id, value]) => {
    const question = state.questions.find((item) => item.id === id);
    return question ? value !== question.answer : value !== "";
  });
  const pendingRetry = pendingCommandsRef.current.size > 0;
  useConsoleDraftGuard(dialogDirty || answerDirty || pendingRetry, "작성 중인 프로그램 내용이 있습니다.");

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
            // Aggregate-only projection: option tallies and survey averages are
            // computed from these already-loaded answers/ratings. Participant
            // identities are never rendered (no per-person rows, no ids).
            const ratings = asRecord(item.ratings) ?? {};
            return [{ id: item.id, moduleId: item.moduleId, answer: text(item.answer), ratings }];
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
              fileName: image ? text(image.name, "photo") : "photo",
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
        archived: text(event.stage).toUpperCase() === "ARCHIVED",
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

  // After a create reveal or a 더 보기 expansion, focus the destination card
  // heading. The row heading itself is focusable (tabIndex -1), so no extra
  // live-region announcement is added.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const created = createdFocusRef.current;
    if (created !== null) {
      const target = created === "__latest__"
        ? state.modules[state.modules.length - 1] ?? null
        : state.modules.find((module) => module.id === created) ?? null;
      if (!target) return;
      createdFocusRef.current = null;
      const heading = document.getElementById(`module-title-${target.id}`);
      heading?.scrollIntoView({ block: "nearest" });
      heading?.focus({ preventScroll: true });
      return;
    }
    if (programRevealRef.current !== null) {
      const index = programRevealRef.current;
      programRevealRef.current = null;
      const target = visibleModulesRef.current[index] ?? null;
      if (!target) return;
      const heading = document.getElementById(`module-title-${target.id}`);
      heading?.scrollIntoView({ block: "nearest" });
      heading?.focus({ preventScroll: true });
    }
  }, [state, moduleLimit]);

  async function postCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (sendingRef.current) throw new Error("이전 요청을 확인하고 있습니다. 잠시 기다려주세요.");
    sendingRef.current = true;
    const attempt = JSON.stringify([eventId, command, payload]);
    const commandId = pendingCommandsRef.current.get(attempt) ?? randomCommandId();
    pendingCommandsRef.current.set(attempt, commandId);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      }).catch(() => { throw new Error("응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요."); });
      const data = (await response.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } & Record<string, unknown> | null;
      if (!response.ok) {
        const uncertain = response.status >= 500 || response.status === 408;
        if (!uncertain) pendingCommandsRef.current.delete(attempt);
        throw new CommandFailure({
          message: uncertain ? "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요." : typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : null,
        });
      }
      if (!data || Array.isArray(data)) throw new Error("응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요.");
      pendingCommandsRef.current.delete(attempt);
      return data;
    } finally {
      sendingRef.current = false;
    }
  }

  function openCreate() {
    if (writeLocked) return;
    dialogUnresolvedRef.current = false;
    setDraft(EMPTY_DRAFT);
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogOpen(true);
  }

  function openEdit(module: Module) {
    if (writeLocked) return;
    dialogUnresolvedRef.current = false;
    setDraft(moduleInitialDraft(module));
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogOpen(true);
  }

  // Shared dismissal gate for the dialog's Escape, backdrop and Cancel
  // paths, mirroring CreateEventDialog: in-flight writes block on the sync
  // ref (state flips only on re-render), an unresolved save warns that it
  // may already have applied, edited drafts confirm, pristine dialogs close
  // without a confirm.
  function confirmDialogClose(): boolean {
    if (sendingRef.current || dialogBusy) return false;
    if (dialogUnresolvedRef.current) {
      return window.confirm("프로그램 저장 결과를 아직 확인하지 못했습니다. 이미 저장되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
    }
    if (!dialogDirty) return true;
    return window.confirm("작성 중인 프로그램 내용이 있습니다. 닫을까요?");
  }

  async function saveModule(event: React.FormEvent<HTMLFormElement>) {
    if (writeLocked) return;
    event.preventDefault();
    setDialogFailure(null);
    setDialogFieldError(null);
    // Pre-block instead of sending for a predictable 409: the server only
    // saves module types whose feature flag is on.
    if (!isTypeEnabled(draft.type)) {
      setDialogFieldError({ field: "type", message: "꺼져 있는 기능의 프로그램은 저장할 수 없습니다. 행사 설정에서 기능을 먼저 켜세요." });
      return;
    }
    setDialogBusy(true);
    // Size growth means this attempt kept its idempotent key: an ambiguous
    // outcome the dismissal gate must warn about.
    const pendingBefore = pendingCommandsRef.current.size;
    const wasCreate = !draft.id;
    try {
      const payload: Record<string, unknown> = {
        type: draft.type,
        title: draft.title,
      };
      if (draft.id) payload.id = draft.id;
      if (draft.type === "poll") payload.options = draft.optionsText.split(/\r?\n/);
      if (draft.type === "quiz") payload.answer = draft.answer;
      if (draft.type === "survey") payload.questions = draft.questionsText.split(/\r?\n/);
      const receipt = await postCommand("module.save", payload);
      dialogUnresolvedRef.current = false;
      setDialogOpen(false);
      setNotice(draft.id ? "프로그램을 저장했습니다." : "프로그램을 만들었습니다.");
      setFailure(null);
      await load(true);
      if (wasCreate) {
        // The server appends new modules at the end, which would hide a 13th+
        // module behind 더 보기. Reveal the full list (ordering untouched;
        // edits keep their limit) and park a focus request so the
        // create→start workflow keeps its destination card heading.
        setModuleLimit(Number.MAX_SAFE_INTEGER);
        const saved = asRecord(receipt.module);
        createdFocusRef.current =
          saved && typeof saved.id === "string" && saved.id ? saved.id : "__latest__";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      if (field) setDialogFieldError({ field, message });
      else setDialogFailure({ message, field });
      dialogUnresolvedRef.current = pendingCommandsRef.current.size > pendingBefore;
    } finally {
      setDialogBusy(false);
    }
  }

  function requestStatusChange(module: Module, status: "DRAFT" | "OPEN" | "CLOSED") {
    if (writeLocked || !isTypeEnabled(module.type) || busy !== null) return;
    setStatusPending({ id: module.id, status });
  }

  async function changeStatus(module: Module, status: "DRAFT" | "OPEN" | "CLOSED") {
    if (writeLocked || !isTypeEnabled(module.type)) return;
    const action = status === "OPEN" ? "시작" : status === "CLOSED" ? "종료" : "준비로 되돌리기";
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
      setStatusPending(null);
    }
  }

  function requestQuizReveal(module: Module) {
    if (writeLocked || !isTypeEnabled("quiz") || busy !== null) return;
    setRevealPendingId(module.id);
  }

  async function revealQuiz(module: Module) {
    if (writeLocked || !isTypeEnabled("quiz")) return;
    if (writeLocked) return;
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
      setRevealPendingId(null);
    }
  }

  function requestDraw(module: Module) {
    if (writeLocked || !isTypeEnabled("draw") || busy !== null) return;
    const count = Number(drawCounts[module.id] ?? "1");
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      setDrawFailure({ id: module.id, message: "당첨 인원은 1~20명으로 입력하세요.", field: "count" });
      return;
    }
    setDrawPending({ id: module.id, count });
  }

  async function runDraw(module: Module, countOverride?: number) {
    if (writeLocked || !isTypeEnabled("draw")) return;
    if (writeLocked) return;
    const count = countOverride ?? Number(drawCounts[module.id] ?? "1");
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      setDrawFailure({ id: module.id, message: "당첨 인원은 1~20명으로 입력하세요.", field: "count" });
      return;
    }
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
      setDrawPending(null);
    }
  }

  function requestDrawPublish(module: Module) {
    if (writeLocked || !isTypeEnabled("draw") || busy !== null) return;
    setPublishPendingId(module.id);
  }

  async function publishDraw(module: Module) {
    if (writeLocked || !isTypeEnabled("draw")) return;
    if (writeLocked) return;
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
      setPublishPendingId(null);
    }
  }

  async function manageQuestion(question: Question, approved: boolean) {
    if (writeLocked || !isTypeEnabled("qa")) return;
    if (writeLocked) return;
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
      // The draft is now the saved answer: drop the local entry so the
      // textarea falls back to server truth instead of shadowing it and
      // tripping the unsaved guard on whitespace alone.
      setAnswerDrafts((current) => {
        if (!(question.id in current)) return current;
        const next = { ...current };
        delete next[question.id];
        return next;
      });
      setNotice(approved
        ? question.approved ? "답변을 저장했습니다. 공개 상태를 유지합니다." : "답변을 저장하고 질문을 공개했습니다."
        : question.approved ? "질문을 비공개로 전환했습니다." : "답변을 저장했습니다. 비공개 상태를 유지합니다.");
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

  function requestPhotoModeration(photo: Photo, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("photo") || busy !== null) return;
    setPhotoPending({ id: photo.id, status });
  }

  async function moderatePhoto(photo: Photo, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("photo")) return;
    if (writeLocked) return;
    const action = status === "APPROVED" ? "승인" : "반려";
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
      setPhotoPending(null);
    }
  }

  function requestPostModeration(post: Post, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("board") || busy !== null) return;
    setPostPending({ id: post.id, status });
  }

  async function moderatePost(post: Post, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("board")) return;
    if (writeLocked) return;
    const action = status === "APPROVED" ? "승인" : "반려";
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
      setPostPending(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="programs" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="참여 프로그램 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="programs" eventId={eventId}>
        {/* ConsoleStatePanel renders "다시 불러오기" and dispatches eventouch:shell-reload before retrying. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void load(); }}
          actions={<Link className="button button-secondary" href="/console">행사 목록으로</Link>}
        />
      </ConsolePage>
    );
  }

  const settingsHref = `/console/events/${encodeURIComponent(eventId)}/settings`;

  // Read-only client filter over the already-loaded modules: no new fetch,
  // no command, no permission change. Read-only filters stay unguarded.
  const programQueryText = programQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleModules = state.modules.filter((module) => {
    if (programStatusFilter === "DRAFT" || programStatusFilter === "OPEN" || programStatusFilter === "CLOSED") {
      if (module.status !== programStatusFilter) return false;
    }
    if (!programQueryText) return true;
    return `${module.title} ${typeLabel(module.type)}`.toLocaleLowerCase("ko-KR").includes(programQueryText);
  });
  visibleModulesRef.current = visibleModules;
  const hasProgramFilter = programQuery.trim() !== "" || programStatusFilter !== "";
  function clearProgramFilters(): void {
    setProgramQuery("");
    setProgramStatusFilter("");
  }

  return (
    <ConsolePage
      pageId="programs"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      headerActions={<Link className="button button-secondary" href={settingsHref}>행사 설정</Link>}
      toolbar={state.canManage ? (
        <ConsoleToolbar
          filters={
            <>
              <label>
                <span className="sr-only" id="program-search-label">프로그램 검색</span>
                <input
                  aria-labelledby="program-search-label"
                  type="search"
                  placeholder="프로그램 이름·유형 검색"
                  value={programQuery}
                  onChange={(event) => setProgramQuery(event.target.value)}
                />
              </label>
              <label>
                <span className="sr-only" id="program-status-label">진행 상태별 보기</span>
                <select aria-labelledby="program-status-label" value={programStatusFilter} onChange={(event) => setProgramStatusFilter(event.target.value)}>
                  <option value="">전체 상태</option>
                  <option value="DRAFT">준비 중</option>
                  <option value="OPEN">진행 중</option>
                  <option value="CLOSED">종료</option>
                </select>
              </label>
            </>
          }
          actions={
            <>
              <button type="button" className="button button-primary" onClick={openCreate} disabled={writeLocked}>
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
            </>
          }
        />
      ) : undefined}
      feedback={
        <>
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {!state.canManage ? (
            <ConsoleFeedback kind="error">참여 프로그램을 관리할 운영 권한이 없습니다.</ConsoleFeedback>
          ) : null}
          {state.canManage && state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 프로그램과 응답을 볼 수 있지만 만들거나 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      {state.canManage ? (
        state.modules.length ? (
          <>
          <p className={styles.resultCount} role="status">
            전체 {state.modules.length}개 중 {visibleModules.length}개
            {hasProgramFilter ? (
              <>
                {" "}
                <button type="button" className="button button-secondary" onClick={clearProgramFilters}>
                  검색·필터 지우기
                </button>
              </>
            ) : null}
          </p>
          {visibleModules.length ? (
          <>
          <ul className={styles.moduleList}>
            {visibleModules.slice(0, moduleLimit).map((module) => (
              <ModuleCard
                key={module.id}
                module={module}
                featureOn={state.features.includes(module.type)}
                eventId={eventId}
                busy={busy}
                locked={writeLocked}
                responses={state.responses.filter((response) => response.moduleId === module.id).length}
                moduleResponses={state.responses.filter((response) => response.moduleId === module.id)}
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
                statusPending={statusPending?.id === module.id ? statusPending : null}
                onRequestStatus={(status) => requestStatusChange(module, status)}
                onConfirmStatus={() => {
                  const pending = statusPending;
                  if (pending && pending.id === module.id) void changeStatus(module, pending.status);
                }}
                onCancelStatus={() => setStatusPending(null)}
                revealPending={revealPendingId === module.id}
                onRequestReveal={() => requestQuizReveal(module)}
                onConfirmReveal={() => void revealQuiz(module)}
                onCancelReveal={() => setRevealPendingId(null)}
                drawPending={drawPending?.id === module.id ? drawPending : null}
                onRequestDraw={() => requestDraw(module)}
                onConfirmDraw={() => {
                  const pending = drawPending;
                  if (pending && pending.id === module.id) void runDraw(module, pending.count);
                }}
                onCancelDraw={() => setDrawPending(null)}
                publishPending={publishPendingId === module.id}
                onRequestPublishDraw={() => requestDrawPublish(module)}
                onConfirmPublishDraw={() => void publishDraw(module)}
                onCancelPublishDraw={() => setPublishPendingId(null)}
                photoPending={photoPending}
                onRequestModeratePhoto={(photo, status) => requestPhotoModeration(photo, status)}
                onConfirmModeratePhoto={(photo, status) => void moderatePhoto(photo, status)}
                onCancelModeratePhoto={() => setPhotoPending(null)}
                postPending={postPending}
                onRequestModeratePost={(post, status) => requestPostModeration(post, status)}
                onConfirmModeratePost={(post, status) => void moderatePost(post, status)}
                onCancelModeratePost={() => setPostPending(null)}
                onManageQuestion={(question, approved) => void manageQuestion(question, approved)}
              />
            ))}
          </ul>
          {visibleModules.length > moduleLimit ? (
            <p className={styles.moreRow}>
              <button
                type="button"
                className="button button-secondary"
                onClick={revealMoreModules}
              >
                더 보기 ({visibleModules.length - moduleLimit})
              </button>
            </p>
          ) : null}
          </>
          ) : (
            <div className={styles.empty}>
              <p>조건에 맞는 프로그램이 없습니다.</p>
              <p>검색어·상태 조건을 바꾸거나 지우고 다시 찾아보세요.</p>
              <p>
                <button type="button" className="button button-secondary" onClick={clearProgramFilters}>
                  검색·필터 지우기
                </button>
              </p>
            </div>
          )}
          </>
        ) : (
          <p className={styles.empty}>등록된 프로그램이 없습니다. 위에서 첫 프로그램을 만드세요.</p>
        )
      ) : null}

      {dialogOpen && state.kind === "ready" ? (
        <ModuleDialog
          draft={draft}
          busy={dialogBusy}
          locked={writeLocked}
          typeEnabled={isTypeEnabled(draft.type)}
          settingsHref={settingsHref}
          failure={dialogFailure}
          fieldError={dialogFieldError}
          canClose={confirmDialogClose}
          onChange={setDraft}
          onClose={() => {
            if (!dialogBusy) setDialogOpen(false);
          }}
          onSubmit={saveModule}
        />
      ) : null}
    </ConsolePage>
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
  locked: boolean;
  responses: number;
  moduleResponses: Response[];
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
  statusPending: { id: string; status: "DRAFT" | "OPEN" | "CLOSED" } | null;
  onRequestStatus: (status: "DRAFT" | "OPEN" | "CLOSED") => void;
  onConfirmStatus: () => void;
  onCancelStatus: () => void;
  revealPending: boolean;
  onRequestReveal: () => void;
  onConfirmReveal: () => void;
  onCancelReveal: () => void;
  drawPending: { id: string; count: number } | null;
  onRequestDraw: () => void;
  onConfirmDraw: () => void;
  onCancelDraw: () => void;
  publishPending: boolean;
  onRequestPublishDraw: () => void;
  onConfirmPublishDraw: () => void;
  onCancelPublishDraw: () => void;
  photoPending: { id: string; status: "APPROVED" | "HIDDEN" } | null;
  onRequestModeratePhoto: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onConfirmModeratePhoto: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onCancelModeratePhoto: () => void;
  postPending: { id: string; status: "APPROVED" | "HIDDEN" } | null;
  onRequestModeratePost: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onConfirmModeratePost: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onCancelModeratePost: () => void;
  onManageQuestion: (question: Question, approved: boolean) => void;
}) {
  const { module } = props;
  const lockReason = editLockReason(module, props.responses, props.questions);
  const latestDraw = module.drawHistory[0] ?? null;
  const statusAction = props.statusPending
    ? props.statusPending.status === "OPEN"
      ? "시작"
      : props.statusPending.status === "CLOSED"
        ? "종료"
        : "준비로 되돌리기"
    : null;
  return (
    <li className={styles.moduleCard}>
      <div className={styles.moduleTop}>
        <div className={styles.moduleTitle}>
          <h3 id={`module-title-${module.id}`} tabIndex={-1}>{module.title}</h3>
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
            disabled={lockReason !== null || props.locked || !props.featureOn}
            title={lockReason ?? undefined}
            onClick={props.onEdit}
          >
            편집
          </button>
          {module.status === "DRAFT" ? (
            <button type="button" className="button button-secondary" disabled={props.busy !== null || props.locked || !props.featureOn} onClick={() => props.onRequestStatus("OPEN")}>시작</button>
          ) : null}
          {module.status === "OPEN" ? (
            <button type="button" className="button button-secondary" disabled={props.busy !== null || props.locked || !props.featureOn} onClick={() => props.onRequestStatus("CLOSED")}>종료</button>
          ) : null}
          {module.status === "CLOSED" ? (
            <button type="button" className="button button-secondary" disabled={props.busy !== null || props.locked || !props.featureOn} onClick={() => props.onRequestStatus("OPEN")}>다시 열기</button>
          ) : null}
        </div>
      </div>
      {props.statusPending && statusAction ? (
        <ConsoleConfirm
          summary={`“${module.title}” 프로그램을 ${statusAction}할까요?`}
          confirmLabel={`${statusAction}한다`}
          busy={props.busy !== null}
          onConfirm={props.onConfirmStatus}
          onCancel={props.onCancelStatus}
        />
      ) : null}
      {lockReason ? <p className={styles.lockNote}>{lockReason}</p> : null}
      {module.type === "poll" && module.options.length ? (
        <p className={styles.detail}>선택지: {module.options.join(" · ")}</p>
      ) : null}
      {module.type === "quiz" && module.revealed ? (
        <p className={styles.detail}>공개된 정답: {module.answer || "정답 확인 필요"}</p>
      ) : null}
      {module.type === "quiz" && module.published && !module.revealed && (module.status === "OPEN" || module.status === "CLOSED") ? (
        <>
          <p>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || props.locked || !props.featureOn}
              onClick={props.onRequestReveal}
            >
              {props.busy === `reveal:${module.id}` ? "공개 중…" : "퀴즈 정답 공개"}
            </button>
          </p>
          {props.revealPending ? (
            <ConsoleConfirm
              summary={`“${module.title}” 퀴즈 정답을 공개할까요? 공개하면 프로그램이 종료됩니다.`}
              confirmLabel="공개한다"
              busy={props.busy !== null}
              onConfirm={props.onConfirmReveal}
              onCancel={props.onCancelReveal}
            />
          ) : null}
        </>
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
              disabled={props.busy !== null || props.locked || !props.featureOn || module.status !== "OPEN"}
              onClick={props.onRequestDraw}
            >
              {props.busy === `draw:${module.id}` ? "실행 중…" : "추첨 실행"}
            </button>
            {latestDraw && !latestDraw.published ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={props.busy !== null || props.locked || !props.featureOn}
                onClick={props.onRequestPublishDraw}
              >
                {props.busy === `publish:${module.id}` ? "공개 중…" : "최신 결과 공개"}
              </button>
            ) : null}
          </div>
          {props.drawPending ? (
            <ConsoleConfirm
              summary={`“${module.title}” 추첨을 ${props.drawPending.count}명으로 실행할까요? 이미 당첨된 참가자는 제외됩니다.`}
              confirmLabel="실행한다"
              busy={props.busy !== null}
              onConfirm={props.onConfirmDraw}
              onCancel={props.onCancelDraw}
            />
          ) : null}
          {props.publishPending ? (
            <ConsoleConfirm
              summary="최신 추첨 결과를 참가자에게 공개할까요?"
              confirmLabel="공개한다"
              busy={props.busy !== null}
              onConfirm={props.onConfirmPublishDraw}
              onCancel={props.onCancelPublishDraw}
            />
          ) : null}
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
          <p className={styles.help}>
            쿼터·등급·업체 대상 추첨과 경품 연동은{" "}
            <Link href={`/console/events/${encodeURIComponent(props.eventId)}/draws`}>추첨</Link> 화면에서 관리합니다.
          </p>
        </div>
      ) : null}
      {module.type === "qa" ? (
        <QuestionList
          questions={props.questions}
          busy={props.busy}
          locked={props.locked}
          featureOn={props.featureOn}
          answerDrafts={props.answerDrafts}
          setAnswerDrafts={props.setAnswerDrafts}
          answerFailure={props.answerFailure}
          onManage={props.onManageQuestion}
        />
      ) : null}
      {module.type === "photo" ? (
        <PhotoList photos={props.photos} busy={props.busy} locked={props.locked} featureOn={props.featureOn} eventId={props.eventId} pending={props.photoPending} onRequestModerate={props.onRequestModeratePhoto} onConfirmModerate={props.onConfirmModeratePhoto} onCancelModerate={props.onCancelModeratePhoto} />
      ) : null}
      {module.type === "board" ? (
        <PostList posts={props.posts} busy={props.busy} locked={props.locked} featureOn={props.featureOn} pending={props.postPending} onRequestModerate={props.onRequestModeratePost} onConfirmModerate={props.onConfirmModeratePost} onCancelModerate={props.onCancelModeratePost} />
      ) : null}
      <ResultDisclosure
        module={module}
        moduleResponses={props.moduleResponses}
        questions={props.questions}
        photos={props.photos}
        posts={props.posts}
      />
    </li>
  );
}

// Aggregate-only result summary over the already-loaded workspace data: no new
// API, no new permission, no per-person rows. Option tallies (poll), free-text
// answer distribution plus 정답/오답/미채점 grading against the stored answer
// (quiz), per-question count + average reusing the reports snapshot math
// (survey),
// answered/unanswered counts (qa), and approved/pending counts (photo/board).
// Stamp has no dedicated store in this workspace, so it reports the response
// total like the default branch. Default collapsed; 진행/편집/잠금 rules live
// elsewhere and are untouched.
function ResultDisclosure(props: {
  module: Module;
  moduleResponses: Response[];
  questions: Question[];
  photos: Photo[];
  posts: Post[];
}) {
  const { module } = props;
  if (module.type === "draw") return null;
  return (
    <details className={styles.resultDisclosure}>
      <summary>결과 보기</summary>
      {module.type === "poll" ? (
        <ul className={styles.resultList}>
          {module.options.length ? (
            module.options.map((option) => (
              <li key={option}>
                {option} · {props.moduleResponses.filter((response) => response.answer === option).length}건
              </li>
            ))
          ) : (
            <li>선택지가 없습니다.</li>
          )}
          <li>전체 응답 {props.moduleResponses.length}건</li>
        </ul>
      ) : null}
      {module.type === "quiz" ? (
        <>
          <p className={styles.detail}>{quizGradeSummary(module.answer, props.moduleResponses.map((response) => response.answer))}</p>
          <p className={styles.detail}>채점은 앞뒤 공백을 제외한 완전 일치 기준입니다. 비슷한 표기는 정답으로 보지 않습니다.</p>
          <ul className={styles.resultList}>
            {quizAnswerGroups(props.moduleResponses.map((response) => response.answer)).map((group) => (
              <li key={group.label}>
                {group.label} · {group.count}건
              </li>
            ))}
            <li>전체 응답 {props.moduleResponses.length}건</li>
          </ul>
        </>
      ) : null}
      {module.type === "survey" ? (
        <ul className={styles.resultList}>
          {(module.questions.length ? module.questions : ["전반적인 만족도", "프로그램 구성", "현장 운영", "행사장 편의성", "재참석 의향"]).map((name) => {
            const ratings = props.moduleResponses
              .map((response) => response.ratings[name])
              .map(Number)
              .filter((value) => Number.isFinite(value));
            const average = averageLabel(ratings);
            return (
              <li key={name}>
                {name} · 응답 {ratings.length}건 · 평균 {average === null ? "응답 없음" : `${average} / 5`}
              </li>
            );
          })}
          <li>전체 응답 {props.moduleResponses.length}건</li>
        </ul>
      ) : null}
      {module.type === "qa" ? (
        <p className={styles.detail}>
          답변 {props.questions.filter((question) => question.answer.trim()).length}건 · 미답변 {props.questions.filter((question) => !question.answer.trim()).length}건
        </p>
      ) : null}
      {module.type === "photo" ? (
        <p className={styles.detail}>
          승인 {props.photos.filter((photo) => photo.status === "APPROVED").length}건 · 대기 {props.photos.filter((photo) => photo.status === "PENDING").length}건
        </p>
      ) : null}
      {module.type === "board" ? (
        <p className={styles.detail}>
          승인 {props.posts.filter((post) => post.status === "APPROVED").length}건 · 대기 {props.posts.filter((post) => post.status === "PENDING").length}건
        </p>
      ) : null}
      {module.type === "stamp" || (module.type !== "poll" && module.type !== "quiz" && module.type !== "survey" && module.type !== "qa" && module.type !== "photo" && module.type !== "board") ? (
        <p className={styles.detail}>응답 {props.moduleResponses.length}건</p>
      ) : null}
    </details>
  );
}

function QuestionList(props: {
  questions: Question[];
  busy: string | null;
  locked: boolean;
  featureOn: boolean;
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
                disabled={props.busy !== null || props.locked || !props.featureOn}
                onClick={() => props.onManage(question, question.approved)}
              >
                {question.approved ? "답변 저장·공개 유지" : "답변 저장"}
              </button>
              {question.approved ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={props.busy !== null || props.locked || !props.featureOn}
                  onClick={() => props.onManage(question, false)}
                >
                  공개 취소
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={props.busy !== null || props.locked || !props.featureOn}
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
  locked: boolean;
  featureOn: boolean;
  eventId: string;
  pending: { id: string; status: "APPROVED" | "HIDDEN" } | null;
  onRequestModerate: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onConfirmModerate: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onCancelModerate: () => void;
}) {
  const approvedPhotos = props.photos.filter((photo) => photo.status === "APPROVED" && photo.fileId);
  if (!props.photos.length) return <p className={styles.help}>공유된 사진이 없습니다.</p>;
  return (
    <>
      <div className={styles.photoArchiveTools}>
        <p className={styles.help}>승인된 참가자 사진만 ZIP에 담습니다. 검토 대기·반려 사진은 제외되며, 1,000장·512MB를 넘으면 개별 원본을 저장하세요.</p>
        {approvedPhotos.length ? (
          <a
            className="button button-secondary"
            href={`/api/events/${encodeURIComponent(props.eventId)}/attendee-photos.zip`}
          >
            승인 사진 ZIP 다운로드 ({approvedPhotos.length}장)
          </a>
        ) : (
          <span className={styles.itemMeta}>다운로드할 승인 사진이 없습니다.</span>
        )}
      </div>
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
              {photo.status === "APPROVED" && photo.fileId ? (
                <a
                  className="button button-secondary"
                  href={`/api/events/${encodeURIComponent(props.eventId)}/files/${encodeURIComponent(photo.fileId)}`}
                  download={photo.fileName || "photo"}
                >
                  원본 저장
                </a>
              ) : null}
              <button
                type="button"
                className="button button-secondary"
                disabled={props.busy !== null || props.locked || !props.featureOn || photo.status === "APPROVED"}
                onClick={() => props.onRequestModerate(photo, "APPROVED")}
              >
                승인
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={props.busy !== null || props.locked || !props.featureOn || photo.status === "HIDDEN"}
                onClick={() => props.onRequestModerate(photo, "HIDDEN")}
              >
                반려
              </button>
            </div>
            {props.pending?.id === photo.id ? (
              <ConsoleConfirm
                summary={`이 사진을 ${props.pending.status === "APPROVED" ? "승인" : "반려"}할까요?`}
                confirmLabel={`${props.pending.status === "APPROVED" ? "승인" : "반려"}한다`}
                busy={props.busy !== null}
                onConfirm={() => props.onConfirmModerate(photo, props.pending?.status ?? "APPROVED")}
                onCancel={props.onCancelModerate}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function PostList(props: {
  posts: Post[];
  busy: string | null;
  locked: boolean;
  featureOn: boolean;
  pending: { id: string; status: "APPROVED" | "HIDDEN" } | null;
  onRequestModerate: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onConfirmModerate: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onCancelModerate: () => void;
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
              disabled={props.busy !== null || props.locked || !props.featureOn || post.status === "APPROVED"}
              onClick={() => props.onRequestModerate(post, "APPROVED")}
            >
              승인
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy !== null || props.locked || !props.featureOn || post.status === "HIDDEN"}
              onClick={() => props.onRequestModerate(post, "HIDDEN")}
            >
              반려
            </button>
          </div>
          {props.pending?.id === post.id ? (
            <ConsoleConfirm
              summary={`이 게시글을 ${props.pending.status === "APPROVED" ? "승인" : "반려"}할까요?`}
              confirmLabel={`${props.pending.status === "APPROVED" ? "승인" : "반려"}한다`}
              busy={props.busy !== null}
              onConfirm={() => props.onConfirmModerate(post, props.pending?.status ?? "APPROVED")}
              onCancel={props.onCancelModerate}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ModuleDialog(props: {
  draft: ModuleDraft;
  busy: boolean;
  locked: boolean;
  typeEnabled: boolean;
  settingsHref: string;
  failure: Failure | null;
  fieldError: { field: string; message: string } | null;
  canClose: () => boolean;
  onChange: (draft: ModuleDraft) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const { draft, busy, locked, typeEnabled, settingsHref, failure, fieldError, canClose, onChange, onClose, onSubmit } = props;
  const titleInputRef = useRef<HTMLInputElement>(null);
  function fieldMessage(field: string): string | null {
    return fieldError?.field === field ? fieldError.message : null;
  }
  return (
    <ConsoleDialog
      title={draft.id ? "프로그램 편집" : "프로그램 만들기"}
      titleId="program-dialog-title"
      onClose={onClose}
      busy={busy}
      canClose={canClose}
      initialFocusRef={titleInputRef}
    >
      <form className={styles.form} onSubmit={onSubmit}>
        <div>
          <label htmlFor="program-title">제목</label>
          <input
            id="program-title"
            ref={titleInputRef}
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
          {!typeEnabled ? (
            <p className={styles.fieldError} role="note">
              이 유형은 꺼져 있습니다. <Link href={settingsHref}>행사 설정</Link>에서 기능을 먼저 켜세요.
            </p>
          ) : null}
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
        <ConsoleFormActions>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => { if (!busy && canClose()) onClose(); }}
          >
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={busy || locked || !typeEnabled}>
            {busy ? "저장 중…" : draft.id ? "저장" : "만들기"}
          </button>
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}
