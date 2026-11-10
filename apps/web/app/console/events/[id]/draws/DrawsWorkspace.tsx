"use client";

import ConsoleChoiceGroup from "../../../console-ui/ConsoleChoiceGroup";
import ValidatedForm from "../../../../ui/ValidatedForm";


import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import styles from "./draws.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsDrawOperation, confirmsDrawRun, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt, subscribeOperatorReceipts, visibleOperatorReceipts, type OperatorReceiptPointer } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";
import { readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";
import { boothScheduleTime } from "../../../../../lib/booth-availability";

// Operator screen for the event-plan draw bundle: voting teams + ranked vote
// tally, named draw programs (quota/status/module) with batched runs, and the
// cross-program duplicate rule. Every write goes through the idempotent event
// command path; the server re-checks role, membership, and feature flags.

type Team = { id: string; name: string; order: number };
type Participant = { id: string; name: string; company: string; group: string; status: string; revoked: boolean; luckyEligible: boolean };
type ProgramTierDraft = { key: string; name: string; count: string };
type RoulettePrizeDraft = { id: string; label: string; quantity: string; unlimited: boolean; weight: string };
type DrawProgram = {
  id: string;
  name: string;
  quota: number;
  moduleId: string;
  revision: number;
  status: string;
  published: boolean;
  eligibility: "PERSON" | "COMPANY";
  eligibleGroups: string[];
  eligibleCompanies: string[];
  overlap: "EVENT" | "PROGRAM" | "NONE";
  prizeTiers: Array<{ name: string; count: number }>;
  winners: Array<{ id?: string; name: string; company: string; kind?: "PERSON" | "COMPANY"; tier?: string; luckyNumber?: number | null }>;
  drawnAt: string;
};
type DrawModule = { id: string; title: string; status: string; published: boolean };
type VoteConfig = { pickCount: number; status: "OPEN" | "CLOSED"; resultsPublished: boolean };
type RouletteConfig = {
  status: "DRAFT" | "OPEN" | "CLOSED";
  startsAt: string | null;
  endsAt: string | null;
  prizes: RoulettePrizeDraft[];
};
type RouletteSnapshot = { version: number; config: RouletteConfig };
type RouletteConflict = { loading: boolean; error: string | null; latest: RouletteSnapshot | null };
type VoteTally = {
  results: Array<{ teamId: string; name: string; selections: number; rank: number; tied: boolean }>;
  totalVotes: number;
  published: boolean;
} | null;
type RewardRecord = {
  id: string;
  name: string;
  company: string;
  participantId: string;
  status: string;
  sourceKind: string;
  sourceProgramId: string;
  winnerIndex: number | null;
};

// Names the section in view for the jump-nav active link. The observer
// below iterates these keys, so the map stays the single list of tracked
// sections.
const DRAW_SECTION_LABELS: Record<string, string> = {
  "draws-programs": "무대 추첨",
  "draws-vote": "순위 투표",
  "draws-roulette": "모바일 룰렛",
  "draws-lucky": "럭키번호",
};

// The single list of tracked sections: the observer iterates it and deep
// links resolve against it.
const DRAW_SECTION_IDS = Object.keys(DRAW_SECTION_LABELS);

// Keys that scroll the document when the focus is not inside an editable
// field. Releasing the explicit-jump pin on exactly these (plus wheel and
// touch) hands control back to the scroll spy on genuine user scrolling,
// while programmatic jumps — which fire none of them — keep the chosen
// section without any timeout.
const SCROLL_RELEASE_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      closeSnapshot: CloseSnapshot;
      eventName: string;
      eventMeta?: string;
      archived: boolean;
      features: string[];
      role: string;
      userId: string;
      memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
      drawEnabled: boolean;
      pollEnabled: boolean;
      rewardEnabled: boolean;
      teams: Team[];
      participants: Participant[];
      drawPrograms: DrawProgram[];
      drawModules: DrawModule[];
      voteConfig: VoteConfig;
      voteTally: VoteTally;
      voteTotal: number;
      luckyIssued: number;
      luckyNumbers: Array<{ participantId: string; number: number }>;
      luckyMin: number;
      luckyMax: number;
      rouletteSpun: number;
      rouletteConfig: RouletteConfig;
      rouletteUsedById: Record<string, number>;
      rewards: RewardRecord[];
    };

type Failure = { message: string; field: string | null };

const DRAW_OPERATION_LABELS: Record<string, string> = {
  "team.save": "투표 팀 저장", "draw.program.save": "추첨 프로그램 저장", "vote.config.save": "투표 설정 저장",
  "vote.tally": "투표 집계", "lucky.config.save": "럭키번호 설정 저장", "lucky.config.save-reviewed": "럭키번호 설정 저장", "lucky.preassign": "럭키번호 배정", "lucky.preassign-reviewed": "럭키번호 배정", "lucky.preassign-range-reviewed": "럭키번호 배정",
  "roulette.config.save": "룰렛 설정 저장", "roulette.config.save-reviewed": "룰렛 설정 저장", "reward.assign": "경품 수령자 지정",
};
type DrawOperationAttempt = { eventId: string; command: string; payload: Record<string, unknown>; intent: string; commandId: string; attempt: string };
type LuckyRange = { min: number; max: number };
type LuckyPlan = { eventId: string; ids: string[]; range: LuckyRange; processed: number; stopRequested: boolean };
type LuckyProgress = { total: number; processed: number; phase: "running" | "uncertain" | "stopping" };
const LUCKY_BATCH_SIZE = 5000;

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function localDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const instant = boothScheduleTime(value);
  if (instant === null || !Number.isFinite(instant)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function isoFromLocalDateTime(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const zoned = `${value}:00+09:00`;
  return Number.isFinite(boothScheduleTime(zoned)) ? zoned : null;
}

function rouletteTimeNeedsReview(value: string | null): boolean {
  return Boolean(value) && !Number.isFinite(boothScheduleTime(value));
}

function rouletteStoredTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : "__invalid_roulette_time__";
}

function rouletteSnapshot(workspace: Record<string, unknown>): RouletteSnapshot | null {
  const version = workspace.rouletteConfigVersion;
  if (!Number.isSafeInteger(version) || Number(version) < 0 || !Object.hasOwn(workspace, "rouletteConfig")) return null;
  if (workspace.rouletteConfig === null) return { version: Number(version), config: { status: "DRAFT", startsAt: null, endsAt: null, prizes: [] } };
  const raw = asRecord(workspace.rouletteConfig);
  if (!raw || !["DRAFT", "OPEN", "CLOSED"].includes(String(raw.status)) || !Array.isArray(raw.prizes)) return null;
  const prizes: RoulettePrizeDraft[] = [];
  for (const item of raw.prizes) {
    const prize = asRecord(item);
    if (!prize || typeof prize.id !== "string" || !prize.id || typeof prize.label !== "string" ||
        !(prize.quantity === null || (Number.isSafeInteger(prize.quantity) && Number(prize.quantity) >= 0)) ||
        !(prize.weight === undefined || prize.weight === null || (Number.isSafeInteger(prize.weight) && Number(prize.weight) >= 0))) return null;
    prizes.push({ id: prize.id, label: prize.label, quantity: prize.quantity === null ? "" : String(prize.quantity),
      unlimited: prize.quantity === null, weight: typeof prize.weight === "number" ? String(prize.weight) : "" });
  }
  return { version: Number(version), config: { status: raw.status as RouletteConfig["status"], startsAt: rouletteStoredTime(raw.startsAt), endsAt: rouletteStoredTime(raw.endsAt), prizes } };
}

function rouletteTimeDescription(value: string | null): string {
  if (!value) return "제한 없음";
  const instant = boothScheduleTime(value);
  if (instant === null || !Number.isFinite(instant)) return "시간 확인 필요";
  return `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", ...(instant % 1000 ? { fractionalSecondDigits: 3 as const } : {}), hourCycle: "h23" }).format(instant)} (한국 시간)`;
}

function roulettePrizeDescription(prizes: RoulettePrizeDraft[]): string {
  return prizes.length ? prizes.map((p) => `${p.label || "이름 미입력"} · ${p.unlimited ? "무제한" : `${p.quantity || "수량 미입력"}개`} · ${p.weight ? `가중치 ${p.weight}` : "기본 가중치"}`).join(" / ") : "등록된 경품 없음";
}

function luckySelection(people: Participant[], numbers: Array<{ participantId: string; number: number }>) {
  const counts = new Map<string, number>();
  for (const person of people) counts.set(person.id, (counts.get(person.id) ?? 0) + 1);
  const assigned = new Set(numbers.map((entry) => entry.participantId));
  const eligible = people.filter((person) => person.status === "APPROVED" && person.luckyEligible && counts.get(person.id) === 1);
  const excluded = people.filter((person) => person.status === "APPROVED" && (!person.luckyEligible || counts.get(person.id) !== 1)).length;
  return { eligible, excluded, missing: eligible.filter((person) => !assigned.has(person.id)) };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class DrawRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly code?: string) { super(message); }
}

