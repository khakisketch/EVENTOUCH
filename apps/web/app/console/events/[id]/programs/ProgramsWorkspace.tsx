"use client";

import { revealDetailsFor } from "../../../../ui/reveal-details";
import ProductButton from "../../../../ui/ProductButton";
import ValidatedForm from "../../../../ui/ValidatedForm";

import { useEffect, useRef, useState, type ReactNode } from "react";
import ProductLink from "../../../../ui/ProductLink";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleRefreshButton from "../../../console-ui/ConsoleRefreshButton";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { PARTICIPATION_TYPES, participationTypeLabel, readParticipationHandoff, type ParticipationReview } from "../../../../../lib/participation-work";
import { drawEventsSnapshot, eventPill, lifecycleSegments, lifecycleSteps, type DrawEvent, type DrawEventsSnapshot, type EventFacts } from "../../../../../lib/participation-events";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsModuleSave, confirmsProgramOperation, confirmsQuestionManagement, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import styles from "./programs.module.css";
import ProgramTypeIcon from "./ProgramIcons";
import ReviewDrawer, { questionNeedsReview, type ReviewTab } from "./ReviewDrawer";
import CountTabs from "../../../console-ui/CountTabs";
import ConsoleEmptyState from "../../../console-ui/ConsoleEmptyState";
import StatusPill from "../../../console-ui/StatusPill";
import TemplateChooser, { TemplateGroups } from "./TemplateChooser";
import DrawEventRow from "./DrawEventRow";
import { EventStepper, LifecycleMeter, eventPillTone } from "./EventLifecycle";
import QuizGrading, { type GradePayload, type GradeResult } from "./QuizGrading";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";
import { readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";

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

export type Module = {
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

type Response = { id: string; moduleId: string; answer: string; ratings: Record<string, unknown>; manualGrade?: "CORRECT" | "INCORRECT" | null; gradeVersion?: number };
export type Question = {
  id: string;
  moduleId: string;
  name: string;
  text: string;
  answer: string;
  approved: boolean;
  likes: number;
  pendingEdit: { id: string; text: string } | null;
};
type QuestionEditApproval = { id: string; expectedEditId: string; expectedText: string; expectedAnswer: string; expectedNewText: string };
type QuestionEditRejection = QuestionEditApproval & { reason: string };
type QuestionBaseline = { text: string; answer: string; approved: boolean };
type QuestionManageAttempt = { eventId: string; payload: { id: string; answer: string; approved: boolean; expectedText: string; expectedQuestion: QuestionBaseline }; commandId: string; wasApproved: boolean };
type QuestionConflict = { id: string; baseline: QuestionBaseline; mine: string; latest: QuestionBaseline | null; loading: boolean; error: string | null };
function questionBaseline(question: Question): QuestionBaseline {
  return { text: question.text, answer: question.answer, approved: question.approved };
}
type ModuleSaveAttempt = { eventId: string; payload: Record<string, unknown>; commandId: string; wasCreate: boolean };
type ProgramOperationAttempt = { eventId: string; command: string; payload: Record<string, unknown>; commandId: string };
const PROGRAM_OPERATION_LABELS: Record<string, string> = {
  "module.status": "콘텐츠 상태 변경", "module.reveal": "퀴즈 정답 공개", "draw.run": "간단 추첨",
  "draw.publish": "추첨 결과 공개", "photo.moderate": "참여 사진 검토", "post.moderate": "게시글 검토",
};
export type Photo = { id: string; caption: string; status: string; at: string; name: string; fileId: string; fileName: string };
export type Post = { id: string; body: string; status: string; at: string; name: string };

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      closeSnapshot: CloseSnapshot;
      eventName: string;
      eventId: string;
      eventMeta?: string;
      archived: boolean;
      features: string[];
      canManage: boolean;
      canWritePrograms: boolean;
      modules: Module[];
      responses: Response[];
      questions: Question[];
      photos: Photo[];
      posts: Post[];
      drawEvents: DrawEventsSnapshot;
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

const MODULE_TYPES = PARTICIPATION_TYPES;

// Long-list paging: reveal the first page only, then grow incrementally.
// Plain slicing only; creation/edit/status affordances stay above the
// fold and the existing empty states are untouched.
const MODULE_PAGE_SIZE = 12;
// Nested moderation lists stay bounded the same way: first page only,
// then grow on demand. Drafts are keyed by id so paging/filtering never
// drops them.
const MODERATION_PAGE_SIZE = 10;

// Quick-review shortcut target: one backlog class at a time. Q&A keeps its
// two overlapping classes separate (미답변 vs 승인 대기 overlap, so no
// summed total is ever shown).
type ReviewTarget = ParticipationReview;

// __NEXT_VISIBLE_MODERATION_ID_BEGIN__
// Next visible moderation target within one rendered list, in DOM order:
// the row after the processed one, else null so the caller always falls
// back to #moderation-status. Pure order math over the visible row ids —
// never the global store, never a hidden filtered row.
export function nextVisibleModerationId(visibleIds: string[], currentId: string): string | null {
  const at = visibleIds.indexOf(currentId);
  if (at === -1) return visibleIds.length ? visibleIds[0] : null;
  return at + 1 < visibleIds.length ? visibleIds[at + 1] : null;
}
// __NEXT_VISIBLE_MODERATION_ID_END__

// Visible row ids of the single rendered list that contains the processed
// row, in DOM order. Scoped to the row's own <ul> so a next target can never
// come from another module or a filtered-out page.
function visibleModerationRowIds(kind: "question" | "photo" | "post", currentId: string, scope: "list" | "drawer" = "list"): string[] {
  if (typeof document === "undefined") return [];
  const prefix = scope === "drawer" ? `review-${kind}-` : `moderation-${kind}-`;
  const current = document.getElementById(`${prefix}${currentId}`);
  const list = current?.closest("ul");
  if (!list) return [];
  const ids: string[] = [];
  list.querySelectorAll(`li[id^="${prefix}"]`).forEach((row) => {
    const id = row.id.slice(prefix.length);
    if (id) ids.push(id);
  });
  return ids;
}

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
function quizGradeCounts(correctAnswer: string, answers: string[], manualGrades: Array<string | null | undefined> = []): { right: number; wrong: number } {
  const correct = correctAnswer.trim();
  let right = 0, wrong = 0;
  for (const [index, answer] of answers.entries()) {
    if (manualGrades[index] === "CORRECT") right += 1;
    else if (manualGrades[index] === "INCORRECT") wrong += 1;
    else if (correct && answer.trim()) {
      if (answer.trim() === correct) right += 1;
      else wrong += 1;
    }
  }
  return { right, wrong };
}

function quizGradeSummary(correctAnswer: string, answers: string[], manualGrades: Array<string | null | undefined> = []): string {
  const { right, wrong } = quizGradeCounts(correctAnswer, answers, manualGrades);
  return `정답 ${right} · 오답 ${wrong} · 미채점 ${answers.length - right - wrong}`;
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
  return participationTypeLabel(type);
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
  code: string | null;
  statusCode: number | null;

  constructor(failure: Failure & { code?: string | null; statusCode?: number | null }) {
    super(failure.message);
    this.field = failure.field;
    this.code = failure.code ?? null;
    this.statusCode = failure.statusCode ?? null;
  }
}

export default function ProgramsWorkspace({ eventId, afterHeader }: { eventId: string; afterHeader?: ReactNode }) {
  const closeHref = useEventCloseHandoff(eventId);
  const router = useRouter();
  const pendingCommandsRef = useRef(new Map<string, string>());
  const sendingRef = useRef(false);
  const [gradeRetry, setGradeRetry] = useState<GradePayload | null>(null);
  const gradeRetryRef = useRef<GradePayload | null>(null);
  // Tracks a dialog save whose outcome is still unknown (ambiguous failure
  // kept its idempotent key). Dismissal must warn that it may already have
  // applied instead of claiming a cancel.
  const dialogUnresolvedRef = useRef(false);
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [draft, setDraft] = useState<ModuleDraft>(EMPTY_DRAFT);
  const [dialogFailure, setDialogFailure] = useState<Failure | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogFieldError, setDialogFieldError] = useState<{ field: string; message: string } | null>(null);
  const [drawCounts, setDrawCounts] = useState<Record<string, string>>({});
  const [drawFailure, setDrawFailure] = useState<{ id: string; message: string; field: string | null } | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answerBaselines, setAnswerBaselines] = useState<Record<string, QuestionBaseline>>({});
  const [questionConflict, setQuestionConflict] = useState<QuestionConflict | null>(null);
  const questionConflictReadRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    questionConflictReadRef.current?.abort();
    questionConflictReadRef.current = null;
  }, [eventId]);
  const [answerFailure, setAnswerFailure] = useState<{ id: string; message: string; field: string | null; statusCode?: number | null } | null>(null);
  const moduleSaveRetryRef = useRef<ModuleSaveAttempt | null>(null);
  const [moduleSaveRetry, setModuleSaveRetry] = useState<ModuleSaveAttempt | null>(null);
  const [checkingModuleSave, setCheckingModuleSave] = useState(false);
  const [abandonModuleConfirm, setAbandonModuleConfirm] = useState(false);
  const questionManageRetryRef = useRef<QuestionManageAttempt | null>(null);
  const activeQuestionEventRef = useRef(eventId);
  activeQuestionEventRef.current = eventId;
  const [questionManageRetry, setQuestionManageRetry] = useState<QuestionManageAttempt | null>(null);
  const [checkingQuestion, setCheckingQuestion] = useState(false);
  const [abandonQuestionConfirm, setAbandonQuestionConfirm] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<ProgramOperationAttempt | null>(null);
  const pendingOperationRef = useRef<ProgramOperationAttempt | null>(null);
  const [checkingOperation, setCheckingOperation] = useState(false);
  const [refreshingOperation, setRefreshingOperation] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [abandonOperation, setAbandonOperation] = useState(false);
  const operationFocusOriginRef = useRef<Element | null>(null);
  const activeProgramEventRef = useRef(eventId);
  const loadedProgramEventRef = useRef<string | null>(null);
  const hadOtherOperationRef = useRef(false);
  activeProgramEventRef.current = eventId;
  const operatorContext = useOperatorContextSnapshot();
  const eventReceipts = useEventReceipts(eventId);
  const otherOperationReceipt = eventReceipts.some((item) => Object.hasOwn(PROGRAM_OPERATION_LABELS, item.command) &&
    item.commandId !== pendingOperation?.commandId && ![...pendingCommandsRef.current.values()].includes(item.commandId));
  useEffect(() => pendingOperation && state.kind === "ready" ? manageOperatorReceipt(pendingOperation.commandId) : undefined, [pendingOperation, state.kind]);
  useEffect(() => {
    if (!pendingOperation) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== operationFocusOriginRef.current && active.isConnected) return;
      const heading = document.getElementById("program-operation-recovery-heading");
      heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }); heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingOperation?.commandId]);
  const otherQuestionReceipt = eventReceipts.some((item) => item.command === "question.manage" && item.commandId !== questionManageRetryRef.current?.commandId);
  const otherModuleReceipt = eventReceipts.some((item) => item.command === "module.save" && item.commandId !== moduleSaveRetryRef.current?.commandId);
  useEffect(() => {
    if (!moduleSaveRetry || moduleSaveRetry.eventId !== eventId) return;
    return manageOperatorReceipt(moduleSaveRetry.commandId);
  }, [eventId, moduleSaveRetry]);
  useEffect(() => {
    if (!questionManageRetry || questionManageRetry.eventId !== eventId) return;
    return manageOperatorReceipt(questionManageRetry.commandId);
  }, [eventId, questionManageRetry]);
  useEffect(() => {
    const held = questionManageRetryRef.current;
    if (held && held.eventId !== eventId) {
      pendingCommandsRef.current.delete(JSON.stringify([held.eventId, "question.manage", held.payload]));
      questionManageRetryRef.current = null;
      setQuestionManageRetry(null);
      setAbandonQuestionConfirm(false);
    }
    const moduleHeld = moduleSaveRetryRef.current;
    if (moduleHeld && moduleHeld.eventId !== eventId) {
      pendingCommandsRef.current.delete(JSON.stringify([moduleHeld.eventId, "module.save", moduleHeld.payload]));
      moduleSaveRetryRef.current = null;
      setModuleSaveRetry(null);
      setAbandonModuleConfirm(false);
      dialogUnresolvedRef.current = false;
    }
  }, [eventId]);
  const questionEditRetryRef = useRef<QuestionEditApproval | null>(null);
  const [questionEditRetry, setQuestionEditRetry] = useState<QuestionEditApproval | null>(null);
  const questionRejectRetryRef = useRef<QuestionEditRejection | null>(null);
  const [questionRejectRetry, setQuestionRejectRetry] = useState<QuestionEditRejection | null>(null);
  const [checkingQuestionEdit, setCheckingQuestionEdit] = useState(false);
  const approvalId = questionEditRetry ? pendingCommandsRef.current.get(JSON.stringify([eventId, "question.edit.approve", questionEditRetry])) : null;
  const rejectionId = questionRejectRetry ? pendingCommandsRef.current.get(JSON.stringify([eventId, "question.edit.reject", questionRejectRetry])) : null;
  const otherEditReceipt = eventReceipts.some((item) => ["question.edit.approve", "question.edit.reject"].includes(item.command) && item.commandId !== approvalId && item.commandId !== rejectionId);
  useEffect(() => {
    const ids = [approvalId, rejectionId].filter((id): id is string => Boolean(id));
    const releases = ids.map(manageOperatorReceipt);
    return () => { releases.forEach((release) => release()); };
  }, [approvalId, rejectionId]);
  const editEventRef = useRef(eventId);
  useEffect(() => {
    const previousEvent = editEventRef.current;
    if (previousEvent !== eventId) {
      if (questionEditRetryRef.current) pendingCommandsRef.current.delete(JSON.stringify([previousEvent, "question.edit.approve", questionEditRetryRef.current]));
      if (questionRejectRetryRef.current) pendingCommandsRef.current.delete(JSON.stringify([previousEvent, "question.edit.reject", questionRejectRetryRef.current]));
      questionEditRetryRef.current = null; setQuestionEditRetry(null);
      questionRejectRetryRef.current = null; setQuestionRejectRetry(null);
      setCheckingQuestionEdit(false);
      gradeRetryRef.current = null; setGradeRetry(null);
      pendingCommandsRef.current.clear();
      setDialogOpen(false); setDraft(EMPTY_DRAFT);
      setAnswerDrafts({}); setAnswerBaselines({}); setQuestionConflict(null); setRejectDrafts({});
      setStatusPending(null); setRevealPendingId(null); setDrawPending(null); setPublishPending(null);
      setPhotoPending(null); setPostPending(null);
      setBusy(null); setFailure(null); setNotice(null); setDrawFailure(null);
      pendingOperationRef.current = null; setPendingOperation(null); setCheckingOperation(false);
      setRefreshingOperation(false); setOperationError(null); setAbandonOperation(false);
      hadOtherOperationRef.current = false; loadedProgramEventRef.current = null;
      editEventRef.current = eventId;
    }
  }, [eventId]);
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});
  const [rejectFailure, setRejectFailure] = useState<{ id: string; editId: string; message: string; field: string | null } | null>(null);
  // In-place confirmations for irreversible/outward-facing commands. One open
  // at a time: each holds only its target (draw also snapshots the count at
  // trigger time). Dialog dismissal gates stay on window.confirm via
  // confirmDialogClose and are unrelated to these.
  const [statusPending, setStatusPending] = useState<{ id: string; status: "DRAFT" | "OPEN" | "CLOSED" } | null>(null);
  const [revealPendingId, setRevealPendingId] = useState<string | null>(null);
  const [drawPending, setDrawPending] = useState<{ id: string; count: number } | null>(null);
  const [publishPending, setPublishPending] = useState<{ moduleId: string; draw: DrawResult } | null>(null);
  const [photoPending, setPhotoPending] = useState<{ id: string; status: "APPROVED" | "HIDDEN" } | null>(null);
  const [postPending, setPostPending] = useState<{ id: string; status: "APPROVED" | "HIDDEN" } | null>(null);
  const [moduleLimit, setModuleLimit] = useState(MODULE_PAGE_SIZE);
  // Client-side list filters only (경품·고객사 목록과 같은 문법): the server
  // contract is untouched, filtering reads the already-loaded modules.
  const [programQuery, setProgramQuery] = useState("");
  const [programStatusFilter, setProgramStatusFilter] = useState("");
  // Nested moderation filters live here (not in the lists) so a quick-review
  // shortcut can set them explicitly in the same batch as clearing the
  // program-level search. Drafts (module dialog, Q&A answers) are untouched
  // by every filter change below.
  const handoffAppliedRef = useRef<string | null>(null);
  const handoffFocusRef = useRef<string | null>(null);
  const [reviewFocusRequest, setReviewFocusRequest] = useState<{ kind: "question" | "photo" | "post"; moduleId: string | null } | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [handoffReturn, setHandoffReturn] = useState<{ moduleId: string | null; label: string; href: string } | null>(null);
  const [qaFilter, setQaFilter] = useState<"all" | "unanswered" | "pending" | "edits">("all");
  const [photoFilter, setPhotoFilter] = useState<"all" | "PENDING" | "APPROVED" | "HIDDEN">("PENDING");
  const [postFilter, setPostFilter] = useState<"all" | "PENDING" | "APPROVED" | "HIDDEN">("PENDING");
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
  // After a successful moderation, focus lands on the next visible row of
  // the same rendered list (same module, same filter page), else the
  // moderation status line. Row containers carry tabIndex -1 so keyboard
  // operators stay in flow. The request is scheduled only after a confirmed
  // success, never before the write and never on failure, so a pending
  // request can never steal focus later.
  const moderationFocusRef = useRef<{ kind: "question" | "photo" | "post"; id: string | null; scope: "list" | "drawer" } | null>(null);
  // The review drawer is modal, so an action taken while it is open always
  // came from it; follow-through focus then stays inside the drawer.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<ReviewTab>("all");
  const drawerOpenRef = useRef(false);
  drawerOpenRef.current = drawerOpen;

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 읽기·내보내기만 둡니다. programs 스코프가 없는 멤버십([] 등)은
  // 같은 읽기 전용 취급이며, 역할·멤버십 존재 게이트는 그대로 둡니다.
  const writeLocked = state.kind === "ready" && (state.archived || !state.canWritePrograms || Boolean(pendingOperation || otherOperationReceipt || refreshingOperation || (hadOtherOperationRef.current && !otherOperationReceipt)));

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

  // Quick-review shortcut: one batch that clears the obstructing
  // program-level search/status, reveals through the relevant module, applies the
  // matching nested filter, then lands keyboard focus on the first visible
  // row of that class. Input drafts are never touched here.
  function runReviewShortcut(target: ReviewTarget) {
    if (state.kind !== "ready") return;
    setProgramQuery("");
    setProgramStatusFilter("");
    setDrawerTab(target === "photo" ? "photo" : target === "post" ? "post" : "question");
    setDrawerOpen(true);
    const targetModuleIds = new Set(state.questions.filter((question) =>
      target === "qa-unanswered" ? !question.answer.trim() : target === "qa-edits" ? Boolean(question.pendingEdit) : !question.approved
    ).map((question) => question.moduleId));
    const targetIndex = state.modules.findIndex((module) =>
      target === "photo" ? module.type === "photo" : target === "post" ? module.type === "board" : targetModuleIds.has(module.id)
    );
    setModuleLimit(Number.MAX_SAFE_INTEGER);
    if (target === "qa-unanswered") setQaFilter("unanswered");
    else if (target === "qa-pending") setQaFilter("pending");
    else if (target === "qa-edits") setQaFilter("edits");
    else if (target === "photo") setPhotoFilter("PENDING");
    else setPostFilter("PENDING");
    const kind = target === "photo" ? "photo" : target === "post" ? "post" : "question";
    setReviewFocusRequest({ kind, moduleId: targetIndex >= 0 ? state.modules[targetIndex].id : null });
    return targetIndex >= 0 ? state.modules[targetIndex].id : null;
  }

  function onAnswerChange(question: Question, value: string) {
    setAnswerBaselines((current) => current[question.id] ? current : { ...current, [question.id]: questionBaseline(question) });
    setAnswerDrafts((current) => ({ ...current, [question.id]: value }));
  }

  // Recovery banners (unknown outcomes, conflicts) live on the page, behind
  // the drawer's scrim: close the drawer so they are visible and actionable.
  const recoveryActive = Boolean(questionConflict || questionManageRetry || questionEditRetry || questionRejectRetry || pendingOperation || moduleSaveRetry);
  useEffect(() => { if (recoveryActive) setDrawerOpen(false); }, [recoveryActive]);

  // 수정안 확인: the drawer hands a pending question edit to the content's own
  // list, where approve/reject and the conflict recovery already live.
  function openQuestionEdit(question: Question) {
    setDrawerOpen(false);
    setQaFilter("edits");
    setModuleLimit(Number.MAX_SAFE_INTEGER);
    setReviewFocusRequest({ kind: "question", moduleId: question.moduleId || null });
  }

  useEffect(() => {
    if (!reviewFocusRequest || state.kind !== "ready" || state.eventId !== eventId) return;
    // A shortcut that opened the drawer lands on its first matching item;
    // otherwise (수정안 확인) it lands on the row inside the content's list.
    const drawerRow = drawerOpenRef.current
      ? document.querySelector<HTMLElement>(`li[id^="review-${reviewFocusRequest.kind}-"]`)
      : null;
    const scope = reviewFocusRequest.moduleId
      ? document.getElementById(`module-title-${reviewFocusRequest.moduleId}`)?.closest("li")
      : null;
    const row = drawerRow ?? scope?.querySelector<HTMLElement>(`li[id^="moderation-${reviewFocusRequest.kind}-"]`);
    const target = row ?? document.getElementById(drawerOpenRef.current ? "review-drawer-status" : "moderation-status");
    if (target) {
      revealDetailsFor(target);
      target.scrollIntoView({ block: "nearest" });
      // The drawer shell focuses its own first control as it mounts; landing
      // on the first matching item waits one frame so that never wins.
      if (drawerRow) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
      else target.focus({ preventScroll: true });
    }
    setReviewFocusRequest(null);
  }, [reviewFocusRequest, state, moduleLimit, eventId]);

  useEffect(() => {
    if (state.kind !== "ready" || state.eventId !== eventId || !state.canManage || handoffAppliedRef.current === eventId) return;
    const url = new URL(window.location.href);
    const handoff = readParticipationHandoff(url.searchParams);
    if (!handoff) return;
    handoffAppliedRef.current = eventId;
    const fromOverview = url.searchParams.get("from") === "overview";
    const returnTo = { label: fromOverview ? "운영 현황으로" : "참여 진행으로", href: fromOverview ? `/console/events/${encodeURIComponent(eventId)}` : `/console/events/${encodeURIComponent(eventId)}/operations#ops-participation` };
    ["review", "module", "status", "from"].forEach(key => url.searchParams.delete(key));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (handoff.kind === "invalid") {
      setHandoffNotice("요청한 작업을 확인하지 못했습니다. 목록에서 콘텐츠나 검토 항목을 선택하세요.");
      return;
    }
    if (handoff.kind === "review") {
      const moduleId = runReviewShortcut(handoff.target) ?? null;
      setHandoffReturn({ ...returnTo, moduleId });
      setHandoffNotice(moduleId ? "선택한 참여 응답으로 이동했습니다. 확인 후 원래 업무 화면으로 돌아갈 수 있습니다." : "이 검토 조건에 맞는 항목이 없습니다. 최신 목록에서 확인할 항목을 선택하세요.");
    } else if (handoff.kind === "module") {
      const at = state.modules.findIndex(module => module.id === handoff.id);
      if (at < 0) { setHandoffNotice("요청한 참여 콘텐츠를 찾을 수 없습니다. 최신 목록에서 다시 선택하세요."); return; }
      setProgramQuery(""); setProgramStatusFilter("");
      setModuleLimit(Number.MAX_SAFE_INTEGER);
      handoffFocusRef.current = handoff.id;
      setHandoffReturn({ ...returnTo, moduleId: handoff.id });
      setHandoffNotice("선택한 콘텐츠의 진행·응답 관리를 열었습니다.");
    } else {
      setProgramQuery(""); setProgramStatusFilter(handoff.status);
      setHandoffReturn({ ...returnTo, moduleId: null });
      setHandoffNotice("선택한 진행 상태의 콘텐츠를 표시했습니다.");
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="진행 상태별 보기"] button[aria-pressed="true"]')?.focus());
    }
    // The accepted event snapshot owns this one-time navigation intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, eventId]);

  useEffect(() => {
    const id = handoffFocusRef.current;
    if (!id || state.kind !== "ready" || state.eventId !== eventId) return;
    const heading = document.getElementById(`module-title-${id}`);
    const summary = heading?.closest("li")?.querySelector<HTMLElement>(":scope > details > summary");
    if (!summary) return;
    handoffFocusRef.current = null;
    revealDetailsFor(summary);
    summary.scrollIntoView({ block: "nearest" });
    summary.focus({ preventScroll: true });
  }, [state, moduleLimit, eventId, handoffReturn]);

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
    return value !== (answerBaselines[id]?.answer ?? question?.answer ?? "");
  });
  const pendingRetry = pendingCommandsRef.current.size > 0;
  const rejectDirty = state.kind === "ready" && Object.entries(rejectDrafts).some(([editId, value]) =>
    value.trim() !== "" && state.questions.some((question) => question.pendingEdit?.id === editId));
  useConsoleDraftGuard(dialogDirty || answerDirty || rejectDirty || pendingRetry || questionConflict !== null, "작성 중인 콘텐츠 내용이 있습니다.");

  async function load(silent = false) {
    const requestEventId = eventId;
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
      ]);
      if (activeProgramEventRef.current !== requestEventId) return false;
      if (meRes.status === 401 || bootRes.status === 401) {
        if (silent && pendingOperationRef.current) { setOperationError("최신 콘텐츠를 불러오지 못했습니다. 현재 계정과 행사 권한을 확인하세요."); return false; }
        router.push(loginHrefForLocation(window.location.pathname, window.location.search));
        return false;
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
      if (activeProgramEventRef.current !== requestEventId) return false;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        if (silent && pendingOperationRef.current) { setOperationError("최신 콘텐츠를 불러오지 못했습니다. 잠시 후 다시 확인하세요."); return false; }
        setState({ kind: "failed", message: "참여 콘텐츠 정보를 불러오지 못했습니다." });
        return false;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      // Retain the raw membership grant: omitted write means full access,
      // [] means read-only. Never default a missing grant to [] here; the
      // capability helper owns that distinction.
      const memberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            const membership = asRecord(item);
            if (!membership || typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
          })
        : [];
      const canManage =
        role === "AGENCY" ||
        (role === "MANAGER" &&
          memberships.some((membership) => membership.accountId === myId && membership.eventId === eventId));
      // Programs-scoped write gate (server/event-permissions.js authority).
      // Unknown membership shapes are accepted by the helper; a thrown
      // helper never blocks reads.
      let canWritePrograms = canManage;
      try {
        canWritePrograms = canWriteEvent({ role, userId: myId, memberships, eventId }, "module.save");
      } catch {
        canWritePrograms = canManage;
      }
      const event = Array.isArray(bootstrap.events)
        ? bootstrap.events.flatMap((item) => {
            const record = asRecord(item);
            return record && record.id === eventId ? [record] : [];
          })[0]
        : undefined;
      const workspace = asRecord(bootstrap.workspaces?.[eventId]);
      if (!event || !workspace) {
        if (silent && pendingOperationRef.current) { setOperationError("최신 콘텐츠를 불러오지 못했습니다. 행사 접근 권한을 확인하세요."); return false; }
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return false;
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
            return [{ id: item.id, moduleId: item.moduleId, answer: text(item.answer), ratings, manualGrade: item.manualGrade === "CORRECT" || item.manualGrade === "INCORRECT" ? item.manualGrade : null, gradeVersion: Number.isSafeInteger(item.gradeVersion) ? Number(item.gradeVersion) : 0 }];
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
              pendingEdit: (() => {
                const edit = asRecord(item.pendingEdit);
                return edit && typeof edit.id === "string" && typeof edit.text === "string"
                  ? { id: edit.id, text: edit.text } : null;
              })(),
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
      loadedProgramEventRef.current = requestEventId;
      setState({
        kind: "ready",
        eventId: requestEventId,
        closeSnapshot: readCloseSnapshot(event, workspace),
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
        canWritePrograms,
        modules,
        responses,
        questions,
        photos,
        posts,
        drawEvents: drawEventsSnapshot(workspace),
      });
      return true;
    } catch {
      if (activeProgramEventRef.current !== requestEventId) return false;
      if (silent && pendingOperationRef.current) { setOperationError("최신 콘텐츠를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요."); return false; }
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    }
  }

  useEffect(() => {
    handoffAppliedRef.current = null;
    handoffFocusRef.current = null;
    setReviewFocusRequest(null);
    setHandoffNotice(null);
    setHandoffReturn(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    if (hadOtherOperationRef.current && !otherOperationReceipt && !pendingOperation) {
      setRefreshingOperation(true);
      const previousEvent = eventId;
      void load(true).finally(() => { if (activeProgramEventRef.current === previousEvent) setRefreshingOperation(false); });
    }
    hadOtherOperationRef.current = otherOperationReceipt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherOperationReceipt, pendingOperation]);

  const hadOtherQuestionReceipt = useRef(false);
  useEffect(() => {
    const other = otherQuestionReceipt || otherEditReceipt;
    if (hadOtherQuestionReceipt.current && !other && !questionManageRetryRef.current && !questionEditRetryRef.current && !questionRejectRetryRef.current) void load(true);
    hadOtherQuestionReceipt.current = other && !sendingRef.current;
    // A shared, status-only confirmation does not return the question body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, otherQuestionReceipt, otherEditReceipt]);
  const hadOtherModuleReceipt = useRef(false);
  useEffect(() => {
    if (hadOtherModuleReceipt.current && !otherModuleReceipt && !moduleSaveRetryRef.current) void load(true);
    hadOtherModuleReceipt.current = otherModuleReceipt && !sendingRef.current;
    // The shared confirmation reports commitment, not saved module details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, otherModuleReceipt]);

  // Shared freshness: safe silent lists only. Drafts (module dialog, Q&A
  // answers, pending idempotent keys, in-flight writes) must never be
  // blindly reloaded, so the shared signal only refreshes a clean screen.
  useEffect(() => {
    return subscribeConsoleFreshness(() => {
      if (dialogDirty || answerDirty || pendingRetry || busy !== null || sendingRef.current) return;
      void load(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, dialogDirty, answerDirty, pendingRetry, busy]);

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
    // Moderation follow-through: runs only when a request was scheduled
    // after a confirmed success (the ref stays null while a write is
    // in-flight or failed, so initiating setBusy can never steal focus).
    // Lands on the next visible row of the same list, else always falls
    // back to the moderation status line.
    if (moderationFocusRef.current !== null) {
      const request = moderationFocusRef.current;
      moderationFocusRef.current = null;
      const prefix = request.scope === "drawer" ? "review" : "moderation";
      const row = request.id ? document.getElementById(`${prefix}-${request.kind}-${request.id}`) : null;
      if (row) {
        revealDetailsFor(row);
        row.scrollIntoView({ block: "nearest" });
        row.focus({ preventScroll: true });
        return;
      }
      const status = document.getElementById(request.scope === "drawer" ? "review-drawer-status" : "moderation-status");
      status?.scrollIntoView({ block: "nearest" });
      (status as HTMLElement | null)?.focus?.({ preventScroll: true });
    }
  }, [state, moduleLimit]);

  async function postCommand(command: string, payload: Record<string, unknown>, wasUnconfirmed = false): Promise<Record<string, unknown>> {
    if (sendingRef.current) throw new Error("이전 요청을 확인하고 있습니다. 잠시 기다려주세요.");
    const held = pendingOperationRef.current;
    if (held && (held.command !== command || JSON.stringify(held.payload) !== JSON.stringify(payload))) throw new Error("이전 작업의 처리 결과를 먼저 확인하세요.");
    sendingRef.current = true;
    const attempt = JSON.stringify([eventId, command, payload]);
    const previous = pendingCommandsRef.current.get(attempt) ?? (held?.command === command && JSON.stringify(held.payload) === JSON.stringify(payload) ? held.commandId : undefined);
    const commandId = previous ?? randomCommandId();
    pendingCommandsRef.current.set(attempt, commandId);
    const focusOrigin = document.activeElement;
    const rememberOperation = () => {
      if (!Object.hasOwn(PROGRAM_OPERATION_LABELS, command) || activeProgramEventRef.current !== eventId) return;
      if (!pendingOperationRef.current) operationFocusOriginRef.current = focusOrigin;
      const frozen: ProgramOperationAttempt = { eventId, command, payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>, commandId };
      pendingOperationRef.current = frozen; setPendingOperation(frozen);
      setOperationError("처리 결과를 확인하지 못했습니다. 서버에서 확인하거나 원래 요청을 다시 시도하세요.");
    };
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      }).catch((error: unknown) => {
        if (isOrganizationContextBlock(error) && !previous && !wasUnconfirmed) {
          pendingCommandsRef.current.delete(attempt);
          throw new Error("현재 조직을 확인한 뒤 다시 시도하세요.");
        }
        rememberOperation();
        throw new Error("응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요.");
      });
      const data = (await response.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } & Record<string, unknown> | null;
      if (!response.ok) {
        // This guard executes after the locked receipt lookup, including on a
        // retry after response loss. Other 409s/403s remain uncertain there.
        if (command === "question.manage" && response.status === 409 && data?.code === "QUESTION_MANAGEMENT_CHANGED") {
          pendingCommandsRef.current.delete(attempt);
          abandonOperatorAttempt(commandId);
          forgetOperatorReceipt(commandId);
          throw new CommandFailure({ message: "질문 또는 답변이 변경되었습니다.", field: "expectedQuestion", code: "QUESTION_MANAGEMENT_CHANGED" });
        }
        const uncertain = Boolean(previous) || wasUnconfirmed || response.status >= 500 || [408, 425, 429].includes(response.status);
        if (!uncertain) pendingCommandsRef.current.delete(attempt);
        else rememberOperation();
        throw new CommandFailure({
          message: uncertain ? "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요." : typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : null,
          statusCode: response.status,
        });
      }
      if (!data || Array.isArray(data)) { rememberOperation(); throw new Error("응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요."); }
      if (Object.hasOwn(PROGRAM_OPERATION_LABELS, command) && !confirmsProgramOperation(command, commandId, payload, data)) {
        rememberOperation(); throw new Error("요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
      }
      if (command === "module.save" && !confirmsModuleSave(payload, data)) throw new Error("콘텐츠 저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
      if (command === "question.manage" && !confirmsQuestionManagement(payload, data)) throw new Error("질문 처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
      if (command === "response.grade" && (data.responseId !== payload.responseId || !Number.isSafeInteger(data.gradeVersion) || Number(data.gradeVersion) <= Number(payload.expectedGradeVersion))) throw new Error("채점 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
      if (command === "question.edit.approve") {
        const result = asRecord(data.question);
        if (!result || result.id !== payload.id || result.text !== payload.expectedNewText || result.approved !== true || result.pendingEdit) {
          throw new Error("수정안 승인 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
        }
      }
      if (command === "question.edit.reject") {
        const result = asRecord(data.question);
        const rejection = asRecord(result?.editRejection);
        if (!result || result.id !== payload.id || result.text !== payload.expectedText || result.answer !== payload.expectedAnswer ||
            result.approved !== true || result.pendingEdit || !rejection || rejection.id !== payload.expectedEditId ||
            rejection.text !== payload.expectedNewText || rejection.reason !== payload.reason) {
          throw new Error("수정안 반려 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
        }
      }
      pendingCommandsRef.current.delete(attempt);
      if (["module.save", "question.manage", "question.edit.approve", "question.edit.reject", "response.grade"].includes(command) || Object.hasOwn(PROGRAM_OPERATION_LABELS, command)) {
        acknowledgeOperatorReceipt(commandId);
        forgetOperatorReceipt(commandId);
      }
      return data;
    } finally {
      sendingRef.current = false;
    }
  }

  async function recoverProgramOperation(retry: boolean) {
    const attempt = pendingOperationRef.current;
    if (!attempt || attempt.eventId !== eventId || checkingOperation || busy !== null || sendingRef.current || operatorContext.changed) return;
    if (retry && (state.kind !== "ready" || state.archived || !state.canWritePrograms)) {
      setOperationError("현재 권한이나 행사 상태에서는 같은 요청을 다시 보낼 수 없습니다. 서버 처리 확인을 이용하세요."); return;
    }
    const focusOrigin = document.activeElement;
    const refocus = () => window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== focusOrigin && active.isConnected) return;
      const heading = document.getElementById("program-operation-recovery-heading");
      heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }); heading?.focus({ preventScroll: true });
    });
    setCheckingOperation(true); setOperationError(null);
    try {
      if (retry) await postCommand(attempt.command, attempt.payload, true);
      else {
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
        const result = asRecord(await response.json().catch(() => null));
        if (activeProgramEventRef.current !== attempt.eventId) return;
        if (!(response.ok && result?.status === "APPLIED" && result.command === attempt.command)) {
          setOperationError(response.ok && result?.status === "UNCONFIRMED"
            ? "아직 처리 여부를 확인할 수 없습니다. 요청이 처리 중이거나 도착하지 않았을 수 있습니다."
            : "처리 결과를 확인하지 못했습니다. 연결과 현재 행사 접근 권한을 확인하세요.");
          refocus(); return;
        }
      }
      if (activeProgramEventRef.current !== attempt.eventId || !await load(true)) return;
      pendingCommandsRef.current.delete(JSON.stringify([attempt.eventId, attempt.command, attempt.payload]));
      acknowledgeOperatorReceipt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
      pendingOperationRef.current = null; setPendingOperation(null); setOperationError(null); setAbandonOperation(false);
      setFailure(null); setDrawFailure(null);
      setNotice("서버에 반영된 것을 확인하고 최신 콘텐츠 결과를 불러왔습니다.");
    } catch {
      if (activeProgramEventRef.current === attempt.eventId) { setOperationError("이전 요청의 처리 여부를 확인하지 못했습니다. 잠시 후 다시 확인하세요."); refocus(); }
    } finally { if (activeProgramEventRef.current === attempt.eventId) setCheckingOperation(false); }
  }

  async function submitGrade(payload: GradePayload, unconfirmed: boolean): Promise<GradeResult> {
    if (writeLocked || sendingRef.current) return { ok: false, message: "이전 작업을 마친 뒤 다시 시도하세요." };
    const held = gradeRetryRef.current;
    if (held && JSON.stringify(held) !== JSON.stringify(payload)) return { ok: false, message: "미확인 채점을 먼저 확인하세요." };
    setBusy(`grade:${payload.responseId}`);
    try {
      await postCommand("response.grade", payload, unconfirmed || Boolean(held));
      gradeRetryRef.current = null; setGradeRetry(null); setNotice("채점을 저장했습니다.");
      await load(true);
      return { ok: true };
    } catch (error) {
      const uncertain = pendingCommandsRef.current.has(JSON.stringify([eventId, "response.grade", payload]));
      if (uncertain) { gradeRetryRef.current = payload; setGradeRetry(payload); }
      return { ok: false, uncertain, message: error instanceof Error ? error.message : "채점을 저장하지 못했습니다." };
    } finally { setBusy(null); }
  }

  function openCreate() {
    if (writeLocked || moduleSaveRetryRef.current || otherModuleReceipt) return;
    dialogUnresolvedRef.current = false;
    setDraft(EMPTY_DRAFT);
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogOpen(true);
  }

  // 이벤트 만들기 → template: the existing create dialog with the type preselected.
  function openCreateOfType(type: string) {
    if (writeLocked || moduleSaveRetryRef.current || otherModuleReceipt) return;
    dialogUnresolvedRef.current = false;
    setTemplateOpen(false);
    setDraft({ ...EMPTY_DRAFT, type });
    setDialogFailure(null);
    setDialogFieldError(null);
    setDialogOpen(true);
  }

  function openEdit(module: Module) {
    if (writeLocked || moduleSaveRetryRef.current || otherModuleReceipt) return;
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
      return window.confirm("콘텐츠 저장 결과를 아직 확인하지 못했습니다. 이미 저장되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
    }
    if (!dialogDirty) return true;
    return window.confirm("작성 중인 콘텐츠 내용이 있습니다. 닫을까요?");
  }

  async function saveModule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeLocked || moduleSaveRetryRef.current || otherModuleReceipt) return;
    setDialogFailure(null);
    setDialogFieldError(null);
    // Pre-block instead of sending for a predictable 409: the server only
    // saves module types whose feature flag is on.
    if (!isTypeEnabled(draft.type)) {
      setDialogFieldError({ field: "type", message: "꺼져 있는 기능의 콘텐츠는 저장할 수 없습니다. 행사 설정에서 기능을 먼저 켜세요." });
      return;
    }
    const wasCreate = !draft.id;
    const payload: Record<string, unknown> = { type: draft.type, title: draft.title };
    if (draft.id) payload.id = draft.id;
    if (draft.type === "poll") payload.options = draft.optionsText.split(/\r?\n/);
    if (draft.type === "quiz") payload.answer = draft.answer;
    if (draft.type === "survey") payload.questions = draft.questionsText.split(/\r?\n/);
    await submitModuleSave({ eventId, payload, commandId: "", wasCreate });
  }

  async function submitModuleSave(request: ModuleSaveAttempt) {
    if (request.eventId !== eventId || writeLocked || dialogBusy || checkingModuleSave) return;
    const held = moduleSaveRetryRef.current;
    if ((held && JSON.stringify(held.payload) !== JSON.stringify(request.payload)) || (!held && otherModuleReceipt)) return;
    setDialogBusy(true);
    setDialogFailure(null);
    setDialogFieldError(null);
    const { payload, wasCreate } = request;
    try {
      const receipt = await postCommand("module.save", payload, Boolean(held));
      if (activeQuestionEventRef.current !== request.eventId) return;
      moduleSaveRetryRef.current = null;
      setModuleSaveRetry(null);
      dialogUnresolvedRef.current = false;
      setDialogOpen(false);
      setNotice(wasCreate ? "콘텐츠를 만들었습니다." : "콘텐츠를 저장했습니다.");
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
      if (activeQuestionEventRef.current !== request.eventId) return;
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      if (field) setDialogFieldError({ field, message });
      else setDialogFailure({ message, field });
      const commandId = pendingCommandsRef.current.get(JSON.stringify([eventId, "module.save", payload]));
      if (commandId) {
        const pending = { ...request, commandId };
        moduleSaveRetryRef.current = pending;
        setModuleSaveRetry(pending);
        dialogUnresolvedRef.current = true;
      } else dialogUnresolvedRef.current = false;
    } finally {
      setDialogBusy(false);
    }
  }

  async function checkModuleSave() {
    const attempt = moduleSaveRetryRef.current;
    if (!attempt || attempt.eventId !== eventId || checkingModuleSave || dialogBusy) return;
    setCheckingModuleSave(true);
    setDialogFailure(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (activeQuestionEventRef.current !== eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === "module.save") {
        pendingCommandsRef.current.delete(JSON.stringify([eventId, "module.save", attempt.payload]));
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        moduleSaveRetryRef.current = null;
        setModuleSaveRetry(null);
        dialogUnresolvedRef.current = false;
        setDialogOpen(false);
        setModuleLimit(Number.MAX_SAFE_INTEGER);
        setNotice("콘텐츠 저장이 서버에 반영된 것을 확인했습니다. 최신 목록을 확인하세요.");
        await load(true);
      } else if (response.ok && data?.status === "UNCONFIRMED") setDialogFailure({ message: "아직 저장 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요.", field: null });
      else setDialogFailure({ message: response.status >= 500 || [425, 429].includes(response.status)
        ? "일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요."
        : "결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.", field: null });
    } catch { setDialogFailure({ message: "서버에 연결하지 못했습니다. 콘텐츠 요청은 다시 보내지 않았습니다.", field: null }); }
    finally { setCheckingModuleSave(false); }
  }

  function moduleSaveRecovery(): ReactNode {
    if (!moduleSaveRetry) return null;
    return <section className={styles.recovery} aria-labelledby="module-recovery-heading">
      <h2 className={styles.recoveryTitle} id="module-recovery-heading">콘텐츠 저장 확인 필요</h2>
      <p>서버 확인은 콘텐츠를 다시 만들지 않습니다.</p>
      {!dialogOpen && dialogFailure ? <p role="alert">{dialogFailure.message}</p> : null}
      <div className={styles.recoveryActions}>
        <ProductButton type="button" variant="secondary" disabled={dialogBusy || checkingModuleSave || abandonModuleConfirm} onClick={() => void checkModuleSave()}>서버 처리 확인</ProductButton>
        <ProductButton type="button" variant="secondary" disabled={dialogBusy || checkingModuleSave || abandonModuleConfirm || writeLocked} onClick={() => void submitModuleSave(moduleSaveRetry)}>같은 요청 다시 시도</ProductButton>
        <ProductButton type="button" variant="secondary" disabled={dialogBusy || checkingModuleSave || abandonModuleConfirm} onClick={() => setAbandonModuleConfirm(true)}>확인 전 그만두기</ProductButton>
      </div>
      {abandonModuleConfirm ? <ConsoleConfirm
        summary="이미 저장된 콘텐츠는 취소되지 않습니다. 입력 화면을 닫고 최신 목록을 확인할까요?"
        confirmLabel="확인 그만두기"
        onConfirm={() => {
          const attempt = moduleSaveRetryRef.current;
          if (!attempt) return;
          pendingCommandsRef.current.delete(JSON.stringify([eventId, "module.save", attempt.payload]));
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          moduleSaveRetryRef.current = null;
          setModuleSaveRetry(null);
          setAbandonModuleConfirm(false);
          dialogUnresolvedRef.current = false;
          setDialogOpen(false);
          setNotice("확인을 그만두었습니다. 서버 처리는 취소되지 않았으므로 최신 목록을 확인하세요.");
          void load(true);
        }}
        onCancel={() => setAbandonModuleConfirm(false)}
      /> : null}
    </section>;
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
      if (activeProgramEventRef.current !== eventId) return;
      setNotice(`콘텐츠를 ${action}했습니다.`);
      await load(true);
    } catch (error) {
      if (activeProgramEventRef.current !== eventId) return;
      setFailure(error instanceof Error ? error.message : "상태를 바꾸지 못했습니다.");
    } finally {
      if (activeProgramEventRef.current === eventId) { setBusy(null); setStatusPending(null); }
    }
  }

  function requestQuizReveal(module: Module) {
    if (writeLocked || !isTypeEnabled("quiz") || busy !== null) return;
    setRevealPendingId(module.id);
  }

  async function revealQuiz(module: Module) {
    if (writeLocked || !isTypeEnabled("quiz")) return;
    setBusy(`reveal:${module.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("module.reveal", { id: module.id });
      if (activeProgramEventRef.current !== eventId) return;
      setNotice("퀴즈 정답을 공개했습니다.");
      await load(true);
    } catch (error) {
      if (activeProgramEventRef.current !== eventId) return;
      setFailure(error instanceof Error ? error.message : "정답을 공개하지 못했습니다.");
    } finally {
      if (activeProgramEventRef.current === eventId) { setBusy(null); setRevealPendingId(null); }
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
      if (activeProgramEventRef.current !== eventId) return;
      setNotice("추첨을 실행했습니다. 결과를 확인하고 공개하세요.");
      await load(true);
    } catch (error) {
      if (activeProgramEventRef.current !== eventId) return;
      setDrawFailure({
        id: module.id,
        message: error instanceof Error ? error.message : "추첨을 실행하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      if (activeProgramEventRef.current === eventId) { setBusy(null); setDrawPending(null); }
    }
  }

  function requestDrawPublish(module: Module) {
    if (writeLocked || !isTypeEnabled("draw") || busy !== null) return;
    const draw = module.drawHistory[0];
    if (!draw?.id || draw.published) return;
    setDrawFailure(null);
    setPublishPending({ moduleId: module.id, draw });
  }

  async function publishDraw(module: Module, reviewed: DrawResult) {
    if (writeLocked || !isTypeEnabled("draw")) return;
    setBusy(`publish:${module.id}`);
    setDrawFailure(null);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.publish", { id: module.id, expectedDrawId: reviewed.id });
      if (activeProgramEventRef.current !== eventId) return;
      setNotice("추첨 결과를 공개했습니다.");
      await load(true);
    } catch (error) {
      if (activeProgramEventRef.current !== eventId) return;
      setDrawFailure({
        id: module.id,
        message: error instanceof Error ? error.message : "결과를 공개하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
      if (error instanceof CommandFailure && error.field === "expectedDrawId") await load(true);
    } finally {
      if (activeProgramEventRef.current === eventId) { setBusy(null); setPublishPending(null); }
    }
  }

  async function manageQuestion(question: Question, approved: boolean) {
    if (writeLocked || !isTypeEnabled("qa") || questionConflict || questionEditRetryRef.current || questionRejectRetryRef.current || questionManageRetryRef.current || otherQuestionReceipt || otherEditReceipt) return;
    const answer = (answerDrafts[question.id] ?? question.answer).trim();
    if (approved && !answer) {
      setAnswerFailure({ id: question.id, message: "답변을 입력한 뒤 공개하세요.", field: "answer" });
      return;
    }
    const baseline = answerBaselines[question.id] ?? questionBaseline(question);
    await submitQuestionManagement({ eventId, payload: { id: question.id, answer, approved, expectedText: baseline.text, expectedQuestion: baseline }, commandId: "", wasApproved: baseline.approved });
  }

  async function submitQuestionManagement(request: QuestionManageAttempt) {
    if (request.eventId !== eventId || writeLocked || !isTypeEnabled("qa") || busy !== null || checkingQuestion || questionEditRetryRef.current || questionRejectRetryRef.current || otherEditReceipt) return;
    const held = questionManageRetryRef.current;
    if ((held && JSON.stringify(held.payload) !== JSON.stringify(request.payload)) || (!held && otherQuestionReceipt)) return;
    const { payload } = request;
    setBusy(`question:${payload.id}`);
    setAnswerFailure(null);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("question.manage", payload, Boolean(held));
      if (activeQuestionEventRef.current !== request.eventId) return;
      questionManageRetryRef.current = null;
      setQuestionManageRetry(null);
      // The draft is now the saved answer: drop the local entry so the
      // textarea falls back to server truth instead of shadowing it and
      // tripping the unsaved guard on whitespace alone.
      setAnswerDrafts((current) => {
        if (!(payload.id in current)) return current;
        const next = { ...current };
        delete next[payload.id];
        return next;
      });
      setAnswerBaselines((current) => { const next = { ...current }; delete next[payload.id]; return next; });
      setNotice(payload.approved
        ? request.wasApproved ? "답변을 저장했습니다. 공개 상태를 유지합니다." : "답변을 저장하고 질문을 공개했습니다."
        : request.wasApproved ? "질문을 비공개로 전환했습니다." : "답변을 저장했습니다. 비공개 상태를 유지합니다.");
      // Confirmed success only: park the next visible row of this same
      // rendered list (same module, same filter page), else fall back to
      // the moderation status line. answerDrafts for the other rows are
      // untouched by the refresh below. Never scheduled on failure.
      const scope = drawerOpenRef.current ? "drawer" : "list";
      moderationFocusRef.current = {
        kind: "question",
        id: nextVisibleModerationId(visibleModerationRowIds("question", payload.id, scope), payload.id),
        scope,
      };
      await load(true);
    } catch (error) {
      if (activeQuestionEventRef.current !== request.eventId) return;
      if (error instanceof CommandFailure && error.code === "QUESTION_MANAGEMENT_CHANGED") {
        questionManageRetryRef.current = null;
        setQuestionManageRetry(null);
        setAnswerDrafts((current) => ({ ...current, [payload.id]: current[payload.id] ?? payload.answer }));
        setAnswerBaselines((current) => ({ ...current, [payload.id]: payload.expectedQuestion }));
        setAnswerFailure(null);
        setQuestionConflict({ id: payload.id, baseline: payload.expectedQuestion, mine: answerDrafts[payload.id] ?? payload.answer, latest: null, loading: false, error: null });
        window.requestAnimationFrame(() => document.getElementById(`question-conflict-${payload.id}`)?.focus());
        return;
      }
      const commandId = pendingCommandsRef.current.get(JSON.stringify([eventId, "question.manage", payload]));
      if (commandId) {
        const pending = { ...request, commandId };
        questionManageRetryRef.current = pending;
        setQuestionManageRetry(pending);
      }
      setAnswerFailure({
        id: payload.id,
        message: error instanceof Error ? error.message : "질문을 처리하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
        statusCode: error instanceof CommandFailure ? error.statusCode : null,
      });
    } finally {
      setBusy(null);
    }
  }

  async function checkQuestionManagement() {
    const attempt = questionManageRetryRef.current;
    if (!attempt || attempt.eventId !== eventId || checkingQuestion || busy !== null) return;
    setCheckingQuestion(true);
    setFailure(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (activeQuestionEventRef.current !== eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === "question.manage") {
        pendingCommandsRef.current.delete(JSON.stringify([eventId, "question.manage", attempt.payload]));
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        questionManageRetryRef.current = null;
        setQuestionManageRetry(null);
        setAnswerDrafts((current) => { const next = { ...current }; delete next[attempt.payload.id]; return next; });
        setAnswerBaselines((current) => { const next = { ...current }; delete next[attempt.payload.id]; return next; });
        setAnswerFailure(null);
        setNotice("질문 처리가 서버에 반영된 것을 확인했습니다. 최신 답변과 공개 상태를 확인하세요.");
        await load(true);
      } else if (response.ok && data?.status === "UNCONFIRMED") setFailure("아직 질문 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요.");
      else setFailure(response.status >= 500 || [425, 429].includes(response.status)
        ? "일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요."
        : "처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
    } catch { setFailure("서버에 연결하지 못했습니다. 질문 요청은 다시 보내지 않았습니다."); }
    finally { setCheckingQuestion(false); }
  }

  async function refreshQuestionConflict() {
    const conflict = questionConflict;
    if (!conflict || conflict.loading || busy !== null) return;
    setQuestionConflict({ ...conflict, latest: null, loading: true, error: null });
    const controller = new AbortController();
    questionConflictReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      // The timeout covers both headers and body reads, even when a transport
      // or test double ignores AbortSignal while consuming a response body.
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      const reading = (async () => {
        const [meResponse, bootstrapResponse] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store", signal: controller.signal }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [me, boot] = await Promise.all([
          meResponse.json().catch(() => null), bootstrapResponse.json().catch(() => null),
        ]);
        return { meResponse, bootstrapResponse, me: asRecord(me), boot: asRecord(boot) };
      })();
      const { meResponse, bootstrapResponse, me, boot } = await Promise.race([reading, aborted]);
      if (activeQuestionEventRef.current !== eventId || questionConflictReadRef.current !== controller) return;
      const user = asRecord(me?.user);
      const snapshot = asRecord(boot?.state);
      const workspaces = asRecord(snapshot?.workspaces);
      const workspace = asRecord(workspaces?.[eventId]);
      const event = Array.isArray(snapshot?.events) ? snapshot.events.map(asRecord).find((item) => item?.id === eventId) : null;
      const memberships = Array.isArray(snapshot?.memberships) ? snapshot.memberships.flatMap((item) => {
        const membership = asRecord(item);
        return membership && typeof membership.accountId === "string" && typeof membership.eventId === "string"
          ? [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }] : [];
      }) : null;
      const row = Array.isArray(workspace?.questions) ? workspace.questions.map(asRecord).find((item) => item?.id === conflict.id) : null;
      if (!meResponse.ok || !bootstrapResponse.ok || !user || typeof user.id !== "string" || typeof user.role !== "string" ||
          !memberships || !event || !workspace || !Array.isArray(event.features) || !event.features.includes("qa") ||
          typeof event.stage !== "string" || event.stage.toUpperCase() === "ARCHIVED" ||
          !canWriteEvent({ role: user.role, userId: user.id, memberships, eventId }, "question.manage") ||
          !row || typeof row.text !== "string" || typeof row.answer !== "string" || typeof row.approved !== "boolean") {
        throw new Error("최신 질문을 확인하지 못했습니다. 행사와 접근 권한을 확인한 뒤 다시 불러오세요.");
      }
      const latest = { text: row.text, answer: row.answer, approved: row.approved };
      setQuestionConflict((current) => current?.id === conflict.id ? { ...current, latest, loading: false, error: null } : current);
    } catch {
      if (activeQuestionEventRef.current !== eventId || questionConflictReadRef.current !== controller) return;
      setQuestionConflict((current) => current?.id === conflict.id ? { ...current, latest: null, loading: false,
        error: "최신 질문을 확인하지 못했습니다. 연결과 행사 접근 권한을 확인한 뒤 다시 불러오세요." } : current);
    } finally {
      window.clearTimeout(timeout);
      if (questionConflictReadRef.current === controller) questionConflictReadRef.current = null;
    }
  }

  function resolveQuestionConflict(choice: "mine" | "latest") {
    const conflict = questionConflict;
    if (!conflict?.latest || conflict.loading || writeLocked || !isTypeEnabled("qa")) return;
    const latest = conflict.latest;
    setState((current) => current.kind !== "ready" ? current : { ...current,
      questions: current.questions.map((question) => question.id === conflict.id ? { ...question, ...latest } : question) });
    setAnswerBaselines((current) => ({ ...current, [conflict.id]: latest }));
    setAnswerDrafts((current) => ({ ...current, [conflict.id]: choice === "mine" ? conflict.mine : latest.answer }));
    setQuestionConflict(null);
    setNotice("최신 질문을 기준으로 다시 검토하세요. 저장하거나 공개하려면 원하는 동작을 다시 선택하세요.");
    window.requestAnimationFrame(() => document.getElementById(`answer-${conflict.id}`)?.focus());
  }

  async function approveQuestionEdit(payload: QuestionEditApproval, retry = false) {
    if (writeLocked || !isTypeEnabled("qa") || busy !== null || questionRejectRetryRef.current || questionManageRetryRef.current || otherQuestionReceipt || otherEditReceipt) return;
    const held = questionEditRetryRef.current;
    if (held && JSON.stringify(held) !== JSON.stringify(payload)) return;
    setBusy(`question-edit:${payload.id}`);
    setAnswerFailure(null);
    setNotice(null);
    try {
      await postCommand("question.edit.approve", payload, retry || Boolean(held));
      questionEditRetryRef.current = null;
      setQuestionEditRetry(null);
      setRejectDrafts((current) => { const next = { ...current }; delete next[payload.expectedEditId]; return next; });
      setNotice("수정안을 승인했습니다. 기존 답변은 유지됩니다.");
      await load(true);
    } catch (error) {
      const uncertain = pendingCommandsRef.current.has(JSON.stringify([eventId, "question.edit.approve", payload]));
      if (uncertain) {
        questionEditRetryRef.current = payload;
        setQuestionEditRetry(payload);
      }
      setAnswerFailure({ id: payload.id, message: error instanceof Error ? error.message : "수정안을 승인하지 못했습니다.", field: null });
    } finally {
      setBusy(null);
    }
  }

  async function rejectQuestionEdit(payload: QuestionEditRejection, retry = false) {
    if (writeLocked || !isTypeEnabled("qa") || busy !== null || questionEditRetryRef.current || questionManageRetryRef.current || otherQuestionReceipt || otherEditReceipt) return;
    const held = questionRejectRetryRef.current;
    if (held && JSON.stringify(held) !== JSON.stringify(payload)) return;
    setBusy(`question-edit:${payload.id}`);
    setRejectFailure(null);
    setNotice(null);
    try {
      await postCommand("question.edit.reject", payload, retry || Boolean(held));
      questionRejectRetryRef.current = null;
      setQuestionRejectRetry(null);
      setRejectDrafts((current) => { const next = { ...current }; delete next[payload.expectedEditId]; return next; });
      setNotice("수정안을 반려했습니다. 작성자는 참여 화면에서 사유를 확인할 수 있습니다.");
      moderationFocusRef.current = {
        kind: "question",
        id: nextVisibleModerationId(visibleModerationRowIds("question", payload.id), payload.id),
        scope: "list",
      };
      await load(true);
    } catch (error) {
      const uncertain = pendingCommandsRef.current.has(JSON.stringify([eventId, "question.edit.reject", payload]));
      if (uncertain) { questionRejectRetryRef.current = payload; setQuestionRejectRetry(payload); }
      setRejectFailure({ id: payload.id, editId: payload.expectedEditId, message: error instanceof Error ? error.message : "수정안을 반려하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null });
    } finally {
      setBusy(null);
    }
  }

  async function checkQuestionEdit(kind: "approve" | "reject") {
    const payload = kind === "approve" ? questionEditRetryRef.current : questionRejectRetryRef.current;
    const command = kind === "approve" ? "question.edit.approve" : "question.edit.reject";
    if (!payload || checkingQuestionEdit || busy !== null) return;
    const fingerprint = JSON.stringify([eventId, command, payload]);
    const commandId = pendingCommandsRef.current.get(fingerprint);
    if (!commandId) return;
    setCheckingQuestionEdit(true);
    setFailure(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(commandId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (activeQuestionEventRef.current !== eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === command) {
        pendingCommandsRef.current.delete(fingerprint);
        acknowledgeOperatorReceipt(commandId);
        forgetOperatorReceipt(commandId);
        if (kind === "approve") { questionEditRetryRef.current = null; setQuestionEditRetry(null); }
        else { questionRejectRetryRef.current = null; setQuestionRejectRetry(null); }
        setRejectDrafts((current) => { const next = { ...current }; delete next[payload.expectedEditId]; return next; });
        setAnswerFailure(null); setRejectFailure(null);
        setNotice("수정안 처리가 서버에 반영된 것을 확인했습니다. 최신 질문 상태를 확인하세요.");
        await load(true);
      } else if (response.ok && data?.status === "UNCONFIRMED") setFailure("아직 수정안 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요.");
      else setFailure(response.status >= 500 || [425, 429].includes(response.status)
        ? "일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요."
        : "결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
    } catch { setFailure("서버에 연결하지 못했습니다. 수정안 요청은 다시 보내지 않았습니다."); }
    finally { setCheckingQuestionEdit(false); }
  }

  function requestPhotoModeration(photo: Photo, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("photo") || busy !== null) return;
    setPhotoPending({ id: photo.id, status });
  }

  async function moderatePhoto(photo: Photo, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("photo")) return;
    const action = status === "APPROVED" ? "승인" : "반려";
    setBusy(`photo:${photo.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("photo.moderate", { id: photo.id, status });
      if (activeProgramEventRef.current !== eventId) return;
      setNotice(`사진을 ${action}했습니다.`);
      // Confirmed success only: next visible row of this same rendered
      // list, else the moderation status line. Never on failure.
      const scope = drawerOpenRef.current ? "drawer" : "list";
      moderationFocusRef.current = {
        kind: "photo",
        id: nextVisibleModerationId(visibleModerationRowIds("photo", photo.id, scope), photo.id),
        scope,
      };
      await load(true);
    } catch (error) {
      if (activeProgramEventRef.current !== eventId) return;
      setFailure(error instanceof Error ? error.message : "사진을 처리하지 못했습니다.");
    } finally {
      if (activeProgramEventRef.current === eventId) { setBusy(null); setPhotoPending(null); }
    }
  }

  function requestPostModeration(post: Post, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("board") || busy !== null) return;
    setPostPending({ id: post.id, status });
  }

  async function moderatePost(post: Post, status: "APPROVED" | "HIDDEN") {
    if (writeLocked || !isTypeEnabled("board")) return;
    const action = status === "APPROVED" ? "승인" : "반려";
    setBusy(`post:${post.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("post.moderate", { id: post.id, status });
      if (activeProgramEventRef.current !== eventId) return;
      setNotice(`게시글을 ${action}했습니다.`);
      // Confirmed success only: next visible row of this same rendered
      // list, else the moderation status line. Never on failure.
      const scope = drawerOpenRef.current ? "drawer" : "list";
      moderationFocusRef.current = {
        kind: "post",
        id: nextVisibleModerationId(visibleModerationRowIds("post", post.id, scope), post.id),
        scope,
      };
      await load(true);
    } catch (error) {
      if (activeProgramEventRef.current !== eventId) return;
      setFailure(error instanceof Error ? error.message : "게시글을 처리하지 못했습니다.");
    } finally {
      if (activeProgramEventRef.current === eventId) { setBusy(null); setPostPending(null); }
    }
  }

  if (state.kind === "loading" || (state.kind === "ready" && loadedProgramEventRef.current !== eventId)) {
    return (
      <ConsolePage pageId="programs" eventId={eventId} afterHeader={afterHeader}>
        <ConsoleStatePanel kind="loading" shape="list" message="참여 이벤트 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="programs" eventId={eventId} afterHeader={afterHeader}>
        {/* ConsoleStatePanel renders "다시 불러오기" and dispatches eventouch:shell-reload before retrying. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void load(); }}
          actions={<ProductLink variant="secondary" href="/console">행사 목록으로</ProductLink>}
        />
      </ConsolePage>
    );
  }

  const settingsHref = closeHref(`/console/events/${encodeURIComponent(eventId)}/settings#settings-features`);

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
  const drawEvents = state.drawEvents.events;
  const visibleDrawEvents = drawEvents.filter((event) => {
    if (programStatusFilter && event.status !== programStatusFilter) return false;
    if (!programQueryText) return true;
    return `${event.title} ${event.typeLabel}`.toLocaleLowerCase("ko-KR").includes(programQueryText);
  });
  const totalEvents = state.modules.length + drawEvents.length;
  const statusCount = (status: string) => state.modules.filter((module) => module.status === status).length + drawEvents.filter((event) => event.status === status).length;
  const hasProgramFilter = programQuery.trim() !== "" || programStatusFilter !== "";
  function clearProgramFilters(): void {
    setProgramQuery("");
    setProgramStatusFilter("");
  }
  function returnToQuestionConflict(): void {
    if (!questionConflict) return;
    const id = questionConflict.id;
    clearProgramFilters();
    setQaFilter("all");
    setModuleLimit(Number.MAX_SAFE_INTEGER);
    setDrawerOpen(false);
    window.requestAnimationFrame(() => {
      const heading = document.getElementById(`question-conflict-${id}`);
      revealDetailsFor(heading);
      heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      heading?.focus({ preventScroll: true });
    });
  }

  // Rows read in running order: what is live first, then what is being
  // prepared, then what ended. Paging slices that same order.
  const STATUS_GROUPS: Array<{ key: string; label: string }> = [
    { key: "OPEN", label: "진행 중" },
    { key: "DRAFT", label: "준비 중" },
    { key: "CLOSED", label: "종료" },
  ];
  const ordered = [
    ...STATUS_GROUPS.flatMap((group) => visibleModules.filter((module) => module.status === group.key)),
    ...visibleModules.filter((module) => !STATUS_GROUPS.some((group) => group.key === module.status)),
  ];
  const shownModules = ordered.slice(0, moduleLimit);
  visibleModulesRef.current = ordered;
  const moduleGroups = [
    ...STATUS_GROUPS,
    { key: "OTHER", label: "상태 확인 필요" },
  ].map((group) => ({
    ...group,
    modules: shownModules.filter((module) => group.key === "OTHER" ? !STATUS_GROUPS.some((known) => known.key === module.status) : module.status === group.key),
    draws: group.key === "OTHER" ? [] : visibleDrawEvents.filter((event) => event.status === group.key),
  })).filter((group) => group.modules.length || group.draws.length);

  // One count for everything attendees sent that still needs a decision.
  // A question needing both an answer and an approval counts once.
  const reviewQuestions = state.kind === "ready" ? state.questions.filter(questionNeedsReview).length : 0;
  const reviewPhotos = state.kind === "ready" ? state.photos.filter((photo) => photo.status === "PENDING").length : 0;
  const reviewPosts = state.kind === "ready" ? state.posts.filter((post) => post.status === "PENDING").length : 0;
  const reviewTotal = reviewQuestions + reviewPhotos + reviewPosts;
  const runningCount = state.modules.filter((module) => module.status === "OPEN").length;
  const returnBack = handoffReturn?.href ?? `/console/events/${encodeURIComponent(eventId)}/operations#ops-participation`;
  const returnLabel = handoffReturn?.label ?? "입장·스태프";

  return (
    <ConsolePage
      pageId="programs"
      closeSnapshot={state.closeSnapshot}
      eventId={eventId} afterHeader={afterHeader}
      eventName={state.eventName}
      meta={state.eventMeta}
      headerActions={
        <div className={`${styles.headerActions} console-header-group`}>
          <ProductLink variant="ghost" href={returnBack}>{returnLabel}</ProductLink>
          {state.canManage ? <ConsoleRefreshButton label="새로고침" disabled={busy !== null} onRefresh={() => load(true)} /> : null}
          {state.canManage ? (
            <ProductButton type="button" variant="primary" aria-haspopup="dialog" onClick={() => setTemplateOpen(true)} disabled={writeLocked || Boolean(moduleSaveRetry) || otherModuleReceipt}>
              이벤트 만들기
            </ProductButton>
          ) : null}
        </div>
      }
      toolbar={state.canManage ? (
        <>
          {moduleSaveRetry && !dialogOpen ? moduleSaveRecovery() : null}
          {otherModuleReceipt && !moduleSaveRetry && !dialogBusy ? <p role="status">이전 콘텐츠 저장 결과를 위에서 확인한 뒤 변경할 수 있습니다.</p> : null}
          {questionConflict ? <div className={styles.recoveryStrip} role="region" aria-label="질문 변경 확인">
            <span>변경된 질문을 확인한 뒤 답변을 다시 저장할 수 있습니다.</span>
            <ProductButton type="button" variant="secondary" onClick={returnToQuestionConflict}>변경 내용 확인</ProductButton>
          </div> : null}
          {questionManageRetry ? (
            <div className={styles.recoveryStrip} role="region" aria-label="질문 처리 확인">
              <span>질문 처리가 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</span>
              {answerFailure?.id === questionManageRetry.payload.id ? (
                <p role="alert">
                  {answerFailure.statusCode === 403
                    ? "다시 보낸 요청이 서버에서 거부되었습니다 (403). 원래 처리가 반영됐는지는 아직 확인되지 않았습니다. 서버 처리 확인으로 상태를 조회하거나 같은 요청을 다시 확인하세요."
                    : answerFailure.message}
                </p>
              ) : null}
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestion || abandonQuestionConfirm} onClick={() => void checkQuestionManagement()}>서버 처리 확인</ProductButton>
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestion || abandonQuestionConfirm || writeLocked} onClick={() => void submitQuestionManagement(questionManageRetry)}>원래 질문 처리 다시 확인</ProductButton>
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestion || abandonQuestionConfirm} onClick={() => setAbandonQuestionConfirm(true)}>확인 전 그만두기</ProductButton>
              {abandonQuestionConfirm ? <ConsoleConfirm
                summary="이미 반영된 질문 처리는 취소되지 않습니다. 확인을 그만둔 뒤 최신 공개 상태를 살펴보세요."
                confirmLabel="확인 그만두기"
                onConfirm={() => {
                  const attempt = questionManageRetryRef.current;
                  if (!attempt) return;
                  pendingCommandsRef.current.delete(JSON.stringify([eventId, "question.manage", attempt.payload]));
                  abandonOperatorAttempt(attempt.commandId);
                  forgetOperatorReceipt(attempt.commandId);
                  questionManageRetryRef.current = null;
                  setQuestionManageRetry(null);
                  setAbandonQuestionConfirm(false);
                  setNotice("확인을 그만두었습니다. 서버 처리는 취소되지 않았으므로 최신 질문을 확인하세요.");
                  void load(true);
                }}
                onCancel={() => setAbandonQuestionConfirm(false)}
              /> : null}
            </div>
          ) : null}
          {(otherQuestionReceipt || otherEditReceipt) && !questionManageRetry && busy === null ? <p role="status">이전 질문 처리 결과를 위에서 확인한 뒤 질문을 변경할 수 있습니다.</p> : null}
          {questionEditRetry ? (
            <div className={styles.recoveryStrip} role="alert">
              <span>수정안 승인 결과를 확인하지 못했습니다. 원래 질문과 수정안으로 다시 확인하세요.</span>
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestionEdit} onClick={() => void checkQuestionEdit("approve")}>서버 처리 확인</ProductButton>
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestionEdit}
                onClick={() => void approveQuestionEdit(questionEditRetry, true)}>원래 승인 재확인</ProductButton>
            </div>
          ) : null}
          {questionRejectRetry ? (
            <div className={styles.recoveryStrip} role="alert">
              <span>수정안 반려 결과를 확인하지 못했습니다. 입력한 사유와 원래 요청으로 다시 확인하세요.</span>
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestionEdit} onClick={() => void checkQuestionEdit("reject")}>서버 처리 확인</ProductButton>
              <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingQuestionEdit}
                onClick={() => void rejectQuestionEdit(questionRejectRetry, true)}>원래 반려 재확인</ProductButton>
            </div>
          ) : null}
          <div className={`${styles.reviewLine} ${reviewTotal ? "" : styles.reviewLineCalm}`} id="moderation-status" tabIndex={-1} role="status">
            {reviewTotal ? (
              <button type="button" className={styles.reviewToggle} aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => { setDrawerTab("all"); setDrawerOpen(true); }}>
                <span>검토할 것 {reviewTotal}<small>{[reviewQuestions ? `질문 ${reviewQuestions}` : "", reviewPhotos ? `사진 ${reviewPhotos}` : "", reviewPosts ? `글 ${reviewPosts}` : ""].filter(Boolean).join(" · ")}</small></span>
                <span aria-hidden="true">열기 ›</span>
              </button>
            ) : <span>검토할 항목이 없습니다.</span>}
          </div>
        </>
      ) : undefined}
      feedback={
        <>
          {handoffNotice ? <ConsoleFeedback kind="info">{handoffNotice}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {failure && !pendingOperation ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {gradeRetry ? <ConsoleFeedback kind="warning"><p>채점 결과가 아직 확인되지 않았습니다. 다른 채점을 하기 전에 같은 요청을 확인하세요.</p><ProductButton type="button" variant="secondary" disabled={busy !== null || writeLocked} onClick={() => void submitGrade(gradeRetry, true)}>같은 채점 다시 확인</ProductButton></ConsoleFeedback> : null}
          {!state.canManage ? (
            <ConsoleFeedback kind="error">참여 콘텐츠를 관리할 운영 권한이 없습니다.</ConsoleFeedback>
          ) : null}
          {state.canManage && state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 콘텐츠와 응답을 볼 수 있지만 만들거나 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
          {state.canManage && !state.archived && !state.canWritePrograms ? (
            <ConsoleFeedback kind="warning">이 행사에 대한 콘텐츠 쓰기 권한이 없습니다. 목록·결과·내보내기는 볼 수 있지만 만들거나 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      {otherOperationReceipt && !pendingOperation ? <ConsoleFeedback kind="warning">이전 콘텐츠 작업의 처리 결과를 화면 위의 ‘처리 결과 확인’에서 먼저 확인하세요.</ConsoleFeedback> : null}
      {refreshingOperation ? <ConsoleFeedback kind="info">최신 콘텐츠와 결과를 불러오고 있습니다.</ConsoleFeedback> : null}
      {pendingOperation ? <section className={styles.recovery} aria-labelledby="program-operation-recovery-heading">
        <h2 className={styles.recoveryTitle} id="program-operation-recovery-heading" tabIndex={-1}>콘텐츠 처리 확인 필요</h2>
        <p>{PROGRAM_OPERATION_LABELS[pendingOperation.command]} 요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
        {state.archived || !state.canWritePrograms ? <p>현재 권한이나 행사 상태에서는 같은 요청을 다시 보낼 수 없습니다. 서버 처리 확인을 이용하세요.</p> : null}
        {operationError ? <p role="alert">{operationError}</p> : null}
        <div className={styles.recoveryActions}>
          <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingOperation || abandonOperation || operatorContext.changed} onClick={() => void recoverProgramOperation(false)}>{checkingOperation ? "확인 중…" : "서버 처리 확인"}</ProductButton>
          <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingOperation || abandonOperation || operatorContext.changed || state.archived || !state.canWritePrograms} onClick={() => void recoverProgramOperation(true)}>같은 요청 다시 시도</ProductButton>
          <ProductButton type="button" variant="secondary" disabled={busy !== null || checkingOperation || abandonOperation} onClick={() => setAbandonOperation(true)}>확인 전 그만두기</ProductButton>
        </div>
        {abandonOperation ? <ConsoleConfirm summary="이미 처리된 콘텐츠 작업은 취소되지 않습니다. 확인을 그만두고 최신 결과를 확인할까요?" confirmLabel="확인 그만두기" onConfirm={() => {
          const attempt = pendingOperationRef.current;
          if (!attempt) return;
          pendingCommandsRef.current.delete(JSON.stringify([attempt.eventId, attempt.command, attempt.payload]));
          abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
          pendingOperationRef.current = null; setPendingOperation(null); setOperationError(null); setAbandonOperation(false);
          setFailure("이전 작업이 반영됐을 수 있습니다. 최신 내용을 확인한 뒤 다시 진행하세요.");
          setRefreshingOperation(true);
          void load(true).finally(() => { if (activeProgramEventRef.current === attempt.eventId) setRefreshingOperation(false); });
        }} onCancel={() => setAbandonOperation(false)} /> : null}
      </section> : null}
      {state.canManage ? (
        totalEvents ? (
          <section className={styles.listSection} aria-label="참여 이벤트 목록">
            <div className={styles.listTools}>
              <CountTabs
                ariaLabel="진행 상태별 보기"
                value={programStatusFilter || "all"}
                onChange={(key) => setProgramStatusFilter(key === "all" ? "" : key)}
                items={[
                  { key: "all", label: "전체", count: totalEvents },
                  { key: "OPEN", label: "진행 중", count: statusCount("OPEN") },
                  { key: "DRAFT", label: "준비 중", count: statusCount("DRAFT"), tone: "wait" },
                  { key: "CLOSED", label: "종료", count: statusCount("CLOSED") },
                ]}
                dots={{ OPEN: "live" }}
                aside={<>받은 응답 <b>{state.responses.length}</b>건</>}
              />
              {totalEvents > 8 || hasProgramFilter ? (
                <label>
                  <span className="sr-only" id="program-search-label">이벤트 검색</span>
                  <input
                    aria-labelledby="program-search-label"
                    type="search"
                    placeholder="이벤트 이름·유형 검색"
                    value={programQuery}
                    onChange={(event) => setProgramQuery(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
            {hasProgramFilter ? (
              <p className={styles.resultCount} role="status">
                검색·필터 결과 {visibleModules.length + visibleDrawEvents.length}개 · 전체 {totalEvents}개{" "}
                <ProductButton type="button" variant="ghost" onClick={clearProgramFilters}>검색·필터 지우기</ProductButton>
              </p>
            ) : null}
            {visibleModules.length + visibleDrawEvents.length ? (
              <>
                {moduleGroups.map((group) => (
                  <div key={group.key} className={styles.moduleGroup}>
                    <h2 className={styles.groupTitle} data-group={group.key}>{group.label}<span className={styles.groupCount}>{group.modules.length + group.draws.length}</span></h2>
                    <ul className={styles.moduleList}>
                      {group.modules.map((module) => (
                        <ModuleCard
                          key={module.id}
                          module={module}
                          rewardCount={module.type === "draw" ? (state.drawEvents.moduleRewards[module.id] ?? 0) : null}
                          reviewCount={module.type === "qa" ? state.questions.filter((question) => question.moduleId === module.id && questionNeedsReview(question)).length : module.type === "photo" ? reviewPhotos : module.type === "board" ? reviewPosts : 0}
                          rewardsHref={`/console/events/${encodeURIComponent(eventId)}/rewards`}
                          featureOn={state.features.includes(module.type)}
                          eventId={eventId}
                          busy={busy}
                          locked={writeLocked || questionEditRetry !== null || questionRejectRetry !== null || questionManageRetry !== null || otherQuestionReceipt || otherEditReceipt || moduleSaveRetry !== null || otherModuleReceipt}
                          responses={state.responses.filter((response) => response.moduleId === module.id).length}
                          moduleResponses={state.responses.filter((response) => response.moduleId === module.id)}
                          submitGrade={submitGrade}
                          gradePending={gradeRetry !== null}
                          questions={state.questions.filter((question) => question.moduleId === module.id)}
                          photos={state.photos}
                          posts={state.posts}
                          drawCounts={drawCounts}
                          setDrawCounts={setDrawCounts}
                          drawFailure={drawFailure?.id === module.id ? drawFailure : null}
                          answerDrafts={answerDrafts}
                          onAnswerChange={onAnswerChange}
                          questionConflict={questionConflict}
                          onRefreshQuestionConflict={() => void refreshQuestionConflict()}
                          onResolveQuestionConflict={resolveQuestionConflict}
                          answerFailure={answerFailure}
                          rejectDrafts={rejectDrafts}
                          setRejectDrafts={(updater) => { setRejectDrafts(updater); setRejectFailure(null); }}
                          rejectFailure={rejectFailure}
                          qaFilter={qaFilter}
                          onQaFilter={setQaFilter}
                          photoFilter={photoFilter}
                          onPhotoFilter={setPhotoFilter}
                          postFilter={postFilter}
                          onPostFilter={setPostFilter}
                          onEdit={() => openEdit(module)}
                          closeHref={closeHref}
                          returnLink={handoffReturn?.moduleId === module.id ? handoffReturn : undefined}
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
                          publishPending={publishPending?.moduleId === module.id ? publishPending.draw : null}
                          onRequestPublishDraw={() => requestDrawPublish(module)}
                          onConfirmPublishDraw={() => {
                            if (publishPending?.moduleId === module.id) void publishDraw(module, publishPending.draw);
                          }}
                          onCancelPublishDraw={() => setPublishPending(null)}
                          photoPending={photoPending}
                          onRequestModeratePhoto={(photo, status) => requestPhotoModeration(photo, status)}
                          onConfirmModeratePhoto={(photo, status) => void moderatePhoto(photo, status)}
                          onCancelModeratePhoto={() => setPhotoPending(null)}
                          postPending={postPending}
                          onRequestModeratePost={(post, status) => requestPostModeration(post, status)}
                          onConfirmModeratePost={(post, status) => void moderatePost(post, status)}
                          onCancelModeratePost={() => setPostPending(null)}
                          onManageQuestion={(question, approved) => void manageQuestion(question, approved)}
                          onApproveQuestionEdit={(question) => {
                            if (!question.pendingEdit) return;
                            void approveQuestionEdit({ id: question.id, expectedEditId: question.pendingEdit.id,
                              expectedText: question.text, expectedAnswer: question.answer, expectedNewText: question.pendingEdit.text });
                          }}
                          onRejectQuestionEdit={(question, reason) => {
                            if (!question.pendingEdit) return;
                            if (!reason.trim()) {
                              setRejectFailure({ id: question.id, editId: question.pendingEdit.id, field: "reason", message: "반려 사유를 입력하세요." });
                              document.getElementById(`reject-reason-${question.id}`)?.focus();
                              return;
                            }
                            void rejectQuestionEdit({ id: question.id, expectedEditId: question.pendingEdit.id,
                              expectedText: question.text, expectedAnswer: question.answer, expectedNewText: question.pendingEdit.text, reason: reason.trim() });
                          }}
                        />
                      ))}
                      {group.draws.map((event) => (
                        <DrawEventRow
                          key={event.key}
                          event={event}
                          eventId={eventId}
                          featureOn={state.features.includes(event.featureKey)}
                          closeHref={closeHref}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {visibleModules.length > moduleLimit ? (
                  <p className={styles.moreRow}>
                    <ProductButton type="button" variant="ghost" onClick={revealMoreModules}>
                      더 보기 ({visibleModules.length - moduleLimit})
                    </ProductButton>
                  </p>
                ) : null}
              </>
            ) : (
              <ConsoleEmptyState
                kind="filtered"
                title="조건에 맞는 이벤트가 없습니다."
                description="검색어·상태 조건을 바꾸거나 지우고 다시 찾아보세요."
                action={<ProductButton type="button" variant="secondary" onClick={clearProgramFilters}>검색·필터 지우기</ProductButton>}
              />
            )}
            <p className={styles.drawsLink}>
              <ProductLink variant="ghost" href={closeHref(`/console/events/${encodeURIComponent(eventId)}/draws`)}>무대 운영 화면 (추첨·룰렛·순위 투표)</ProductLink>
            </p>
          </section>
        ) : (
          <section className={styles.emptyChooser} aria-label="이벤트 만들기">
            <h2 className={styles.emptyChooserTitle}>첫 이벤트를 만들어 보세요</h2>
            <p>종류를 고르면 해당 설정이 열립니다.</p>
            <TemplateGroups eventId={eventId} closeHref={closeHref} isTypeEnabled={isTypeEnabled} isDrawEnabled={(key) => state.features.includes(key)}
              disabled={writeLocked || Boolean(moduleSaveRetry) || otherModuleReceipt} onPickModule={openCreateOfType} />
          </section>
        )
      ) : null}

      {drawerOpen && state.canManage ? (
        <ReviewDrawer
          eventId={eventId}
          modules={state.modules}
          questions={state.questions}
          photos={state.photos}
          posts={state.posts}
          tab={drawerTab}
          onTab={setDrawerTab}
          busy={busy}
          locked={writeLocked || questionEditRetry !== null || questionRejectRetry !== null || questionManageRetry !== null || otherQuestionReceipt || otherEditReceipt}
          conflict={Boolean(questionConflict)}
          answerDrafts={answerDrafts}
          onAnswerChange={onAnswerChange}
          answerFailure={answerFailure}
          onManage={(question, approved) => void manageQuestion(question, approved)}
          onOpenEdit={openQuestionEdit}
          photoPending={photoPending}
          onRequestPhoto={(photo, status) => requestPhotoModeration(photo, status)}
          onConfirmPhoto={(photo, status) => void moderatePhoto(photo, status)}
          onCancelPhoto={() => setPhotoPending(null)}
          postPending={postPending}
          onRequestPost={(post, status) => requestPostModeration(post, status)}
          onConfirmPost={(post, status) => void moderatePost(post, status)}
          onCancelPost={() => setPostPending(null)}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}

      {templateOpen && state.kind === "ready" && state.canManage ? (
        <TemplateChooser
          eventId={eventId}
          closeHref={closeHref}
          isTypeEnabled={isTypeEnabled}
          isDrawEnabled={(key) => state.features.includes(key)}
          disabled={writeLocked || Boolean(moduleSaveRetry) || otherModuleReceipt}
          onPickModule={openCreateOfType}
          onClose={() => setTemplateOpen(false)}
        />
      ) : null}

      {dialogOpen && state.kind === "ready" ? (
        <ModuleDialog
          draft={draft}
          busy={dialogBusy || checkingModuleSave}
          locked={writeLocked || Boolean(moduleSaveRetry) || otherModuleReceipt}
          frozen={Boolean(moduleSaveRetry) || otherModuleReceipt}
          recovery={moduleSaveRetry ? moduleSaveRecovery() : null}
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

// One quiet line and one number per row, plus an optional thin meter, so the
// list reads at a glance. Everything is derived from the loaded workspace.
type RowSummary = { line: string; warn: string | null; count: number | null; unit: string; meter: number[] | null; meterLabel: string | null };

function rowSummary(module: Module, moduleResponses: Response[], questions: Question[], photos: Photo[], posts: Post[]): RowSummary {
  const type = typeLabel(module.type);
  const answers = moduleResponses.map((response) => response.answer);
  switch (module.type) {
    case "poll": {
      const tally = module.options.map((option) => answers.filter((answer) => answer === option).length);
      const total = moduleResponses.length;
      const top = tally.length && total ? tally.indexOf(Math.max(...tally)) : -1;
      return {
        line: top >= 0 && tally[top] > 0 ? `${type} · 1위 ${module.options[top]} ${Math.round((tally[top] / total) * 100)}%` : `${type} · 선택지 ${module.options.length}개`,
        warn: null, count: total, unit: "응답",
        meter: total ? tally.slice(0, 3).map((value) => Math.round((value / total) * 100)) : null,
        meterLabel: total ? `선택지별 득표 비율 ${tally.map((value) => `${Math.round((value / total) * 100)}%`).join(", ")}` : null,
      };
    }
    case "quiz": {
      const { right } = quizGradeCounts(module.answer, answers, moduleResponses.map((response) => response.manualGrade));
      const rate = answers.length ? Math.round((right / answers.length) * 100) : null;
      return { line: rate === null ? type : `${type} · 정답률 ${rate}%`, warn: null, count: answers.length, unit: "응답", meter: rate === null ? null : [rate], meterLabel: rate === null ? null : `정답률 ${rate}%` };
    }
    case "survey":
      return { line: type, warn: null, count: moduleResponses.length, unit: "응답", meter: null, meterLabel: null };
    case "qa": {
      const approved = questions.filter((question) => question.approved).length;
      const rate = questions.length ? Math.round((approved / questions.length) * 100) : null;
      return { line: `${type} · 공개 ${approved}`, warn: null, count: questions.length, unit: "질문", meter: rate === null ? null : [rate], meterLabel: rate === null ? null : `공개 비율 ${rate}%` };
    }
    case "draw": {
      const winners = module.drawHistory.reduce((total, result) => total + result.winners.length, 0);
      const latest = module.drawHistory[0] ?? null;
      return {
        line: module.drawHistory.length ? `${type} · 당첨 ${winners}명` : type,
        warn: latest && !latest.published ? "결과 미공개" : null,
        count: module.drawHistory.length, unit: "회", meter: null, meterLabel: null,
      };
    }
    case "photo": {
      const approved = photos.filter((photo) => photo.status === "APPROVED").length;
      const rate = photos.length ? Math.round((approved / photos.length) * 100) : null;
      return { line: `${type} · 승인 ${approved}`, warn: null, count: photos.length, unit: "장", meter: rate === null ? null : [rate], meterLabel: rate === null ? null : `승인 비율 ${rate}%` };
    }
    case "board": {
      const approved = posts.filter((post) => post.status === "APPROVED").length;
      return { line: `${type} · 승인 ${approved}`, warn: null, count: posts.length, unit: "글", meter: null, meterLabel: null };
    }
    default:
      return { line: type, warn: null, count: moduleResponses.length, unit: "응답", meter: null, meterLabel: null };
  }
}

// "Prepared" is only what the type needs to run, read from saved content.
function moduleConfigured(module: Module): boolean {
  switch (module.type) {
    case "poll": return module.options.length >= 2;
    case "quiz": return module.answer.trim() !== "";
    case "survey": return module.questions.length > 0;
    default: return true;
  }
}

// A module whose content attendees already touched keeps its questions
// locked: the server rejects module.save with 409, so the UI disables
// editing with the same guidance instead of letting the save fail.
function editLockReason(module: Module, responseCount: number, questions: Question[]): string | null {
  if (module.type === "qa") {
    return questions.length
      ? "접수된 질문이 있어 콘텐츠 설정을 바꿀 수 없습니다. 질문과 답변은 아래에서 관리하세요."
      : null;
  }
  if (module.type === "draw") {
    return module.drawHistory.length
      ? "추첨 기록이 있어 콘텐츠 설정을 바꿀 수 없습니다. 다른 설정이 필요하면 새 콘텐츠를 만드세요."
      : null;
  }
  if (module.type === "photo" || module.type === "board") return null;
  return responseCount > 0
    ? "접수된 응답이 있어 콘텐츠 설정을 바꿀 수 없습니다. 다른 설정이 필요하면 새 콘텐츠를 만드세요."
    : null;
}

function ModuleCard(props: {
  /** Linked reward count; null when this type has no reward path. */
  rewardCount: number | null;
  reviewCount: number;
  rewardsHref: string;
  returnLink?: { label: string; href: string };
  closeHref: (target: string) => string;
  module: Module;
  featureOn: boolean;
  eventId: string;
  busy: string | null;
  locked: boolean;
  responses: number;
  moduleResponses: Response[];
  submitGrade: (payload: GradePayload, unconfirmed: boolean) => Promise<GradeResult>;
  gradePending: boolean;
  questions: Question[];
  photos: Photo[];
  posts: Post[];
  drawCounts: Record<string, string>;
  setDrawCounts: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  drawFailure: { id: string; message: string; field: string | null } | null;
  answerDrafts: Record<string, string>;
  onAnswerChange: (question: Question, value: string) => void;
  questionConflict: QuestionConflict | null;
  onRefreshQuestionConflict: () => void;
  onResolveQuestionConflict: (choice: "mine" | "latest") => void;
  answerFailure: { id: string; message: string; field: string | null } | null;
  rejectDrafts: Record<string, string>;
  setRejectDrafts: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  rejectFailure: { id: string; editId: string; message: string; field: string | null } | null;
  qaFilter: "all" | "unanswered" | "pending" | "edits";
  onQaFilter: (filter: "all" | "unanswered" | "pending" | "edits") => void;
  photoFilter: "all" | "PENDING" | "APPROVED" | "HIDDEN";
  onPhotoFilter: (filter: "all" | "PENDING" | "APPROVED" | "HIDDEN") => void;
  postFilter: "all" | "PENDING" | "APPROVED" | "HIDDEN";
  onPostFilter: (filter: "all" | "PENDING" | "APPROVED" | "HIDDEN") => void;
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
  publishPending: DrawResult | null;
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
  onApproveQuestionEdit: (question: Question) => void;
  onRejectQuestionEdit: (question: Question, reason: string) => void;
}) {
  const { module } = props;
  const lockReason = editLockReason(module, props.responses, props.questions);
  const latestDraw = module.drawHistory[0] ?? null;
  const reviewedDraw = props.publishPending;
  const reviewedNames = reviewedDraw?.winners.slice(0, 3).map((winner) => winner.name || "이름 미등록").join(", ");
  const reviewedOthers = Math.max(0, (reviewedDraw?.winners.length ?? 0) - 3);
  const statusAction = props.statusPending
    ? props.statusPending.status === "OPEN"
      ? "시작"
      : props.statusPending.status === "CLOSED"
        ? "종료"
        : "준비로 되돌리기"
    : null;
  const summary = rowSummary(module, props.moduleResponses, props.questions, props.photos, props.posts);
  const state = module.status === "OPEN" ? "live" : module.status === "CLOSED" ? "done" : "prep";
  const rowAction = module.status === "DRAFT" ? { label: "시작", to: "OPEN" as const } : module.status === "CLOSED" ? { label: "다시 열기", to: "OPEN" as const } : null;
  const actionsDisabled = props.busy !== null || props.locked || !props.featureOn;
  const facts: EventFacts = {
    status: module.status,
    configured: moduleConfigured(module),
    hasResult: module.type === "draw" ? module.drawHistory.length > 0 : module.status === "CLOSED",
    rewardCount: props.rewardCount,
  };
  const pill = eventPill(facts, props.reviewCount);
  return (
    <li className={styles.moduleCard} data-status={module.status} data-feature-off={props.featureOn ? undefined : "true"}>
      <details className={styles.moduleDetails}>
        <summary className={styles.moduleSummary} data-has-action={rowAction ? "true" : undefined}>
          <ProgramTypeIcon type={module.type} state={state} />
          <span className={styles.moduleName}>
            <h3 className={styles.moduleTitle} id={`module-title-${module.id}`} tabIndex={-1}>{module.title}</h3>
            <span className={styles.moduleLine}>
              <span>{summary.line}</span>
              {props.rewardCount !== null && props.rewardCount > 0 ? <span>경품 {props.rewardCount}</span> : null}
              {summary.warn ? <b className={styles.moduleWarn}>{summary.warn}</b> : null}
              {!props.featureOn ? <b className={styles.moduleWarn}>이 유형이 꺼져 있습니다</b> : null}
              <span className="sr-only"> · {statusLabel(module)}</span>
            </span>
          </span>
          <LifecycleMeter segments={lifecycleSegments(facts)} />
          <span className={styles.moduleCount}>{summary.count !== null && module.status !== "DRAFT" ? <><b>{summary.count}</b>{summary.unit}</> : null}</span>
          <StatusPill tone={eventPillTone(pill.tone)} dot={pill.tone === "live"} align="end">{pill.label}</StatusPill>
        </summary>
        <div className={styles.moduleBody}>
          <EventStepper steps={lifecycleSteps(facts)} rewardsHref={props.rewardsHref} rewardCount={props.rewardCount} />
          {!props.featureOn ? (
            <p className={styles.featureOff} role="note">
              이 유형이 꺼져 있습니다.{" "}
              <ProductLink href={props.closeHref(`/console/events/${encodeURIComponent(props.eventId)}/settings#settings-features`)}>행사 설정</ProductLink>에서
              기능을 먼저 켜세요.
            </p>
          ) : null}
          {lockReason ? <p className={styles.lockNote}>{lockReason}</p> : null}
          {module.type === "quiz" && module.revealed ? (
            <p className={styles.detail}>공개된 정답: {module.answer || "정답 확인 필요"}</p>
          ) : null}
          {module.type === "quiz" && module.published && !module.revealed && (module.status === "OPEN" || module.status === "CLOSED") ? (
            <>
              <p>
                <ProductButton
                  type="button"
                  variant="secondary"
                  disabled={actionsDisabled}
                  onClick={props.onRequestReveal}
                >
                  {props.busy === `reveal:${module.id}` ? "공개 중…" : "퀴즈 정답 공개"}
                </ProductButton>
              </p>
              {props.revealPending ? (
                <ConsoleConfirm
                  summary={`“${module.title}” 퀴즈 정답을 공개할까요? 공개하면 콘텐츠가 종료됩니다.`}
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
            <ProductButton
              type="button"
              variant="secondary"
              disabled={props.busy !== null || props.locked || !props.featureOn || module.status !== "OPEN"}
              onClick={props.onRequestDraw}
            >
              {props.busy === `draw:${module.id}` ? "실행 중…" : "추첨 실행"}
            </ProductButton>
            {latestDraw && !latestDraw.published ? (
              <ProductButton
                type="button"
                variant="secondary"
                disabled={props.busy !== null || props.locked || !props.featureOn}
                onClick={props.onRequestPublishDraw}
              >
                {props.busy === `publish:${module.id}` ? "공개 중…" : "최신 결과 공개"}
              </ProductButton>
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
          {reviewedDraw && reviewedDraw.id === latestDraw?.id && !latestDraw.published ? (
            <ConsoleConfirm
              summary={`당첨자 ${reviewedNames || "없음"}${reviewedOthers ? ` 외 ${reviewedOthers}명` : ""}의 결과를 참가자에게 공개할까요?`}
              confirmLabel="공개한다"
              busy={props.busy !== null}
              onConfirm={props.onConfirmPublishDraw}
              onCancel={props.onCancelPublishDraw}
            />
          ) : reviewedDraw && reviewedDraw.id !== latestDraw?.id ? (
            <p className={styles.fieldError} role="status">추첨 결과가 바뀌었습니다. 최신 결과를 검토한 뒤 공개하세요.</p>
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
            <ProductLink href={props.closeHref(`/console/events/${encodeURIComponent(props.eventId)}/draws`)}>추첨</ProductLink> 화면에서 관리합니다.
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
          onAnswerChange={props.onAnswerChange}
          questionConflict={props.questionConflict}
          onRefreshQuestionConflict={props.onRefreshQuestionConflict}
          onResolveQuestionConflict={props.onResolveQuestionConflict}
          answerFailure={props.answerFailure}
          rejectDrafts={props.rejectDrafts}
          setRejectDrafts={props.setRejectDrafts}
          rejectFailure={props.rejectFailure}
          filter={props.qaFilter}
          onFilterChange={props.onQaFilter}
          onManage={props.onManageQuestion}
          onApproveEdit={props.onApproveQuestionEdit}
          onRejectEdit={props.onRejectQuestionEdit}
        />
      ) : null}
      {module.type === "photo" ? (
        <PhotoList photos={props.photos} busy={props.busy} locked={props.locked} featureOn={props.featureOn} eventId={props.eventId} pending={props.photoPending} filter={props.photoFilter} onFilterChange={props.onPhotoFilter} onRequestModerate={props.onRequestModeratePhoto} onConfirmModerate={props.onConfirmModeratePhoto} onCancelModerate={props.onCancelModeratePhoto} />
      ) : null}
      {module.type === "board" ? (
        <PostList posts={props.posts} busy={props.busy} locked={props.locked} featureOn={props.featureOn} pending={props.postPending} filter={props.postFilter} onFilterChange={props.onPostFilter} onRequestModerate={props.onRequestModeratePost} onConfirmModerate={props.onConfirmModeratePost} onCancelModerate={props.onCancelModeratePost} />
      ) : null}
      <ResultSummary
        module={module}
        moduleResponses={props.moduleResponses}
        submitGrade={props.submitGrade}
        gradePending={props.gradePending}
        locked={props.locked || props.busy !== null || !props.featureOn}
        questions={props.questions}
        photos={props.photos}
        posts={props.posts}
      />
          <div className={styles.moduleFoot}>
            <ProductButton
              type="button"
              variant="ghost"
              disabled={lockReason !== null || props.locked || !props.featureOn}
              title={lockReason ?? undefined}
              onClick={props.onEdit}
            >
              편집
            </ProductButton>
            {module.status === "OPEN" ? (
              <ProductButton type="button" variant="ghost" disabled={actionsDisabled} onClick={() => props.onRequestStatus("CLOSED")}>종료</ProductButton>
            ) : null}
          </div>
        </div>
      </details>
      {rowAction ? (
        <ProductButton type="button" variant="ghost" className={styles.rowAction} disabled={actionsDisabled} onClick={() => props.onRequestStatus(rowAction.to)}>{rowAction.label}</ProductButton>
      ) : null}
      {props.statusPending && statusAction ? (
        <ConsoleConfirm
          summary={`“${module.title}” 콘텐츠를 ${statusAction}할까요?`}
          confirmLabel={`${statusAction}한다`}
          busy={props.busy !== null}
          onConfirm={props.onConfirmStatus}
          onCancel={props.onCancelStatus}
        />
      ) : null}
      {props.returnLink ? <ProductLink variant="secondary" className={styles.returnLink} href={props.returnLink.href}>{props.returnLink.label}</ProductLink> : null}
    </li>
  );
}

// Result summary uses the loaded workspace; quiz grading reuses the existing
// program write scope and the event-command receipt path. Option tallies (poll), free-text
// answer distribution plus 정답/오답/미채점 grading against the stored answer
// (quiz), per-question count + average reusing the reports snapshot math
// (survey),
// answered/unanswered counts (qa), and approved/pending counts (photo/board).
// Stamp has no dedicated store in this workspace, so it reports the response
// total like the default branch. Shown inline in the expanded row (no second
// fold); 진행/편집/잠금 rules live elsewhere and are untouched.
function ResultSummary(props: {
  module: Module;
  locked: boolean;
  moduleResponses: Response[];
  submitGrade: (payload: GradePayload, unconfirmed: boolean) => Promise<GradeResult>;
  gradePending: boolean;
  questions: Question[];
  photos: Photo[];
  posts: Post[];
}) {
  const { module } = props;
  if (module.type === "draw") return null;
  const total = props.moduleResponses.length;
  return (
    <section className={styles.resultSection} aria-label="결과">
      {module.type === "poll" ? (
        <ul className={styles.resultBars}>
          {module.options.length ? (
            module.options.map((option) => {
              const count = props.moduleResponses.filter((response) => response.answer === option).length;
              return (
                <li key={option}>
                  <span>{option}</span>
                  <span className={styles.resultBar} aria-hidden="true"><i style={{ width: `${total ? Math.round((count / total) * 100) : 0}%` }} /></span>
                  <span>{count}건</span>
                </li>
              );
            })
          ) : (
            <li>선택지가 없습니다.</li>
          )}
          <li className={styles.resultTotal}>전체 응답 {total}건</li>
        </ul>
      ) : null}
      {module.type === "quiz" ? (
        <>
          <p className={styles.detail}>{quizGradeSummary(module.answer, props.moduleResponses.map(response => response.answer), props.moduleResponses.map(response => response.manualGrade))}</p>
          <p className={styles.detail}>자동 비교는 앞뒤 공백을 제외한 완전 일치 기준입니다. 수동 채점이 있으면 해당 결과를 우선합니다.</p>
          <QuizGrading moduleId={module.id} responses={props.moduleResponses} locked={props.locked} pending={props.gradePending} submit={props.submitGrade} />
          <p className={styles.detail}>원본 답변 분포</p>
          <ul className={styles.resultList}>
            {quizAnswerGroups(props.moduleResponses.map((response) => response.answer)).map((group) => (
              <li key={group.label}>
                {group.label} · {group.count}건
              </li>
            ))}
            <li>전체 응답 {total}건</li>
          </ul>
        </>
      ) : null}
      {module.type === "survey" ? (
        <ul className={styles.resultList}>
          {(module.questions.length ? module.questions : ["전반적인 만족도", "콘텐츠 구성", "현장 운영", "행사장 편의성", "재참석 의향"]).map((name) => {
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
          <li>전체 응답 {total}건</li>
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
        <p className={styles.detail}>응답 {total}건</p>
      ) : null}
    </section>
  );
}

function QuestionList(props: {
  questions: Question[];
  busy: string | null;
  locked: boolean;
  featureOn: boolean;
  answerDrafts: Record<string, string>;
  onAnswerChange: (question: Question, value: string) => void;
  questionConflict: QuestionConflict | null;
  onRefreshQuestionConflict: () => void;
  onResolveQuestionConflict: (choice: "mine" | "latest") => void;
  answerFailure: { id: string; message: string; field: string | null } | null;
  rejectDrafts: Record<string, string>;
  setRejectDrafts: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  rejectFailure: { id: string; editId: string; message: string; field: string | null } | null;
  filter: "all" | "unanswered" | "pending" | "edits";
  onFilterChange: (filter: "all" | "unanswered" | "pending" | "edits") => void;
  onManage: (question: Question, approved: boolean) => void;
  onApproveEdit: (question: Question) => void;
  onRejectEdit: (question: Question, reason: string) => void;
}) {
  const { filter, onFilterChange } = props;
  const [limit, setLimit] = useState(MODERATION_PAGE_SIZE);
  if (!props.questions.length) return <p className={styles.help}>등록된 질문이 없습니다.</p>;
  const unanswered = props.questions.filter((question) => !question.answer.trim()).length;
  const pending = props.questions.filter((question) => !question.approved).length;
  const filtered = props.questions.filter((question) => {
    if (props.questionConflict?.id === question.id) return true;
    if (filter === "unanswered") return !question.answer.trim();
    if (filter === "pending") return !question.approved;
    if (filter === "edits") return Boolean(question.pendingEdit);
    return true;
  });
  const shown = filtered.slice(0, limit);
  const conflictQuestion = filtered.find((question) => question.id === props.questionConflict?.id);
  if (conflictQuestion && !shown.some((question) => question.id === conflictQuestion.id)) shown.push(conflictQuestion);
  const remaining = filtered.length - shown.length;
  return (
    <>
      <p className={styles.itemMeta} role="status">
        미답변 {unanswered}건 · 승인 대기 {pending}건 · 전체 조건 {filtered.length}건 중 {shown.length}건 표시
      </p>
      <p className={styles.itemMeta}>
        <label htmlFor={`qa-filter-${props.questions[0]?.moduleId ?? "all"}`}>질문 상태별 보기</label>{" "}
        <select
          id={`qa-filter-${props.questions[0]?.moduleId ?? "all"}`}
          value={filter}
          onChange={(event) => {
            onFilterChange(event.target.value as "all" | "unanswered" | "pending" | "edits");
            setLimit(MODERATION_PAGE_SIZE);
          }}
        >
          <option value="all">전체 질문</option>
          <option value="unanswered">미답변만</option>
          <option value="pending">승인 대기만</option>
          <option value="edits">수정안 대기만</option>
        </select>
      </p>
      <ul className={styles.itemList}>
        {shown.map((question) => {
          const failure = props.answerFailure?.id === question.id ? props.answerFailure : null;
          const conflict = props.questionConflict?.id === question.id ? props.questionConflict : null;
          const rejectionFailure = props.rejectFailure?.id === question.id && props.rejectFailure.editId === question.pendingEdit?.id ? props.rejectFailure : null;
          return (
            <li key={question.id} id={`moderation-question-${question.id}`} tabIndex={-1} className={styles.itemRow}>
              <p className={styles.itemText}><strong>{question.name}</strong> · {question.text}</p>
              <p className={styles.itemMeta}>
                {question.approved ? "공개됨" : "대기 중"} · 좋아요 {question.likes}개
                {question.answer ? ` · 답변: ${question.answer}` : " · 답변 없음"}
              </p>
              {conflict ? <section className={styles.detail} aria-labelledby={`question-conflict-${question.id}`}>
                <h4 id={`question-conflict-${question.id}`} tabIndex={-1}>질문 또는 답변이 변경되었습니다</h4>
                <p role="status">작성한 답변은 보관했습니다. 최신 내용을 확인하고 어떤 답변으로 계속할지 선택하세요.</p>
                <p><strong>처음 검토한 질문</strong> · {conflict.baseline.text}</p>
                <p><strong>내가 작성한 답변</strong> · {conflict.mine || "답변 없음"}</p>
                {conflict.latest ? <>
                  <p><strong>최신 질문</strong> · {conflict.latest.text}</p>
                  <p><strong>최신 답변</strong> · {conflict.latest.answer || "답변 없음"}</p>
                  <p><strong>현재 공개 상태</strong> · {conflict.latest.approved ? "공개됨" : "비공개"}</p>
                  <p>선택만으로는 저장하거나 공개하지 않습니다.</p>
                  <div className={styles.itemActions}>
                    <ProductButton type="button" variant="secondary" disabled={props.busy !== null || props.locked || !props.featureOn} onClick={() => props.onResolveQuestionConflict("mine")}>내 답변으로 계속</ProductButton>
                    <ProductButton type="button" variant="secondary" disabled={props.busy !== null || props.locked || !props.featureOn} onClick={() => props.onResolveQuestionConflict("latest")}>최신 답변으로 계속</ProductButton>
                  </div>
                </> : null}
                {conflict.error ? <p role="alert">{conflict.error}</p> : null}
                <ProductButton type="button" variant="secondary" disabled={conflict.loading || props.busy !== null} onClick={props.onRefreshQuestionConflict}>
                  {conflict.loading ? "최신 내용 확인 중…" : conflict.latest ? "최신 내용 다시 확인" : "최신 내용 불러오기"}
                </ProductButton>
              </section> : null}
              {question.pendingEdit ? (
                <div className={styles.detail}>
                  <p><strong>수정안 검토 대기</strong></p>
                  <p>수정 후: {question.pendingEdit.text}</p>
                  <p>승인하면 질문이 바뀌며 기존 답변과 좋아요는 유지됩니다.</p>
                  {(props.answerDrafts[question.id] ?? question.answer) !== question.answer
                    ? <p>작성 중인 답변을 먼저 저장하거나 되돌린 뒤 수정안을 승인하세요.</p> : null}
                  <ProductButton type="button" variant="secondary"
                    disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict) || (props.answerDrafts[question.id] ?? question.answer) !== question.answer}
                    onClick={() => props.onApproveEdit(question)}>수정안 승인</ProductButton>
                  <details className={styles.rejectDisclosure}>
                    <summary data-disclosure-indicator="">수정안 반려</summary>
                    <p>기존 질문과 답변은 유지됩니다. 사유는 작성자의 참여 화면에만 표시됩니다.</p>
                    <ValidatedForm onSubmit={(event) => {
                      event.preventDefault();
                      const reason = props.rejectDrafts[question.pendingEdit!.id] ?? "";
                      if (props.busy === null && !props.locked && props.featureOn && !props.questionConflict) props.onRejectEdit(question, reason);
                    }}>
                      <label htmlFor={`reject-reason-${question.id}`}>반려 사유</label>
                      <textarea id={`reject-reason-${question.id}`} data-resize-none="true" rows={3} maxLength={300} required
                        value={props.rejectDrafts[question.pendingEdit.id] ?? ""} disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict)}
                        aria-invalid={Boolean(rejectionFailure)} aria-describedby={rejectionFailure ? `reject-reason-${question.id}-error` : undefined}
                        onChange={(event) => props.setRejectDrafts((current) => ({ ...current, [question.pendingEdit!.id]: event.target.value }))} />
                      {rejectionFailure ? <p className={styles.fieldError} id={`reject-reason-${question.id}-error`} role="alert">{rejectionFailure.message}</p> : null}
                      <ProductButton type="submit" variant="secondary" disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict)}>
                        사유를 전달하고 반려
                      </ProductButton>
                    </ValidatedForm>
                  </details>
                </div>
              ) : null}
              <label htmlFor={`answer-${question.id}`}>답변</label>
              <textarea data-resize-none="true"
                id={`answer-${question.id}`}
                rows={2}
                maxLength={500}
                disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict)}
                value={props.answerDrafts[question.id] ?? question.answer}
                aria-invalid={failure?.field === "answer"}
                aria-describedby={failure ? `answer-${question.id}-error` : undefined}
                onChange={(event) => props.onAnswerChange(question, event.target.value)}
              />
              {failure ? <p className={styles.fieldError} id={`answer-${question.id}-error`} role="alert">{failure.message}</p> : null}
              <div className={styles.itemActions}>
                <ProductButton
                  type="button"
                  variant="secondary"
                  disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict)}
                  onClick={() => props.onManage(question, question.approved)}
                >
                  {question.approved ? "답변 저장·공개 유지" : "답변 저장"}
                </ProductButton>
                {question.approved ? (
                  <ProductButton
                    type="button"
                    variant="secondary"
                    disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict)}
                    onClick={() => props.onManage(question, false)}
                  >
                    공개 취소
                  </ProductButton>
                ) : (
                  <ProductButton
                    type="button"
                    variant="secondary"
                    disabled={props.busy !== null || props.locked || !props.featureOn || Boolean(props.questionConflict)}
                    onClick={() => props.onManage(question, true)}
                  >
                    승인·공개
                  </ProductButton>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 ? <p className={styles.help}>조건에 맞는 질문이 없습니다.</p> : null}
      {remaining > 0 ? (
        <p className={styles.moreRow}>
          <ProductButton
            type="button"
            variant="secondary"
            onClick={() => {
              const nextIndex = limit;
              setLimit((current) => current + MODERATION_PAGE_SIZE);
              const next = filtered[nextIndex];
              window.setTimeout(() => {
                if (next) document.getElementById(`moderation-question-${next.id}`)?.focus({ preventScroll: false });
              }, 0);
            }}
          >
            더 보기 ({remaining})
          </ProductButton>
        </p>
      ) : null}
    </>
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
  filter: "all" | "PENDING" | "APPROVED" | "HIDDEN";
  onFilterChange: (filter: "all" | "PENDING" | "APPROVED" | "HIDDEN") => void;
  onRequestModerate: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onConfirmModerate: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onCancelModerate: () => void;
}) {
  const { filter, onFilterChange } = props;
  const [limit, setLimit] = useState(MODERATION_PAGE_SIZE);
  const approvedPhotos = props.photos.filter((photo) => photo.status === "APPROVED" && photo.fileId);
  if (!props.photos.length) return <p className={styles.help}>공유된 사진이 없습니다.</p>;
  const pendingCount = props.photos.filter((photo) => photo.status === "PENDING").length;
  const filtered = props.photos.filter((photo) => (filter === "all" ? true : photo.status === filter));
  const shown = filtered.slice(0, limit);
  const remaining = filtered.length - shown.length;
  return (
    <>
      <div className={styles.photoArchiveTools}>
        <p className={styles.help}>승인된 참가자 사진만 ZIP에 담습니다. 검토 대기·반려 사진은 제외되며, 1,000장·512MB를 넘으면 개별 원본을 저장하세요.</p>
        {approvedPhotos.length ? (
          <a
            className="product-action product-link" data-action-variant="secondary" data-native-control="download"
            href={`/api/events/${encodeURIComponent(props.eventId)}/attendee-photos.zip`}
          >
            승인 사진 ZIP 다운로드 ({approvedPhotos.length}장)
          </a>
        ) : (
          <span className={styles.itemMeta}>다운로드할 승인 사진이 없습니다.</span>
        )}
      </div>
      <p className={styles.itemMeta} role="status">대기 {pendingCount}건 · 전체 조건 {filtered.length}건 중 {shown.length}건 표시</p>
      <p className={styles.itemMeta}>
        <label htmlFor="photo-status-filter">사진 상태별 보기</label>{" "}
        <select
          id="photo-status-filter"
          value={filter}
          onChange={(event) => {
            onFilterChange(event.target.value as "all" | "PENDING" | "APPROVED" | "HIDDEN");
            setLimit(MODERATION_PAGE_SIZE);
          }}
        >
          <option value="PENDING">대기 중만</option>
          <option value="all">전체</option>
          <option value="APPROVED">승인됨만</option>
          <option value="HIDDEN">반려됨만</option>
        </select>
      </p>
      <ul className={styles.itemList}>
        {shown.map((photo) => (
          <li key={photo.id} id={`moderation-photo-${photo.id}`} tabIndex={-1} className={styles.itemRow}>
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
                  className="product-action product-link" data-action-variant="secondary" data-native-control="download"
                  href={`/api/events/${encodeURIComponent(props.eventId)}/files/${encodeURIComponent(photo.fileId)}`}
                  download={photo.fileName || "photo"}
                >
                  원본 저장
                </a>
              ) : null}
              <ProductButton
                type="button"
                variant="secondary"
                disabled={props.busy !== null || props.locked || !props.featureOn || photo.status === "APPROVED"}
                onClick={() => props.onRequestModerate(photo, "APPROVED")}
              >
                승인
              </ProductButton>
              <ProductButton
                type="button"
                variant="secondary"
                disabled={props.busy !== null || props.locked || !props.featureOn || photo.status === "HIDDEN"}
                onClick={() => props.onRequestModerate(photo, "HIDDEN")}
              >
                반려
              </ProductButton>
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
      {filtered.length === 0 ? <p className={styles.help}>조건에 맞는 사진이 없습니다.</p> : null}
      {remaining > 0 ? (
        <p className={styles.moreRow}>
          <ProductButton
            type="button"
            variant="secondary"
            onClick={() => {
              const nextIndex = limit;
              setLimit((current) => current + MODERATION_PAGE_SIZE);
              const next = filtered[nextIndex];
              window.setTimeout(() => {
                if (next) document.getElementById(`moderation-photo-${next.id}`)?.focus({ preventScroll: false });
              }, 0);
            }}
          >
            더 보기 ({remaining})
          </ProductButton>
        </p>
      ) : null}
    </>
  );
}

function PostList(props: {
  posts: Post[];
  busy: string | null;
  locked: boolean;
  featureOn: boolean;
  pending: { id: string; status: "APPROVED" | "HIDDEN" } | null;
  filter: "all" | "PENDING" | "APPROVED" | "HIDDEN";
  onFilterChange: (filter: "all" | "PENDING" | "APPROVED" | "HIDDEN") => void;
  onRequestModerate: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onConfirmModerate: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onCancelModerate: () => void;
}) {
  const { filter, onFilterChange } = props;
  const [limit, setLimit] = useState(MODERATION_PAGE_SIZE);
  if (!props.posts.length) return <p className={styles.help}>작성된 게시글이 없습니다.</p>;
  const pendingCount = props.posts.filter((post) => post.status === "PENDING").length;
  const filtered = props.posts.filter((post) => (filter === "all" ? true : post.status === filter));
  const shown = filtered.slice(0, limit);
  const remaining = filtered.length - shown.length;
  return (
    <>
      <p className={styles.itemMeta} role="status">대기 {pendingCount}건 · 전체 조건 {filtered.length}건 중 {shown.length}건 표시</p>
      <p className={styles.itemMeta}>
        <label htmlFor="post-status-filter">게시글 상태별 보기</label>{" "}
        <select
          id="post-status-filter"
          value={filter}
          onChange={(event) => {
            onFilterChange(event.target.value as "all" | "PENDING" | "APPROVED" | "HIDDEN");
            setLimit(MODERATION_PAGE_SIZE);
          }}
        >
          <option value="PENDING">대기 중만</option>
          <option value="all">전체</option>
          <option value="APPROVED">승인됨만</option>
          <option value="HIDDEN">반려됨만</option>
        </select>
      </p>
      <ul className={styles.itemList}>
        {shown.map((post) => (
          <li key={post.id} id={`moderation-post-${post.id}`} tabIndex={-1} className={styles.itemRow}>
          <p className={styles.itemText}><strong>{post.name}</strong> · {post.body}</p>
          <p className={styles.itemMeta}>{post.status === "APPROVED" ? "승인됨" : post.status === "HIDDEN" ? "반려됨" : "대기 중"}</p>
          <div className={styles.itemActions}>
            <ProductButton
              type="button"
              variant="secondary"
              disabled={props.busy !== null || props.locked || !props.featureOn || post.status === "APPROVED"}
              onClick={() => props.onRequestModerate(post, "APPROVED")}
            >
              승인
            </ProductButton>
            <ProductButton
              type="button"
              variant="secondary"
              disabled={props.busy !== null || props.locked || !props.featureOn || post.status === "HIDDEN"}
              onClick={() => props.onRequestModerate(post, "HIDDEN")}
            >
              반려
            </ProductButton>
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
      {filtered.length === 0 ? <p className={styles.help}>조건에 맞는 게시글이 없습니다.</p> : null}
      {remaining > 0 ? (
        <p className={styles.moreRow}>
          <ProductButton
            type="button"
            variant="secondary"
            onClick={() => {
              const nextIndex = limit;
              setLimit((current) => current + MODERATION_PAGE_SIZE);
              const next = filtered[nextIndex];
              window.setTimeout(() => {
                if (next) document.getElementById(`moderation-post-${next.id}`)?.focus({ preventScroll: false });
              }, 0);
            }}
          >
            더 보기 ({remaining})
          </ProductButton>
        </p>
      ) : null}
    </>
  );
}

function ModuleDialog(props: {
  draft: ModuleDraft;
  busy: boolean;
  locked: boolean;
  frozen: boolean;
  recovery: ReactNode;
  typeEnabled: boolean;
  settingsHref: string;
  failure: Failure | null;
  fieldError: { field: string; message: string } | null;
  canClose: () => boolean;
  onChange: (draft: ModuleDraft) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const { draft, busy, locked, frozen, recovery, typeEnabled, settingsHref, failure, fieldError, canClose, onChange, onClose, onSubmit } = props;
  const titleInputRef = useRef<HTMLInputElement>(null);
  function fieldMessage(field: string): string | null {
    return fieldError?.field === field ? fieldError.message : null;
  }
  return (
    <ConsoleDialog
      title={draft.id ? "이벤트 편집" : "이벤트 만들기"}
      titleId="program-dialog-title"
      onClose={onClose}
      busy={busy}
      canClose={canClose}
      initialFocusRef={titleInputRef}
    >
      <ValidatedForm className={styles.form} onSubmit={onSubmit}>
        <fieldset className={styles.draftFields} disabled={frozen || busy}>
        <legend className="sr-only">콘텐츠 내용</legend>
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
              이 유형은 꺼져 있습니다. <ProductLink href={settingsHref}>행사 설정</ProductLink>에서 기능을 먼저 켜세요.
            </p>
          ) : null}
        </div>
        {draft.type === "poll" ? (
          <div>
            <label htmlFor="program-options">투표 선택지 · 한 줄에 하나씩, 두 개 이상</label>
            <textarea data-resize-none="true"
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
            <textarea data-resize-none="true"
              id="program-questions"
              rows={5}
              value={draft.questionsText}
              placeholder={"전반적인 만족도\n콘텐츠 구성\n현장 운영\n행사장 편의성\n재참석 의향"}
              aria-invalid={fieldError?.field === "questions"}
              aria-describedby={fieldMessage("questions") ? "program-questions-error" : undefined}
              onChange={(event) => onChange({ ...draft, questionsText: event.target.value })}
            />
            {fieldMessage("questions") ? <p className={styles.fieldError} id="program-questions-error" role="alert">{fieldMessage("questions")}</p> : null}
          </div>
        ) : null}
        </fieldset>
        {failure ? <p className={styles.fieldError} role="alert">{failure.message}</p> : null}
        {recovery}
        <ConsoleFormActions>
          <ProductButton
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => { if (!busy && canClose()) onClose(); }}
          >
            취소
          </ProductButton>
          <ProductButton type="submit" variant="primary" disabled={busy || locked || !typeEnabled}>
            {busy ? "저장 중…" : draft.id ? "저장" : "만들기"}
          </ProductButton>
        </ConsoleFormActions>
      </ValidatedForm>
    </ConsoleDialog>
  );
}