export default function DrawsWorkspace({ eventId }: { eventId: string }) {
  const closeHref = useEventCloseHandoff(eventId);
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [activeSection, setActiveSection] = useState("draws-programs");
  // Explicit-jump priority: a jump or deep link names its section at once
  // and pins it past the scroll spy, which watches tiny headings in a
  // narrow band and can never see a bottom-of-page section arrive. Only a
  // genuine wheel, touch, or scroll-key releases the pin.
  const navPinRef = useRef<string | null>(null);
  const followJumpedSection = useCallback((id: string) => {
    navPinRef.current = id;
    setActiveSection(id);
  }, []);
  useEffect(() => {
    const releaseJumpPin = () => { navPinRef.current = null; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_RELEASE_KEYS.has(event.key)) return;
      // Keystrokes inside an editable control drive that control, not the
      // document: arrows moving through a field must not release the pin.
      const target = event.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest("input, select, textarea, [contenteditable]")) return;
      releaseJumpPin();
    };
    window.addEventListener("wheel", releaseJumpPin, { passive: true });
    window.addEventListener("touchmove", releaseJumpPin, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", releaseJumpPin);
      window.removeEventListener("touchmove", releaseJumpPin);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One grammar for the commands that cannot be undone: the screen states
  // the effect, the operator confirms in place.
  const [programFormOpen, setProgramFormOpen] = useState(false);
  // Validated roulette settings travel with the confirmation, so the saved
  // values are the ones the summary was based on.
  const roulettePayloadRef = useRef<{
    prizes: Array<{ id: string; label: string; quantity: number | null; weight?: number }>;
    startsAt: string;
    endsAt: string;
    status: RouletteConfig["status"];
    expectedVersion: number;
  } | null>(null);
  const rouletteBaseRef = useRef<RouletteConfig | null>(null);
  const rouletteVersionRef = useRef<number | null>(null);
  const rouletteReviewedStatusRef = useRef<RouletteConfig["status"] | null>(null);
  const [rouletteConflict, setRouletteConflict] = useState<RouletteConflict | null>(null);
  const rouletteConflictRead = useRef<symbol | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: "programStatus"; program: DrawProgram; status: "DRAFT" | "OPEN" | "CLOSED"; summary: string }
    | { kind: "publishEmptyProgram"; program: DrawProgram; summary: string }
    | { kind: "run"; program: DrawProgram; count: number; toStage: boolean; summary: string }
    | { kind: "lucky"; summary: string }
    | { kind: "roulette"; summary: string }
  | null>(null);
  const [teamName, setTeamName] = useState("");
  const [programName, setProgramName] = useState("");
  const [programQuota, setProgramQuota] = useState("");
  const [programModuleId, setProgramModuleId] = useState("");
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [programEligibility, setProgramEligibility] = useState<"PERSON" | "COMPANY">("PERSON");
  const [programGroups, setProgramGroups] = useState<string[]>([]);
  const [programCompanies, setProgramCompanies] = useState<string[]>([]);
  const [programOverlap, setProgramOverlap] = useState<"EVENT" | "PROGRAM" | "NONE">("EVENT");
  const [programTiers, setProgramTiers] = useState<ProgramTierDraft[]>([]);
  const [groupDraft, setGroupDraft] = useState("");
  const [companyDraft, setCompanyDraft] = useState("");
  const [runCounts, setRunCounts] = useState<Record<string, string>>({});
  const [votePickCount, setVotePickCount] = useState("5");
  const [voteStatus, setVoteStatus] = useState<"OPEN" | "CLOSED">("CLOSED");
  const [voteResultsPublished, setVoteResultsPublished] = useState(false);
  const [luckyMin, setLuckyMin] = useState("1");
  const [luckyMax, setLuckyMax] = useState("900");
  const luckyRangeDraftRef = useRef({ min: "1", max: "900" });
  const luckyRangeBaselineRef = useRef<{ min: string; max: string } | null>(null);
  const luckyRangeEditBaseRef = useRef<LuckyRange | null>(null);
  const luckyRangeRevisionRef = useRef(0);
  const [luckyRangeConflict, setLuckyRangeConflict] = useState<{ loading: boolean; ready: boolean } | null>(null);
  const [preassignAllApproved, setPreassignAllApproved] = useState(false);
  const luckyDraftRef = useRef<{ ids: string[]; range: LuckyRange } | null>(null);
  const luckyPlanRef = useRef<LuckyPlan | null>(null);
  const luckyRunnerRef = useRef<symbol | null>(null);
  const [luckyProgress, setLuckyProgress] = useState<LuckyProgress | null>(null);
  useEffect(() => () => { luckyDraftRef.current = null; luckyPlanRef.current = null; }, [eventId]);
  const [rouletteStatus, setRouletteStatus] = useState<"DRAFT" | "OPEN" | "CLOSED">("DRAFT");
  const [rouletteStartsAt, setRouletteStartsAt] = useState("");
  const [rouletteEndsAt, setRouletteEndsAt] = useState("");
  const [rouletteStartChanged, setRouletteStartChanged] = useState(false);
  const [rouletteEndChanged, setRouletteEndChanged] = useState(false);
  const [rouletteStartCleared, setRouletteStartCleared] = useState(false);
  const [rouletteEndCleared, setRouletteEndCleared] = useState(false);
  const [roulettePrizes, setRoulettePrizes] = useState<RoulettePrizeDraft[]>([
    { id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" },
  ]);
  const [rewardRecipient, setRewardRecipient] = useState<Record<string, string>>({});
  const [tallyLoading, setTallyLoading] = useState(false);
  // A lost response must replay the same receipt, not start another draw.
  const pendingCommands = useRef(new Map<string, { id: string; uncertain: boolean }>());
  const [pendingDraw, setPendingDraw] = useState<{ program: DrawProgram; count: number; toStage: boolean; commandId: string; attempt: string } | null>(null);
  const [conflictedProgram, setConflictedProgram] = useState<Pick<DrawProgram, "id" | "name"> | null>(null);
  const conflictPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = conflictPanelRef.current;
    if (!panel || document.activeElement !== document.body) return;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: "center", behavior: "instant" });
  }, [conflictedProgram, state.kind]);
  const [receiptItems, setReceiptItems] = useState<OperatorReceiptPointer[]>([]);
  const [rememberedDrawReceipt, setRememberedDrawReceipt] = useState<OperatorReceiptPointer | null>(null);
  const [checkingDraw, setCheckingDraw] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<DrawOperationAttempt | null>(null);
  const pendingOperationRef = useRef<DrawOperationAttempt | null>(null);
  const [checkingOperation, setCheckingOperation] = useState(false);
  const [refreshingOtherOperation, setRefreshingOtherOperation] = useState(false);
  const hadOtherOperationReceiptRef = useRef(false);
  const [operationRecoveryError, setOperationRecoveryError] = useState<string | null>(null);
  const [abandonOperation, setAbandonOperation] = useState(false);
  const operationInFlightRef = useRef<symbol | null>(null);
  const operationFocusOriginRef = useRef<Element | null>(null);
  const activeDrawEventRef = useRef(eventId);
  const loadedDrawEventRef = useRef<string | null>(null);
  activeDrawEventRef.current = eventId;
  const eventReceipts = useEventReceipts(eventId);
  const otherOperationReceipt = eventReceipts.some((item) => Object.hasOwn(DRAW_OPERATION_LABELS, item.command) &&
    item.commandId !== pendingOperation?.commandId && ![...pendingCommands.current.values()].some((pending) => pending.id === item.commandId));
  const operatorContext = useOperatorContextSnapshot();
  useEffect(() => pendingOperation && state.kind === "ready" ? manageOperatorReceipt(pendingOperation.commandId) : undefined, [pendingOperation, state.kind]);
  useEffect(() => {
    if (!pendingOperation) return;
    const frame = window.requestAnimationFrame(() => {
      const origin = operationFocusOriginRef.current;
      const active = document.activeElement;
      if (active && active !== document.body && active !== origin && active.isConnected) return;
      const heading = document.getElementById("draw-operation-recovery-heading");
      heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingOperation?.commandId]);
  useEffect(() => {
    const update = () => setReceiptItems(visibleOperatorReceipts());
    update();
    return subscribeOperatorReceipts(update);
  }, []);
  const drawReceipt = receiptItems.find((item) => item.eventId === eventId && item.command === "draw.program.run" &&
    item.userId === operatorContext.context?.userId && item.organizationId === operatorContext.context?.organizationId) ?? null;
  useEffect(() => {
    setPendingDraw(null); setRememberedDrawReceipt(null); pendingOperationRef.current = null;
    setConflictedProgram(null);
    setPendingOperation(null); setOperationRecoveryError(null); setAbandonOperation(false);
    setRefreshingOtherOperation(false); hadOtherOperationReceiptRef.current = false;
  }, [eventId]);
  useEffect(() => { if (drawReceipt) setRememberedDrawReceipt(drawReceipt); }, [drawReceipt]);
  const programFormRef = useRef<HTMLFormElement>(null);

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 읽기만 둡니다. 역할·멤버십 게이트는 그대로 둡니다.
  const writeLocked = (state.kind === "ready" && state.archived) || Boolean(luckyProgress || pendingDraw || drawReceipt || rememberedDrawReceipt || pendingOperation || otherOperationReceipt || refreshingOtherOperation || (hadOtherOperationReceiptRef.current && !otherOperationReceipt));

  // Cross-route guard predicates: actual editing diffs plus retained
  // idempotent keys (an ambiguous outcome whose same-request retry is still
  // available). Read-only filters and the section picker stay unguarded;
  // clean saves delete their keys and reset their inputs, so they warn
  // nothing.
  //
  // A default empty prize row is not an edit: it is filtered before the
  // baseline compare so a pristine view stays clean, while any real input
  // (including a half-filled row) still guards.
  const normalizedPrizes = roulettePrizes
    .filter((prize) => prize.label.trim() !== "" || prize.quantity !== "" || prize.weight !== "" || prize.unlimited)
    .map((prize) => ({ ...prize, label: prize.label.trim() }));
  const drawsDirty = state.kind === "ready" && (
    teamName.trim() !== "" ||
    editingProgramId !== null ||
    programName.trim() !== "" || programQuota !== "" || programModuleId !== "" ||
    programTiers.length > 0 || programGroups.length > 0 || programCompanies.length > 0 ||
    groupDraft.trim() !== "" || companyDraft.trim() !== "" ||
    programEligibility !== "PERSON" || programOverlap !== "EVENT" ||
    votePickCount !== String(state.voteConfig.pickCount) ||
    voteStatus !== state.voteConfig.status ||
    voteResultsPublished !== state.voteConfig.resultsPublished ||
    luckyMin !== String(state.luckyMin) || luckyMax !== String(state.luckyMax) ||
    rouletteStatus !== (rouletteBaseRef.current ?? state.rouletteConfig).status ||
    rouletteStartsAt !== localDateTime((rouletteBaseRef.current ?? state.rouletteConfig).startsAt) ||
    rouletteEndsAt !== localDateTime((rouletteBaseRef.current ?? state.rouletteConfig).endsAt) ||
    rouletteStartChanged || rouletteEndChanged ||
    JSON.stringify(normalizedPrizes) !== JSON.stringify((rouletteBaseRef.current ?? state.rouletteConfig).prizes) ||
    pendingCommands.current.size > 0 || Boolean(luckyProgress)
  );
  useConsoleDraftGuard(drawsDirty, "작성 중인 추첨·투표 설정이 있습니다.");

  async function load(silent = false, preserveFailure = false, preserveLuckyDraft = false) {
    const requestEventId = eventId;
    const luckyRevision = luckyRangeRevisionRef.current;
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
      ]);
      if (activeDrawEventRef.current !== requestEventId) return false;
      if (meRes.status === 401 || bootRes.status === 401) {
        if (silent && (pendingOperationRef.current || pendingDraw)) { setOperationRecoveryError("최신 결과를 불러오지 못했습니다. 현재 계정과 행사 권한을 확인하세요."); return false; }
        if (preserveFailure) return false;
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
      if (activeDrawEventRef.current !== requestEventId) return false;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        if (silent && (pendingOperationRef.current || pendingDraw)) { setOperationRecoveryError("최신 결과를 불러오지 못했습니다. 잠시 후 다시 확인하세요."); return false; }
        if (preserveFailure) return false;
        setState({ kind: "failed", message: "추첨·투표 정보를 불러오지 못했습니다." });
        return;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      // Raw membership grants ride along untouched: omitted write reads as
      // full access, an explicit [] as read-only. Render gates below
      // re-check per scope (draw/vote/lucky/roulette programs, team
      // config and display linkage are programs; 업체 수령자 지정 is
      // reward.assign in results) through the capability helper.
      const memberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            const membership = asRecord(item);
            if (!membership || typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
          })
        : [];
      const event = Array.isArray(bootstrap.events)
        ? bootstrap.events.flatMap((item) => {
            const record = asRecord(item);
            return record && record.id === eventId ? [record] : [];
          })[0]
        : undefined;
      const workspace = asRecord(bootstrap.workspaces?.[eventId]);
      if (!event || !workspace) {
        if (silent && (pendingOperationRef.current || pendingDraw)) { setOperationRecoveryError("최신 결과를 불러오지 못했습니다. 행사 접근 권한을 확인하세요."); return false; }
        if (preserveFailure) return false;
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return;
      }
      const clientName = Array.isArray(bootstrap.clients)
        ? bootstrap.clients
            .map(asRecord)
            .find((client) => client?.id === event.clientId)?.name
        : "";
      const venue = asRecord(workspace.venue);
      const teams: Team[] = Array.isArray(workspace.teams)
        ? workspace.teams.flatMap((item) => {
            const team = asRecord(item);
            if (!team || typeof team.id !== "string" || typeof team.name !== "string") return [];
            return [{ id: team.id, name: team.name, order: Number(team.order) || 0 }];
          }).sort((a, b) => a.order - b.order)
        : [];
      const participants: Participant[] = Array.isArray(workspace.participants)
        ? workspace.participants.flatMap((item) => {
            const person = asRecord(item);
            if (!person || typeof person.id !== "string") return [];
            return [{
              id: person.id,
              name: text(person.name, "이름 없음"),
              company: text(person.company),
              group: text(person.group),
              status: text(person.status).toUpperCase(),
              revoked: person.revoked === true,
              luckyEligible: (person.revoked == null || person.revoked === false) && (person.cancelled == null || person.cancelled === false),
            }];
          })
        : [];
      const drawPrograms: DrawProgram[] = Array.isArray(workspace.drawPrograms)
        ? workspace.drawPrograms.flatMap((item) => {
            const program = asRecord(item);
            if (!program || typeof program.id !== "string") return [];
            const winners = Array.isArray(program.winners)
              ? program.winners.flatMap((winner) => {
                  const entry = asRecord(winner);
                  if (!entry || typeof entry.name !== "string") return [];
                    const kind: "PERSON" | "COMPANY" | undefined =
                      entry.kind === "PERSON" || entry.kind === "COMPANY" ? entry.kind : undefined;
                    return [{
                      id: typeof entry.id === "string" ? entry.id : undefined,
                      name: entry.name,
                      company: text(entry.company),
                      ...(kind ? { kind } : {}),
                      ...(typeof entry.tier === "string" ? { tier: entry.tier } : {}),
                      ...(typeof entry.luckyNumber === "number" || entry.luckyNumber === null
                        ? { luckyNumber: entry.luckyNumber as number | null }
                        : {}),
                    }];
                })
              : [];
            return [{
              id: program.id,
              name: text(program.name, "이름 없는 추첨"),
              quota: typeof program.quota === "number" ? program.quota : 0,
              moduleId: text(program.moduleId),
              revision: typeof program.revision === "number" && Number.isSafeInteger(program.revision) && program.revision >= 0 ? program.revision : 0,
              status: text(program.status, "DRAFT"),
              published: program.published === true,
              eligibility: program.eligibility === "COMPANY" ? "COMPANY" : "PERSON",
              eligibleGroups: Array.isArray(program.eligibleGroups) ? program.eligibleGroups.filter((item): item is string => typeof item === "string") : [],
              eligibleCompanies: Array.isArray(program.eligibleCompanies) ? program.eligibleCompanies.filter((item): item is string => typeof item === "string") : [],
              overlap: program.overlap === "PROGRAM" || program.overlap === "NONE" ? program.overlap : "EVENT",
              prizeTiers: Array.isArray(program.prizeTiers)
                ? program.prizeTiers.flatMap((item) => {
                    const tier = asRecord(item);
                    if (!tier || typeof tier.name !== "string" || typeof tier.count !== "number") return [];
                    return [{ name: tier.name, count: tier.count }];
                  })
                : [],
              winners,
              drawnAt: text(program.drawnAt),
            }];
          })
        : [];
      const drawModules: DrawModule[] = Array.isArray(workspace.modules)
        ? workspace.modules.flatMap((item) => {
            const module = asRecord(item);
            if (!module || module.type !== "draw" || typeof module.id !== "string") return [];
            return [{
              id: module.id,
              title: text(module.title, "제목 없는 추첨"),
              status: text(module.status, "DRAFT"),
              published: module.published === true,
            }];
          })
        : [];
      const voteConfigSource = asRecord(workspace.voteConfig);
      const voteConfig: VoteConfig = {
        pickCount: typeof voteConfigSource?.pickCount === "number" ? voteConfigSource.pickCount : 5,
        status: voteConfigSource?.status === "OPEN" ? "OPEN" : "CLOSED",
        resultsPublished: voteConfigSource?.resultsPublished === true,
      };
      let voteTotal = 0;
      if (Array.isArray(workspace.votes)) {
        for (const item of workspace.votes) {
          const vote = asRecord(item);
          if (!vote || !Array.isArray(vote.picks)) continue;
          voteTotal += 1;
        }
      }
      const luckyNumbers = Array.isArray(workspace.luckyNumbers)
        ? workspace.luckyNumbers.flatMap((item) => {
            const number = asRecord(item);
            if (!number || typeof number.participantId !== "string" || typeof number.number !== "number") return [];
            return [{ participantId: number.participantId, number: number.number }];
          })
        : [];
      const luckyConfigSource = asRecord(workspace.luckyConfig);
      const luckyConfigured = Number.isInteger(luckyConfigSource?.min) && Number.isInteger(luckyConfigSource?.max) &&
        Number(luckyConfigSource?.min) >= 1 && Number(luckyConfigSource?.min) <= Number(luckyConfigSource?.max);
      const luckyMin = luckyConfigured ? Number(luckyConfigSource?.min) : 1;
      const luckyMax = luckyConfigured ? Number(luckyConfigSource?.max) : 10000;
      const rouletteConfigSource = asRecord(workspace.rouletteConfig);
      const rouletteConfig: RouletteConfig = {
        status: rouletteConfigSource?.status === "OPEN"
          ? "OPEN"
          : rouletteConfigSource?.status === "CLOSED" ? "CLOSED" : "DRAFT",
        startsAt: rouletteStoredTime(rouletteConfigSource?.startsAt),
        endsAt: rouletteStoredTime(rouletteConfigSource?.endsAt),
        prizes: Array.isArray(rouletteConfigSource?.prizes)
          ? rouletteConfigSource.prizes.flatMap((item) => {
              const prize = asRecord(item);
              if (!prize || typeof prize.id !== "string" || typeof prize.label !== "string") return [];
              const unlimited = prize.quantity === null;
              return [{
                id: prize.id,
                label: prize.label,
                quantity: unlimited ? "" : typeof prize.quantity === "number" ? String(prize.quantity) : "",
                unlimited,
                weight: typeof prize.weight === "number" ? String(prize.weight) : "",
              }];
            })
          : [],
      };
      const rouletteUsedById: Record<string, number> = {};
      if (Array.isArray(workspace.rouletteResults)) {
        for (const item of workspace.rouletteResults) {
          const result = asRecord(item);
          if (typeof result?.prizeId === "string") {
            rouletteUsedById[result.prizeId] = (rouletteUsedById[result.prizeId] ?? 0) + 1;
          }
        }
      }
      const rouletteSpun = Array.isArray(workspace.rouletteResults) ? workspace.rouletteResults.length : 0;
      const rewards: RewardRecord[] = Array.isArray(workspace.rewards)
        ? workspace.rewards.flatMap((item) => {
            const reward = asRecord(item);
            if (!reward || typeof reward.id !== "string") return [];
            const source = asRecord(reward.source);
            return [{
              id: reward.id,
              name: text(reward.name),
              company: text(reward.company),
              participantId: text(reward.participantId),
              status: text(reward.status),
              sourceKind: text(source?.kind),
              sourceProgramId: text(source?.programId),
              winnerIndex: typeof source?.winnerIndex === "number" ? source.winnerIndex : null,
            }];
          })
        : [];
      const features = Array.isArray(event.features)
        ? event.features.filter((feature): feature is string => typeof feature === "string")
        : [];
      const latestLuckyRange = { min: String(luckyMin), max: String(luckyMax) };
      const previousLuckyRange = luckyRangeBaselineRef.current;
      const draftRange = luckyRangeDraftRef.current;
      if (!silent || (!preserveLuckyDraft && luckyRevision === luckyRangeRevisionRef.current && previousLuckyRange && draftRange.min === previousLuckyRange.min && draftRange.max === previousLuckyRange.max)) {
        luckyRangeDraftRef.current = latestLuckyRange;
        setLuckyMin(latestLuckyRange.min);
        setLuckyMax(latestLuckyRange.max);
        luckyRangeEditBaseRef.current = null;
      }
      luckyRangeBaselineRef.current = latestLuckyRange;
      if (!silent) {
        luckyRangeEditBaseRef.current = null;
        setLuckyRangeConflict(null);
        const snapshot = rouletteSnapshot(workspace);
        rouletteBaseRef.current = snapshot?.config ?? null;
        rouletteVersionRef.current = snapshot?.version ?? null;
        rouletteReviewedStatusRef.current = snapshot?.config.status ?? null;
        setRouletteConflict(null);
        setVotePickCount(String(voteConfig.pickCount));
        setVoteStatus(voteConfig.status);
        setVoteResultsPublished(voteConfig.resultsPublished);
        setRouletteStatus(rouletteConfig.status);
        setRouletteStartsAt(localDateTime(rouletteConfig.startsAt));
        setRouletteEndsAt(localDateTime(rouletteConfig.endsAt));
        setRouletteStartChanged(false);
        setRouletteEndChanged(false);
        setRouletteStartCleared(false);
        setRouletteEndCleared(false);
        setRoulettePrizes(rouletteConfig.prizes.length
          ? rouletteConfig.prizes
          : [{ id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" }]);
        setPreassignAllApproved(false);
      }
      loadedDrawEventRef.current = requestEventId;
      setState({
        kind: "ready",
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
        features,
        role,
        userId: myId,
        memberships,
        drawEnabled: features.includes("draw"),
        pollEnabled: features.includes("poll"),
        rewardEnabled: features.includes("reward"),
        teams,
        participants,
        drawPrograms,
        drawModules,
        voteConfig,
        voteTally: null,
        voteTotal,
        luckyIssued: luckyNumbers.length,
        luckyNumbers,
        luckyMin,
        luckyMax,
        rouletteSpun,
        rouletteConfig,
        rouletteUsedById,
        rewards,
      });
      return true;
    } catch {
      if (activeDrawEventRef.current !== requestEventId) return false;
      if (silent && (pendingOperationRef.current || pendingDraw)) { setOperationRecoveryError("최신 결과를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요."); return false; }
      if (preserveFailure) return false;
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    }
  }

  useEffect(() => {
    pendingCommands.current.clear();
    luckyDraftRef.current = null; luckyPlanRef.current = null; luckyRunnerRef.current = null; setLuckyProgress(null);
    operationInFlightRef.current = null;
    loadedDrawEventRef.current = null;
    rouletteBaseRef.current = null; rouletteVersionRef.current = null; rouletteReviewedStatusRef.current = null;
    rouletteConflictRead.current = null; setRouletteConflict(null);
    setTeamName(""); setProgramName(""); setProgramQuota(""); setProgramModuleId("");
    setEditingProgramId(null); setProgramEligibility("PERSON"); setProgramGroups([]); setProgramCompanies([]);
    setProgramOverlap("EVENT"); setProgramTiers([]); setGroupDraft(""); setCompanyDraft("");
    setRunCounts({}); setRewardRecipient({}); setNotice(null); setFailure(null); setPendingConfirm(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    if (hadOtherOperationReceiptRef.current && !otherOperationReceipt && !pendingOperation) {
      setRefreshingOtherOperation(true);
      const previousEvent = eventId;
      void load(true).finally(() => { if (activeDrawEventRef.current === previousEvent) setRefreshingOtherOperation(false); });
    }
    hadOtherOperationReceiptRef.current = otherOperationReceipt;
    // A shared status-only check may have resolved a pointer after reload.
    // Refresh the server state while preserving locally edited controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherOperationReceipt, pendingOperation]);

  // Names the section in view for the jump-nav active link. Anchor clicks keep
  // working natively whether or not the observer is available.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = DRAW_SECTION_IDS;
    const observer = new IntersectionObserver(
      (entries) => {
        // An explicit jump or deep link holds the current marker: the
        // observed headings are small and the band is narrow, so a stale
        // heading must not rename the section the operator just chose.
        if (navPinRef.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { rootMargin: "-30% 0px -60% 0px" }
    );
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [state]);

  // A deep link names its section even where the scroll spy cannot see it
  // arrive; the pin holds until the operator really scrolls.
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash;
      const id = hash.startsWith("#") ? hash.slice(1) : "";
      if (id && (DRAW_SECTION_IDS as readonly string[]).includes(id)) followJumpedSection(id);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [followJumpedSection]);

  async function postCommand(command: string, payload: Record<string, unknown>, intent = ""): Promise<Record<string, unknown>> {
    const attempt = JSON.stringify([eventId, command, payload, intent]);
    if (operationInFlightRef.current || (pendingOperationRef.current && pendingOperationRef.current.attempt !== attempt)) {
      throw new DrawRequestError("이전 요청의 처리 결과를 먼저 확인하세요.", Boolean(pendingOperationRef.current));
    }
    const inFlight = Symbol("draw-operation");
    operationInFlightRef.current = inFlight;
    const focusOrigin = document.activeElement;
    const heldId = pendingOperationRef.current?.attempt === attempt ? pendingOperationRef.current.commandId : pendingDraw?.attempt === attempt ? pendingDraw.commandId : null;
    let pending = pendingCommands.current.get(attempt) ?? (heldId ? { id: heldId, uncertain: true } : undefined);
    if (!pending) { pending = { id: randomCommandId(), uncertain: false }; pendingCommands.current.set(attempt, pending); }
    else if (!pendingCommands.current.has(attempt)) pendingCommands.current.set(attempt, pending);
    const commandId = pending.id;
    const rememberOperation = () => {
      if (!Object.hasOwn(DRAW_OPERATION_LABELS, command) || activeDrawEventRef.current !== eventId) return;
      if (!pendingOperationRef.current) operationFocusOriginRef.current = focusOrigin;
      const frozen: DrawOperationAttempt = { eventId, command, payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>, intent, commandId, attempt };
      pendingOperationRef.current = frozen;
      setPendingOperation(frozen);
      setOperationRecoveryError("처리 결과를 확인하지 못했습니다. 서버에서 확인하거나 원래 요청을 다시 시도하세요.");
    };
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      }).catch((error: unknown) => {
        if (isOrganizationContextBlock(error) && !pending.uncertain) {
          pendingCommands.current.delete(attempt);
          throw new DrawRequestError("조직 전환을 먼저 확인한 뒤 다시 시도하세요. 요청은 보내지 않았습니다.", false);
        }
        pending.uncertain = true;
        rememberOperation();
        throw new DrawRequestError("서버 응답을 확인하지 못했습니다. 같은 작업을 다시 시도해 결과를 확인하세요.", true);
      });
      const data = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        // A later rejection cannot settle a prior response loss.
        const ambiguous = pending.uncertain || response.status >= 500 || [408, 425, 429].includes(response.status);
        if (!ambiguous) pendingCommands.current.delete(attempt);
        else { pending.uncertain = true; rememberOperation(); }
        const code = !ambiguous && response.status === 409 && typeof data?.code === "string" ? data.code : undefined;
        if (!ambiguous && (command === "roulette.config.save-reviewed" || command === "lucky.config.save-reviewed" || command === "lucky.preassign-reviewed" || command === "lucky.preassign-range-reviewed") && response.status === 400 && typeof data?.error === "string" && data.error.includes("지원하지 않는")) {
          throw new DrawRequestError("현재 서버에서 변경 검토를 지원하지 않습니다. 서버를 갱신한 뒤 다시 확인하세요.", false);
        }
        throw new DrawRequestError(ambiguous ? "이전 요청의 처리 여부를 확인하지 못했습니다. 서버에서 확인하거나 원래 요청으로 다시 확인하세요." : typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.", ambiguous, code);
      }
      if (!data || (command === "draw.program.run" ? !confirmsDrawRun(payload, data, commandId) :
          Object.hasOwn(DRAW_OPERATION_LABELS, command) && !confirmsDrawOperation(command, payload, data))) {
        pending.uncertain = true;
        rememberOperation();
        throw new DrawRequestError("서버 응답을 확인하지 못했습니다. 같은 작업을 다시 시도하세요.", true);
      }
      pendingCommands.current.delete(attempt);
      acknowledgeOperatorReceipt(commandId); forgetOperatorReceipt(commandId);
      return data;
    } finally {
      if (operationInFlightRef.current === inFlight) operationInFlightRef.current = null;
    }
  }

  async function addTeam(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (state.kind !== "ready" || !teamName.trim() || busy) return;
    if (state.voteTotal > 0) {
      setFailure("첫 투표가 접수되어 팀 구성을 바꿀 수 없습니다.");
      return;
    }
    setBusy("team:add");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("team.save", { name: teamName.trim() });
      setTeamName("");
      setNotice("투표 팀을 등록했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "팀을 등록하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function saveProgram(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (state.kind !== "ready" || !programName.trim() || busy) return;
    const quota = Number(programQuota);
    if (!Number.isInteger(quota) || quota < 1 || quota > 10000) {
      setFailure("당첨 인원을 1~10000명으로 입력하세요.");
      return;
    }
    if (!programModuleId) {
      setFailure("추첨용 draw 프로그램을 먼저 선택하세요.");
      return;
    }
    const tiers = programTiers.map((tier) => ({ name: tier.name.trim(), count: Number(tier.count) }));
    if (programTiers.length && (
      tiers.some((tier) => !tier.name || !Number.isInteger(tier.count) || tier.count < 1 || tier.count > 10000) ||
      tiers.reduce((sum, tier) => sum + tier.count, 0) !== quota
    )) {
      setFailure("상품 등급별 인원은 1명 이상이며, 합계가 전체 당첨 인원과 같아야 합니다.");
      return;
    }
    const existing = editingProgramId
      ? state.drawPrograms.find((program) => program.id === editingProgramId)
      : null;
    if (existing?.winners.length) {
      setFailure("첫 당첨 이후에는 대상·쿼터·등급 설정을 변경할 수 없습니다.");
      return;
    }
    setBusy("program:save");
    setNotice(null);
    setFailure(null);
    try {
      const payload: Record<string, unknown> = {
        name: programName.trim(),
        quota,
        moduleId: programModuleId,
        eligibility: programEligibility,
        eligibleGroups: programGroups,
        eligibleCompanies: programCompanies,
        overlap: programOverlap,
        prizeTiers: tiers.length ? tiers : null,
      };
      if (editingProgramId) {
        payload.id = editingProgramId;
        if (existing) payload.status = existing.status;
      }
      await postCommand("draw.program.save", payload);
      setProgramName("");
      setProgramQuota("");
      setProgramModuleId("");
      setProgramEligibility("PERSON");
      setProgramGroups([]);
      setProgramCompanies([]);
      setProgramTiers([]);
      setGroupDraft("");
      setCompanyDraft("");
      setProgramOverlap("EVENT");
      setEditingProgramId(null);
      setNotice(editingProgramId ? "추첨 프로그램을 저장했습니다." : "추첨 프로그램을 만들었습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "추첨 프로그램을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  function requestProgramStatus(program: DrawProgram, status: "DRAFT" | "OPEN" | "CLOSED") {
    if (writeLocked) return;
    setPendingConfirm({
      kind: "programStatus",
      program,
      status,
      summary: `“${program.name}” 추첨을 ${status === "OPEN" ? "시작" : status === "CLOSED" ? "종료" : "준비로 되돌릴까요"}?`,
    });
  }

  async function setProgramStatus(program: DrawProgram, status: "DRAFT" | "OPEN" | "CLOSED") {
    if (writeLocked) return;
    setBusy(`program:${program.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.program.save", {
        id: program.id,
        status,
        published: status === "OPEN" ? true : status === "DRAFT" ? false : program.published,
      });
      setNotice("추첨 상태를 바꿨습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "상태를 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function setProgramPublished(program: DrawProgram, published: boolean) {
    if (writeLocked) return;
    setBusy(`publish:${program.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.program.save", { id: program.id, status: program.status, published });
      setNotice(published ? "추첨 결과를 공개했습니다." : "참가자·전광판 결과를 숨겼습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "공개 상태를 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  function selectedRunCount(program: DrawProgram): number | null {
    const remaining = program.quota - program.winners.length;
    const count = Number(runCounts[program.id] ?? "1");
    if (!Number.isInteger(count) || count < 1 || count > 20 || count > remaining) return null;
    return count;
  }

  function drawIntent(program: DrawProgram, count: number, toStage: boolean): string {
    // Repeating after an ambiguous response reuses the same command receipt.
    // A later intentional run starts a distinct receipt after winner count changes.
    return JSON.stringify([program.winners.length, count, toStage]);
  }

  async function runProgram(program: DrawProgram, toStage = false) {
    if (writeLocked) return;
    const remaining = program.quota - program.winners.length;
    if (remaining <= 0) {
      setFailure("이미 추첨이 완료된 프로그램입니다.");
      return;
    }
    const count = selectedRunCount(program);
    if (count === null) {
      setFailure(`이번 실행 인원은 1~${Math.min(20, remaining)}명으로 입력하세요.`);
      return;
    }
    const overlapCopy = program.overlap === "EVENT"
      ? "행사 안에서 이미 당첨된 참가자와 업체는 제외됩니다."
      : program.overlap === "PROGRAM"
        ? "이 프로그램에서 이미 당첨된 참가자와 업체만 제외됩니다."
        : "중복 당첨을 허용합니다.";
    const actionCopy = toStage ? "추첨하고 전광판에 결과를 표시" : "추첨";
    setPendingConfirm({
      kind: "run",
      program,
      count,
      toStage,
      summary: `“${program.name}”에서 ${count}명을 ${actionCopy}할까요? 현재 ${program.winners.length}명 당첨 · ${remaining}명 남음. ${overlapCopy}`,
    });
  }

  async function runProgramConfirmed(program: DrawProgram, count: number, toStage: boolean) {
    const remaining = program.quota - program.winners.length;
    const payload = { id: program.id, count, expectedRevision: program.revision, ...(toStage ? { showOnScreen: true } : {}) };
    setBusy(`${toStage ? "stage" : "run"}:${program.id}`);
    setNotice(null);
    setFailure(null);
    setConflictedProgram(null);
    try {
      const data = await postCommand("draw.program.run", payload, drawIntent(program, count, toStage));
      const winners = (data.winners as unknown[]).length;
      setNotice(toStage
        ? `${winners}명 결과를 추첨해 전광판 출력으로 설정했습니다.${remaining - winners > 0 ? ` 남은 인원 ${remaining - winners}명은 다음 터치에서 추첨하세요.` : ""}`
        : `${winners}명 결과를 추첨했습니다.${remaining - winners > 0 ? ` 남은 인원 ${remaining - winners}명은 다음 실행에서 추첨하세요.` : ""}`);
      if (await load(true)) { setPendingDraw(null); setRememberedDrawReceipt(null); }
    } catch (error) {
      if (error instanceof DrawRequestError && error.code === "DRAW_PROGRAM_CHANGED") {
        await load(true);
        if (activeDrawEventRef.current === eventId) setConflictedProgram({ id: program.id, name: program.name });
        return;
      }
      if (error instanceof DrawRequestError && error.uncertain) {
        const attempt = JSON.stringify([eventId, "draw.program.run", payload, drawIntent(program, count, toStage)]);
        const commandId = pendingCommands.current.get(attempt)?.id;
        if (commandId) setPendingDraw({ program, count, toStage, commandId, attempt });
      }
      setFailure(error instanceof DrawRequestError && error.uncertain
        ? "추첨 응답을 확인하지 못했습니다. 아래에서 서버 처리 여부를 확인하세요."
        : error instanceof Error ? error.message : "추첨을 실행하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function checkUncertainDraw() {
    const pointer = drawReceipt ?? rememberedDrawReceipt;
    const commandId = pendingDraw?.commandId ?? pointer?.commandId;
    if (!commandId || checkingDraw || operatorContext.changed) return;
    setCheckingDraw(true);
    setFailure(null);
    setOperationRecoveryError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(commandId)}`, { cache: "no-store" });
      const result = asRecord(await response.json().catch(() => null));
      if (response.ok && result?.status === "APPLIED" && result.command === "draw.program.run") {
        if (await load(true)) {
          if (pendingDraw) pendingCommands.current.delete(pendingDraw.attempt);
          acknowledgeOperatorReceipt(commandId);
          forgetOperatorReceipt(commandId);
          setPendingDraw(null);
          setRememberedDrawReceipt(null);
          setNotice("추첨이 서버에 반영된 것을 확인하고 최신 결과를 불러왔습니다.");
        }
      } else if (response.ok && result?.status === "UNCONFIRMED") {
        setFailure("아직 추첨 처리 여부를 확인할 수 없습니다. 요청이 처리 중이거나 도착하지 않았을 수 있습니다. 잠시 후 다시 확인하세요.");
      } else if (response.status >= 500 || [425, 429].includes(response.status)) setFailure("일시적으로 추첨 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요.");
      else setFailure("추첨 처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
    } catch {
      setFailure("서버에 연결하지 못했습니다. 추첨 요청을 다시 보내지 않았습니다.");
    } finally { setCheckingDraw(false); }
  }

  function settleDrawOperation(attempt: DrawOperationAttempt) {
    if (activeDrawEventRef.current !== attempt.eventId || pendingOperationRef.current?.commandId !== attempt.commandId) return;
    // Clear only the submitted values. Work typed while the result was
    // uncertain stays in the editor.
    if (attempt.command === "team.save" && typeof attempt.payload.name === "string") {
      setTeamName((current) => current.trim() === attempt.payload.name ? "" : current);
    }
    if (attempt.command === "draw.program.save" && typeof attempt.payload.name === "string" &&
        programName.trim() === attempt.payload.name && Number(programQuota) === attempt.payload.quota &&
        programModuleId === attempt.payload.moduleId && programEligibility === attempt.payload.eligibility &&
        programOverlap === attempt.payload.overlap && (editingProgramId ?? null) === (attempt.payload.id ?? null) &&
        !groupDraft.trim() && !companyDraft.trim() &&
        JSON.stringify(programGroups) === JSON.stringify(attempt.payload.eligibleGroups) &&
        JSON.stringify(programCompanies) === JSON.stringify(attempt.payload.eligibleCompanies) &&
        JSON.stringify(programTiers.length ? programTiers.map((tier) => ({ name: tier.name.trim(), count: Number(tier.count) })) : null) === JSON.stringify(attempt.payload.prizeTiers)) {
      setProgramName(""); setProgramQuota(""); setProgramModuleId(""); setProgramEligibility("PERSON");
      setProgramGroups([]); setProgramCompanies([]); setProgramTiers([]); setGroupDraft("");
      setCompanyDraft(""); setProgramOverlap("EVENT"); setEditingProgramId(null);
    }
    if (attempt.command === "lucky.preassign" || attempt.command === "lucky.preassign-reviewed" || attempt.command === "lucky.preassign-range-reviewed") setPreassignAllApproved(false);
    if (attempt.command === "lucky.config.save-reviewed" && typeof attempt.payload.min === "number" && typeof attempt.payload.max === "number") {
      settleSavedLuckyRange({ min: attempt.payload.min, max: attempt.payload.max });
      setLuckyRangeConflict(null);
    }
    if (attempt.command === "roulette.config.save-reviewed" && Number.isSafeInteger(attempt.payload.expectedVersion)) {
      const saved = rouletteSnapshot({ rouletteConfigVersion: Number(attempt.payload.expectedVersion) + 1, rouletteConfig: attempt.payload });
      if (saved) {
        rouletteBaseRef.current = saved.config; rouletteVersionRef.current = saved.version; rouletteReviewedStatusRef.current = saved.config.status;
        setRouletteStartChanged(false); setRouletteEndChanged(false); setRouletteStartCleared(false); setRouletteEndCleared(false);
      }
    }
    pendingCommands.current.delete(attempt.attempt);
    acknowledgeOperatorReceipt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
    pendingOperationRef.current = null; setPendingOperation(null); setOperationRecoveryError(null);
    setAbandonOperation(false); setFailure(null);
    setNotice(attempt.command === "vote.tally"
      ? "서버 처리를 확인했습니다. 최신 투표 집계를 다시 조회하세요."
      : "서버에 반영된 것을 확인하고 최신 내용을 불러왔습니다.");
  }

  async function recoverDrawOperation(retry: boolean) {
    const attempt = pendingOperationRef.current;
    if (!attempt || checkingOperation || operationInFlightRef.current || operatorContext.changed || attempt.eventId !== eventId) return;
    if (retry && (state.kind !== "ready" || state.archived || !canWriteEvent({
      role: state.role, userId: state.userId, memberships: state.memberships, eventId,
    }, attempt.command))) {
      setOperationRecoveryError("현재 권한이나 행사 상태에서는 같은 요청을 다시 보낼 수 없습니다. 서버 처리 확인을 이용하세요.");
      return;
    }
    const focusOrigin = document.activeElement;
    const focusRecoveryIfUnchanged = () => window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== focusOrigin && active.isConnected) return;
      const heading = document.getElementById("draw-operation-recovery-heading");
      heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      heading?.focus({ preventScroll: true });
    });
    setCheckingOperation(true); setOperationRecoveryError(null);
    try {
      if (retry) {
        await postCommand(attempt.command, attempt.payload, attempt.intent);
      } else {
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
        const result = asRecord(await response.json().catch(() => null));
        if (activeDrawEventRef.current !== attempt.eventId) return;
        if (!(response.ok && result?.status === "APPLIED" && result.command === attempt.command)) {
          setOperationRecoveryError(response.ok && result?.status === "UNCONFIRMED"
            ? "아직 처리 여부를 확인할 수 없습니다. 요청이 처리 중이거나 도착하지 않았을 수 있습니다. 잠시 후 다시 확인하세요."
            : "서버 처리 결과를 확인하지 못했습니다. 연결과 현재 행사 접근 권한을 확인하세요.");
          focusRecoveryIfUnchanged();
          return;
        }
      }
      if (activeDrawEventRef.current === attempt.eventId && await load(true, false, attempt.command === "lucky.config.save-reviewed")) {
        const plan = luckyPlanRef.current;
        const ids = Array.isArray(attempt.payload.participantIds) ? attempt.payload.participantIds : [];
        const expectedRange = asRecord(attempt.payload.expectedRange);
        const resumesLucky = attempt.command === "lucky.preassign-range-reviewed" && plan?.eventId === attempt.eventId &&
          expectedRange?.min === plan.range.min && expectedRange?.max === plan.range.max &&
          JSON.stringify(ids) === JSON.stringify(plan.ids.slice(plan.processed, plan.processed + LUCKY_BATCH_SIZE));
        if (resumesLucky && plan) {
          plan.processed += ids.length;
          setLuckyProgress({ total: plan.ids.length, processed: plan.processed, phase: plan.stopRequested ? "stopping" : "running" });
        }
        settleDrawOperation(attempt);
        if (resumesLucky && plan) void runLuckyPlan(plan);
      }
    } catch {
      if (activeDrawEventRef.current === attempt.eventId) {
        setOperationRecoveryError("이전 요청의 처리 여부를 확인하지 못했습니다. 입력을 보존하고 나중에 다시 확인하세요.");
        focusRecoveryIfUnchanged();
      }
    } finally {
      if (activeDrawEventRef.current === attempt.eventId) setCheckingOperation(false);
    }
  }

  async function saveVoteConfig(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (state.kind !== "ready" || busy) return;
    const pickCount = Number(votePickCount);
    if (!Number.isInteger(pickCount) || pickCount < 1 || pickCount > 20) {
      setFailure("참가자가 선택할 팀 수를 1~20개로 입력하세요.");
      return;
    }
    if (voteStatus === "OPEN" && state.teams.length < pickCount) {
      setFailure(`투표를 열려면 최소 ${pickCount}개 팀을 먼저 등록하세요.`);
      return;
    }
    if (state.voteTotal > 0 && pickCount !== state.voteConfig.pickCount) {
      setFailure("첫 투표가 접수되어 선택할 팀 수를 바꿀 수 없습니다.");
      return;
    }
    setBusy("vote:save");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("vote.config.save", {
        pickCount,
        status: voteStatus,
        resultsPublished: voteResultsPublished,
      });
      setNotice("투표 설정을 저장했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "투표 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshVoteTally() {
    if (writeLocked) return;
    if (tallyLoading || busy) return;
    setTallyLoading(true);
    setFailure(null);
    try {
      const data = await postCommand("vote.tally", {}, "operator-tally");
      const results = Array.isArray(data.results)
        ? data.results.flatMap((item) => {
            const row = asRecord(item);
            if (!row || typeof row.teamId !== "string" || typeof row.name !== "string") return [];
            return [{
              teamId: row.teamId,
              name: row.name,
              selections: typeof row.selections === "number" ? row.selections : 0,
              rank: typeof row.rank === "number" ? row.rank : 0,
              tied: row.tied === true,
            }];
          })
        : [];
      setState((current) => current.kind === "ready" ? {
        ...current,
        voteTally: {
          results,
          totalVotes: typeof data.totalVotes === "number" ? data.totalVotes : 0,
          published: data.published === true,
        },
      } : current);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "투표 집계를 불러오지 못했습니다.");
    } finally {
      setTallyLoading(false);
    }
  }

  async function saveLuckyConfig(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (busy || luckyRangeConflict || state.kind !== "ready") return;
    const min = Number(luckyMin);
    const max = Number(luckyMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 999999) {
      setFailure("번호 범위는 1~999999의 정수이며 최소 번호가 최대 번호보다 클 수 없습니다.");
      return;
    }
    setBusy("lucky:save");
    setNotice(null);
    setFailure(null);
    try {
      const expectedRange = luckyRangeEditBaseRef.current ?? { min: state.luckyMin, max: state.luckyMax };
      await postCommand("lucky.config.save-reviewed", { min, max, expectedRange });
      setNotice("럭키번호 범위를 저장했습니다.");
      if (await load(true, false, true)) settleSavedLuckyRange({ min, max });
    } catch (error) {
      if (error instanceof DrawRequestError && error.code === "LUCKY_RANGE_CHANGED") {
        setLuckyRangeConflict({ loading: true, ready: false });
        const refreshed = await load(true, true, true);
        if (activeDrawEventRef.current === eventId) setLuckyRangeConflict({ loading: false, ready: refreshed === true });
      } else setFailure(error instanceof Error ? error.message : "번호 범위를 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  function settleSavedLuckyRange(saved: LuckyRange) {
    const draft = luckyRangeDraftRef.current;
    if (draft.min === String(saved.min) && draft.max === String(saved.max)) {
      const latest = luckyRangeBaselineRef.current;
      if (latest) { luckyRangeDraftRef.current = { ...latest }; setLuckyMin(latest.min); setLuckyMax(latest.max); }
      luckyRangeEditBaseRef.current = null;
    } else luckyRangeEditBaseRef.current = saved;
  }

  function editLuckyRange(field: "min" | "max", value: string) {
    luckyRangeRevisionRef.current += 1;
    if (!luckyRangeEditBaseRef.current && state.kind === "ready") luckyRangeEditBaseRef.current = { min: state.luckyMin, max: state.luckyMax };
    luckyRangeDraftRef.current = { ...luckyRangeDraftRef.current, [field]: value };
    if (field === "min") setLuckyMin(value); else setLuckyMax(value);
  }

  async function refreshLuckyRangeConflict() {
    if (!luckyRangeConflict || luckyRangeConflict.loading) return;
    setLuckyRangeConflict({ loading: true, ready: false });
    const refreshed = await load(true, true, true);
    if (activeDrawEventRef.current === eventId) setLuckyRangeConflict({ loading: false, ready: refreshed === true });
  }

  async function preassignLuckyNumbers() {
    if (writeLocked || luckyRangeConflict) return;
    if (state.kind !== "ready" || !preassignAllApproved || busy) return;
    const targets = luckySelection(state.participants, state.luckyNumbers).missing.map((person) => person.id);
    if (!targets.length) {
      setFailure("번호를 배정할 승인 참가자가 없습니다.");
      return;
    }
    luckyDraftRef.current = { ids: targets, range: { min: state.luckyMin, max: state.luckyMax } };
    setPendingConfirm({
      kind: "lucky",
      summary: `미발급 승인 참가자 ${targets.length}명에게 ${state.luckyMin}–${state.luckyMax} 범위의 럭키번호를 배정할까요? ${targets.length > LUCKY_BATCH_SIZE ? "최대 5,000명씩 순차 처리하며, 중간에 멈춰도 이미 처리된 번호는 유지됩니다. " : ""}이미 번호가 있으면 유지합니다.`,
    });
  }

  async function preassignLuckyNumbersConfirmed() {
    const draft = luckyDraftRef.current;
    luckyDraftRef.current = null;
    if (state.kind !== "ready" || !draft?.ids.length || luckyPlanRef.current) return;
    const plan: LuckyPlan = { eventId, ...draft, processed: 0, stopRequested: false };
    luckyPlanRef.current = plan;
    setNotice(null); setFailure(null);
    setLuckyProgress({ total: draft.ids.length, processed: 0, phase: "running" });
    await runLuckyPlan(plan);
  }

  async function runLuckyPlan(plan: LuckyPlan) {
    if (luckyPlanRef.current !== plan || luckyRunnerRef.current) return;
    const runner = Symbol("lucky-batches"); luckyRunnerRef.current = runner;
    setBusy("lucky:preassign");
    try {
      while (luckyPlanRef.current === plan && activeDrawEventRef.current === plan.eventId && plan.processed < plan.ids.length && !plan.stopRequested) {
        const batch = plan.ids.slice(plan.processed, plan.processed + LUCKY_BATCH_SIZE);
        await postCommand("lucky.preassign-range-reviewed", { participantIds: batch, expectedRange: plan.range });
        if (luckyPlanRef.current !== plan || activeDrawEventRef.current !== plan.eventId) return;
        plan.processed += batch.length;
        setLuckyProgress({ total: plan.ids.length, processed: plan.processed, phase: plan.stopRequested ? "stopping" : "running" });
      }
      if (luckyPlanRef.current !== plan || activeDrawEventRef.current !== plan.eventId) return;
      const stopped = plan.stopRequested && plan.processed < plan.ids.length;
      const refreshed = await load(true);
      if (luckyPlanRef.current !== plan || activeDrawEventRef.current !== plan.eventId) return;
      luckyPlanRef.current = null; setLuckyProgress(null); setPreassignAllApproved(false);
      if (refreshed) setNotice(stopped
        ? `${plan.processed}명 처리 후 남은 배정을 중단했습니다. 이미 배정된 번호는 유지됩니다.`
        : `${plan.processed}명의 번호 배정을 확인했습니다. 기존 번호는 유지됩니다.`);
      else setState({ kind: "failed", message: `${plan.processed}명 처리 후 최신 명단을 불러오지 못했습니다. 다시 확인하세요.` });
    } catch (error) {
      if (luckyPlanRef.current !== plan || activeDrawEventRef.current !== plan.eventId) return;
      if (error instanceof DrawRequestError && error.uncertain) {
        setLuckyProgress({ total: plan.ids.length, processed: plan.processed, phase: "uncertain" });
      } else {
        luckyPlanRef.current = null; setLuckyProgress(null); setPreassignAllApproved(false);
        const message = error instanceof Error ? error.message : "번호 배정을 완료하지 못했습니다.";
        const refreshed = await load(true);
        if (refreshed) setFailure(`${plan.processed}명 처리 후 배정이 멈췄습니다. ${message}`);
        else setState({ kind: "failed", message: `${plan.processed}명 처리 후 배정이 멈췄습니다. 최신 명단을 다시 확인하세요.` });
      }
    } finally {
      if (luckyRunnerRef.current === runner) luckyRunnerRef.current = null;
      if (activeDrawEventRef.current === plan.eventId) setBusy(null);
    }
  }

  async function saveRouletteConfig(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (busy) return;
    if (!roulettePrizes.length || roulettePrizes.length > 20) {
      setFailure("룰렛 경품을 1~20개 등록하세요.");
      return;
    }
    const prizes: Array<{ id: string; label: string; quantity: number | null; weight?: number }> = [];
    for (const [index, prize] of roulettePrizes.entries()) {
      const label = prize.label.trim();
      if (!label) {
        setFailure(`경품 ${index + 1}의 이름을 입력하세요.`);
        return;
      }
      if (prize.unlimited) {
        const weight = Number(prize.weight);
        if (!Number.isInteger(weight) || weight <= 0 || weight > 1000000) {
          setFailure(`“${label}” 무제한 경품에는 1 이상의 정수 가중치가 필요합니다.`);
          return;
        }
        prizes.push({ id: prize.id, label, quantity: null, weight });
      } else {
        const quantity = Number(prize.quantity);
        if (prize.quantity.trim() === "" || !Number.isInteger(quantity) || quantity < 0 || quantity > 100000) {
          setFailure(`“${label}”의 재고 수량을 0~100000의 정수로 입력하세요. 무제한이면 해당 항목을 명시적으로 선택하세요.`);
          return;
        }
        const finitePrize: { id: string; label: string; quantity: number; weight?: number } = { id: prize.id, label, quantity };
        if (prize.weight.trim() !== "") {
          const weight = Number(prize.weight);
          if (!Number.isInteger(weight) || weight < 0 || weight > 1000000) {
            setFailure(`“${label}”의 가중치는 0~1000000의 정수로 입력하세요.`);
            return;
          }
          finitePrize.weight = weight;
        }
        prizes.push(finitePrize);
      }
    }
    if (state.kind !== "ready") return;
    const baseline = rouletteBaseRef.current;
    const expectedVersion = rouletteVersionRef.current;
    if (!baseline || expectedVersion === null) {
      setFailure("룰렛 설정을 안전하게 확인할 수 없습니다. 화면을 다시 불러오거나 운영자에게 문의하세요.");
      return;
    }
    if ((rouletteStartChanged && !rouletteStartsAt && !rouletteStartCleared) ||
        (rouletteEndChanged && !rouletteEndsAt && !rouletteEndCleared)) {
      setFailure("날짜와 시간을 모두 입력하거나 시간 제한 해제 버튼을 선택하세요.");
      return;
    }
    if ((!rouletteStartChanged && rouletteTimeNeedsReview(baseline.startsAt)) ||
        (!rouletteEndChanged && rouletteTimeNeedsReview(baseline.endsAt))) {
      setFailure("저장된 운영 시간을 확인하고 새 시간을 입력하거나 제한을 해제하세요.");
      return;
    }
    const startsAt = rouletteStartChanged ? isoFromLocalDateTime(rouletteStartsAt) : baseline.startsAt;
    const endsAt = rouletteEndChanged ? isoFromLocalDateTime(rouletteEndsAt) : baseline.endsAt;
    if ((rouletteStartsAt && !startsAt) || (rouletteEndsAt && !endsAt)) {
      setFailure("룰렛 운영 시간을 확인하세요.");
      return;
    }
    if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) {
      setFailure("종료 시간은 시작 시간 이후여야 합니다.");
      return;
    }
    if (rouletteStatus === "OPEN" && prizes.every((prize) => prize.quantity === 0)) {
      setFailure("룰렛을 열려면 재고가 있는 경품 또는 가중치를 지정한 무제한 경품이 필요합니다.");
      return;
    }
    if (rouletteStatus === "OPEN" && rouletteReviewedStatusRef.current !== "OPEN") {
      setPendingConfirm({
        kind: "roulette",
        summary: "설정한 운영 시간에 참가자가 참여할 수 있으며 결과는 1회 저장됩니다. 룰렛을 열까요?",
      });
      roulettePayloadRef.current = { prizes, startsAt: startsAt ?? "", endsAt: endsAt ?? "", status: rouletteStatus, expectedVersion };
      return;
    }
    await saveRouletteConfigConfirmed(prizes, startsAt ?? "", endsAt ?? "", rouletteStatus, expectedVersion);
  }

  async function saveRouletteConfigConfirmed(
    prizes: Array<{ id: string; label: string; quantity: number | null; weight?: number }>,
    startsAt: string,
    endsAt: string,
    status: RouletteConfig["status"],
    expectedVersion: number
  ) {
    setBusy("roulette:save");
    setNotice(null);
    setFailure(null);
    try {
      const data = await postCommand("roulette.config.save-reviewed", {
        prizes,
        status,
        startsAt,
        endsAt,
        expectedVersion,
      });
      const saved = rouletteSnapshot({ rouletteConfigVersion: data.rouletteConfigVersion, rouletteConfig: data.rouletteConfig });
      if (saved) { rouletteBaseRef.current = saved.config; rouletteVersionRef.current = saved.version; rouletteReviewedStatusRef.current = saved.config.status; }
      setNotice("룰렛 경품과 운영 상태를 저장했습니다.");
      if (await load(true)) {
        setRouletteStartChanged(false);
        setRouletteEndChanged(false);
        setRouletteStartCleared(false);
        setRouletteEndCleared(false);
      }
    } catch (error) {
      if (error instanceof DrawRequestError && error.code === "ROULETTE_CONFIG_CHANGED") {
        setRouletteConflict({ loading: false, error: null, latest: null });
        window.requestAnimationFrame(() => document.getElementById("roulette-conflict-heading")?.focus());
      } else setFailure(error instanceof Error ? error.message : "룰렛 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function readLatestRoulette() {
    if (!rouletteConflict || rouletteConflictRead.current) return;
    const requestedEventId = eventId;
    const request = Symbol("roulette-conflict-read");
    rouletteConflictRead.current = request;
    setRouletteConflict({ loading: true, error: null, latest: null });
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(requestedEventId)}/bootstrap`, { cache: "no-store" });
      const body = asRecord(await response.json().catch(() => null));
      const boot = asRecord(body?.state);
      const workspaces = asRecord(boot?.workspaces);
      const workspace = asRecord(workspaces?.[requestedEventId]);
      const snapshot = workspace ? rouletteSnapshot(workspace) : null;
      if (!response.ok || !snapshot || !workspace || !Array.isArray(workspace.rouletteResults)) throw new Error();
      if (activeDrawEventRef.current !== requestedEventId) return;
      const used: Record<string, number> = {};
      for (const item of workspace.rouletteResults) {
        const result = asRecord(item);
        if (!result || typeof result.prizeId !== "string") throw new Error();
        used[result.prizeId] = (used[result.prizeId] ?? 0) + 1;
      }
      const resultCount = workspace.rouletteResults.length;
      setState((current) => current.kind === "ready" ? { ...current, rouletteSpun: resultCount, rouletteUsedById: used } : current);
      setRouletteConflict({ loading: false, error: null, latest: snapshot });
    } catch {
      if (activeDrawEventRef.current === requestedEventId) setRouletteConflict({ loading: false, latest: null, error: "최신 룰렛 설정을 확인하지 못했습니다. 작성한 내용은 그대로 있습니다. 다시 확인하세요." });
    } finally { if (rouletteConflictRead.current === request) rouletteConflictRead.current = null; }
  }

  function resolveRouletteConflict(useLatest: boolean) {
    const latest = rouletteConflict?.latest;
    if (!latest) return;
    rouletteVersionRef.current = latest.version;
    rouletteReviewedStatusRef.current = latest.config.status;
    if (useLatest) {
      rouletteBaseRef.current = latest.config;
      setRouletteStatus(latest.config.status);
      setRouletteStartsAt(localDateTime(latest.config.startsAt)); setRouletteEndsAt(localDateTime(latest.config.endsAt));
      setRouletteStartChanged(false); setRouletteEndChanged(false); setRouletteStartCleared(false); setRouletteEndCleared(false);
      setRoulettePrizes(latest.config.prizes.length ? latest.config.prizes : [{ id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" }]);
    }
    setRouletteConflict(null); setFailure(null);
    setNotice(useLatest ? "최신 룰렛 설정을 불러왔습니다. 확인한 뒤 저장하세요." : "작성 내용을 유지합니다. 저장하면 표시된 내 설정 전체가 적용됩니다.");
    window.requestAnimationFrame(() => document.getElementById("roulette-status")?.focus());
  }

  async function assignCompanyRecipient(reward: RewardRecord) {
    const participantId = rewardRecipient[reward.id];
    if (writeLocked) return;
    if (!canWriteRewardAssign) return;
    if (!participantId || busy) return;
    setBusy(`reward:${reward.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("reward.assign", { id: reward.id, participantId });
      setNotice("당첨 업체의 수령자를 지정했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "수령자를 지정하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading" || (state.kind === "ready" && loadedDrawEventRef.current !== eventId)) {
    return (
      <ConsolePage pageId="draws" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="추첨·투표 정보를 불러오고 있습니다." onRetry={() => load()} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="draws" eventId={eventId}>
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => load()}
        />
      </ConsolePage>
    );
  }

  const approvedParticipants = state.participants.filter((person) => person.status === "APPROVED" && !person.revoked);
  const selectedLucky = luckySelection(state.participants, state.luckyNumbers);
  const missingLuckyCount = selectedLucky.missing.length;
  const luckyPoolSize = state.luckyMax - state.luckyMin + 1;
  const luckyOccupied = new Set(state.luckyNumbers.map((entry) => entry.number)
    .filter((value) => Number.isInteger(value) && value >= state.luckyMin && value <= state.luckyMax)).size;
  const luckyOutsideRange = state.luckyNumbers.filter((entry) => Number.isInteger(entry.number) &&
    (entry.number < state.luckyMin || entry.number > state.luckyMax)).length;
  const luckyAvailable = Math.max(0, luckyPoolSize - luckyOccupied);
  const rouletteFrozen = state.rouletteSpun > 0;
  const shownRouletteBase = rouletteBaseRef.current ?? state.rouletteConfig;
  const savedRouletteStart = boothScheduleTime(shownRouletteBase.startsAt);
  const savedRouletteEnd = boothScheduleTime(shownRouletteBase.endsAt);
  const rouletteScheduleNeedsReview = rouletteTimeNeedsReview(shownRouletteBase.startsAt) || rouletteTimeNeedsReview(shownRouletteBase.endsAt) ||
    (savedRouletteStart !== null && savedRouletteEnd !== null && Number.isFinite(savedRouletteStart) && Number.isFinite(savedRouletteEnd) && savedRouletteStart >= savedRouletteEnd);
  const groupOptions = [...new Set(state.participants.map((person) => person.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const companyOptions = [...new Set(state.participants.map((person) => person.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const configuredTierTotal = programTiers.reduce((sum, tier) => sum + (Number(tier.count) || 0), 0);
  const screenEnabled = state.features.includes("screen");
  // Draw/vote/lucky/roulette/team config and display linkage are programs
  // scope; 업체 수령자 지정 (reward.assign) is results scope. Neither gate
  // invents access; the server re-checks every command.
  const capabilities = { role: state.role, userId: state.userId, memberships: state.memberships, eventId };
  const canWriteDraws = canWriteEvent(capabilities, "draw.run");
  const canWriteRewardAssign = canWriteEvent(capabilities, "reward.assign");

  return (
    <ConsolePage
      pageId="draws"
      closeSnapshot={state.closeSnapshot}
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      sectionNav={
        <div className={styles.navSticky}>
          <p className={styles.navIndexLabel} aria-hidden="true">추첨·투표 목차</p>
          <ConsoleSectionNav mode="tabs"
            label="추첨·투표 구역"
            activeId={activeSection}
            onNavigate={followJumpedSection}
            items={[
              { id: "draws-programs", label: "무대 추첨" },
              { id: "draws-vote", label: "순위 투표" },
              { id: "draws-roulette", label: "모바일 룰렛" },
              { id: "draws-lucky", label: "럭키번호" },
            ]}
          />
        </div>
      }
      feedback={
        <>
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {failure && !pendingOperation ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {conflictedProgram && !state.drawPrograms.some((program) => program.id === conflictedProgram.id) ? (
            <ConsoleFeedback kind="error">“{conflictedProgram.name}” 추첨 내용이 다른 곳에서 바뀌었습니다. 목록에서 최신 프로그램을 확인하세요.</ConsoleFeedback>
          ) : null}
          {!canWriteDraws ? (
            <ConsoleFeedback kind="warning">추첨·투표 설정 변경은 추첨(프로그램) 쓰기 권한이 필요합니다. 결과 조회는 그대로 볼 수 있습니다.</ConsoleFeedback>
          ) : null}
          {canWriteDraws && state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 설정과 결과를 볼 수 있지만 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >

      {otherOperationReceipt && !pendingOperation ? <ConsoleFeedback kind="warning">이전 추첨·투표 요청의 처리 결과를 화면 위의 ‘처리 결과 확인’에서 먼저 확인하세요. 번호 배정을 중간에 떠났다면 확인 후 남은 참가자를 다시 선택하세요.</ConsoleFeedback> : null}
      {refreshingOtherOperation ? <ConsoleFeedback kind="info">최신 추첨·투표 내용을 불러오고 있습니다.</ConsoleFeedback> : null}
      {pendingOperation ? <section className={styles.drawRecovery} aria-labelledby="draw-operation-recovery-heading">
        <h2 id="draw-operation-recovery-heading" tabIndex={-1}>추첨·투표 처리 확인 필요</h2>
        <p>{DRAW_OPERATION_LABELS[pendingOperation.command]} 요청이 반영됐을 수 있습니다. 서버 처리 확인은 요청을 다시 보내지 않습니다.</p>
        {state.archived || !canWriteEvent(capabilities, pendingOperation.command) ? <p>현재 권한이나 행사 상태에서는 같은 요청을 다시 보낼 수 없습니다. 서버 처리 확인을 이용하세요.</p> : null}
        {operationRecoveryError ? <p role="alert">{operationRecoveryError}</p> : null}
        <div className={styles.drawRecoveryActions}>
          <button type="button" className="button button-secondary" disabled={checkingOperation || busy !== null || operatorContext.changed || abandonOperation} onClick={() => void recoverDrawOperation(false)}>{checkingOperation ? "확인 중…" : "서버 처리 확인"}</button>
          <button type="button" className="button button-secondary" disabled={checkingOperation || busy !== null || operatorContext.changed || abandonOperation || state.archived || !canWriteEvent(capabilities, pendingOperation.command)} onClick={() => void recoverDrawOperation(true)}>같은 요청 다시 시도</button>
          <button type="button" className="button button-secondary" disabled={checkingOperation || busy !== null || abandonOperation} onClick={() => setAbandonOperation(true)}>확인 전 그만두기</button>
        </div>
        {abandonOperation ? <ConsoleConfirm summary="이미 반영된 작업은 취소되지 않습니다. 확인을 그만두고 최신 내용을 확인할까요?" confirmLabel="확인 그만두기" onConfirm={() => {
          const attempt = pendingOperationRef.current;
          if (!attempt) return;
          if (attempt.command === "lucky.preassign-reviewed" || attempt.command === "lucky.preassign-range-reviewed") { luckyPlanRef.current = null; setLuckyProgress(null); }
          pendingCommands.current.delete(attempt.attempt); abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
          pendingOperationRef.current = null; setPendingOperation(null); setOperationRecoveryError(null); setAbandonOperation(false);
          setFailure("이전 작업이 반영됐을 수 있습니다. 최신 내용을 확인한 뒤 다시 진행하세요.");
          setRefreshingOtherOperation(true);
          void load(true).finally(() => { if (activeDrawEventRef.current === attempt.eventId) setRefreshingOtherOperation(false); });
        }} onCancel={() => setAbandonOperation(false)} /> : null}
      </section> : null}

      {luckyProgress ? <section className={styles.luckyProgress} aria-labelledby="lucky-progress-heading">
        <h2 id="lucky-progress-heading">럭키번호 배정 진행</h2>
        <p role="status" aria-live="polite">확인된 대상 {luckyProgress.processed} / {luckyProgress.total}명 · {luckyProgress.phase === "uncertain" ? "현재 요청 확인 필요" : luckyProgress.phase === "stopping" ? "현재 요청 확인 후 중단" : "순차 처리 중"}</p>
        <progress max={luckyProgress.total} value={luckyProgress.processed} aria-label="번호 배정 확인 진행률" />
        <p>이미 확인된 배정은 유지됩니다. 화면을 떠나면 현재 요청을 확인한 뒤 남은 참가자를 다시 선택하세요.</p>
        <button type="button" className="button button-secondary" disabled={luckyProgress.phase === "stopping"} onClick={() => {
          const plan = luckyPlanRef.current;
          if (!plan) return;
          plan.stopRequested = true;
          setLuckyProgress({ total: plan.ids.length, processed: plan.processed, phase: "stopping" });
        }}>남은 배정 중단</button>
      </section> : null}

      {pendingDraw || drawReceipt || rememberedDrawReceipt ? (
        <section className={styles.drawRecovery} aria-labelledby="draw-recovery-heading">
          <h2 id="draw-recovery-heading">추첨 처리 확인 필요</h2>
          <p>이전 추첨이 처리됐을 수 있어 새 작업을 잠시 잠갔습니다. 서버 처리 확인은 추첨을 다시 실행하지 않습니다.</p>
          {operationRecoveryError ? <p role="alert">{operationRecoveryError}</p> : null}
          <div className={styles.drawRecoveryActions}>
            <button type="button" className="button button-primary" disabled={checkingDraw || busy !== null || operatorContext.changed} onClick={() => void checkUncertainDraw()}>{checkingDraw ? "확인 중…" : "추첨 처리 확인"}</button>
            {pendingDraw ? <button type="button" className="button button-secondary" disabled={checkingDraw || busy !== null || operatorContext.changed} onClick={() => void runProgramConfirmed(pendingDraw.program, pendingDraw.count, pendingDraw.toStage)}>원래 추첨 요청 다시 확인</button> : null}
          </div>
          {!pendingDraw ? <p>새로고침 후에는 원래 입력을 보관하지 않습니다. 서버 처리 여부를 확인해 주세요.</p> : null}
        </section>
      ) : null}

      {pendingConfirm ? (
        <ConsoleConfirm
          summary={pendingConfirm.kind === "programStatus"
            ? `“${pendingConfirm.program.name}” 추첨을 ${pendingConfirm.status === "OPEN" ? "시작" : pendingConfirm.status === "CLOSED" ? "종료" : "준비로 되돌릴까요"}?`
            : pendingConfirm.kind === "run"
              ? pendingConfirm.summary
              : pendingConfirm.kind === "lucky"
                ? pendingConfirm.summary
                : pendingConfirm.summary}
          confirmLabel={pendingConfirm.kind === "programStatus"
            ? pendingConfirm.status === "OPEN" ? "시작한다" : pendingConfirm.status === "CLOSED" ? "종료한다" : "되돌린다"
            : pendingConfirm.kind === "publishEmptyProgram" ? "공개 허용"
            : pendingConfirm.kind === "run"
              ? pendingConfirm.toStage ? "추첨하고 전광판에 표시" : "추첨 실행"
              : pendingConfirm.kind === "lucky" ? "번호 배정" : "룰렛 운영 시작"}
          busy={busy !== null}
          onConfirm={() => {
            const pending = pendingConfirm;
            setPendingConfirm(null);
            if (pending.kind === "programStatus") void setProgramStatus(pending.program, pending.status);
            else if (pending.kind === "publishEmptyProgram") void setProgramPublished(pending.program, true);
            else if (pending.kind === "run") void runProgramConfirmed(pending.program, pending.count, pending.toStage);
            else if (pending.kind === "lucky") void preassignLuckyNumbersConfirmed();
            else {
              const payload = roulettePayloadRef.current;
              roulettePayloadRef.current = null;
              if (payload) void saveRouletteConfigConfirmed(payload.prizes, payload.startsAt, payload.endsAt, payload.status, payload.expectedVersion);
            }
          }}
          onCancel={() => { if (pendingConfirm.kind === "lucky") luckyDraftRef.current = null; setPendingConfirm(null); }}
        />
      ) : null}

      <ConsoleSection headingId="draws-programs" title={`무대 추첨 · ${state.drawPrograms.length}개`}>
        {!state.drawEnabled ? <p className={styles.featureOff}>이 행사에서 무대 추첨 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>실행 인원은 매번 1~20명으로 지정합니다(기본 1명). 프로그램 대상·쿼터·등급은 첫 당첨 뒤 잠기고, 공개 여부는 별도로 관리합니다.</p>
            {!screenEnabled && canWriteDraws ? (
              <p className={styles.stagePrerequisite} id="stage-screen-prerequisite">
                무대 터치 실행은 당첨 결과와 경품을 저장하고 이번 결과를 전광판에 올립니다. 사용 전 <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/settings#settings-features`)}>행사 설정에서 행사장 출력을 켜세요.</Link>
              </p>
            ) : null}
            {!state.drawModules.some((module) => module.published) && !state.drawPrograms.length && canWriteDraws ? (
              <p className={styles.stagePrerequisite}>
                {state.drawModules.length
                  ? <>무대 터치 실행에는 공개된 추첨 무대가 필요합니다. 기존 비공개 결과는 자동 공개하지 않습니다. <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 콘텐츠에서 무대 운영을 시작해 공개하세요.</Link></>
                  : <>추첨 프로그램을 만들려면 먼저 <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 콘텐츠에서 추첨 무대를 만들고 공개하세요.</Link> 공개 상태로 전환한 무대만 여기에 연결할 수 있습니다.</>}
              </p>
            ) : null}
            {state.drawPrograms.length ? (
              <ul className={styles.programList}>
                {state.drawPrograms.map((program) => {
                  const remaining = Math.max(program.quota - program.winners.length, 0);
                  const runCount = Number(runCounts[program.id] ?? "1");
                  const countLimit = Math.min(20, remaining);
                  const runCountValid = Number.isInteger(runCount) && runCount >= 1 && runCount <= countLimit;
                  const canRun = program.status === "OPEN" && program.published && remaining > 0 && runCountValid;
                  const linkedModule = state.drawModules.find((module) => module.id === program.moduleId);
                  const moduleTitle = linkedModule?.title ?? "무대 추첨";
                  const moduleNeedsPublishing = !linkedModule || !linkedModule.published;
                  const stagePrerequisites = [
                    !screenEnabled ? "stage-screen-prerequisite" : null,
                    moduleNeedsPublishing ? `stage-module-prerequisite-${program.id}` : null,
                  ].filter((id): id is string => id !== null);
                  // Ordinary draws do not require the venue screen or a
                  // published stage module. Keep those extra requirements
                  // attached only to the stage action.
                  const runBlockers = [
                    !program.published ? "결과 공개 필요" : "",
                    !runCountValid ? `실행 인원 1~${countLimit}명` : "",
                  ].filter((reason) => reason !== "");
                  const stageOnlyBlockers = [
                    !screenEnabled ? "행사장 출력 꺼짐" : "",
                    moduleNeedsPublishing ? "무대 프로그램 공개 필요" : "",
                  ].filter((reason) => reason !== "");
                  const runBlockerId = `run-blockers-${program.id}`;
                  const stageBlockerId = `stage-blockers-${program.id}`;
                  const runNextAction = !program.published
                    ? "결과를 공개하면"
                    : `실행 인원을 1~${countLimit}명 범위로 고치면`;
                  return (
                    <li key={program.id} id={`draw-program-${program.id}`} className={styles.programItem}>
                      <div className={styles.programTop}>
                        <strong>{program.name}</strong>
                        <span>총 {program.quota}명 · 당첨 {program.winners.length}명 · 남은 {remaining}명</span>
                      </div>
                      {conflictedProgram?.id === program.id ? (
                        <div ref={conflictPanelRef} tabIndex={-1}>
                          <ConsoleFeedback kind="error">추첨 내용이 다른 곳에서 바뀌었습니다. 최신 결과와 남은 인원을 확인한 뒤 다음 작업을 선택하세요.</ConsoleFeedback>
                        </div>
                      ) : null}
                      <div className={styles.programMeta}>
                        <span className={`${styles.status} ${program.status === "OPEN" ? styles.statusOpen : program.status === "DRAFT" ? styles.statusDraft : styles.statusClosed}`}>{program.status === "OPEN" ? "운영 중" : program.status === "DRAFT" ? "준비" : "종료"}</span>
                        <span>{program.eligibility === "COMPANY" ? "업체 추첨" : "개인 추첨"}</span>
                        <span>{program.overlap === "EVENT" ? "행사 중복 제외" : program.overlap === "PROGRAM" ? "프로그램 중복 제외" : "중복 허용"}</span>
                        <span>{program.published ? "참가자 공개" : "결과 비공개"}</span>
                        <span>{moduleTitle}</span>
                      </div>
                      {(program.eligibleGroups.length || program.eligibleCompanies.length) ? (
                        <p className={styles.programMetaText}>대상 {[
                          program.eligibleGroups.length ? `그룹 ${program.eligibleGroups.join(", ")}` : "",
                          program.eligibleCompanies.length ? `업체 ${program.eligibleCompanies.join(", ")}` : "",
                        ].filter(Boolean).join(" · ")}</p>
                      ) : <p className={styles.programMetaText}>그룹·업체 필터 없음 · 입장(체크인)한 승인 참가자 전체 대상</p>}
                      {program.prizeTiers.length ? <p className={styles.programMetaText}>등급 · {program.prizeTiers.map((tier) => `${tier.name} ${tier.count}명`).join(" · ")}</p> : null}
                      {program.winners.length ? (
                        <ul className={styles.winnerList} aria-label={`${program.name} 당첨 결과`}>
                          {program.winners.map((winner, index) => {
                            const reward = state.rewards.find((entry) => entry.sourceKind === "draw" && entry.sourceProgramId === program.id && entry.winnerIndex === index);
                            const recipient = reward?.participantId ? state.participants.find((person) => person.id === reward.participantId) : null;
                            const eligibleRecipients = winner.kind === "COMPANY"
                              ? state.participants.filter((person) => person.status === "APPROVED" && !person.revoked && person.company === winner.company)
                              : [];
                            return (
                              <li className={styles.winnerItem} key={`${program.id}-winner-${index}`}>
                                <div className={styles.winnerSummary}>
                                  <strong>{winner.name}</strong>
                                  <span>{winner.kind === "COMPANY" ? "당첨 업체" : winner.kind === "PERSON" ? "당첨 참가자" : "당첨"}{winner.tier ? ` · ${winner.tier}` : ""}{typeof winner.luckyNumber === "number" ? ` · 럭키번호 ${winner.luckyNumber}` : ""}</span>
                                </div>
                                {winner.kind === "COMPANY" ? (
                                  reward?.status === "PENDING" ? (
                                    canWriteRewardAssign ? (
                                    <div className={styles.recipientAssign}>
                                      <label htmlFor={`recipient-${reward.id}`}>업체 수령자 지정</label>
                                      <div className={styles.recipientControls}>
                                        <select id={`recipient-${reward.id}`} value={rewardRecipient[reward.id] ?? ""} onChange={(event) => setRewardRecipient((items) => ({ ...items, [reward.id]: event.target.value }))}>
                                          <option value="">같은 업체 승인 참가자 선택</option>
                                          {eligibleRecipients.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                                        </select>
                                        <button type="button" className="button button-secondary" disabled={!rewardRecipient[reward.id] || writeLocked || busy === `reward:${reward.id}`} onClick={() => assignCompanyRecipient(reward)}>{busy === `reward:${reward.id}` ? "지정 중입니다" : "수령자 지정"}</button>
                                      </div>
                                      <p className={styles.hint}>수령자는 자동으로 정하지 않습니다. 지정 후 현장 DESK에서 수령 처리할 수 있습니다.</p>
                                    </div>
                                    ) : (
                                      <p className={styles.programMetaText}>업체 수령자 지정은 경품 쓰기 권한이 필요합니다. 필요하면 담당 행사 운영자에게 요청하세요.</p>
                                    )
                                  ) : reward?.participantId ? (
                                    <p className={styles.programMetaText}>수령자 지정 · {recipient?.name ?? "참가 확정자"} · {reward.status === "RECEIVED" ? "수령 완료" : "수령 대기"}</p>
                                  ) : <p className={styles.programMetaText}>수령자 정보를 확인할 수 없습니다. 경품 목록에서 해당 업체의 보류 경품을 확인하세요.</p>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : <p className={styles.programWinners}>아직 추첨 결과가 없습니다.</p>}
                      {canWriteDraws ? (
                        <div className={styles.programActions}>
                          {!program.winners.length ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked} onClick={() => {
                            setProgramFormOpen(true);
                            setEditingProgramId(program.id); setProgramName(program.name); setProgramQuota(String(program.quota)); setProgramModuleId(program.moduleId);
                            setProgramEligibility(program.eligibility); setProgramGroups(program.eligibleGroups); setProgramCompanies(program.eligibleCompanies); setProgramOverlap(program.overlap);
                            setProgramTiers(program.prizeTiers.map((tier) => ({ key: randomId("tier"), name: tier.name, count: String(tier.count) })));
                            requestAnimationFrame(() => {
                              programFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                            });
                          }}>설정 수정</button> : null}
                          {program.status === "DRAFT" || program.status === "CLOSED" && remaining > 0 ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked || !program.published && program.winners.length > 0} onClick={() => requestProgramStatus(program, "OPEN")}>{program.status === "DRAFT" ? "운영 시작" : "다시 열기"}</button> : null}
                          {program.status === "OPEN" ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked} onClick={() => requestProgramStatus(program, "CLOSED")}>운영 종료</button> : null}
                          {program.winners.length || (program.status === "OPEN" && !program.published) ? (
                            <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked} onClick={() => {
                              if (!program.winners.length && !program.published) {
                                setPendingConfirm({ kind: "publishEmptyProgram", program, summary: `“${program.name}”의 결과 공개를 허용할까요? 추첨을 실행하면 당첨 결과가 참가자에게 공개될 수 있습니다. 지금 추첨이 실행되지는 않습니다.` });
                              } else {
                                void setProgramPublished(program, !program.published);
                              }
                            }}>{!program.winners.length ? "결과 공개 허용" : program.published ? "결과 비공개" : "결과 공개"}</button>
                          ) : null}
                          {program.status === "OPEN" && remaining > 0 ? (
                            <>
                              <div className={styles.runCountField}>
                                <label htmlFor={`run-count-${program.id}`}>이번 실행 인원</label>
                                <input id={`run-count-${program.id}`} type="number" min={1} max={countLimit} value={runCounts[program.id] ?? "1"} disabled={writeLocked} onChange={(event) => setRunCounts((values) => ({ ...values, [program.id]: event.target.value }))} />
                              </div>
                              <div className={styles.runActions} role="group" aria-label={`${program.name} 추첨 실행`}>
                                <button type="button" className="button button-primary" aria-describedby={runBlockers.length ? runBlockerId : undefined} disabled={!canRun || busy !== null || writeLocked} onClick={() => runProgram(program)}>{busy === `run:${program.id}` ? "추첨 중입니다" : `${runCount}명 추첨 실행`}</button>
                                <button type="button" className={`button button-secondary ${styles.stageButton}`} aria-describedby={[...stagePrerequisites, runBlockers.length ? runBlockerId : null, stageOnlyBlockers.length ? stageBlockerId : null].filter(Boolean).join(" ") || undefined} disabled={!canRun || !screenEnabled || moduleNeedsPublishing || busy !== null || writeLocked} onClick={() => runProgram(program, true)}>{busy === `stage:${program.id}` ? "무대 결과 준비 중" : "무대 터치 실행"}</button>
                                {runBlockers.length ? (
                                  <p className={styles.runBlocker} id={runBlockerId}>실행 전제: {runBlockers.join(" · ")} · {runNextAction} 실행할 수 있습니다</p>
                                ) : null}
                                {stageOnlyBlockers.length ? (
                                  <p className={styles.runBlocker} id={stageBlockerId}>무대 터치 실행 전제: {stageOnlyBlockers.join(" · ")}</p>
                                ) : null}
                              </div>
                              {moduleNeedsPublishing ? (
                                <p className={styles.stagePrerequisite} id={`stage-module-prerequisite-${program.id}`}>
                                  {!linkedModule
                                    ? <>연결된 추첨용 무대 프로그램이 없습니다. <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 콘텐츠에서 추첨 무대를 만들고 연결하세요.</Link></>
                                    : <>연결된 무대 프로그램이 비공개입니다. 기존 결과는 자동 공개되지 않습니다. <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 콘텐츠에서 해당 무대의 운영을 시작해 공개하세요.</Link></>}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.empty}>등록된 추첨 프로그램이 없습니다. 쿼터·대상·중복 정책을 정해 첫 프로그램을 만드세요.</p>}
            {canWriteDraws ? (
                    <details className={styles.setupDetails} open={programFormOpen} onToggle={(event) => setProgramFormOpen((event.target as HTMLDetailsElement).open)}>
        <summary className={styles.setupSummary} data-disclosure-indicator="">추첨 프로그램 설정 · {state.drawPrograms.length}개</summary>
<ValidatedForm ref={programFormRef} className={styles.programForm} onSubmit={saveProgram}>
                <h3 className={styles.formHeading}>{editingProgramId ? "추첨 설정 수정" : "추첨 프로그램 만들기"}</h3>
                <div className={styles.configGrid}>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-name">추첨 이름</label>
                    <input id="draws-program-name" type="text" maxLength={80} placeholder="예: 초빙 업체 추첨" value={programName} onChange={(event) => setProgramName(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-quota">총 당첨 인원</label>
                    <input id="draws-program-quota" type="number" min={1} max={10000} value={programQuota} onChange={(event) => setProgramQuota(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-module">연결된 무대 추첨</label>
                    <select id="draws-program-module" value={programModuleId} onChange={(event) => setProgramModuleId(event.target.value)}>
                      <option value="">선택하세요</option>
                      {state.drawModules.map((module) => <option key={module.id} value={module.id}>{module.title} · {module.status}</option>)}
                    </select>
                  </div>
                  <div className={styles.programField}>
                    <ConsoleChoiceGroup id="draws-program-eligibility" label="추첨 단위" value={programEligibility}
                      onChange={(value) => setProgramEligibility(value as "PERSON" | "COMPANY")}
                      options={[{ value: "PERSON", label: "개인 참가자" }, { value: "COMPANY", label: "업체 (업체별 1회 추첨)" }]} />
                  </div>
                  <div className={styles.programField}>
                    <ConsoleChoiceGroup id="draws-program-overlap" label="중복 당첨 범위" value={programOverlap}
                      onChange={(value) => setProgramOverlap(value as "EVENT" | "PROGRAM" | "NONE")}
                      options={[{ value: "EVENT", label: "행사 전체에서 제외" }, { value: "PROGRAM", label: "이 프로그램에서만 제외" }, { value: "NONE", label: "중복 허용" }]} />
                  </div>
                </div>
                <p className={styles.hint}>
                  {programOverlap === "EVENT" ? "행사 전체에서 이미 당첨된 개인·업체를 제외합니다." : programOverlap === "PROGRAM" ? "이 프로그램의 이전 당첨만 제외합니다." : "다른 실행·프로그램의 당첨자도 다시 뽑힐 수 있습니다. 경품도 당첨 건마다 별도로 생성됩니다."}
                </p>
                <div className={styles.filterGrid}>
                  <NameFilter
                    id="draw-groups"
                    label="대상 그룹"
                    options={groupOptions}
                    selected={programGroups}
                    onChange={setProgramGroups}
                    value={groupDraft}
                    onValueChange={setGroupDraft}
                  />
                  <NameFilter
                    id="draw-companies"
                    label="대상 업체"
                    options={companyOptions}
                    selected={programCompanies}
                    onChange={setProgramCompanies}
                    value={companyDraft}
                    onValueChange={setCompanyDraft}
                  />
                </div>
                <div className={styles.tierEditor}>
                  <div className={styles.tierHeading}>
                    <div>
                      <h4>경품 등급 (선택)</h4>
                      <p className={styles.hint}>등급을 쓰면 인원 합계가 총 당첨 인원과 같아야 합니다. 비워두면 등급 없는 추첨입니다.</p>
                    </div>
                    <button type="button" className="button button-secondary" disabled={programTiers.length >= 20} onClick={() => setProgramTiers((tiers) => [...tiers, { key: randomId("tier"), name: "", count: "" }])}>등급 추가</button>
                  </div>
                  {programTiers.map((tier, index) => (
                    <div className={styles.tierRow} key={tier.key}>
                      <div className={styles.programField}>
                        <label htmlFor={`draw-tier-name-${tier.key}`}>등급 {index + 1} 이름</label>
                        <input id={`draw-tier-name-${tier.key}`} type="text" maxLength={80} placeholder="예: 1등" value={tier.name} onChange={(event) => setProgramTiers((items) => items.map((item) => item.key === tier.key ? { ...item, name: event.target.value } : item))} />
                      </div>
                      <div className={styles.programField}>
                        <label htmlFor={`draw-tier-count-${tier.key}`}>당첨 인원</label>
                        <input id={`draw-tier-count-${tier.key}`} type="number" min={1} max={10000} value={tier.count} onChange={(event) => setProgramTiers((items) => items.map((item) => item.key === tier.key ? { ...item, count: event.target.value } : item))} />
                      </div>
                      <button type="button" className="button button-secondary" aria-label={`${tier.name || `등급 ${index + 1}`} 제거`} onClick={() => setProgramTiers((items) => items.filter((item) => item.key !== tier.key))}>제거</button>
                    </div>
                  ))}
                  {programTiers.length ? <p className={configuredTierTotal === Number(programQuota) ? styles.successHint : styles.fieldError}>등급 인원 합계 {configuredTierTotal}명 · 전체 {Number(programQuota) || 0}명</p> : null}
                </div>
                <ConsoleFormActions>
                  <button type="submit" className="button button-secondary" disabled={busy === "program:save" || writeLocked || !state.drawModules.length}>
                    {busy === "program:save" ? "저장 중입니다" : editingProgramId ? "설정 저장" : "추첨 만들기"}
                  </button>
                  {editingProgramId ? <button type="button" className="button button-secondary" onClick={() => {
                    setEditingProgramId(null); setProgramName(""); setProgramQuota(""); setProgramModuleId("");
                    setProgramEligibility("PERSON"); setProgramGroups([]); setProgramCompanies([]); setProgramOverlap("EVENT"); setProgramTiers([]);
                  }}>취소</button> : null}
                </ConsoleFormActions>
              </ValidatedForm>
      </details>
            ) : null}
          </>
        )}
      </ConsoleSection>

      <ConsoleSection headingId="draws-vote" title={`순위 투표 · ${state.voteTotal}표`}>
        {!state.pollEnabled ? <p className={styles.featureOff}>이 행사에서 투표 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>선택 수는 1~20개로 설정합니다. 첫 투표 접수 뒤에는 선택 수와 팀 구성이 잠깁니다. 집계는 서버 순위와 동률을 그대로 표시하며 임의 순위를 만들지 않습니다.</p>
            {canWriteDraws ? (
              <ValidatedForm className={styles.configForm} onSubmit={saveVoteConfig}>
                <div className={styles.configGrid}>
                  <div className={styles.programField}>
                    <label htmlFor="vote-pick-count">참가자 선택 수</label>
                    <input id="vote-pick-count" type="number" min={1} max={20} value={votePickCount} onChange={(event) => setVotePickCount(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="vote-status">투표 상태</label>
                    <select id="vote-status" value={voteStatus} onChange={(event) => setVoteStatus(event.target.value as "OPEN" | "CLOSED")}>
                      <option value="CLOSED">마감</option>
                      <option value="OPEN">운영 중</option>
                    </select>
                  </div>
                </div>
                <label className={styles.checkLine}>
                  <input type="checkbox" checked={voteResultsPublished} onChange={(event) => setVoteResultsPublished(event.target.checked)} />
                  참가자에게 집계 결과 공개
                </label>
                <p className={styles.hint}>공개를 끄면 집계 수치는 운영자 화면에만 표시됩니다. 결과 순위의 동률은 동률 그대로 공개합니다.</p>
                <ConsoleFormActions>
                  <button type="submit" className="button button-secondary" disabled={busy === "vote:save" || writeLocked}>
                    {busy === "vote:save" ? "저장 중입니다" : "투표 설정 저장"}
                  </button>
                </ConsoleFormActions>
              </ValidatedForm>
            ) : null}
            {canWriteDraws ? (
              // Team registration is setup work; the roster and the tally are
              // what the operator reads during the event.
              <details className={styles.setupDetails}>
                <summary className={styles.setupSummary} data-disclosure-indicator="">투표 팀 등록 · {state.teams.length}팀</summary>
                <ValidatedForm className={styles.inlineForm} onSubmit={addTeam}>
                  <label className={styles.inlineLabel} htmlFor="draws-team-name">투표 팀</label>
                  <input
                    id="draws-team-name"
                    type="text"
                    maxLength={80}
                    placeholder="예: 영업 1팀"
                    value={teamName}
                    onChange={(event) => setTeamName(event.target.value)}
                    disabled={state.voteTotal > 0}
                  />
                  <button type="submit" className="button button-secondary" disabled={busy === "team:add" || writeLocked || !teamName.trim() || state.voteTotal > 0}>
                    {busy === "team:add" ? "등록 중입니다" : "팀 등록"}
                  </button>
                </ValidatedForm>
              </details>
            ) : null}
            {state.voteTotal > 0 ? <p className={styles.lockNote}>첫 투표가 접수되어 팀 구성과 선택 수는 잠겼습니다.</p> : null}
            {state.teams.length ? (
              <ul className={styles.teamList}>
                {state.teams.map((team) => {
                  const result = state.voteTally?.results.find((row) => row.teamId === team.id);
                  return (
                    <li key={team.id} className={styles.teamItem}>
                      <strong>{result ? `${result.tied ? `공동 ${result.rank}` : result.rank}위 · ` : ""}{team.name}</strong>
                      <span>{result ? `${result.selections}표` : state.voteTally ? "0표" : "집계 전"}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.empty}>등록된 투표 팀이 없습니다.</p>}
            {canWriteDraws ? (
              <div className={styles.tallyActions}>
                <button type="button" className="button button-secondary" onClick={refreshVoteTally} disabled={tallyLoading || writeLocked || state.teams.length === 0}>
                  {tallyLoading ? "집계 중입니다" : "서버 집계 새로고침"}
                </button>
                {state.voteTally ? (
                  <span className={styles.hint}>
                    {state.voteTally.totalVotes}표 집계 · 참가자 결과 {state.voteTally.published ? "공개" : "비공개"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </ConsoleSection>



      <ConsoleSection headingId="draws-roulette" title={`모바일 룰렛 · ${state.rouletteSpun}회 참여`}>
        {!state.drawEnabled ? <p className={styles.featureOff}>이 행사에서 룰렛 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>모바일 룰렛은 무대 추첨과 별도로 운영됩니다. 유한 재고는 남은 수량이 기본 가중치이며, 무제한 경품은 명시한 양의 가중치로 반영됩니다.</p>
            {canWriteDraws ? (
                    <details className={styles.setupDetails} >
        <summary className={styles.setupSummary} data-disclosure-indicator="">룰렛 운영 설정 · {rouletteConflict ? "변경 내용 확인 필요" : rouletteScheduleNeedsReview && rouletteStatus === "OPEN" ? "시간 확인 필요 · 참여 보류" : `${rouletteStatus === "OPEN" ? "운영 중" : rouletteStatus === "DRAFT" ? "준비" : "마감"}${rouletteScheduleNeedsReview ? " · 시간 확인 필요" : ""}`}</summary>
<ValidatedForm className={styles.programForm} onSubmit={saveRouletteConfig}>
                {rouletteConflict ? <section className={styles.rouletteConflict} aria-labelledby="roulette-conflict-heading">
                  <h3 id="roulette-conflict-heading" tabIndex={-1}>다른 작업에서 룰렛 설정이 변경됐습니다</h3>
                  <p>이번 저장은 반영되지 않았습니다. 작성한 내용은 그대로 있습니다. 최신 설정과 비교해 주세요.</p>
                  {rouletteConflict.error ? <p role="alert">{rouletteConflict.error}</p> : null}
                  {rouletteConflict.latest ? <>
                    <h4>최신 설정과 내 작성 내용 비교</h4>
                    <dl className={styles.rouletteComparison}>
                      {[
                        { label: "운영 상태", latest: ({ OPEN: "운영 중", DRAFT: "준비", CLOSED: "마감" })[rouletteConflict.latest.config.status], draft: ({ OPEN: "운영 중", DRAFT: "준비", CLOSED: "마감" })[rouletteStatus] },
                        { label: "시작 시간", latest: rouletteTimeDescription(rouletteConflict.latest.config.startsAt), draft: rouletteTimeDescription(rouletteStartChanged ? rouletteStartCleared ? null : isoFromLocalDateTime(rouletteStartsAt) ?? "invalid" : shownRouletteBase.startsAt) },
                        { label: "종료 시간", latest: rouletteTimeDescription(rouletteConflict.latest.config.endsAt), draft: rouletteTimeDescription(rouletteEndChanged ? rouletteEndCleared ? null : isoFromLocalDateTime(rouletteEndsAt) ?? "invalid" : shownRouletteBase.endsAt) },
                        { label: "경품과 재고", latest: roulettePrizeDescription(rouletteConflict.latest.config.prizes), draft: roulettePrizeDescription(roulettePrizes) },
                      ].map((row) => <div key={row.label} className={styles.rouletteComparisonRow}>
                        <dt>{row.label}{row.latest !== row.draft ? <span className={styles.rouletteDifference}>다름</span> : null}</dt>
                        <dd><span>최신 설정</span>{row.latest}</dd><dd><span>내 작성 내용</span>{row.draft}</dd>
                      </div>)}
                    </dl>
                    <p>내 작성 내용으로 계속하면 저장할 때 운영 상태·시간·경품 전체가 내 작성 내용으로 적용됩니다. 최신 설정을 사용하면 내 작성 내용은 사라집니다.</p>
                    <div className={styles.drawRecoveryActions}>
                      <button type="button" className="button button-secondary" onClick={() => resolveRouletteConflict(false)}>내 작성 내용으로 계속</button>
                      <button type="button" className="button button-secondary" onClick={() => resolveRouletteConflict(true)}>최신 설정 사용</button>
                    </div>
                    <p>선택만으로 저장되지 않습니다. 확인 후 직접 저장하세요.</p>
                  </> : <button type="button" className="button button-secondary" disabled={rouletteConflict.loading} onClick={() => void readLatestRoulette()}>{rouletteConflict.loading ? "최신 설정 확인 중…" : "최신 설정 확인"}</button>}
                </section> : null}
                {!rouletteBaseRef.current || rouletteVersionRef.current === null ? <p role="note">룰렛 설정을 안전하게 확인할 수 없습니다. 화면을 다시 불러오거나 운영자에게 문의하세요.</p> : null}
                <fieldset className={styles.rouletteFields} disabled={Boolean(rouletteConflict) || busy === "roulette:save" || writeLocked}>
                <legend className="sr-only">룰렛 설정</legend>
                <div className={`${styles.configGrid} ${styles.rouletteScheduleGrid}`}>
                  <div className={styles.programField}>
                    <label htmlFor="roulette-status">운영 상태</label>
                    <select id="roulette-status" value={rouletteStatus} onChange={(event) => setRouletteStatus(event.target.value as "DRAFT" | "OPEN" | "CLOSED")}>
                      <option value="DRAFT">준비</option><option value="OPEN">운영 중</option><option value="CLOSED">마감</option>
                    </select>
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="roulette-starts">시작 시간 (한국 시간, 선택)</label>
                    <input id="roulette-starts" type="datetime-local" value={rouletteStartsAt} disabled={busy === "roulette:save" || writeLocked} aria-describedby="roulette-time-help" onChange={(event) => { setRouletteStartsAt(event.target.value); setRouletteStartChanged(true); setRouletteStartCleared(false); }} />
                    {rouletteTimeNeedsReview(shownRouletteBase.startsAt) && !rouletteStartChanged ? <p role="note">저장된 시작 시간 확인 필요{shownRouletteBase.startsAt !== "__invalid_roulette_time__" ? `: ${shownRouletteBase.startsAt}` : ""}. 새 시간을 입력하거나 제한을 해제하세요.</p> : null}
                    {(shownRouletteBase.startsAt || rouletteStartsAt || rouletteStartChanged) && !rouletteStartCleared ? <button type="button" className={`button button-quiet ${styles.rouletteTimeAction}`} disabled={busy === "roulette:save" || writeLocked} onClick={() => { setRouletteStartsAt(""); setRouletteStartChanged(true); setRouletteStartCleared(true); }}>시작 시간 제한 해제</button> : null}
                    {rouletteStartCleared ? <p role="status">저장하면 시작 시간 제한을 해제합니다.</p> : null}
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="roulette-ends">종료 시간 (한국 시간, 선택)</label>
                    <input id="roulette-ends" type="datetime-local" value={rouletteEndsAt} disabled={busy === "roulette:save" || writeLocked} aria-describedby="roulette-time-help" onChange={(event) => { setRouletteEndsAt(event.target.value); setRouletteEndChanged(true); setRouletteEndCleared(false); }} />
                    {rouletteTimeNeedsReview(shownRouletteBase.endsAt) && !rouletteEndChanged ? <p role="note">저장된 종료 시간 확인 필요{shownRouletteBase.endsAt !== "__invalid_roulette_time__" ? `: ${shownRouletteBase.endsAt}` : ""}. 새 시간을 입력하거나 제한을 해제하세요.</p> : null}
                    {(shownRouletteBase.endsAt || rouletteEndsAt || rouletteEndChanged) && !rouletteEndCleared ? <button type="button" className={`button button-quiet ${styles.rouletteTimeAction}`} disabled={busy === "roulette:save" || writeLocked} onClick={() => { setRouletteEndsAt(""); setRouletteEndChanged(true); setRouletteEndCleared(true); }}>종료 시간 제한 해제</button> : null}
                    {rouletteEndCleared ? <p role="status">저장하면 종료 시간 제한을 해제합니다.</p> : null}
                  </div>
                </div>
                <p id="roulette-time-help" className={styles.hint}>시간을 지정하지 않으면 제한이 없습니다. 기존 제한은 해제 버튼으로 지울 수 있습니다. 저장된 시간을 확인할 수 없으면 참여가 보류됩니다.</p>
                {(() => {
                  const start = boothScheduleTime(shownRouletteBase.startsAt), end = boothScheduleTime(shownRouletteBase.endsAt);
                  return start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end) && start >= end
                    ? <p role="note">저장된 종료 시간이 시작 시간보다 빠르거나 같습니다. 시간을 확인해 수정하세요.</p> : null;
                })()}
                {roulettePrizes.map((prize, index) => {
                  const used = state.rouletteUsedById[prize.id] ?? 0;
                  const remaining = prize.unlimited ? null : Math.max(0, (Number(prize.quantity) || 0) - used);
                  return (
                    <div className={styles.roulettePrizeRow} key={prize.id}>
                      <div className={styles.prizeRowHeading}>
                        <strong>경품 {index + 1}</strong>
                        <span>{prize.unlimited ? `무제한 · ${used}회 지급` : `남은 재고 ${remaining}개 · ${used}회 지급`}</span>
                      </div>
                      <div className={styles.configGrid}>
                        <div className={styles.programField}>
                          <label htmlFor={`roulette-name-${prize.id}`}>경품 이름</label>
                          <input id={`roulette-name-${prize.id}`} type="text" maxLength={80} value={prize.label} disabled={rouletteFrozen} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, label: event.target.value } : item))} />
                        </div>
                        <div className={styles.programField}>
                          <label htmlFor={`roulette-quantity-${prize.id}`}>유한 재고 수량</label>
                          <input id={`roulette-quantity-${prize.id}`} type="number" min={0} max={100000} value={prize.quantity} disabled={prize.unlimited} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, quantity: event.target.value } : item))} />
                        </div>
                      </div>
                      {!prize.unlimited ? <div className={styles.programField}>
                        <label htmlFor={`roulette-weight-${prize.id}`}>가중치 재정의 (선택, 0 이상)</label>
                        <input id={`roulette-weight-${prize.id}`} type="number" min={0} max={1000000} value={prize.weight} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, weight: event.target.value } : item))} />
                        <p className={styles.hint}>{prize.weight === "0" ? "가중치 0은 이 경품을 추첨에서 제외합니다." : "비워두면 남은 재고 수량이 가중치로 쓰입니다."}</p>
                      </div> : null}
                      <label className={styles.checkLine}>
                        <input type="checkbox" checked={prize.unlimited} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, unlimited: event.target.checked } : item))} />
                        무제한 재고로 운영
                      </label>
                      {prize.unlimited ? <div className={styles.programField}>
                        <label htmlFor={`roulette-weight-${prize.id}`}>무제한 경품 가중치 (양의 정수)</label>
                        <input id={`roulette-weight-${prize.id}`} type="number" min={1} max={1000000} value={prize.weight} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, weight: event.target.value } : item))} />
                        <p className={styles.hint}>가중치는 추첨 비중입니다. 한정 재고와 같은 수치 척도에서 운영자가 직접 정합니다.</p>
                      </div> : null}
                      <button type="button" className="button button-secondary" disabled={rouletteFrozen || roulettePrizes.length <= 1} onClick={() => setRoulettePrizes((items) => items.filter((item) => item.id !== prize.id))}>이 경품 제거</button>
                    </div>
                  );
                })}
                {rouletteFrozen ? <p className={styles.lockNote}>결과가 발생해 경품 이름·목록 순서는 고정되었습니다. 재고 수량, 운영 시간·상태, 가중치는 계속 조정할 수 있습니다.</p> : null}
                <ConsoleFormActions>
                  <button type="button" className="button button-secondary" disabled={rouletteFrozen || roulettePrizes.length >= 20} onClick={() => setRoulettePrizes((items) => [...items, { id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" }])}>경품 추가</button>
                  <button type="submit" className="button button-primary" disabled={busy === "roulette:save" || writeLocked}>{busy === "roulette:save" ? "저장 중입니다" : "룰렛 설정 저장"}</button>
                </ConsoleFormActions>
                <p className={styles.hint}>운영 중에는 설정한 시간에 참가할 수 있습니다. 각 티켓의 결과는 한 번만 저장되며, 수량은 이미 나온 결과보다 줄일 수 없습니다.</p>
                </fieldset>
              </ValidatedForm>
      </details>
            ) : null}
            {!roulettePrizes.length ? <p className={styles.empty}>등록된 경품이 없습니다.</p> : null}
          </>
        )}
      </ConsoleSection>

      <ConsoleSection headingId="draws-lucky" title="럭키번호 사전 배정">
        {!state.drawEnabled ? <p className={styles.featureOff}>이 행사에서 럭키번호 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>알림 캠페인을 보내기 전에 승인 참가자에게 번호를 미리 배정할 수 있습니다. 번호는 범위 내에서 고유하며 기존 발급 번호는 유지됩니다.</p>
            {canWriteDraws ? (
                    <details className={styles.setupDetails} >
        <summary className={styles.setupSummary} data-disclosure-indicator="">럭키번호 범위 설정 · {state.luckyMin}–{state.luckyMax}</summary>
<ValidatedForm className={styles.configForm} onSubmit={saveLuckyConfig}>
                <div className={styles.configGrid}>
                  <div className={styles.programField}><label htmlFor="lucky-min">최소 번호</label><input id="lucky-min" type="number" min={1} max={999999} value={luckyMin} onChange={(event) => editLuckyRange("min", event.target.value)} /></div>
                  <div className={styles.programField}><label htmlFor="lucky-max">최대 번호</label><input id="lucky-max" type="number" min={1} max={999999} value={luckyMax} onChange={(event) => editLuckyRange("max", event.target.value)} /></div>
                </div>
                {!luckyRangeConflict && (luckyMin !== String(state.luckyMin) || luckyMax !== String(state.luckyMax)) && <p className={styles.hint}>입력한 범위는 아직 저장되지 않았습니다. 현재 저장된 범위는 {state.luckyMin}–{state.luckyMax}입니다.</p>}
                {luckyRangeConflict ? <section className={styles.drawRecovery} aria-labelledby="lucky-range-conflict-heading">
                  <h3 id="lucky-range-conflict-heading">번호 범위가 변경됐습니다</h3>
                  {luckyRangeConflict.loading ? <p role="status">최신 범위를 확인하고 있습니다.</p> : !luckyRangeConflict.ready ? <><p role="alert">최신 범위를 불러오지 못했습니다. 입력한 값은 유지됩니다.</p><button type="button" className="button button-secondary" onClick={() => void refreshLuckyRangeConflict()}>최신 범위 다시 확인</button></> : <>
                    <p role="alert">현재 저장된 범위는 {state.luckyMin}–{state.luckyMax}, 입력한 범위는 {luckyMin || "미입력"}–{luckyMax || "미입력"}입니다. 입력을 유지하면 다음 저장에서 현재 범위를 덮어씁니다.</p>
                    <div className={styles.drawRecoveryActions}>
                      <button type="button" className="button button-secondary" onClick={() => { const latest = { min: String(state.luckyMin), max: String(state.luckyMax) }; luckyRangeDraftRef.current = latest; luckyRangeEditBaseRef.current = null; setLuckyMin(latest.min); setLuckyMax(latest.max); setLuckyRangeConflict(null); }}>최신 범위 사용</button>
                      <button type="button" className="button button-secondary" onClick={() => { luckyRangeEditBaseRef.current = { min: state.luckyMin, max: state.luckyMax }; setLuckyRangeConflict(null); }}>입력 유지하고 다시 검토</button>
                    </div>
                  </>}
                </section> : null}
                <p className={styles.hint}>{luckyProgress ? "배정 현황은 현재 요청을 확인한 뒤 새로 표시됩니다." : <>범위 {state.luckyMin}–{state.luckyMax} · 발급 {state.luckyIssued}명 · 미발급 승인 참가자 {missingLuckyCount}명 · 남은 고유 번호 {luckyAvailable}개</>}</p>
                {luckyOutsideRange > 0 ? <p role="note" className={styles.hint}>현재 범위 밖에 발급된 번호 {luckyOutsideRange}건은 유지되며 남은 번호를 차지하지 않습니다. 번호 범위를 확인하세요.</p> : null}
                <ConsoleFormActions>
                  <button type="submit" className="button button-secondary" disabled={busy === "lucky:save" || writeLocked || Boolean(luckyRangeConflict)}>{busy === "lucky:save" ? "저장 중입니다" : "번호 범위 저장"}</button>
                </ConsoleFormActions>
              </ValidatedForm>
      </details>
            ) : <p className={styles.hint}>범위 {state.luckyMin}–{state.luckyMax} · 발급 {state.luckyIssued}명</p>}
            {canWriteDraws ? (
              <div className={styles.preassignBox}>
                <label className={styles.checkLine}>
                  <input type="checkbox" checked={preassignAllApproved} disabled={selectedLucky.eligible.length === 0 || missingLuckyCount === 0 || writeLocked || Boolean(luckyRangeConflict) || busy === "lucky:preassign"} onChange={(event) => setPreassignAllApproved(event.target.checked)} />
                  가져온 참가자를 포함해 승인 참가자 전체 {selectedLucky.eligible.length}명 선택 (기존 번호 유지)
                </label>
                {selectedLucky.excluded > 0 ? <p role="note">취소·티켓 상태나 참가자 식별을 확인해야 하는 기록 {selectedLucky.excluded}건은 배정에서 제외됩니다. 참가자 명단에서 확인하세요.</p> : null}
                {selectedLucky.eligible.length > 0 && missingLuckyCount === 0 ? <p role="status">승인 참가자에게 번호가 모두 배정되었습니다.</p> : null}
                {missingLuckyCount > LUCKY_BATCH_SIZE ? <p className={styles.hint}>최대 5,000명씩 순차 처리합니다. 중간에 멈춰도 이미 처리된 배정은 유지됩니다.</p> : null}
                {missingLuckyCount > luckyAvailable ? <p className={styles.fieldError}>전체 배정에 번호가 {missingLuckyCount - luckyAvailable}개 부족합니다. 범위를 먼저 넓히세요.</p> : null}
                <button type="button" className="button button-primary" disabled={!preassignAllApproved || writeLocked || Boolean(luckyRangeConflict) || busy === "lucky:preassign" || selectedLucky.eligible.length === 0 || missingLuckyCount === 0 || missingLuckyCount > luckyAvailable} onClick={preassignLuckyNumbers}>
                  {busy === "lucky:preassign" ? "번호 배정 중입니다" : selectedLucky.eligible.length === 0 ? "배정할 참가자 없음" : missingLuckyCount === 0 ? "번호 배정 완료" : `${missingLuckyCount}명 번호 일괄 배정`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}

function NameFilter({
  id,
  label,
  options,
  selected,
  onChange,
  value,
  onValueChange,
}: {
  id: string;
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  value: string;
  onValueChange: (value: string) => void;
}) {
  function addValue() {
    const next = value.trim();
    if (!next) return;
    if (!selected.includes(next)) onChange([...selected, next]);
    onValueChange("");
  }

  return (
    <div className={styles.filterField}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className={styles.filterControls}>
        <input id={`${id}-input`} list={`${id}-options`} value={value} onChange={(event) => onValueChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); addValue(); }
        }} placeholder="이름을 입력하거나 목록에서 선택" />
        <datalist id={`${id}-options`}>{options.map((option) => <option value={option} key={option} />)}</datalist>
        <button type="button" className="button button-secondary" disabled={!value.trim()} onClick={addValue}>추가</button>
      </div>
      {selected.length ? <ul className={styles.filterChips}>{selected.map((item) => <li key={item}><span>{item}</span><button type="button" aria-label={`${item} 제외`} onClick={() => onChange(selected.filter((entry) => entry !== item))}>×</button></li>)}</ul> : <p className={styles.hint}>비워두면 전체 대상입니다.</p>}
    </div>
  );
}
