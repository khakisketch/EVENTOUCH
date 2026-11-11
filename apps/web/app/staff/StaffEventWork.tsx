"use client";

import ValidatedForm from "../ui/ValidatedForm";
import NameTagPrint, { type NameTagIdentity } from "../ui/NameTagPrint";


import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import QRCode from "react-qr-code";
import { loginHrefForLocation } from "../auth-redirect";
import { buildStaffScopes, resolveStaffScopeId, type StaffScope } from "./staff-scope";
import { readStaffBootstrap, staffReadErrorMessage } from "./staff-bootstrap";
import {
  buildCorrectionPending,
  isCorrectionLocked,
  type CorrectionPending,
} from "./correction-retry";
import {
  describeWorkingOrg,
  isSelectionRequiredError,
  resolveStaffLeave,
} from "./staff-org-guard";
import {
  abandonOperatorAttempt,
  ensureOperatorContext,
  isOrganizationContextBlock,
  operatorFetch,
} from "../../lib/operator-context";
import { OrganizationContextNotice } from "../OrganizationSwitcher";
import StaffAccountMenu from "./StaffAccountMenu";
import { BackIcon, CopyIcon, RefreshIcon } from "../console/console-ui/ConsoleIcons";
import { useOperatorContextSnapshot } from "./use-operator-context";
import { useEventReceipts } from "../../lib/use-event-receipts";
import { forgetOperatorReceipt } from "../../lib/operator-receipts";
import OperatorReceiptRecovery from "../ui/OperatorReceiptRecovery";
import { boothCanAttempt, boothOperatingStatus, boothScheduleTime, isBoothContextChanged } from "../../lib/booth-availability";
import { readServerClock, type ServerClock } from "../../lib/server-clock";
import prizeStyles from "./staff-event-work.module.css";

// The scanner (and its decoder) loads only when the operator opens it: the
// field screen never pays for jsQR until the first scan.
const CameraScan = dynamic(() => import("../CameraScan"), {
  ssr: false,
  loading: () => <p className="loading-state" role="status">카메라를 준비하고 있습니다.</p>,
});

// A staff screen can stay open across an assigned booth's start or end.
// Recalculate at the next boundary without fetching or changing any write
// state; the server still decides whether each actual visit is accepted.
function useBoothScheduleClock(booths: StaffScope["booths"] | undefined, active: boolean, clock: ServerClock | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || !booths) return;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      const current = readServerClock(clock);
      setTick((value) => value + 1);
      let delay = 60_000;
      for (const booth of booths) {
        if (!current) break;
        if (booth.status !== "OPEN" && booth.status !== "WAITING") continue;
        const start = boothScheduleTime(booth.startsAt);
        const end = boothScheduleTime(booth.endsAt);
        const uncertainty = current.uncertaintyMs;
        for (const boundary of [start === null ? null : start - uncertainty, start === null ? null : start + uncertainty,
          end === null ? null : end - uncertainty, end === null ? null : end + uncertainty + 1]) {
          if (boundary !== null && Number.isFinite(boundary) && boundary > current.now) {
            delay = Math.min(delay, boundary - current.now + 20);
          }
        }
      }
      timer = window.setTimeout(update, delay);
    };
    const onVisible = () => { if (document.visibilityState === "visible") update(); };
    update();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", update);
    };
  }, [active, booths, clock]);
  return readServerClock(clock);
}

type DeskReward = { id: string; name: string; status: string; method: string; issue?: string };
type RewardLookup = { ticket: string } | { participantId: string; verificationId: string };
class SettledRewardError extends Error {
  constructor(message: string, readonly status: "RECEIVED" | "CANCELLED") {
    super(message);
  }
}
class RewardContextError extends Error {
  constructor(message: string, readonly reason: "desk" | "identity") { super(message); }
}

function canHandOutReward(reward: DeskReward): boolean {
  const method = reward.method.trim().toUpperCase();
  return !method || method === "ONSITE";
}

type RewardParticipant = { id: string; name: string; company: string; verificationId: string; ticket: string };
type DeskParticipant = { id: string; name: string; company: string; group: string; status: string; inside: boolean | null; attendanceReview: boolean | null };
type AppliedReceiptDetail = { eventId?: string; commandId?: string; command?: string; userId?: string; organizationId?: string };
type DeskDirection = "IN" | "OUT";
type DeskDirectionReview = { from: DeskDirection | null; to: DeskDirection | null };

function deskDirection(value: unknown): DeskDirection | null {
  return value === "IN" || value === "OUT" ? value : null;
}

type ScanPlace = { task: "desk" | "booth"; placeName: string; actionLabel: string };
type PendingScan = {
  eventId: string;
  assignmentId: string;
  command: "check.scan" | "booth.visit";
  payload: { deskId: string; expectedAction: "IN" | "OUT" } & ({ ticket: string } | { participantId: string; expectedIdentity: { name: string; company: string } })
    | { boothId: string; ticket: string };
  commandId: string;
  attempt: string;
  place: ScanPlace;
  targetLabel?: string;
  uncertain: boolean;
};

const SCAN_HISTORY_NOTICES = {
  CORRECTED: "이 출입 기록은 이미 정정됐습니다.",
  SUPERSEDED: "이 요청 이후 다른 출입이 기록됐습니다.",
  PARTICIPANT_CHANGED: "이 요청 이후 참가 상태가 바뀌었습니다.",
  UNAVAILABLE: "이 기록이 현재 출입 상태에 해당하는지 확인할 수 없습니다.",
};
type ScanRecordStatus = keyof typeof SCAN_HISTORY_NOTICES;

type ScanResult =
  | { kind: "idle" }
  | { kind: "ok"; participantId: string; name: string; action: string; reentry: boolean; booth?: string; place: ScanPlace; checkId?: string; correctionChanged?: true; recordStatus?: ScanRecordStatus }
  | { kind: "failed"; message: string; uncertain: boolean; place: ScanPlace; requestTicket: string; requestTarget?: string; deskRefreshRequired?: boolean; sourceRefreshRequired?: boolean; manualRefreshRequired?: boolean; boothLimitReached?: boolean; attendanceReviewRequired?: boolean; eligibilityReviewRequired?: boolean };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function parseRewardList(value: unknown): DeskReward[] | null {
  if (!Array.isArray(value)) return null;
  const rewards: DeskReward[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const reward = item as Record<string, unknown>;
    if (typeof reward.id !== "string" || !reward.id || ids.has(reward.id) ||
        typeof reward.name !== "string" || !reward.name || typeof reward.status !== "string" || typeof reward.method !== "string") return null;
    ids.add(reward.id);
    rewards.push({ id: reward.id, name: reward.name, status: reward.status, method: reward.method });
  }
  return rewards;
}

// Recent checks read in queue order; a bare name is not enough to verify the
// last scan while a line is moving.
function formatCheckTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function identityKey(person: Pick<DeskParticipant, "name" | "company">): string {
  return `${person.name.trim().toLowerCase()}\u0000${person.company.trim().toLowerCase()}`;
}

async function readNameTagIdentity(eventId: string, participantId: string, confirmedName: string,
  checkId: string | undefined, context: string, signal: AbortSignal): Promise<NameTagIdentity> {
  const unavailable = "최신 참가자 정보를 확인하지 못했습니다. 연결과 업무 권한을 확인한 뒤 다시 시도하세요.";
  try {
    const { status, state } = await readStaffBootstrap(new AbortController(), signal);
    if (status !== 200 || !state || !Array.isArray(state.events)) throw new Error(unavailable);
    const event = state.events.find((item) => item?.id === eventId);
    const workspace = state.workspaces?.[eventId];
    if (!event || typeof event.name !== "string" || !workspace || workspace.participantsAvailable !== true ||
        workspace.checksAvailable !== true || !Array.isArray(workspace.participants) ||
        !Array.isArray(workspace.assignments) || !workspace.assignments.some((item) => item && item.type === "DESK")) {
      throw new Error(unavailable);
    }
    const matches = workspace.participants.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item) && (item as Record<string, unknown>).id === participantId);
    const person = matches[0];
    if (matches.length !== 1 || typeof person.name !== "string" || typeof person.company !== "string" ||
        typeof person.status !== "string" || typeof person.inside !== "boolean") throw new Error(unavailable);
    if (person.name !== confirmedName || person.status !== "APPROVED" || !person.inside) {
      throw new Error("참가자 정보나 입장 상태가 바뀌었습니다. 현장 책임자에게 확인해 주세요.");
    }
    if (checkId && (!Array.isArray(workspace.checks) || !workspace.checks.some((item) =>
      item && item.id === checkId && item.participantId === participantId && item.action === "IN" && item.corrected === false))) {
      throw new Error("입장 기록을 확인하지 못했습니다. 현장 책임자에게 확인해 주세요.");
    }
    return { name: confirmedName, company: person.company, eventName: event.name, context };
  } catch (failure) {
    if (signal.aborted) throw failure;
    if (failure instanceof Error && (failure.message === unavailable || failure.message.startsWith("참가자 정보나") || failure.message.startsWith("입장 기록을"))) throw failure;
    throw new Error(unavailable);
  }
}

export default function StaffEventWork({ eventId }: { eventId: string }) {
  const router = useRouter();
  const targetEventId = resolveStaffScopeId(eventId);
  const pendingScanIdRef = useRef(new Map<string, string>());
  const pendingScanRef = useRef<PendingScan | null>(null);
  const scanBusyRef = useRef(false);
  const loadRequestRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<StaffScope | null>(null);
  const [missingAssignment, setMissingAssignment] = useState(false);
  const [assignmentStale, setAssignmentStale] = useState(false);
  const [deskDirectionReviews, setDeskDirectionReviews] = useState<Record<string, DeskDirectionReview>>({});
  const [confirmingDirection, setConfirmingDirection] = useState(false);
  const confirmedDeskDirectionsRef = useRef(new Map<string, DeskDirection>());
  const deskDirectionReviewsRef = useRef<Record<string, DeskDirectionReview>>({});
  const lastLoadedScopeRef = useRef<StaffScope | null>(null);
  const directionConfirmRef = useRef(false);
  const [task, setTask] = useState<"desk" | "booth">("desk");
  const [deskId, setDeskId] = useState("");
  const selectedDeskIdRef = useRef("");
  selectedDeskIdRef.current = deskId;
  const [boothId, setBoothId] = useState("");
  const [boothStatusStale, setBoothStatusStale] = useState(false);
  const [serverClock, setServerClock] = useState<ServerClock | null>(null);
  const boothClock = useBoothScheduleClock(scope?.booths, task === "booth", serverClock);
  const [ticket, setTicket] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraButtonRef = useRef<HTMLButtonElement | null>(null);
  const [kiosk, setKiosk] = useState(false);
  const [nametagResult, setNametagResult] = useState<ScanResult | null>(null);
  const [result, setResult] = useState<ScanResult>({ kind: "idle" });
  const historicalScan = result.kind === "ok" && result.recordStatus;
  const nametagOpen = result.kind === "ok" && !historicalScan && result === nametagResult;
  const [correctReason, setCorrectReason] = useState("");
  const [correctNotice, setCorrectNotice] = useState<string | null>(null);
  // An unconfirmed correction keeps its full identity: event, assignment,
  // record, payload, and command id. While the outcome is unknown the reason
  // field locks and the desk/task/kiosk/scan controls lock with it, so the
  // pending request can never be silently swapped underneath the retry.
  const [correctUnknown, setCorrectUnknown] = useState(false);
  const correctingRef = useRef(false);
  const pendingCorrectRef = useRef<CorrectionPending | null>(null);
  const [boothCopyNotice, setBoothCopyNotice] = useState<string | null>(null);
  // Copy feedback for the ticket/booth code typed into the scan form. Kept
  // separate from the SELF-mode QR copy notice so each message stays next to
  // the button that produced it.
  const [ticketCopyNotice, setTicketCopyNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [directory, setDirectory] = useState<Record<string, string>>({});
  const [deskParticipants, setDeskParticipants] = useState<DeskParticipant[]>([]);
  const [manualQuery, setManualQuery] = useState("");
  const [manualVisibleLimit, setManualVisibleLimit] = useState(10);
  const [manualTarget, setManualTarget] = useState<DeskParticipant | null>(null);
  const [manualIdentityConfirmed, setManualIdentityConfirmed] = useState(false);
  // 입력 방식: 스캔(카메라+코드)과 명단 찾기를 같은 위계의 전환으로 둔다.
  // 접힌 details 뒤에 숨기지 않는다: 카메라 고장 순간에 발견 비용이 가장 크기 때문이다.
  // 카메라 API 자체가 없으면 처음부터 명단 모드로 시작한다.
  const [entryMode, setEntryMode] = useState<"scan" | "roster">("scan");
  useEffect(() => {
    if (typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia) setEntryMode("roster");
  }, []);
  function chooseEntryMode(next: "scan" | "roster") {
    setEntryMode(next);
    if (next === "roster") window.requestAnimationFrame(() => document.getElementById("staff-manual-search")?.focus({ preventScroll: false }));
  }
  const [rewardEnabled, setRewardEnabled] = useState(false);
  const [rewardTarget, setRewardTarget] = useState<RewardParticipant | null>(null);
  const [targetRewards, setTargetRewards] = useState<DeskReward[]>([]);
  const [rewardDataLoaded, setRewardDataLoaded] = useState(false);
  const [rewardLookupTicket, setRewardLookupTicket] = useState("");
  const [rewardLookupLoading, setRewardLookupLoading] = useState(false);
  // The last successfully scanned desk ticket, kept so the prize lookup can
  // replay it with one touch: an exit scan that missed its reward response
  // must not force the operator to retype the same ticket. Client memory
  // only; no new server field is involved.
  const [lastScannedTicket, setLastScannedTicket] = useState("");
  const [rewardCollectingId, setRewardCollectingId] = useState<string | null>(null);
  const rewardRequestRef = useRef<symbol | null>(null);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [rewardDeskError, setRewardDeskError] = useState<string | null>(null);
  const [rewardNotice, setRewardNotice] = useState<string | null>(null);
  const pendingRewardCommandsRef = useRef(new Map<string, { id: string; uncertain: boolean; command: "reward.lookup" | "reward.collect"; payload: Record<string, unknown> }>());
  const eventReceipts = useEventReceipts(targetEventId);
  const previousOtherReceipt = useRef({ eventId: targetEventId, pending: false });
  const [receiptRefreshNeeded, setReceiptRefreshNeeded] = useState(false);
  const [receiptRefreshing, setReceiptRefreshing] = useState(false);
  const receiptRefreshRef = useRef(false);
  const appliedReceiptQueueRef = useRef<AppliedReceiptDetail[]>([]);
  const [receiptNotice, setReceiptNotice] = useState("");
  const [scanStatusChecking, setScanStatusChecking] = useState(false);
  const currentEventRef = useRef(targetEventId); currentEventRef.current = targetEventId;
  const ownReceiptIds = new Set([pendingScanRef.current?.commandId, pendingCorrectRef.current?.commandId, ...[...pendingRewardCommandsRef.current.values()].map((entry) => entry.id)]);
  const inlineScanReceiptId = result.kind === "failed" && result.uncertain ? pendingScanRef.current?.commandId : undefined;
  const otherReceipt = eventReceipts.some((entry) => ["check.scan", "booth.visit", "check.correct", "reward.lookup", "reward.collect"].includes(entry.command) && !ownReceiptIds.has(entry.commandId));
  const receiptLock = otherReceipt || receiptRefreshNeeded || (previousOtherReceipt.current.eventId === targetEventId && previousOtherReceipt.current.pending && !otherReceipt);
  function drainAppliedReceipts() {
    const next = appliedReceiptQueueRef.current.shift();
    if (next) window.setTimeout(() => window.dispatchEvent(new CustomEvent("eventouch:operator-receipt-applied", { detail: next })), 0);
  }
  const scopeRef = useRef<StaffScope | null>(null);
  const boothQrRef = useRef<HTMLDivElement | null>(null);
  // The primary next step after a successful scan, focused on success so
  // keyboard and screen-reader users land on the next action.
  const nextParticipantRef = useRef<HTMLButtonElement | null>(null);
  const directionReviewControlRef = useRef<HTMLButtonElement | null>(null);
  const correctionConflictRef = useRef<HTMLParagraphElement | null>(null);
  const scanInputRef = useRef<HTMLDivElement | null>(null);
  const scanFailureRef = useRef<HTMLElement | null>(null);
  const retryFailedRef = useRef<HTMLButtonElement | null>(null);
  const scanFocusAtSubmitRef = useRef<Element | null>(null);
  const scanEditRevisionRef = useRef(0);
  const scanEditAtSubmitRef = useRef(0);
  scopeRef.current = scope;

  // Compare every previously selected desk with the last direction the staff
  // member chose or explicitly confirmed. A refresh may follow a successful
  // scan, so changing the selector alone must not authorize the next action.
  function noteDeskDirections(next: StaffScope, reset: boolean) {
    if (reset) {
      confirmedDeskDirectionsRef.current.clear();
      const initialReviews: Record<string, DeskDirectionReview> = {};
      if (next.desks.length === 1) {
        const desk = next.desks[0];
        const direction = deskDirection(desk.action);
        if (direction) {
          confirmedDeskDirectionsRef.current.set(desk.id, direction);
          // An auto-selected desk has not been chosen or confirmed by the
          // staff member. Require a fresh confirmation on each page entry;
          // never persist a desk or organization context on a shared device.
          initialReviews[desk.id] = { from: null, to: direction };
        }
      }
      deskDirectionReviewsRef.current = initialReviews;
      setDeskDirectionReviews(initialReviews);
      return;
    }
    const reviews = { ...deskDirectionReviewsRef.current };
    for (const [id, from] of confirmedDeskDirectionsRef.current) {
      const desk = next.desks.find((item) => item.id === id);
      const to = deskDirection(desk?.action);
      if (to !== from || reviews[id]) reviews[id] = { from: reviews[id] ? reviews[id].from : from, to };
    }
    deskDirectionReviewsRef.current = reviews;
    setDeskDirectionReviews(reviews);
    if (reviews[selectedDeskIdRef.current]) setCameraOpen(false);
  }

  function selectDeskDirection(id: string, next: StaffScope) {
    if (!id || confirmedDeskDirectionsRef.current.has(id)) return;
    const direction = deskDirection(next.desks.find((desk) => desk.id === id)?.action);
    if (direction) {
      confirmedDeskDirectionsRef.current.set(id, direction);
    }
  }
  // Shared operator context: the active organization, role, and whether
  // another tab changed the organization underneath this screen.
  const orgSnapshot = useOperatorContextSnapshot();
  const orgChanged = orgSnapshot.changed;
  // The shared switcher dispatches this only after an explicitly confirmed,
  // successful select, immediately before the native role-home navigation.
  // From that point our own beforeunload warnings would only duplicate the
  // browser prompt — suppress them. Nothing is cleared here: the result is
  // known and the navigation owns the rest.
  const confirmedExitRef = useRef(false);
  useEffect(() => {
    const markConfirmedExit = () => {
      confirmedExitRef.current = true;
    };
    window.addEventListener("eventouch:organization-confirmed-exit", markConfirmedExit);
    return () => {
      window.removeEventListener("eventouch:organization-confirmed-exit", markConfirmedExit);
    };
  }, []);

  function focusTicketField() {
    window.requestAnimationFrame(() => {
      const field = document.getElementById("staff-ticket");
      if (field instanceof HTMLInputElement) field.focus();
    });
  }

  // A success clears the just-processed input so the old value can never be
  // resent, and folds the scan input away: the result block next to it owns
  // the "다음 참가자" step. That step restores the input for the next person.
  function allowContextChange(): boolean {
    if (!correctReason.trim() && !manualTarget) return true;
    const warning = manualTarget
      ? "작성 중인 정정 사유 또는 선택한 참가자가 있습니다. 계속하면 입력과 선택이 지워집니다. 이동할까요?"
      : "작성 중인 정정 사유가 있습니다. 계속하면 이 사유가 지워집니다. 이동할까요?";
    if (!window.confirm(warning)) return false;
    setCorrectReason("");
    setManualTarget(null);
    setManualIdentityConfirmed(false);
    setManualQuery("");
    return true;
  }

  function prepareNextParticipant() {
    if (writeLocked || (activeTask === "desk" && deskDirectionReviewsRef.current[deskId]) || scanBusyRef.current || pendingScanRef.current || pendingCorrectRef.current || receiptRefreshRef.current || [...pendingRewardCommandsRef.current.values()].some((entry) => entry.command === "reward.collect" && entry.uncertain)) return;
    if (!allowContextChange()) return;
    setTicket("");
    setManualTarget(null);
    setManualIdentityConfirmed(false);
    setManualQuery("");
    setTicketCopyNotice(null);
    setResult({ kind: "idle" });
    focusTicketField();
  }

  // A failed scan keeps the typed code in place: the operator pressed
  // "다시 시도" because the same ticket should go again, not because the
  // input was wrong. Clearing it here would force a retype of a long code
  // while the line waits. Only a success folds the input away.
  function retryFailedScan() {
    if (pendingScanRef.current) return;
    setResult({ kind: "idle" });
    if (result.kind === "failed" && result.requestTarget) {
      window.requestAnimationFrame(() => document.getElementById("staff-manual-search")?.focus());
    } else focusTicketField();
  }

  // Client-side copy of the code typed into the scan form. Long ET:BOOTH
  // codes truncate inside the single-line input, so the full value stays
  // readable below the field and travels through the clipboard instead of
  // retyping. No server call: the code itself never changes.
  async function copyTicketCode() {
    const code = ticket.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setTicketCopyNotice("입력한 코드를 복사했습니다.");
    } catch {
      setTicketCopyNotice("복사에 실패했습니다. 코드 전체를 선택해 직접 복사하세요.");
    }
  }

  // Organization-switch gate for this screen: busy or uncertain writes block
  // even if the operator would confirm, so an unconfirmed receipt can never
  // move into another organization. Unsaved input asks once with the
  // existing wording; cancel preserves every draft, selection, and retained
  // id in place. Recovery itself is explicit in the parent notice/switcher.
  // The block reads this screen's own in-flight/retained refs — not the
  // adapter's uncertain registry, which also retains definitively answered
  // receipts as a cross-version rebind guard.
  function staffLeaveState(): {
    busyWrites: boolean;
    uncertainWrites: boolean;
    unsavedDraft: boolean;
  } {
    return {
      busyWrites:
        submitting ||
        scanBusyRef.current ||
        correcting ||
        correctingRef.current ||
        rewardLookupLoading ||
        rewardCollectingId !== null,
      uncertainWrites:
        correctUnknown ||
        pendingCorrectRef.current !== null ||
        pendingScanRef.current !== null ||
        pendingRewardCommandsRef.current.size > 0,
      unsavedDraft:
        ticket.trim() !== "" ||
        manualTarget !== null ||
        correctReason.trim() !== "" ||
        rewardLookupTicket.trim() !== "" ||
        cameraOpen ||
        nametagOpen,
    };
  }

  function confirmLeaveStaff(): boolean {
    const verdict = resolveStaffLeave(staffLeaveState());
    if (!verdict.allow) return false;
    if (verdict.needsConfirm) {
      return window.confirm("입력 중인 내용이 있습니다. 조직을 전환하면 이 화면의 입력이 유지되지 않을 수 있습니다. 그래도 전환하시겠습니까?");
    }
    return true;
  }

  // Account-page gate for this screen: the same verdict inputs as the
  // organization switch, but the confirm names leaving for the account page
  // — never an organization switch. Busy or uncertain work blocks silently
  // (the in-flight or unknown-verdict work is visible on screen); a draft
  // asks once with the account wording; cancel keeps everything.
  function confirmLeaveAccountPage(): boolean {
    const verdict = resolveStaffLeave(staffLeaveState());
    if (!verdict.allow) return false;
    if (verdict.needsConfirm) {
      return window.confirm("입력 중인 내용이 있습니다. 내 계정 페이지로 이동하면 이 화면의 입력이 유지되지 않을 수 있습니다. 그래도 이동하시겠습니까?");
    }
    return true;
  }

  // Live at-risk check for navigation warnings: retained receipts (refs) plus
  // the current draft/selection state.
  function staffWorkAtRisk(): boolean {
    return (
      pendingCorrectRef.current !== null ||
      pendingScanRef.current !== null ||
      pendingRewardCommandsRef.current.size > 0 ||
      submitting ||
      correcting ||
      ticket.trim() !== "" ||
      manualTarget !== null ||
      correctReason.trim() !== "" ||
      rewardLookupTicket.trim() !== "" ||
      cameraOpen
    );
  }

  function orgLineText(): string {
    return describeWorkingOrg(
      orgSnapshot.context,
      orgSnapshot.loading,
      !orgSnapshot.context && !orgSnapshot.loading && isSelectionRequiredError(orgSnapshot.error)
    );
  }

  async function load(silent = false, signal?: AbortSignal): Promise<boolean> {
    if (!silent && pendingScanRef.current) return false;
    const requestedEvent = targetEventId;
    loadRequestRef.current?.abort();
    const controller = new AbortController();
    loadRequestRef.current = controller;
    const isCurrent = () => currentEventRef.current === requestedEvent && loadRequestRef.current === controller;
    // A post-scan refresh must not unmount the result the operator just
    // read: only the first load takes over the screen.
    setRefreshing(silent);
    if (!silent) {
      setLoading(true);
      setMissingAssignment(false);
      setScope(null);
      setLoadError(null);
    }
    try {
      const { status, state, clock } = await readStaffBootstrap(controller, signal);
      if (!isCurrent()) return false;
      if (status === 401) {
        lastLoadedScopeRef.current = null;
        if (silent) { setLoadError("업무 정보를 다시 확인하려면 로그인과 행사 접근 권한을 확인하세요."); return false; }
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return false;
      }
      if (!state) {
        lastLoadedScopeRef.current = null;
        setLoadError("업무 정보를 불러오지 못했습니다.");
        return false;
      }
      const scopes = buildStaffScopes(
        Array.isArray(state.events) ? state.events : [],
        state.workspaces ?? {}
      );
      const next = scopes.find((item) => item.eventId === targetEventId) ?? null;
      if (!next) {
        lastLoadedScopeRef.current = null;
        // Assignment revoked, wrong event, or signed in as an operator
        // without desk work: stay on a stable explanation, never a loop.
        if (silent && scopeRef.current) {
          setAssignmentStale(true);
          setCameraOpen(false);
          setLoadError("현재 이 행사의 업무 배정을 확인할 수 없습니다. 운영자에게 확인하세요.");
        } else {
          setScope(null);
          setMissingAssignment(true);
        }
        return false;
      }
      lastLoadedScopeRef.current = next;
      noteDeskDirections(next, !silent);
      setScope(next);
      setServerClock(clock);
      setBoothStatusStale(false);
      setLoadError(null);
      setMissingAssignment(false);
      setAssignmentStale(false);
      const eventRecord = Array.isArray(state.events)
        ? state.events.find((item) => item && item.id === targetEventId)
        : undefined;
      setRewardEnabled(Array.isArray(eventRecord?.features) && eventRecord.features.includes("reward"));
      // Name directory for nametags: the staff projection already carries
      // names and companies for desk work, so no extra read is needed.
      const directoryMap: Record<string, string> = {};
      const nextParticipants: DeskParticipant[] = [];
      const roster = state.workspaces?.[targetEventId]?.participants;
      if (Array.isArray(roster)) {
        for (const entry of roster) {
          if (typeof entry === "object" && entry !== null) {
            const person = entry as Record<string, unknown>;
            if (typeof person.id === "string" && person.id) {
              directoryMap[person.id] = typeof person.company === "string" ? person.company : "";
              if (typeof person.name === "string" && person.name.trim()) nextParticipants.push({
                id: person.id,
                name: person.name,
                company: typeof person.company === "string" ? person.company : "",
                group: typeof person.group === "string" ? person.group : "",
                status: typeof person.status === "string" ? person.status : "",
                inside: typeof person.inside === "boolean" ? person.inside : null,
                attendanceReview: typeof person.attendanceReview === "boolean" ? person.attendanceReview : null,
              });
            }
          }
        }
      }
      if (next.participantsAvailable) {
        setDirectory(directoryMap);
        setDeskParticipants(nextParticipants);
      } else {
        setManualIdentityConfirmed(false);
      }
      if (!silent) {
        // A single assigned desk is not a choice. Keep its name and IN/OUT
        // explanation visible in the existing selector; never pick between
        // multiple desks or submit a scan on the staff member's behalf.
        setDeskId(next.desks.length === 1 ? next.desks[0].id : "");
        setBoothId("");
        setTask(next.desks.length ? "desk" : "booth");
        setResult({ kind: "idle" });
        setManualTarget(null);
        setManualIdentityConfirmed(false);
        setManualQuery("");
        setRewardTarget(null);
        setTargetRewards([]);
        setRewardLookupTicket("");
        setRewardError(null);
        setRewardNotice(null);
      }
      // A silent refresh keeps the operator's desk selection and the result
      // just read; only the scope data (recent checks) updates underneath.
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      lastLoadedScopeRef.current = null;
      setLoadError(staffReadErrorMessage(error));
      return false;
    } finally {
      if (isCurrent()) {
        loadRequestRef.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    confirmedDeskDirectionsRef.current.clear();
    deskDirectionReviewsRef.current = {};
    setDeskDirectionReviews({});
    lastLoadedScopeRef.current = null;
    directionConfirmRef.current = false;
    setConfirmingDirection(false);
    pendingScanIdRef.current.clear();
    pendingScanRef.current = null;
    setBoothStatusStale(false);
    pendingRewardCommandsRef.current.clear();
    rewardRequestRef.current = null;
    pendingCorrectRef.current = null;
    setCorrectUnknown(false);
    setReceiptNotice(""); setReceiptRefreshNeeded(false); setReceiptRefreshing(false); receiptRefreshRef.current = false; appliedReceiptQueueRef.current = [];
    setRewardTarget(null);
    setTargetRewards([]);
    setRewardDataLoaded(false);
    setRewardLookupTicket("");
    setRewardLookupLoading(false);
    setRewardCollectingId(null);
    setLastScannedTicket("");
    setRewardError(null);
    setRewardNotice(null);
    setRewardDeskError(null);
    // Seed the shared organization context; the bootstrap below stays the
    // assignment source and the server preserves its shape.
    // Selection and transport failures already surface through the shared
    // context banner, not as an unrelated unhandled runtime exception.
    void ensureOperatorContext().catch(() => {});
    void load();
    return () => {
      loadRequestRef.current?.abort();
      loadRequestRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEventId]);

  // A reload keeps only a scoped pointer. Do not start a new staff task until
  // its status is checked or explicitly dismissed and the assignment and
  // recent records have been read again.
  useEffect(() => {
    if (previousOtherReceipt.current.eventId === targetEventId && previousOtherReceipt.current.pending && !otherReceipt) {
      const event = targetEventId;
      receiptRefreshRef.current = true; setReceiptRefreshNeeded(true); setReceiptRefreshing(true);
      let refreshed = false;
      void load(true).then((ok) => { refreshed = ok; if (currentEventRef.current === event && ok) setReceiptRefreshNeeded(false); })
        .finally(() => { if (currentEventRef.current === event) { receiptRefreshRef.current = false; setReceiptRefreshing(false); if (refreshed) drainAppliedReceipts(); } });
    }
    previousOtherReceipt.current = { eventId: targetEventId, pending: otherReceipt };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEventId, otherReceipt]);

  // The shared panel has already checked this exact account/event/command.
  // Reconcile only the matching in-memory request, and keep it locked if the
  // current assignment and records cannot be refreshed.
  useEffect(() => {
    const onApplied = (event: Event) => {
      const detail = (event as CustomEvent<AppliedReceiptDetail>).detail;
      const context = orgSnapshot.context;
      if (!detail || detail.eventId !== targetEventId || !context || detail.userId !== context.userId || detail.organizationId !== context.organizationId) return;
      if (receiptRefreshRef.current) {
        if (!appliedReceiptQueueRef.current.some((entry) => entry.commandId === detail.commandId)) appliedReceiptQueueRef.current.push(detail);
        return;
      }
      const scan = pendingScanRef.current;
      const correction = pendingCorrectRef.current;
      const rewardEntry = [...pendingRewardCommandsRef.current.entries()].find(([, value]) => value.id === detail.commandId && value.command === detail.command);
      const scanMatch = Boolean(scan && scan.commandId === detail.commandId && scan.command === detail.command);
      const correctionMatch = correction?.commandId === detail.commandId && detail.command === "check.correct";
      if (!scanMatch && !correctionMatch && !rewardEntry) return;
      // The shared receipt status confirms the command name only. It does not
      // identify the booth, so keep the frozen scan until replay verifies the
      // returned visit against the request instead of silently clearing it.
      if ((scanMatch && scan?.command === "booth.visit") || rewardEntry) {
        setReceiptNotice(rewardEntry ? "경품 대상을 확인하려면 아래에서 같은 요청을 다시 확인하세요." : "대상 확인을 위해 아래에서 같은 요청을 다시 확인하세요.");
        return;
      }
      const selectedEvent = targetEventId;
      receiptRefreshRef.current = true; setReceiptRefreshing(true);
      let refreshed = false;
      void load(true).then((ok) => {
        if (currentEventRef.current !== selectedEvent) return;
        if (!ok) {
          if (!appliedReceiptQueueRef.current.some((entry) => entry.commandId === detail.commandId)) appliedReceiptQueueRef.current.push(detail);
          setReceiptRefreshNeeded(true); setReceiptNotice("서버 처리는 확인됐지만 업무 정보를 갱신하지 못했습니다. 업무 정보를 다시 확인하세요."); return;
        }
        refreshed = true;
        if (scanMatch && scan && pendingScanRef.current?.commandId === scan.commandId) {
          pendingScanIdRef.current.delete(scan.attempt); pendingScanRef.current = null;
          if ("ticket" in scan.payload) {
            const scannedTicket = scan.payload.ticket;
            setTicket((current) => current === scannedTicket ? "" : current);
          }
          else { setManualTarget(null); setManualIdentityConfirmed(false); setManualQuery(""); }
          setResult({ kind: "idle" }); setReceiptNotice("서버 처리를 확인했습니다. 최신 현장 기록을 확인하세요.");
        }
        if (correctionMatch && correction && pendingCorrectRef.current?.commandId === correction.commandId) {
          pendingCorrectRef.current = null; setCorrectUnknown(false); setCorrectReason(""); setResult({ kind: "idle" });
          setCorrectNotice("서버에서 정정 처리를 확인했습니다. 최신 현장 기록을 확인하세요.");
        }
        setReceiptRefreshNeeded(false);
      }).finally(() => { if (currentEventRef.current === selectedEvent) { receiptRefreshRef.current = false; setReceiptRefreshing(false); if (refreshed) drainAppliedReceipts(); } });
    };
    window.addEventListener("eventouch:operator-receipt-applied", onApplied);
    return () => window.removeEventListener("eventouch:operator-receipt-applied", onApplied);
  });

  useEffect(() => {
    if (!kiosk || loading) return;
    const input = document.getElementById("staff-ticket");
    if (input instanceof HTMLInputElement) input.focus();
  }, [kiosk, loading, task, deskId, boothId]);

  // A refresh or tab close during an unconfirmed correction drops the
  // retained id: warn with the platform dialog while the outcome is unknown.
  // In-app back navigation gets its own confirm on the back link below.
  useEffect(() => {
    if (!correctUnknown && !submitting && !(result.kind === "failed" && result.uncertain) &&
        !ticket.trim() && !correctReason.trim() && !rewardLookupTicket.trim() && !pendingRewardCommandsRef.current.size) return;
    const warn = (event: BeforeUnloadEvent) => {
      // After an explicitly confirmed, successful organization switch the
      // navigation owns the exit: never double-prompt on top of it.
      if (confirmedExitRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [correctUnknown, result, submitting, ticket, correctReason, rewardLookupTicket, rewardError, rewardNotice, rewardCollectingId]);
  // Same for an other-tab organization change with work at risk: the
  // retained receipts and drafts live in this tab only. Console draft
  // guards are separate; the staff-local dialog stays.
  useEffect(() => {
    if (!orgChanged) return;
    const warnChanged = (event: BeforeUnloadEvent) => {
      // Suppressed after a confirmed exit exactly like the correction
      // warning above: the successful switch owns the navigation.
      if (confirmedExitRef.current) return;
      if (
        pendingCorrectRef.current !== null ||
        pendingScanIdRef.current.size > 0 ||
        pendingRewardCommandsRef.current.size > 0 ||
        ticket.trim() !== "" ||
        correctReason.trim() !== "" ||
        rewardLookupTicket.trim() !== ""
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warnChanged);
    return () => {
      window.removeEventListener("beforeunload", warnChanged);
    };
  }, [orgChanged, ticket, correctReason, rewardLookupTicket]);
  // The booth QR is shown to the participant, so it has to be fully on
  // screen: scroll it into view whenever a booth is picked.
  // Booth QR scroll respects reduced motion: a smooth glide is decoration,
  // not the task, and must not move under a motion-sensitive operator.
  useEffect(() => {
    if (!boothId || task !== "booth") return;
    const node = boothQrRef.current;
    if (!node) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }, [boothId, task]);

  // Do not reopen a camera implicitly if a booth later becomes available
  // again after a time or status change.
  useEffect(() => {
    if (task !== "booth" || !cameraOpen) return;
    const booth = scope?.booths.find((item) => item.id === boothId);
    if (!booth || !boothCanAttempt(boothOperatingStatus(booth, boothClock?.now ?? null, boothClock?.uncertaintyMs))) setCameraOpen(false);
  }, [boothClock, boothId, cameraOpen, scope, task]);

  // After a successful scan the next step is the "다음 참가자" button in the
  // result block, so focus moves there instead of staying on the folded
  // input. Failures keep focus where the retry happens.
  useEffect(() => {
    if (result.kind !== "ok") return;
    if (result.correctionChanged || result.recordStatus) {
      correctionConflictRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    // Do not pull someone back from another task while a response is late.
    // The removed scan input leaves body focused, which is safe to recover.
    if (active && active !== document.body && active !== scanFocusAtSubmitRef.current && !scanInputRef.current?.contains(active)) return;
    const node = deskDirectionReviewsRef.current[deskId] ? directionReviewControlRef.current : nextParticipantRef.current;
    if (node) node.focus();
  }, [result]);

  // A completed scan request must not leave its result below a short screen.
  // Only move focus when the operator is still in the scan task (or the
  // camera has just closed); never interrupt work they deliberately moved to.
  useEffect(() => {
    if (result.kind !== "failed") return;
    const active = document.activeElement;
    if (scanEditRevisionRef.current !== scanEditAtSubmitRef.current) return;
    if (active && active !== document.body && (active !== scanFocusAtSubmitRef.current || !scanInputRef.current?.contains(active))) return;
    // "nearest" can align the heading at the top while leaving the retry
    // below a short viewport. Center the whole recovery group before focusing
    // without a second browser scroll, so the verdict and action stay together.
    scanFailureRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
    retryFailedRef.current?.focus({ preventScroll: true });
  }, [result]);

  if (loading || (scope && scope.eventId !== targetEventId)) {
    return (
      <>
        <StaffAccountMenu confirmLeave={confirmLeaveStaff} confirmLeaveAccount={confirmLeaveAccountPage} />
        <p className="loading-state" role="status">업무 정보를 불러오고 있습니다.</p>
      </>
    );
  }
  if (missingAssignment || (!scope && loadError)) {
    return (
      <>
        <StaffAccountMenu confirmLeave={confirmLeaveStaff} confirmLeaveAccount={confirmLeaveAccountPage} />
        <p className={prizeStyles.orgLine}>{orgLineText()}</p>
        {orgChanged ? <OrganizationContextNotice confirmLeave={confirmLeaveStaff} /> : null}
        <section className="staff-workspace state-panel">
          <p role="alert">{loadError ?? "이 행사에 대한 업무 배정이 없습니다. 운영자에게 문의하세요."}</p>
          <p>
            <button type="button" className="button button-secondary" onClick={() => load()}>
              다시 불러오기
            </button>{" "}
            <Link className="button button-secondary" href="/staff">
              내 업무로
            </Link>
          </p>
        </section>
      </>
    );
  }
  if (!scope) {
    return (
      <>
        <StaffAccountMenu confirmLeave={confirmLeaveStaff} confirmLeaveAccount={confirmLeaveAccountPage} />
        <p className="loading-state">배정된 업무가 없습니다. 내 업무 목록에서 배정을 확인하거나, 현장 책임자에게 배정을 요청하세요.</p>
        <p><Link className="button button-secondary" href="/staff">내 업무 보기</Link></p>
      </>
    );
  }

  function clearRewardPanel() {
    setRewardTarget(null);
    setTargetRewards([]);
    setRewardDataLoaded(false);
    setRewardError(null);
    setRewardNotice(null);
  }

  const activeScope: StaffScope = scope;
  const hasDeskWork = activeScope.desks.length > 0;
  const hasBoothWork = activeScope.booths.length > 0;
  const activeTask: "desk" | "booth" =
    task === "booth" && hasBoothWork ? "booth" : hasDeskWork ? "desk" : "booth";
  const assignment = activeTask === "desk"
    ? activeScope.assignments.find((item) => item.targetId === deskId) ?? null
    : activeScope.boothAssignments.find((item) => item.targetId === boothId) ?? null;
  const selectedDesk = activeScope.desks.find((desk) => desk.id === deskId) ?? null;
  const directionReview = activeTask === "desk" ? deskDirectionReviews[deskId] : undefined;
  // The SELF booth QR is shown to the participant, so its visible caption
  // names the booth: with several booths on one screen the wrong code is a
  // one-tap mistake the camera cannot catch.
  const selectedBooth = activeTask === "booth"
    ? activeScope.booths.find((booth) => booth.id === boothId) ?? null
    : null;
  const isExitDesk = activeTask === "desk" && selectedDesk?.action === "OUT";
  const deskClosed = activeTask === "desk" && selectedDesk?.open === false;
  const deskRefreshRequired = activeTask === "desk" && (Boolean(rewardDeskError) || result.kind === "failed" && (result.deskRefreshRequired || result.sourceRefreshRequired));
  const boothStatus = selectedBooth ? boothOperatingStatus(selectedBooth, boothClock?.now ?? null, boothClock?.uncertaintyMs) : null;
  const hasBoothScheduleIssue = activeTask === "booth" && activeScope.booths.some((booth) => boothOperatingStatus(booth, boothClock?.now ?? null, boothClock?.uncertaintyMs) === "운영 시간 확인 필요");
  const hasBoothClockUncertainty = activeTask === "booth" && activeScope.booths.some((booth) => boothOperatingStatus(booth, boothClock?.now ?? null, boothClock?.uncertaintyMs) === "인증 시 시간 확인");
  const boothRefreshRequired = boothStatusStale && result.kind === "failed" && result.place.task === "booth" && !result.uncertain;
  const boothLimitReached = result.kind === "failed" && result.boothLimitReached === true;
  // An unavailable booth puts recovery above the next scan. The ticket
  // stays in local state while the scanner and its fallback are out of view.
  const boothAvailable = activeScope.stampAvailable && !boothStatusStale && !loadError;
  const scanInputHasWork = activeTask === "desk" ||
    (activeScope.stampMode !== "SELF" && boothAvailable && !boothLimitReached && (!boothStatus || boothCanAttempt(boothStatus) || Boolean(ticket.trim())));
  const taskChecks = activeTask === "desk" ? activeScope.checks.filter((check) => check.action !== "STAMP") : [];
  const deskSourcesAvailable = activeScope.participantsAvailable && activeScope.checksAvailable;
  const boothVisits = activeTask === "booth"
    ? activeScope.boothVisits.filter((visit) => !selectedBooth || visit.boothId === selectedBooth.id).slice(0, 10)
    : [];
  const ready = activeTask === "desk"
    ? Boolean(assignment && selectedDesk && deskDirection(selectedDesk.action) && !deskClosed && !deskRefreshRequired && !directionReview && !confirmingDirection && deskSourcesAvailable)
    : Boolean(assignment && boothAvailable && !boothLimitReached && boothCanAttempt(boothStatus) && !refreshing);
  const scanHint = directionReview ? "바뀐 데스크 방향을 확인한 뒤 진행하세요." : activeTask === "desk" && !deskSourcesAvailable ? "참가자 명단과 출입 기록을 확인한 뒤 진행하세요." : deskClosed || deskRefreshRequired ? "데스크 상태를 확인한 뒤 진행하세요." : !ready
    ? activeTask === "desk" ? "데스크를 먼저 선택하세요." : boothStatus && !boothCanAttempt(boothStatus) ? `선택한 부스가 ${boothStatus} 상태입니다. 운영 중인 부스를 선택하세요.` : "운영 중인 부스를 먼저 선택하세요."
    : "카메라로 QR을 스캔하거나 티켓 코드를 입력하세요.";
  // Operating context at the action: after any scroll, the operator still
  // sees which desk/booth and action the scan below will commit to. Shown
  // only when the scan is actionable (ready + selected); the select and the
  // direction hint stay the single sources otherwise.
  const scanContext = !ready
    ? null
    : activeTask === "desk"
      ? (selectedDesk ? `현재 ${selectedDesk.name} · ${selectedDesk.action === "OUT" ? "퇴장" : "입장"}` : null)
      : (selectedBooth ? `현재 ${selectedBooth.name} · 부스 인증` : null);
  // The scan input owns exactly one context line: the commit target when
  // actionable, otherwise the missing-selection guidance (a degenerate
  // ready-without-selection falls back to the how-to). It stays mounted in
  // the failed state too, so the input always names where the next submit
  // will go — separate from the failed verdict's request snapshot below.
  // The id stays mounted with the input so the camera button and code field
  // descriptors resolve.
  const scanLine = scanContext ?? scanHint;
  // While a correction is in flight or unconfirmed, the desk, task, kiosk,
  // and scan controls lock so the retained identity cannot be silently
  // swapped underneath the retry. The retry control itself stays enabled.
  const correctionLocked = isCorrectionLocked(correcting, correctUnknown);
  // An other-tab organization change locks new writes synchronously while
  // every draft, ticket, selection, record, and retained id stays in place.
  // No automatic navigation or role-home redirect happens; the notice above
  // the work body owns the explicit recovery. The unconfirmed-correction
  // retry keeps resolving through the frozen request organization, never
  // switching the old receipt into the new organization.
  const pendingCollection = [...pendingRewardCommandsRef.current.values()].find((entry) => entry.command === "reward.collect" && entry.uncertain);
  const pendingLookup = [...pendingRewardCommandsRef.current.values()].find((entry) => entry.command === "reward.lookup" && entry.uncertain);
  const rewardCollectUncertain = Boolean(pendingCollection);
  const rewardSnapshotCurrent = rewardDataLoaded && !rewardLookupLoading;
  const writeLocked = correctionLocked || orgChanged || assignmentStale || rewardCollectUncertain || receiptLock || receiptRefreshing || rewardLookupLoading || rewardCollectingId !== null;
  const scanUnknown = result.kind === "failed" && result.uncertain && pendingScanRef.current !== null;
  const manualRefreshRequired = result.kind === "failed" && result.manualRefreshRequired === true;
  const scanControlsLocked = writeLocked || scanUnknown || confirmingDirection;
  const manualSearchTerm = manualQuery.trim().toLocaleLowerCase();
  const manualMatches = manualSearchTerm
    ? deskParticipants.filter((person) => {
        const name = person.name.trim().toLocaleLowerCase();
        return manualSearchTerm.length === 1 ? name === manualSearchTerm : name.includes(manualSearchTerm);
      }) : [];
  const manualTargetCurrent = manualTarget && deskParticipants.find((person) => person.id === manualTarget.id && identityKey(person) === identityKey(manualTarget));
  const manualTargetDistinct = manualTargetCurrent && manualTargetCurrent.company.trim() !== "" && deskParticipants.filter((person) => identityKey(person) === identityKey(manualTargetCurrent)).length === 1;

  async function submitTicket(code: string, retrySame = false, person?: DeskParticipant) {
    const activeAssignment = assignment;
    const manualPerson = !retrySame && activeTask === "desk" && person && person.id === manualTargetCurrent?.id && manualTargetCurrent.status === "APPROVED" && manualTargetDistinct && manualIdentityConfirmed ? manualTargetCurrent : undefined;
    // Synchronous write lock: no new scan starts while a correction is
    // unresolved or another tab changed the organization.
    if (scanBusyRef.current || submitting || receiptRefreshRef.current || rewardRequestRef.current || writeLocked || (!retrySame && pendingScanRef.current) || (retrySame && !pendingScanRef.current) || (!retrySame && (!ready || !activeAssignment || (!code.trim() && !manualPerson)))) return;
    scanFocusAtSubmitRef.current = document.activeElement;
    scanEditAtSubmitRef.current = scanEditRevisionRef.current;
    scanBusyRef.current = true;
    setSubmitting(true);
    // Closing an already-open camera also prevents a late detection from
    // replacing the ticket whose request is currently being resolved.
    setCameraOpen(false);
    if (!retrySame) setResult({ kind: "idle" });
    setTicketCopyNotice(null);
    clearRewardPanel();
    // Bind a retry to the exact ticket AND desk/booth assignment. A gateway
    // error can happen after commit; a different person's scan is not a retry.
    const isDesk = retrySame ? pendingScanRef.current?.command === "check.scan" : activeTask === "desk";
    // Request-bound location: the verdict below names the desk/booth this
    // request committed to, never the currently selected value. Any later
    // desk/booth/task controls lock while an outcome is unknown; a replay
    // uses the retained snapshot even if current data changes in a refresh.
    const requestPlace: ScanPlace = retrySame ? pendingScanRef.current!.place : isDesk
      ? { task: "desk", placeName: selectedDesk?.name ?? "", actionLabel: selectedDesk?.action === "OUT" ? "퇴장" : "입장" }
      : { task: "booth", placeName: selectedBooth?.name ?? "", actionLabel: "부스 인증" };
    const expectedAction = requestPlace.actionLabel === "퇴장" ? "OUT" : "IN";
    const payload: PendingScan["payload"] = retrySame ? pendingScanRef.current!.payload : isDesk
      ? manualPerson ? { deskId, expectedAction, participantId: manualPerson.id, expectedIdentity: { name: manualPerson.name, company: manualPerson.company } } : { deskId, expectedAction, ticket: code.trim() }
      : { boothId, ticket: code.trim() };
    const attempt = retrySame ? pendingScanRef.current!.attempt : JSON.stringify([activeScope.eventId, activeAssignment!.id, activeTask, payload]);
    const commandId = retrySame ? pendingScanRef.current!.commandId : pendingScanIdRef.current.get(attempt) ?? randomCommandId();
    const pending: PendingScan = retrySame ? pendingScanRef.current! : {
      eventId: activeScope.eventId, assignmentId: activeAssignment!.id,
      command: isDesk ? "check.scan" : "booth.visit", payload, commandId, attempt, place: requestPlace, uncertain: false,
      targetLabel: manualPerson ? `${manualPerson.name} · ${manualPerson.company || "소속 미입력"}` : undefined,
    };
    const requestTicket = "ticket" in pending.payload ? pending.payload.ticket : "";
    pendingScanRef.current = pending;
    pendingScanIdRef.current.set(attempt, commandId);
    // Bound the temporary editing lock even when the network stops responding.
    // An abort never proves failure: the retained command ID is used to retry.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const res = await operatorFetch(`/api/events/${encodeURIComponent(pending.eventId)}/commands`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: pending.commandId,
          command: pending.command,
          assignmentId: pending.assignmentId,
          payload: pending.payload,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        id?: unknown;
        checkId?: unknown;
        recordStatus?: unknown;
        name?: unknown;
        action?: unknown;
        reentry?: unknown;
        booth?: unknown;
        visitId?: unknown;
        boothId?: unknown;
        participantId?: unknown;
        rewards?: unknown;
        rewardVerificationId?: unknown;
      } | null;
      if (!res.ok) {
        // These verdicts are produced only after the server has locked the
        // event and checked the receipt for this exact scan. A committed
        // scan would have replayed instead; ordinary 403/409 responses do
        // not provide that guarantee and must retain an uncertain attempt.
        const deskChanged = isDesk && res.status === 409 &&
          (data?.code === "DESK_ACTION_CHANGED" || data?.code === "DESK_CLOSED");
        const manualChanged = isDesk && "participantId" in pending.payload && res.status === 409 && data?.code === "MANUAL_IDENTITY_CHANGED";
        const attendanceReviewRequired = isDesk && res.status === 409 && data?.code === "CHECK_ATTENDANCE_REVIEW_REQUIRED";
        const sourceUnavailable = isDesk && res.status === 409 && data?.code === "CHECK_SOURCE_UNAVAILABLE";
        const eligibilityReviewRequired = isDesk && res.status === 409 && typeof data?.code === "string" && ["TICKET_STATUS_CONFLICT", "CHECK_OUT_REVIEW_REQUIRED"].includes(data.code);
        const uncertain = !deskChanged && !manualChanged && !attendanceReviewRequired && !eligibilityReviewRequired && !sourceUnavailable && (pending.uncertain || res.status >= 500 || [408, 425, 429].includes(res.status));
        if (uncertain) pending.uncertain = true;
        if (!uncertain) {
          pendingScanIdRef.current.delete(attempt);
          pendingScanRef.current = null;
          if (deskChanged || manualChanged || attendanceReviewRequired || eligibilityReviewRequired || sourceUnavailable) { abandonOperatorAttempt(pending.commandId); forgetOperatorReceipt(pending.commandId); }
        }
        if (manualChanged) setManualIdentityConfirmed(false);
        if (!isDesk && !uncertain && isBoothContextChanged(data?.code)) setBoothStatusStale(true);
        const boothLimitReached = !isDesk && !uncertain && data?.code === "BOOTH_LIMIT_REACHED";
        if (boothLimitReached) setTicket((current) => current.trim() === requestTicket ? "" : current);
        setResult({
          kind: "failed",
          uncertain,
          boothLimitReached,
          attendanceReviewRequired,
          eligibilityReviewRequired,
          deskRefreshRequired: deskChanged,
          sourceRefreshRequired: sourceUnavailable,
          manualRefreshRequired: manualChanged,
          place: requestPlace,
          requestTicket,
          requestTarget: pending.targetLabel,
          message: uncertain
            ? pending.targetLabel ? "처리 응답을 확인하지 못했습니다. 같은 참가자 요청을 다시 확인하세요." : "처리 응답을 확인하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요."
            : typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
        });
        return;
      }
      if (!data || typeof data.name !== "string" ||
        (isDesk && (typeof data.id !== "string" || !data.id || data.checkId !== pending.commandId ||
          !("expectedAction" in pending.payload) || data.action !== pending.payload.expectedAction)) ||
        ("participantId" in pending.payload && data.id !== pending.payload.participantId) ||
        (!isDesk && (typeof data.booth !== "string" || data.visitId !== pending.commandId ||
          !("boothId" in pending.payload) || data.boothId !== pending.payload.boothId ||
          typeof data.participantId !== "string" || !data.participantId))) {
        pending.uncertain = true;
        setResult({ kind: "failed", uncertain: true, place: requestPlace, requestTicket, requestTarget: pending.targetLabel, message: pending.targetLabel ? "처리 응답을 확인하지 못했습니다. 같은 참가자 요청을 다시 확인하세요." : "처리 응답을 확인하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요." });
        return;
      }
      pendingScanIdRef.current.delete(attempt);
      pendingScanRef.current = null;
      const scanAction = isDesk
        ? typeof data?.action === "string" ? data.action : ""
        : "STAMP";
      const participantId = typeof data?.id === "string" ? data.id : "";
      const participantName = typeof data?.name === "string" ? data.name : "";
      const recordStatus = isDesk && typeof data.recordStatus === "string"
        ? Object.hasOwn(SCAN_HISTORY_NOTICES, data.recordStatus) ? data.recordStatus as ScanRecordStatus : "UNAVAILABLE"
        : undefined;
      if (isDesk) setLastScannedTicket(recordStatus ? "" : requestTicket);
      if (isDesk && !recordStatus && scanAction === "OUT" && participantId && rewardEnabled) {
        const verificationId = data.rewardVerificationId === pending.commandId ? pending.commandId : "";
        setRewardTarget({ id: participantId, name: participantName, company: directory[participantId] ?? "", verificationId, ticket: requestTicket });
        const rewards = parseRewardList(data?.rewards);
        setTargetRewards(rewards ?? []);
        setRewardDataLoaded(Boolean(verificationId) && rewards !== null);
        if (!rewards) setRewardError("경품 목록을 확인하지 못했습니다. 경품 다시 확인을 눌러주세요.");
      }
      // Keep the input protected until the bounded refresh finishes too: the
      // success action must never look available while the busy guard rejects it.
      const refreshed = await load(true, controller.signal);
      if (refreshed && "participantId" in pending.payload) forgetOperatorReceipt(pending.commandId);
      setResult({
        kind: "ok",
        participantId,
        name: participantName,
        action: scanAction,
        checkId: isDesk ? pending.commandId : undefined,
        recordStatus,
        reentry: data?.reentry === true,
        booth: typeof data?.booth === "string" ? data.booth : "",
        place: requestPlace,
      });
      setTicket("");
      setManualTarget(null);
      setManualIdentityConfirmed(false);
      setManualQuery("");
    } catch {
      pending.uncertain = true;
      setResult({ kind: "failed", uncertain: true, place: requestPlace, requestTicket, requestTarget: pending.targetLabel, message: pending.targetLabel ? "연결하지 못했습니다. 같은 참가자 요청을 다시 확인하세요." : "연결하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요." });
    } finally {
      window.clearTimeout(timeout);
      scanBusyRef.current = false;
      setSubmitting(false);
    }
  }

  async function onScan(event: React.FormEvent) {
    event.preventDefault();
    await submitTicket(ticket);
  }

  async function refreshDeskStatus() {
    if (refreshing || submitting || writeLocked || scanUnknown) return;
    if (!(await load(true)) || currentEventRef.current !== targetEventId) return;
    if (rewardDeskError) setRewardDeskError(null);
    if (result.kind === "failed" && (result.deskRefreshRequired || result.sourceRefreshRequired)) {
      setManualIdentityConfirmed(false);
      setResult((current) => current === result ? { kind: "idle" } : current);
    }
    document.getElementById("staff-desk")?.focus();
  }

  async function confirmChangedDeskDirection() {
    const id = deskId;
    const shown = deskDirectionReviewsRef.current[id];
    if (!shown || !shown.to || directionConfirmRef.current || submitting || writeLocked || scanUnknown || pendingScanRef.current || receiptRefreshRef.current) return;
    directionConfirmRef.current = true;
    setConfirmingDirection(true);
    try {
      if (!(await load(true)) || currentEventRef.current !== targetEventId || selectedDeskIdRef.current !== id) return;
      const latest = lastLoadedScopeRef.current;
      const desk = latest?.desks.find((item) => item.id === id);
      const current = deskDirection(desk?.action);
      const review = deskDirectionReviewsRef.current[id];
      if (!desk || desk.open === false || !latest?.assignments.some((item) => item.targetId === id) ||
          !current || current !== shown.to || !review || review.from !== shown.from || review.to !== shown.to) return;
      confirmedDeskDirectionsRef.current.set(id, current);
      const remaining = { ...deskDirectionReviewsRef.current };
      delete remaining[id];
      deskDirectionReviewsRef.current = remaining;
      setDeskDirectionReviews(remaining);
      window.requestAnimationFrame(() => document.getElementById("staff-desk")?.focus());
    } finally {
      directionConfirmRef.current = false;
      if (currentEventRef.current === targetEventId) setConfirmingDirection(false);
    }
  }

  async function refreshManualRoster() {
    if (refreshing || submitting || writeLocked || scanUnknown) return;
    if (!(await load(true)) || currentEventRef.current !== targetEventId) return;
    setManualTarget(null);
    setManualIdentityConfirmed(false);
    setResult((current) => current.kind === "failed" && current.manualRefreshRequired ? { kind: "idle" } : current);
    window.requestAnimationFrame(() => document.getElementById("staff-manual-search")?.focus());
  }

  async function refreshBoothStatus() {
    if (refreshing || submitting || scanControlsLocked || scanBusyRef.current) return;
    setCameraOpen(false);
    setBoothCopyNotice(null);
    if (!(await load(true)) || currentEventRef.current !== targetEventId) return;
    if (boothRefreshRequired) setResult((current) => current === result ? { kind: "idle" } : current);
    document.getElementById("staff-booth")?.focus();
  }

  async function postRewardCommand(command: "reward.lookup" | "reward.collect", payload: Record<string, unknown>) {
    if (assignmentStale) throw new Error("현재 업무 배정을 확인한 뒤 다시 시도하세요.");
    if (orgChanged) {
      throw new Error("다른 탭에서 조직이 전환됐습니다. 위 안내에서 전환을 먼저 확인하세요.");
    }
    if (!assignment || activeTask !== "desk") throw new Error("배정된 데스크를 먼저 선택하세요.");
    const attempt = JSON.stringify([activeScope.eventId, assignment.id, command, payload]);
    let pending = pendingRewardCommandsRef.current.get(attempt);
    if (!pending) { pending = { id: randomCommandId(), uncertain: false, command, payload }; pendingRewardCommandsRef.current.set(attempt, pending); }
    const commandId = pending.id;
    const retrying = pending.uncertain;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await operatorFetch(`/api/events/${encodeURIComponent(activeScope.eventId)}/commands`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, assignmentId: assignment.id, payload }),
      }).catch((error: unknown) => {
        if (isOrganizationContextBlock(error) && !pending.uncertain) {
          pendingRewardCommandsRef.current.delete(attempt);
          throw new Error("조직 전환을 먼저 확인하세요. 요청은 보내지 않았습니다.");
        }
        pending.uncertain = true;
        throw new Error(command === "reward.collect"
          ? "수령 처리 응답을 확인하지 못했습니다. 같은 요청을 다시 확인하거나 위에서 서버 처리를 확인하세요."
          : "경품 조회 응답을 확인하지 못했습니다. 다시 조회하세요.");
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const uncertain = pending.uncertain || response.status >= 500 || [408, 425, 429].includes(response.status);
        if (!uncertain) pendingRewardCommandsRef.current.delete(attempt);
        else pending.uncertain = true;
        if (uncertain) throw new Error(command === "reward.collect"
          ? "이전 경품 요청의 처리 여부를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요."
          : "최신 경품 상태를 확인하지 못했습니다. 다시 조회하세요.");
        const message = typeof data?.error === "string" ? data.error : "경품 요청을 처리하지 못했습니다.";
        if (data?.code === "REWARD_DESK_CHANGED") throw new RewardContextError(message, "desk");
        if (data?.code === "REWARD_VERIFICATION_CHANGED") throw new RewardContextError(message, "identity");
        if (command === "reward.collect" && response.status === 409) {
          if (data?.code === "REWARD_ALREADY_RECEIVED") throw new SettledRewardError(message, "RECEIVED");
          if (data?.code === "REWARD_CANCELLED") throw new SettledRewardError(message, "CANCELLED");
        }
        throw new Error(message);
      }
      if (!data || Array.isArray(data)) {
        pending.uncertain = true;
        throw new Error("경품 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      }
      return { data, attempt, retrying, commandId };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function readRewardSnapshot(payload: RewardLookup) {
    const { data, attempt, retrying, commandId } = await postRewardCommand("reward.lookup", payload);
    const person = typeof data.participant === "object" && data.participant !== null
      ? data.participant as Record<string, unknown>
      : null;
    const rewards = parseRewardList(data.rewards);
    if (!person || typeof person.id !== "string" || !person.id || typeof person.name !== "string" || !person.name || rewards === null ||
        data.rewardRequestVersion !== 1 || data.rewardVerificationId !== commandId || ("participantId" in payload && person.id !== payload.participantId)) {
      const pending = pendingRewardCommandsRef.current.get(attempt);
      if (pending) pending.uncertain = true;
      throw new Error("경품 조회 응답을 확인하지 못했습니다. 다시 조회하세요.");
    }
    pendingRewardCommandsRef.current.delete(attempt);
    return {
      target: { id: person.id, name: person.name, company: typeof person.company === "string" ? person.company : "", verificationId: commandId, ticket: "ticket" in payload ? payload.ticket : "" },
      rewards, retrying,
    };
  }

  function invalidateRewardContext(error: RewardContextError) {
    clearRewardPanel();
    if (error.reason === "desk") setRewardDeskError(error.message);
    else {
      setRewardLookupTicket("");
      setLastScannedTicket("");
      setRewardError(error.message);
    }
    const recoveryControl = error.reason === "desk" ? "staff-reward-desk-recheck" : "reward-lookup-ticket";
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body && currentEventRef.current === targetEventId) {
        document.getElementById(recoveryControl)?.focus();
      }
    });
  }

  async function loadRewards(payload: RewardLookup, refresh = false) {
    if (!rewardEnabled || !isExitDesk || !ready || rewardRequestRef.current || scanBusyRef.current ||
        pendingScanRef.current || pendingCorrectRef.current || receiptRefreshRef.current || rewardCollectUncertain || receiptLock) return;
    const request = Symbol("reward-lookup");
    rewardRequestRef.current = request;
    setRewardLookupLoading(true);
    if (!refresh && "ticket" in payload) {
      setRewardLookupTicket(payload.ticket);
      clearRewardPanel();
    } else {
      setRewardError(null);
      setRewardNotice(null);
    }
    try {
      const response = await readRewardSnapshot(payload);
      if (rewardRequestRef.current !== request || currentEventRef.current !== targetEventId) return;
      // A recovered read receipt can contain the snapshot from before another desk acted.
      const latest = response.retrying ? await readRewardSnapshot(payload) : response;
      if (rewardRequestRef.current !== request || currentEventRef.current !== targetEventId) return;
      setRewardTarget(latest.target);
      setTargetRewards(latest.rewards);
      setRewardDataLoaded(true);
      setRewardNotice(refresh ? `${latest.target.name}님의 경품 정보를 다시 확인했습니다.` : `${latest.target.name}님의 경품을 확인했습니다.`);
    } catch (error) {
      if (rewardRequestRef.current === request && currentEventRef.current === targetEventId) {
        if (error instanceof RewardContextError) invalidateRewardContext(error);
        else {
          setRewardDataLoaded(false);
          setRewardError(error instanceof Error ? error.message : "경품을 조회하지 못했습니다.");
        }
      }
    } finally {
      if (rewardRequestRef.current === request) {
        rewardRequestRef.current = null;
        setRewardLookupLoading(false);
      }
    }
  }

  async function lookupRewardsByTicket(event: React.FormEvent, ticketOverride?: string) {
    event.preventDefault();
    const lookupTicket = (ticketOverride ?? rewardLookupTicket).trim();
    if (lookupTicket) await loadRewards({ ticket: lookupTicket });
  }

  async function refreshTargetRewards() {
    if (!rewardTarget) return;
    await loadRewards(rewardTarget.ticket ? { ticket: rewardTarget.ticket }
      : { participantId: rewardTarget.id, verificationId: rewardTarget.verificationId }, true);
  }

  async function collectReward(reward: DeskReward) {
    if (rewardRequestRef.current || scanBusyRef.current || pendingScanRef.current || pendingCorrectRef.current || receiptRefreshRef.current || receiptLock) return;
    if (pendingCollection && pendingCollection.payload.id !== reward.id) return;
    if (!rewardTarget?.verificationId || !assignment || !ready || !rewardDataLoaded || !canHandOutReward(reward) || reward.status !== "READY") return;
    if (!window.confirm(`${rewardTarget.name}님의 “${reward.name}” 수령을 기록할까요? 이번 요청의 수령 완료를 확인한 뒤 경품을 전달하세요.`)) return;
    const request = Symbol("reward-collect");
    rewardRequestRef.current = request;
    setRewardCollectingId(reward.id);
    setRewardError(null);
    setRewardNotice(null);
    try {
      const { data, attempt } = await postRewardCommand("reward.collect", { id: reward.id, verificationId: rewardTarget.verificationId, expectedParticipantId: rewardTarget.id });
      if (rewardRequestRef.current !== request || currentEventRef.current !== targetEventId) return;
      const result = typeof data.reward === "object" && data.reward !== null
        ? data.reward as Record<string, unknown>
        : null;
      if (!result || result.id !== reward.id || result.participantId !== rewardTarget.id || result.status !== "RECEIVED" || data.rewardRequestVersion !== 1) {
        const pending = pendingRewardCommandsRef.current.get(attempt); if (pending) pending.uncertain = true;
        throw new Error("수령 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
      }
      pendingRewardCommandsRef.current.delete(attempt);
      setTargetRewards((items) => items.map((item) => item.id === reward.id ? { ...item, status: "RECEIVED" } : item));
      setRewardNotice(`${reward.name} · 수령 완료`);
    } catch (error) {
      if (rewardRequestRef.current !== request || currentEventRef.current !== targetEventId) return;
      if (error instanceof SettledRewardError) {
        setTargetRewards((items) => items.map((item) => item.id === reward.id
          ? { ...item, status: error.status, issue: `${error.message} 지급 기록을 운영자에게 확인하세요.` }
          : item));
      } else if (error instanceof RewardContextError) {
        invalidateRewardContext(error);
      } else {
        setRewardError(error instanceof Error ? error.message : "경품 수령 처리를 확인하지 못했습니다.");
      }
    } finally {
      if (rewardRequestRef.current === request) {
        rewardRequestRef.current = null;
        setRewardCollectingId(null);
      }
    }
  }

  // A valid QR for the wrong person is accepted instantly, so the latest
  // record of this session carries its own correction. The server still
  // enforces desk scope and authorship; other records stay read-only here.
  const correctableCheck = deskSourcesAvailable && result.kind === "ok" && result.checkId && !result.correctionChanged && !historicalScan
    ? activeScope.checks.find(
        (check) => check.id === result.checkId && check.participantId === result.participantId && check.corrected !== true && check.deskId === deskId
      ) ?? null
    : null;

  async function correctLatest(event: React.FormEvent, retrySame = false) {
    event.preventDefault();
    if (pendingScanRef.current || receiptRefreshRef.current || rewardRequestRef.current) return;
    // Synchronous double-click guard: `correcting` state lands a render
    // late, so two rapid submits would otherwise both fire in the same tick.
    if (correctingRef.current || correcting) return;
    const stored = pendingCorrectRef.current;
    let pending: CorrectionPending;
    if (retrySame && stored) {
      // Replay the stored request verbatim: same event, assignment, record,
      // payload, and command id — never the currently selected context.
      pending = stored;
    } else {
      // The outcome is still unknown: resolve the stored request first
      // instead of minting a second correction for another target.
      if (correctUnknown) return;
      if (rewardCollectUncertain || receiptLock || rewardLookupLoading || rewardCollectingId !== null) return;
      // No new correction starts after an other-tab organization change;
      // the retained retry below still resolves through the frozen request
      // organization in the shared adapter.
      if (orgChanged || assignmentStale) return;
      if (!correctableCheck || !assignment || !correctReason.trim()) return;
      pending = buildCorrectionPending({
        eventId: activeScope.eventId,
        assignmentId: assignment.id,
        checkId: correctableCheck.id,
        reason: correctReason.trim(),
        stored,
      });
      // Mint and retain before the first await: a rapid second attempt (or a
      // render between ticks) reuses this identity instead of minting another.
      pendingCorrectRef.current = pending;
    }
    correctingRef.current = true;
    setCorrecting(true);
    setCorrectNotice(null);
    try {
      const res = await operatorFetch(`/api/events/${encodeURIComponent(pending.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: pending.commandId,
          command: "check.correct",
          assignmentId: pending.assignmentId,
          payload: { id: pending.checkId, reason: pending.reason },
        }),
      });
      const data = (await res.json()) as { error?: unknown; code?: unknown; check?: { id?: unknown; corrected?: unknown; correction?: { id?: unknown } } } | null;
      if (!res.ok) {
        if (res.status === 409 && data?.code === "CHECK_CORRECTION_STALE") {
          pendingCorrectRef.current = null;
          forgetOperatorReceipt(pending.commandId);
          setCorrectUnknown(false);
          setCorrectReason("");
          clearRewardPanel();
          setResult((current) => current.kind === "ok" && current.checkId === pending.checkId
            ? { ...current, correctionChanged: true } : current);
          await load(true);
          return;
        }
        const uncertain = correctUnknown || res.status >= 500 || [408, 425, 429].includes(res.status);
        if (uncertain) {
          setCorrectUnknown(true);
          setCorrectNotice("정정 응답을 확인하지 못했습니다. 대상·사유를 바꾸지 말고 같은 요청으로 다시 시도하세요.");
        } else {
          if (pendingCorrectRef.current?.key === pending.key) pendingCorrectRef.current = null;
          setCorrectUnknown(false);
          setCorrectNotice(typeof data?.error === "string" ? data.error : "정정하지 못했습니다.");
        }
        return;
      }
      if (data?.check?.id !== pending.checkId || data.check.corrected !== true || data.check.correction?.id !== pending.commandId) {
        setCorrectUnknown(true);
        setCorrectNotice("정정 응답을 확인하지 못했습니다. 대상·사유를 바꾸지 말고 같은 요청으로 다시 시도하세요.");
        return;
      }
      if (pendingCorrectRef.current?.key === pending.key) pendingCorrectRef.current = null;
      setCorrectUnknown(false);
      setCorrectNotice("기록을 정정했습니다. 현재 입장 상태에 반영되었습니다.");
      setCorrectReason("");
      setResult({ kind: "idle" });
      await load(true);
    } catch {
      // Offline or dropped connection: the server may still have committed,
      // so the retained id stays for a same-request replay. Nothing is queued.
      setCorrectUnknown(true);
      setCorrectNotice("연결하지 못했습니다. 대상·사유를 바꾸지 말고 같은 요청으로 다시 시도하세요.");
    } finally {
      correctingRef.current = false;
      setCorrecting(false);
    }
  }

  return (
    <section className={`staff-workspace${kiosk ? " kiosk-mode" : ""}`} aria-label={`${activeScope.eventName} 현장 업무`}>
      <p className={`staff-event-context ${prizeStyles.eventContext}`}>
        <Link
          className="staff-back-link"
          href="/staff"
          onClick={(event) => {
            let confirmed = false;
            if (
              (pendingScanRef.current !== null || pendingRewardCommandsRef.current.size > 0) &&
              !window.confirm("확인하지 못한 요청이 있습니다. 떠나면 같은 요청으로 다시 확인할 수 없습니다. 그래도 떠나시겠습니까?")
            ) {
              event.preventDefault();
              return;
            }
            if (pendingScanRef.current !== null || pendingRewardCommandsRef.current.size > 0) confirmed = true;
            // Leaving with an unconfirmed correction drops the retained id:
            // confirm first so the operator can stay and replay it instead.
            if (
              correctUnknown &&
              !window.confirm("정정 응답을 아직 확인하지 못했습니다. 떠나면 같은 요청으로 다시 시도할 수 없습니다. 그래도 떠나시겠습니까?")
            ) {
              event.preventDefault();
              return;
            }
            if (correctUnknown) confirmed = true;
            // Same after an other-tab organization change with work at risk:
            // leaving unmounts this tab's retained drafts and receipts.
            if (
              !confirmed && orgChanged &&
              staffWorkAtRisk() &&
              !window.confirm("다른 탭에서 조직이 전환됐습니다. 떠나면 확인 중인 정정·입력을 잃을 수 있습니다. 그래도 떠나시겠습니까?")
            ) {
              event.preventDefault();
              return;
            }
            if (!confirmed && !orgChanged && (ticket.trim() || manualTarget || correctReason.trim() || rewardLookupTicket.trim()) &&
                !window.confirm("입력 중인 내용이 있습니다. 떠나면 사라집니다. 이동할까요?")) event.preventDefault();
          }}
        >
          <BackIcon />
          <span>내 업무</span>
        </Link>
        <span className={prizeStyles.eventWorkTitle}>{activeScope.eventName}</span>
        <button
          type="button"
          role="switch"
          aria-checked={kiosk}
          className={`${prizeStyles.kioskSwitch} ${kiosk ? prizeStyles.kioskSwitchOn : ""}`}
          disabled={scanControlsLocked || submitting}
          onClick={() => {
            if (!allowContextChange()) return;
            setKiosk((current) => !current);
            setResult({ kind: "idle" });
            clearRewardPanel();
          }}
        >
          <span className={prizeStyles.kioskSwitchTrack} aria-hidden="true">
            <span className={prizeStyles.kioskSwitchThumb} />
          </span>
          <span>키오스크</span>
        </button>
      </p>
      <div className={prizeStyles.accountContext}>
        <p className={prizeStyles.orgLine}>{orgLineText()}</p>
        <StaffAccountMenu compact confirmLeave={confirmLeaveStaff} confirmLeaveAccount={confirmLeaveAccountPage} excludeReceiptCommandId={inlineScanReceiptId} />
      </div>
      {orgChanged ? <OrganizationContextNotice confirmLeave={confirmLeaveStaff} /> : null}
      {otherReceipt ? <p className="notice" role="alert">이전 현장 처리의 결과를 위의 처리 결과 확인에서 확인한 뒤 새 업무를 진행하세요.</p> : null}
      {receiptRefreshNeeded ? <p className="notice" role="alert">최신 업무 정보를 불러온 뒤 다시 진행할 수 있습니다. <button type="button" className="button button-secondary" disabled={receiptRefreshing} onClick={() => {
        if (receiptRefreshRef.current) return; const selectedEvent = targetEventId;
        receiptRefreshRef.current = true; setReceiptRefreshing(true);
        let refreshed = false;
        void load(true).then((ok) => { refreshed = ok; if (currentEventRef.current === selectedEvent && ok) { setReceiptRefreshNeeded(false); setReceiptNotice("최신 업무 정보를 불러왔습니다. 미확인 요청이 남았다면 같은 요청을 확인하세요."); } })
          .finally(() => { if (currentEventRef.current === selectedEvent) { receiptRefreshRef.current = false; setReceiptRefreshing(false); if (refreshed) drainAppliedReceipts(); } });
      }}>업무 정보 다시 확인</button></p> : null}
      {receiptNotice ? <p className="notice" role="status">{receiptNotice}</p> : null}
      {rewardCollectUncertain ? <div className="notice" role="alert">
        <p>경품 수령 결과를 확인할 때까지 다른 현장 업무를 잠급니다. 아래에서 같은 요청을 다시 확인하세요. 서버 처리 확인만으로는 대상을 확인할 수 없습니다.</p>
        <button type="button" className="button button-secondary" disabled={rewardCollectingId !== null || receiptRefreshing} onClick={() => {
          const entry = [...pendingRewardCommandsRef.current.entries()].find(([, item]) => item.command === "reward.collect" && item.uncertain);
          if (!entry || !window.confirm("확인을 중단해도 이미 처리된 경품 수령은 취소되지 않습니다. 운영자에게 경품 내역을 확인한 뒤 계속하세요. 확인을 중단할까요?")) return;
          abandonOperatorAttempt(entry[1].id);
          forgetOperatorReceipt(entry[1].id);
          pendingRewardCommandsRef.current.delete(entry[0]);
          setRewardDataLoaded(false);
          setRewardNotice(null);
          setRewardError("확인을 중단했습니다. 이미 처리됐을 수 있으니 운영자에게 경품 내역을 확인하세요.");
        }}>확인 중단하고 내역 확인</button>
      </div> : null}
      {assignmentStale ? <p className="notice" role="alert">{loadError || "현재 업무 배정을 확인할 수 없습니다."} 새 현장 처리는 잠겼으며 입력과 마지막 결과는 유지됩니다. {!receiptRefreshNeeded ? <button type="button" className="button button-secondary" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "배정 확인 중" : "배정 다시 확인"}</button> : null}</p> : null}
      {kiosk ? (
        <p className="notice" role="status">
          공용 태블릿용 큰 화면입니다. 무인 셀프 체크인은 지원하지 않습니다.
        </p>
      ) : null}
      {hasDeskWork && hasBoothWork ? (
        <div className={`staff-task-switch ${prizeStyles.taskSwitch}`} role="group" aria-label="업무 종류">
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={activeTask === "desk"}
            disabled={scanControlsLocked || submitting}
            onClick={() => {
              if (activeTask === "desk" || !allowContextChange()) return;
              setTask("desk");
              setResult({ kind: "idle" });
              clearRewardPanel();
            }}
          >
            데스크 체크인
          </button>
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={activeTask === "booth"}
            disabled={scanControlsLocked || submitting}
            onClick={() => {
              if (activeTask === "booth" || !allowContextChange()) return;
              setTask("booth");
              setResult({ kind: "idle" });
              clearRewardPanel();
            }}
          >
            부스 인증
          </button>
        </div>
      ) : null}
      {activeTask === "desk" ? (
        <section className={prizeStyles.workSection} aria-label="처리 위치 선택">
        <div className="staff-select-field">
          <label htmlFor="staff-desk">데스크</label>
          <select
            id="staff-desk"
            value={deskId}
            disabled={scanControlsLocked || submitting}
            onChange={(event) => {
              if (!allowContextChange()) return;
              selectedDeskIdRef.current = event.target.value;
              selectDeskDirection(event.target.value, activeScope);
              setDeskId(event.target.value);
              setCameraOpen(false);
              setResult({ kind: "idle" });
              clearRewardPanel();
            }}
          >
            <option value="">선택하세요</option>
            {activeScope.desks.map((desk) => (
              <option key={desk.id} value={desk.id}>
                {desk.name} · {desk.action === "OUT" ? "퇴장" : "입장"}{desk.open === false ? " · 가동 중지" : ""}
              </option>
            ))}
          </select>
          {directionReview ? (
            <section className={prizeStyles.directionReview} aria-labelledby="staff-direction-review-title">
              <div role="alert">
                <strong id="staff-direction-review-title">데스크 업무 방향을 확인해 주세요</strong>
                <p>{directionReview.from === null ? "시작하기 전에 업무 방향을 확인해 주세요." : directionReview.from === directionReview.to ? `방향은 그대로 ${directionReview.to === "IN" ? "입장" : "퇴장"}입니다. 계속하려면 확인해 주세요.` : `이전에 확인한 방향은 ${directionReview.from === "IN" ? "입장" : "퇴장"}입니다. ${directionReview.to ? `현재 방향은 ${directionReview.to === "IN" ? "입장" : "퇴장"}입니다.` : "현재 데스크 방향이나 배정을 확인할 수 없습니다."}`}</p>
                <p>업무 방향을 확인하기 전까지 다음 참가자 처리는 잠깁니다. {result.kind === "ok" ? "마지막 처리 결과는 유지됩니다." : "입력한 내용은 유지됩니다."}</p>
                {deskClosed ? <p>현재 데스크는 가동 중지 상태입니다. 운영자에게 확인하세요.</p> : null}
                {loadError ? <p>{loadError}</p> : null}
              </div>
              {directionReview.to && selectedDesk && !deskClosed ? (
                <button type="button" ref={directionReviewControlRef} className="button button-secondary" disabled={confirmingDirection || refreshing || submitting || writeLocked || scanUnknown} onClick={() => void confirmChangedDeskDirection()}>
                  {confirmingDirection ? "최신 방향 확인 중" : `${directionReview.to === "IN" ? "입장" : "퇴장"} 업무 확인`}
                </button>
              ) : (
                <button type="button" ref={directionReviewControlRef} className="button button-secondary" disabled={refreshing || submitting || writeLocked || scanUnknown} onClick={() => void load(true)}>
                  {refreshing ? "데스크 상태 확인 중" : "데스크 상태 다시 확인"}
                </button>
              )}
            </section>
          ) : null}
          {rewardDeskError ? (
            <>
              <p className="staff-direction-hint" role="alert">{loadError || rewardDeskError}</p>
              <button id="staff-reward-desk-recheck" type="button" className="button button-secondary" disabled={refreshing || writeLocked} onClick={() => void refreshDeskStatus()}>
                {refreshing ? "데스크 상태 확인 중" : "데스크 상태 다시 확인"}
              </button>
            </>
          ) : deskClosed && !deskRefreshRequired && !directionReview ? (
            <>
              <p className="staff-direction-hint" role="status">
                {loadError || "가동 중지된 데스크입니다. 운영자가 다시 가동한 뒤 상태를 확인하세요."}
              </p>
              <button type="button" className="button button-secondary" disabled={refreshing || writeLocked || scanUnknown || submitting} onClick={() => void refreshDeskStatus()}>
                {refreshing ? "데스크 상태 확인 중" : "데스크 상태 다시 확인"}
              </button>
            </>
          ) : deskId && !deskRefreshRequired && !directionReview ? (
            <p className="staff-direction-hint" role="status">
              {selectedDesk ? `이 데스크는 ${selectedDesk.action === "OUT" ? "퇴장" : "입장"} 처리합니다.` : ""}
            </p>
          ) : null}
        </div>
        </section>
      ) : (
        <section className={prizeStyles.workSection} aria-label="운영 부스 선택">
        <div className="staff-select-field">
          <label htmlFor="staff-booth">부스</label>
          <select
            id="staff-booth"
            value={boothId}
            aria-describedby={[hasBoothScheduleIssue ? "staff-booth-schedule-help" : "", hasBoothClockUncertainty ? "staff-booth-clock-help" : ""].filter(Boolean).join(" ") || undefined}
            disabled={scanControlsLocked || submitting}
            onChange={(event) => {
              if (!allowContextChange()) return;
              setBoothId(event.target.value);
              setBoothCopyNotice(null);
              setCameraOpen(false);
              setResult({ kind: "idle" });
              clearRewardPanel();
            }}
          >
            <option value="">선택하세요</option>
            {activeScope.booths.map((booth) => {
              const status = boothOperatingStatus(booth, boothClock?.now ?? null, boothClock?.uncertaintyMs);
              return <option key={booth.id} value={booth.id} disabled={!boothCanAttempt(status)}>
                {booth.name}{status === "운영 중" ? "" : ` (${status})`}
              </option>;
            })}
          </select>
          {hasBoothScheduleIssue ? <p id="staff-booth-schedule-help" className="staff-direction-hint">운영 시간을 확인해야 하는 부스는 행사 운영자에게 문의하세요.</p> : null}
          {hasBoothClockUncertainty ? <p id="staff-booth-clock-help" className="staff-direction-hint" role="status">운영 시각을 확인할 수 없어 인증할 때 서버에서 확인합니다.</p> : null}
          {!activeScope.stampAvailable ? <p className="staff-direction-hint" role="status">현재 행사에서는 부스 인증을 진행하지 않습니다.</p> :
            boothStatus && boothStatus !== "운영 중" ? <p className="staff-direction-hint" role="status">선택한 부스 · {boothStatus}</p> : null}
          {!boothRefreshRequired && !assignmentStale ? (
            <>
              {loadError && !receiptRefreshNeeded ? <p className="staff-direction-hint" role="alert">{loadError}</p> : null}
              {boothStatusStale && !loadError ? <p className="staff-direction-hint" role="status">부스 상태가 바뀌었습니다. 상태를 다시 확인하세요.</p> : null}
              <button type="button" className="button button-secondary" disabled={refreshing || scanControlsLocked || submitting} onClick={() => void refreshBoothStatus()}>
                {refreshing ? "부스 상태 확인 중" : "부스 상태 다시 확인"}
              </button>
            </>
          ) : null}
        </div>
        </section>
      )}
      {activeTask === "booth" && activeScope.stampAvailable && activeScope.stampMode === "SELF" && (!selectedBooth || ready) ? (
        <p className="notice" role="status">
          참가자가 직접 인증하는 방식입니다. QR을 보여주고 참가자 홈 &gt; 부스 인증에서 카메라로 바로 인증하도록 안내하세요.
          이 화면에서 티켓을 대신 처리하지 않습니다.
        </p>
      ) : null}
      {activeTask === "booth" && activeScope.stampMode === "SELF" && ready && !writeLocked ? (
        <div className="staff-booth-code">
          <p>이 QR을 참가자에게 보여주세요. 참가자는 참가자 홈 &gt; 부스 인증에서 카메라로 찍어 바로 인증하고, 카메라를 쓸 수 없으면 아래 코드를 직접 입력합니다.</p>
          <p className={prizeStyles.boothQrCaption}>{selectedBooth?.name ?? "부스"} 인증 QR</p>
          <div
            className={prizeStyles.boothQr}
            role="img"
            aria-label={`${selectedBooth?.name ?? "부스"} 인증 QR`}
            ref={boothQrRef}
          >
            <QRCode value={`ET:BOOTH:${activeScope.eventId}:${boothId}`} size={220} />
          </div>
          <p>
            <button
              type="button"
              className="button button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`ET:BOOTH:${activeScope.eventId}:${boothId}`);
                  setBoothCopyNotice("부스 코드를 복사했습니다.");
                } catch {
                  setBoothCopyNotice("복사에 실패했습니다. 아래 코드를 선택해 복사하세요.");
                }
              }}
            >
              <CopyIcon />
              코드 복사
            </button>
          </p>
          {boothCopyNotice ? <p role="status">{boothCopyNotice}</p> : null}
          <details className={prizeStyles.codeFallback}>
            <summary>코드 직접 복사</summary>
            <p><code>{`ET:BOOTH:${activeScope.eventId}:${boothId}`}</code></p>
          </details>
        </div>
      ) : null}
      {correctionLocked ? (
        <p className="notice" role="status">정정 응답을 확인하는 중입니다. 데스크·스캔 전환은 잠겨 있습니다.</p>
      ) : null}
      {orgChanged ? (
        <p className="notice" role="status">다른 탭에서 조직이 전환됐습니다. 입력한 티켓·사유와 선택·기록은 그대로 유지됩니다. 스캔·정정·경품 쓰기는 잠시 잠겨 있습니다. 위 안내에서 전환을 먼저 확인하세요. 정정 응답 확인이 남아 있다면 같은 요청으로 다시 시도할 수 있습니다.</p>
      ) : null}
      {activeTask === "desk" && !deskSourcesAvailable ? (
        <div className={prizeStyles.directionReview} role="alert">
          <p>{[!activeScope.participantsAvailable ? "참가자 명단" : "", !activeScope.checksAvailable ? "출입 기록" : ""].filter(Boolean).join(" · ")}을 확인할 수 없어 입퇴장을 잠시 멈췄습니다. 다시 확인해도 계속되면 현장 책임자에게 문의하세요.</p>
          <button type="button" className="button button-secondary" disabled={refreshing || submitting || writeLocked || scanUnknown} onClick={() => void load(true)}>
            {refreshing ? "확인 중" : "업무 정보 다시 확인"}
          </button>
        </div>
      ) : null}
      {scanInputHasWork && result.kind !== "ok" && !scanUnknown ? (
       <div className={prizeStyles.scanInput} ref={scanInputRef}>
      <h2 className={prizeStyles.sectionTitle}>참가자 티켓 확인</h2>
      {activeTask === "desk" ? (
        <div className={prizeStyles.entryModeSwitch} role="group" aria-label="입력 방식">
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={entryMode === "scan"}
            disabled={scanControlsLocked || submitting}
            onClick={() => { setEntryMode("scan"); setCameraOpen(false); }}
          >
            스캔
          </button>
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={entryMode === "roster"}
            disabled={scanControlsLocked || submitting}
            onClick={() => chooseEntryMode("roster")}
          >
            명단 찾기
          </button>
        </div>
      ) : null}
      {/* Field order is scan-first: a moving line points the camera, and the
          manual input stays as the fallback for unreadable codes. The bar
          stays in normal flow (never a fixed overlay), so the selector, the
          org line, and the SELF QR below can never be covered by it. One
          context line only (see scanLine): the duplicate how-to hint that
          used to sit above this block is gone. */}
      {scanLine ? <p id="staff-scan-hint" className={scanContext ? prizeStyles.scanContext : "staff-direction-hint"} role="status">{scanLine}</p> : null}
      {submitting ? <p id="staff-scan-wait" className="notice" role="status">처리 결과를 확인하고 있습니다. 확인이 끝나면 티켓과 업무를 다시 바꿀 수 있습니다.</p> : null}
      {(entryMode === "scan" || activeTask !== "desk") ? <div className="camera-action">
        {activeTask === "booth" && activeScope.stampMode === "SELF" ? null : (
          <button
            ref={cameraButtonRef}
            type="button"
            disabled={!ready || writeLocked || submitting}
            aria-describedby="staff-scan-hint"
            className={`button button-primary ${prizeStyles.scanPrimary}`}
            onClick={() => {
              setResult({ kind: "idle" });
              setCameraOpen(true);
            }}
          >
            카메라로 스캔
          </button>
        )}
        {cameraOpen && ready && !orgChanged && !scanUnknown ? (
          <CameraScan
            focusOrigin={cameraButtonRef.current}
            manualHint={activeTask === "desk" ? "참가자 명단에서 확인하거나 현장 책임자에게 도움을 요청하세요." : "티켓 코드가 없다면 현장 책임자에게 도움을 요청하세요."}
            onUseManual={activeTask === "desk" ? () => {
              const previousFocus = document.activeElement;
              setCameraOpen(false);
              setEntryMode("roster");
              window.requestAnimationFrame(() => {
                const focused = document.activeElement;
                if (focused && focused !== document.body && focused !== previousFocus && focused.isConnected) return;
                document.getElementById("staff-manual-search")?.focus();
              });
            } : undefined}
            onDetected={(code) => {
              setCameraOpen(false);
              if (scanBusyRef.current || submitting || writeLocked) return;
              setTicket(code);
              submitTicket(code);
            }}
            onClose={() => setCameraOpen(false)}
          />
        ) : null}
      </div> : null}
      {activeTask === "booth" && activeScope.stampMode !== "SELF" ? (
        <ValidatedForm className="scan-form" onSubmit={onScan}>
          <div className={prizeStyles.fallbackBlock}>
            <p className={prizeStyles.fallbackLabel}>카메라가 안 될 때 · 코드로 인증</p>
          <div className="form-field">
            <label htmlFor="staff-ticket">티켓 코드</label>
            <input
              id="staff-ticket"
              type="text"
              autoComplete="off"
              placeholder="카메라가 안 되면 코드를 직접 입력하세요"
              value={ticket}
              aria-describedby={submitting ? "staff-scan-hint staff-scan-wait" : result.kind === "failed" ? "staff-scan-hint staff-scan-retry-hint" : "staff-scan-hint"}
              disabled={writeLocked}
              readOnly={submitting}
              onChange={(event) => { if (!scanBusyRef.current) { scanEditRevisionRef.current += 1; setTicket(event.target.value); } }}
            />
          </div>
          {ticket ? (
            <p className={prizeStyles.ticketFullCode} data-ticket-full-code>
              <span className={prizeStyles.ticketFullCodeLabel}>입력한 코드 전체</span>
              <code>{ticket}</code>
            </p>
          ) : null}
          <button
            type="button"
            className={`button button-secondary ${prizeStyles.ticketCopy}`}
            disabled={!ticket.trim() || submitting}
            onClick={copyTicketCode}
          >
            <CopyIcon />
            코드 복사
          </button>
          {ticketCopyNotice ? <p role="status" className={prizeStyles.nextStep}>{ticketCopyNotice}</p> : null}
          <button className="button button-secondary" type="submit" disabled={submitting || writeLocked || !ready || !ticket.trim()}>
            {submitting ? "처리 중입니다" : "부스 인증"}
          </button>
          </div>
        </ValidatedForm>
      ) : null}
      {activeTask === "desk" && entryMode === "scan" ? (
        <ValidatedForm className="scan-form" onSubmit={onScan}>
          <div className={prizeStyles.fallbackBlock}>
            <p className={prizeStyles.fallbackLabel}>코드로 직접 처리</p>
          <div className="form-field">
            <label htmlFor="staff-ticket">티켓 코드</label>
            <input
              id="staff-ticket"
              type="text"
              autoComplete="off"
              placeholder="카메라가 안 되면 코드를 직접 입력하세요"
              value={ticket}
              aria-describedby={submitting ? "staff-scan-hint staff-scan-wait" : result.kind === "failed" ? "staff-scan-hint staff-scan-retry-hint" : "staff-scan-hint"}
              disabled={writeLocked}
              readOnly={submitting}
              onChange={(event) => { if (!scanBusyRef.current) { scanEditRevisionRef.current += 1; setTicket(event.target.value); } }}
            />
          </div>
          <button className="button button-secondary" type="submit" disabled={submitting || writeLocked || !ready || !ticket.trim()}>
            {submitting ? "처리 중입니다" : isExitDesk ? "퇴장 처리" : "입장 처리"}
          </button>
          </div>
        </ValidatedForm>
      ) : null}
      {activeTask === "desk" && entryMode === "roster" ? (
        <section className={prizeStyles.manualSearch} aria-label="참가자 명단 찾기">
          <div className={prizeStyles.manualSearchBody}>
            <p>참가자의 이름과 소속을 확인한 뒤 처리하세요. 같은 이름과 소속이 여럿이면 현장 책임자에게 확인을 요청하세요.</p>
            <div className={prizeStyles.manualSearchHeading}>
              <label htmlFor="staff-manual-search">참가자 이름</label>
              <button type="button" className={`button button-quiet ${prizeStyles.manualRefresh}`} aria-label="참가자 명단 새로고침" title="참가자 명단 새로고침"
                disabled={!ready || scanControlsLocked || submitting || refreshing || manualRefreshRequired}
                onClick={() => void load(true)}><RefreshIcon /></button>
            </div>
            <input id="staff-manual-search" type="search" autoComplete="off" value={manualQuery} disabled={!ready || writeLocked || submitting || manualRefreshRequired}
              onChange={(event) => { setManualQuery(event.target.value); setManualVisibleLimit(10); setManualTarget(null); setManualIdentityConfirmed(false); }}
              aria-describedby="staff-manual-search-help" />
            <p id="staff-manual-search-help">이름을 두 글자 이상 입력하세요. 한 글자 이름은 그대로 입력합니다. 연락처와 티켓 코드는 표시하지 않습니다.</p>
            <p role="status">{refreshing ? "명단을 다시 확인하고 있습니다." : loadError ? "최신 명단을 확인하지 못했습니다. 표시된 출입 상태는 이전 확인 기준입니다." : "출입 상태는 마지막으로 확인한 명단 기준입니다. 처리할 때 서버가 다시 확인합니다."}</p>
            {manualSearchTerm && deskSourcesAvailable ? (
              <div aria-live="polite">
                <p>{manualMatches.length ? `${manualMatches.length}명 검색됨${manualMatches.length > manualVisibleLimit ? ` · ${manualVisibleLimit}명 표시` : ""}` : "일치하는 참가자가 없습니다. 이름을 확인하세요."}</p>
                <ul className={prizeStyles.manualResults} aria-label="참가자 검색 결과">
                  {manualMatches.slice(0, manualVisibleLimit).map((person, index) => {
                    const ambiguous = deskParticipants.filter((item) => identityKey(item) === identityKey(person)).length > 1;
                    const needsAssistance = ambiguous || !person.company.trim();
                    const selected = manualTarget?.id === person.id;
                    const presenceTone = person.attendanceReview !== false || person.inside === null ? "review" : person.inside ? "inside" : "outside";
                    const presenceLabel = person.attendanceReview === true ? "출입 기록 확인 필요" : presenceTone === "review" ? "출입 상태 확인 불가" : presenceTone === "inside" ? "입장 중" : "입장 중 아님";
                    return <li key={person.id} id={`staff-manual-result-${index}`} tabIndex={-1}>
                      <div>
                        <strong>{person.name}</strong>
                        <span className={prizeStyles.manualCompany}>{person.company || "소속 미입력"}{person.group ? ` · ${person.group}` : ""}</span>
                        <span>{person.status === "APPROVED" ? "참가 확정" : person.status === "PENDING" ? "승인 대기" : person.status === "WAITLIST" ? "대기 명단" : person.status === "CANCELLED" ? "신청 취소" : "상태 확인 필요"}</span>
                        <span className={prizeStyles.manualPresence} data-state={presenceTone}>{presenceLabel}</span>
                        {needsAssistance ? <span className={prizeStyles.manualWarning}>{ambiguous ? "같은 이름·소속이 있습니다." : "소속 정보가 없습니다."} 책임자에게 확인하세요.</span> : null}
                      </div>
                      <button type="button" className="button button-secondary" disabled={!ready || writeLocked || submitting || manualRefreshRequired || needsAssistance || person.status !== "APPROVED"}
                        aria-label={`${person.name} ${person.company || "소속 미입력"} 선택`}
                        aria-expanded={selected} aria-controls={selected ? "staff-manual-confirm" : undefined}
                        onClick={() => {
                          setManualTarget(person);
                          setManualIdentityConfirmed(false);
                          window.requestAnimationFrame(() => {
                            document.getElementById("staff-manual-confirm")?.scrollIntoView({ block: "nearest", behavior: "instant" });
                            document.getElementById("staff-manual-identity-confirm")?.focus({ preventScroll: true });
                          });
                        }}>선택</button>
                      {selected ? <section id="staff-manual-confirm" className={prizeStyles.manualConfirm} aria-label="선택한 참가자 확인">
                        <strong>{person.name} · {person.company || "소속 미입력"}</strong>
                        {!manualTargetCurrent || !manualTargetDistinct ? <p role="alert">참가자 정보가 변경됐거나 같은 이름과 소속이 있습니다. 명단을 다시 확인하거나 책임자에게 문의하세요.</p> : null}
                        {manualTargetCurrent && manualTargetCurrent.status !== "APPROVED" ? <p role="alert">참가 상태가 바뀌어 처리할 수 없습니다. 현장 책임자에게 확인하세요.</p> : null}
                        <label><input id="staff-manual-identity-confirm" type="checkbox" checked={manualIdentityConfirmed} disabled={writeLocked || submitting || manualRefreshRequired || !manualTargetCurrent || manualTargetCurrent.status !== "APPROVED" || !manualTargetDistinct}
                          onChange={(event) => setManualIdentityConfirmed(event.target.checked)} /> 이름·소속을 직접 확인했습니다</label>
                        <button type="button" className="button button-primary" disabled={!ready || writeLocked || submitting || manualRefreshRequired || !manualIdentityConfirmed || !manualTargetCurrent || manualTargetCurrent.status !== "APPROVED" || !manualTargetDistinct}
                          onClick={() => void submitTicket("", false, person)}>{isExitDesk ? "확인한 참가자 퇴장 처리" : "확인한 참가자 입장 처리"}</button>
                      </section> : null}
                    </li>;
                  })}
                </ul>
                {manualMatches.length > manualVisibleLimit ? <button type="button" className="button button-secondary" disabled={writeLocked || submitting || manualRefreshRequired} onClick={() => {
                  const nextIndex = manualVisibleLimit;
                  setManualVisibleLimit((current) => current + 10);
                  window.requestAnimationFrame(() => document.getElementById(`staff-manual-result-${nextIndex}`)?.focus());
                }}>{Math.min(10, manualMatches.length - manualVisibleLimit)}명 더 보기</button> : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      </div>
      ) : null}
      {loadError && activeTask === "desk" && !assignmentStale && !receiptRefreshNeeded && !deskClosed && !deskRefreshRequired ? (
        <p className="notice" role="status">
          {loadError}{" "}
          <button type="button" className="button button-secondary" disabled={refreshing} onClick={() => void load(true)}>
            {refreshing ? "불러오는 중" : "다시 불러오기"}
          </button>
        </p>
      ) : null}
      {result.kind === "ok" ? (
        <section className={prizeStyles.workSection} aria-label="스캔 결과">
          <h2 className={prizeStyles.sectionTitle}>{historicalScan ? "이전 출입 기록" : "방금 처리한 참가자"}</h2>
        <section className={prizeStyles.resultBlock} aria-label="스캔 결과 상세">
          <p className={correctionLocked || result.correctionChanged || historicalScan ? "scan-result notice" : "scan-result scan-success"} role="status">
            {result.correctionChanged ? "이 데스크의 처리 기록 · " : correctionLocked ? "마지막 확인: " : ""}
            {result.name} ·{" "}
            {result.action === "STAMP"
              ? `부스 인증${result.booth ? ` · ${result.booth}` : ""}`
              : result.action === "IN" ? "입장" : "퇴장"}
            {result.reentry ? " (재입장)" : ""}
          </p>
          {result.place.placeName ? (
            <p className={prizeStyles.nextStep}>처리 위치: {result.place.placeName} · {result.place.actionLabel}</p>
          ) : null}
          {historicalScan ? (
            <p className={prizeStyles.nextStep} ref={correctionConflictRef} tabIndex={-1}>
              {SCAN_HISTORY_NOTICES[historicalScan]}
            </p>
          ) : result.correctionChanged ? (
            <p className="scan-result scan-failure" role="alert" ref={correctionConflictRef} tabIndex={-1}>
              출입 기록이 바뀌어 이 요청은 중단했습니다. 추가 정정은 현장 책임자에게 요청하세요.
            </p>
          ) : null}
          <p className={prizeStyles.nextStep}>{correctionLocked ? "정정 결과를 먼저 확인하세요. 위 기록은 정정 전 마지막으로 확인한 스캔입니다." : rewardCollectUncertain ? "경품 수령 결과를 확인한 뒤 다음 참가자를 처리하세요." : directionReview ? "바뀐 데스크 업무를 확인한 뒤 다음 참가자를 처리하세요." : result.recordStatus === "UNAVAILABLE" || (activeTask === "desk" && !deskSourcesAvailable) ? "현장 책임자에게 참가자와 최근 출입 기록 확인을 요청한 뒤 다음 참가자를 처리하세요." : "다음 참가자를 스캔하세요."}</p>
          <div className={prizeStyles.nextActions}>
            <button type="button" ref={nextParticipantRef} className="button button-primary" disabled={writeLocked || Boolean(directionReview) || confirmingDirection} onClick={prepareNextParticipant}>
              다음 참가자
            </button>
            {result.action === "IN" && !result.correctionChanged && !historicalScan ? (
              <button
                type="button"
                className={`button button-secondary ${prizeStyles.auxAction}`}
                disabled={writeLocked}
                aria-expanded={nametagOpen}
                onClick={() => setNametagResult(result)}
              >
                네임택 인쇄
              </button>
            ) : null}
          </div>
          {nametagOpen ? (
            <NameTagPrint identity={{
              name: result.name,
              company: "",
              eventName: activeScope.eventName,
              context: `${result.place.placeName} · 입장`,
            }} resolveIdentity={(signal) => readNameTagIdentity(targetEventId, result.participantId, result.name,
              result.checkId, `${result.place.placeName} · 입장`, signal)} onClose={() => {
              setNametagResult(null);
              window.requestAnimationFrame(() => {
                const field = document.getElementById("staff-ticket");
                if (field instanceof HTMLInputElement) field.focus();
              });
            }} />
          ) : null}
        </section>
        </section>
      ) : null}
      {result.kind === "failed" ? (
        <section ref={scanFailureRef} className={prizeStyles.workSection} aria-label={result.uncertain ? "스캔 결과 미확인과 복구" : "스캔 실패와 복구"}>
          <h2 className={prizeStyles.sectionTitle}>{boothLimitReached ? "인증 한도 도달" : result.uncertain ? "처리 결과를 확인하지 못했습니다" : result.attendanceReviewRequired ? "출입 기록 확인이 필요합니다" : result.eligibilityReviewRequired ? "참가 상태 확인이 필요합니다" : "처리에 실패했습니다"}</h2>
        <section className={prizeStyles.resultBlock} aria-label={result.uncertain ? "스캔 결과 미확인" : "스캔 실패"}>
          <p className={boothLimitReached ? "scan-result notice" : "scan-result scan-failure"} role={boothLimitReached ? "status" : "alert"}>{result.message}</p>
          {/* Request-bound snapshot: always names the desk/booth this request
              committed to, even when the input line above currently names the
              same place. The crossrole audit pins both lines visible together
              after a ticket edit ("현재 …" at the input, "처리 위치:" at the
              verdict); wording and placement carry the distinction. */}
          {result.place.placeName ? (
            <p className={prizeStyles.nextStep}>처리 위치: {result.place.placeName} · {result.place.actionLabel}</p>
          ) : null}
          {result.requestTarget ? <p className={prizeStyles.nextStep}>확인한 참가자: {result.requestTarget}</p> : null}
          {/* Server verdicts (중복·미등록·만료) carry no recovery steps, while
              uncertain-network messages already ask for a retry: add only the
              missing half so the same "다시 시도" guidance never repeats. */}
          {/* Recovery guidance carries its own id: in the failed state the
              code inputs are described by both the current-target line above
              and this recovery text, never by nothing and never by one id
              twice. */}
          <p id="staff-scan-retry-hint" className={prizeStyles.nextStep}>
            {result.uncertain
              ? "다른 스캔과 업무 전환이 잠깁니다. 서버 확인은 요청을 다시 보내지 않습니다. 같은 요청 재확인은 아직 처리되지 않았다면 처리할 수 있습니다."
              : result.manualRefreshRequired
              ? loadError || "최신 명단을 불러온 뒤 이름과 소속을 다시 확인하세요."
              : result.sourceRefreshRequired
              ? loadError || "참가자 명단과 출입 기록을 다시 확인하세요. 입력과 참가자 선택은 유지됩니다."
              : result.deskRefreshRequired
              ? loadError || "데스크 상태를 다시 불러오세요. 입력과 참가자 선택은 유지됩니다."
              : boothRefreshRequired
              ? loadError || "부스 상태를 확인한 뒤 안내에 따라 진행하세요."
              : boothLimitReached
              ? "같은 부스에서 다음 참가자의 티켓을 확인하세요."
              : result.attendanceReviewRequired
              ? "현장 책임자가 참가자와 최근 출입 기록을 확인한 뒤 처리해 주세요."
              : result.eligibilityReviewRequired
              ? "현장 책임자가 참가 상태와 출입 기록을 확인한 뒤 처리해 주세요."
              : result.requestTarget
              ? "참가자 정보와 처리 위치를 확인하거나 현장 책임자에게 문의하세요."
              : result.message.includes("다시 시도")
              ? "카메라가 안 되면 티켓 코드를 직접 입력하세요."
              : "같은 업무·같은 티켓으로 다시 시도하세요. 카메라가 안 되면 티켓 코드를 직접 입력하세요."}
          </p>
          <div className={prizeStyles.nextActions}>
            {result.uncertain ? (
              <button type="button" ref={retryFailedRef} className="button button-primary" disabled={writeLocked || submitting || scanStatusChecking} onClick={() => { void submitTicket(result.requestTicket, true); }}>
                같은 요청 재확인
              </button>
            ) : null}
            {result.uncertain && inlineScanReceiptId ? <OperatorReceiptRecovery inline currentEventId={targetEventId} onlyCommandId={inlineScanReceiptId} disabled={writeLocked || submitting || receiptRefreshing} onCheckingChange={setScanStatusChecking} /> : null}
            {result.manualRefreshRequired ? (
              <button type="button" ref={retryFailedRef} className="button button-primary" disabled={refreshing || writeLocked || submitting} onClick={() => void refreshManualRoster()}>
                {refreshing ? "명단 확인 중" : "참가자 명단 다시 확인"}
              </button>
            ) : result.sourceRefreshRequired ? (
              <button type="button" ref={retryFailedRef} className="button button-primary" disabled={refreshing || writeLocked || submitting} onClick={() => void refreshDeskStatus()}>
                {refreshing ? "업무 정보 확인 중" : "업무 정보 다시 확인"}
              </button>
            ) : result.deskRefreshRequired ? (
              <button type="button" ref={retryFailedRef} className="button button-primary" disabled={refreshing || writeLocked || submitting} onClick={() => void refreshDeskStatus()}>
                {refreshing ? "데스크 상태 확인 중" : "데스크 상태 다시 확인"}
              </button>
            ) : boothRefreshRequired ? (
              <button type="button" ref={retryFailedRef} className="button button-primary" disabled={refreshing || writeLocked || submitting} onClick={() => void refreshBoothStatus()}>
                {refreshing ? "부스 상태 확인 중" : "부스 상태 다시 확인"}
              </button>
            ) : boothLimitReached || result.attendanceReviewRequired || result.eligibilityReviewRequired ? (
              <button type="button" ref={retryFailedRef} className="button button-primary" disabled={writeLocked} onClick={prepareNextParticipant}>
                다음 참가자
              </button>
            ) : !result.uncertain ? <button type="button" ref={retryFailedRef} className="button button-primary" disabled={writeLocked} onClick={retryFailedScan}>
              다시 시도
            </button> : (
              <button type="button" className="button button-secondary" disabled={submitting || scanStatusChecking} onClick={() => {
                if (!window.confirm("처리됐을 수 있는 요청의 결과를 아직 확인하지 못했습니다. 확인을 중단하면 이 화면에서 요청을 다시 확인할 수 없을 수 있습니다. 운영자에게 기록을 확인한 뒤 계속하세요. 확인을 중단하시겠습니까?")) return;
                if (pendingScanRef.current) {
                  pendingScanIdRef.current.delete(pendingScanRef.current.attempt);
                  abandonOperatorAttempt(pendingScanRef.current.commandId); forgetOperatorReceipt(pendingScanRef.current.commandId);
                }
                pendingScanRef.current = null;
                setManualTarget(null);
                setManualIdentityConfirmed(false);
                setResult({ kind: "idle" });
              }}>확인 중단하고 다른 업무</button>
            )}
          </div>
        </section>
        </section>
      ) : null}
      {result.kind === "ok" && result.action === "OUT" && !historicalScan && !rewardEnabled ? (
        <p className="notice" role="status">이 행사에서 경품 기능이 꺼져 있어 현장 경품 조회·수령 처리를 사용할 수 없습니다.</p>
      ) : null}
      {rewardEnabled && isExitDesk && assignment ? (
        <section className={`${prizeStyles.workSection} ${prizeStyles.prizeWorkspace}`} aria-label="경품 확인 및 수령">
          <div className={prizeStyles.prizeHeader}>
            <div>
              <h2>경품 확인·수령</h2>
              <p>퇴장 처리 응답 또는 티켓 조회로 해당 참가자의 경품만 확인합니다.</p>
            </div>
          </div>
          <ValidatedForm className={prizeStyles.lookupForm} onSubmit={lookupRewardsByTicket}>
            <div className="form-field">
              <label htmlFor="reward-lookup-ticket">경품 대상 티켓</label>
              <input
                id="reward-lookup-ticket"
                type="text"
                autoComplete="off"
                placeholder="퇴장 스캔 응답을 놓쳤다면 티켓 코드를 입력하세요"
                value={rewardLookupTicket}
                disabled={scanUnknown || rewardLookupLoading || rewardCollectUncertain || receiptLock || receiptRefreshing || rewardCollectingId !== null}
                onChange={(event) => {
                  if (rewardRequestRef.current) return;
                  setRewardLookupTicket(event.target.value);
                  clearRewardPanel();
                }}
              />
            </div>
            <button type="submit" className="button button-secondary" disabled={scanUnknown || rewardLookupLoading || assignmentStale || rewardCollectUncertain || receiptLock || receiptRefreshing || rewardCollectingId !== null || !ready || !rewardLookupTicket.trim()}>
              {rewardLookupLoading ? "조회 중입니다" : "경품 조회"}
            </button>
            {lastScannedTicket ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={scanUnknown || rewardLookupLoading || assignmentStale || rewardCollectUncertain || receiptLock || receiptRefreshing || rewardCollectingId !== null || !ready}
                onClick={(event) => lookupRewardsByTicket(event, lastScannedTicket)}
              >
                마지막 스캔 티켓으로 조회
              </button>
            ) : null}
          </ValidatedForm>
          {pendingLookup ? <div className={prizeStyles.prizeNote} role="status">
            <p>이전 경품 조회의 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하거나 조회 확인을 중단할 수 있습니다.</p>
            <button type="button" className="button button-secondary" disabled={rewardLookupLoading || rewardCollectingId !== null} onClick={() => {
              const entry = [...pendingRewardCommandsRef.current.entries()].find(([, item]) => item.command === "reward.lookup" && item.uncertain);
              if (!entry) return;
              abandonOperatorAttempt(entry[1].id);
              forgetOperatorReceipt(entry[1].id);
              pendingRewardCommandsRef.current.delete(entry[0]);
              setRewardDataLoaded(false);
              setRewardError(null);
              setRewardNotice("이전 조회 확인을 중단했습니다. 티켓으로 다시 조회하세요. 조회 중단은 경품 지급을 기록하지 않습니다.");
            }}>이전 조회 확인 중단</button>
          </div> : null}
          {rewardError && !rewardTarget ? <p className={prizeStyles.prizeError} role="alert">{rewardError}</p> : null}
          {rewardTarget ? (
            <div className={prizeStyles.prizeTarget}>
              <div className={prizeStyles.prizeTargetHead}>
                <div className={prizeStyles.targetIdentity}>
                  <strong>{rewardTarget.name}</strong>
                  {rewardTarget.company ? <span>{rewardTarget.company}</span> : null}
                </div>
                <button type="button" className="button button-secondary" disabled={!ready || rewardLookupLoading || scanUnknown || assignmentStale || rewardCollectUncertain || receiptLock || receiptRefreshing || rewardCollectingId !== null} onClick={refreshTargetRewards}>
                  {rewardLookupLoading ? "다시 확인 중" : "경품 다시 확인"}
                </button>
              </div>
              {!rewardDataLoaded && !rewardLookupLoading ? (
                rewardError ? <p className={prizeStyles.prizeError} role="alert">{rewardError}</p>
                  : <p className={prizeStyles.prizeEmpty}>최신 수령 상태를 확인하려면 ‘경품 다시 확인’을 누르세요.</p>
              ) : null}
              {targetRewards.length ? (
                <ul className={prizeStyles.rewardList}>
                  {targetRewards.map((reward) => {
                    const onsite = canHandOutReward(reward);
                    const received = onsite && reward.status === "RECEIVED";
                    const readyReward = onsite && reward.status === "READY";
                    const pending = onsite && reward.status === "PENDING";
                    const statusLabel = !onsite ? (reward.method.trim().toUpperCase() === "GIFT" ? "기프티콘 · 운영자 확인" : "지급 방식 확인 필요")
                      : received ? "수령 완료"
                      : readyReward ? "수령 대기"
                      : pending ? "운영자 수령자 지정 필요"
                      : reward.status === "CANCELLED" ? "취소"
                      : "상태 확인 필요";
                    const statusTone = received && !reward.issue ? prizeStyles.rewardReceived : readyReward ? prizeStyles.rewardReady : "";
                    const retrying = pendingRewardCommandsRef.current.has(JSON.stringify([
                      activeScope.eventId,
                      assignment.id,
                      "reward.collect",
                      { id: reward.id, verificationId: rewardTarget.verificationId, expectedParticipantId: rewardTarget.id },
                    ]));
                    return (
                      <li key={reward.id} className={prizeStyles.rewardItem}>
                        <div className={prizeStyles.rewardInfo}>
                          <strong>{reward.name}</strong>
                          <span className={`${prizeStyles.rewardStatus} ${rewardSnapshotCurrent ? statusTone : ""}`}>
                            {rewardSnapshotCurrent ? statusLabel : `이전 조회 · ${statusLabel}`}
                          </span>
                          {reward.issue && rewardSnapshotCurrent ? <p className={prizeStyles.prizeError} role="alert">{reward.issue}</p> : null}
                        </div>
                        {readyReward ? (
                          <button type="button" className="button button-primary" disabled={!ready || !rewardSnapshotCurrent || scanUnknown || orgChanged || assignmentStale || receiptLock || receiptRefreshing || (rewardCollectUncertain && pendingCollection?.payload.id !== reward.id) || rewardCollectingId !== null} onClick={() => collectReward(reward)}>
                            {rewardCollectingId === reward.id ? "수령 확인 중" : retrying ? "같은 요청으로 다시 확인" : "수령 확인"}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : rewardDataLoaded ? (
                <p className={prizeStyles.prizeEmpty}>이 참가자에게 등록된 경품이 없습니다.</p>
              ) : null}
              {rewardDataLoaded && targetRewards.some((reward) => reward.status === "PENDING") ? <p className={prizeStyles.prizeNote}>수령자를 먼저 지정해야 합니다. 운영자에게 확인을 요청하세요.</p> : null}
            </div>
          ) : rewardError || rewardDeskError ? null : result.kind === "ok" && result.action === "OUT" && !historicalScan ? (
            <p className={prizeStyles.prizeEmpty}>퇴장 스캔 결과의 경품을 불러오지 못했습니다. 티켓으로 다시 조회하세요.</p>
          ) : (
            <p className={prizeStyles.prizeEmpty}>경품 확인은 티켓 스캔 또는 퇴장 처리 후 시작할 수 있습니다.</p>
          )}
          {rewardNotice ? <p className={prizeStyles.prizeNotice} role="status">{rewardNotice}</p> : null}
          {rewardError && rewardTarget && rewardDataLoaded ? <p className={prizeStyles.prizeError} role="alert">{rewardError}</p> : null}
          <p className={prizeStyles.prizeNote}>이번 요청의 수령 완료 안내를 확인한 뒤 경품을 전달하세요.</p>
        </section>
      ) : null}
      {correctableCheck || correctUnknown ? (
        <section className={prizeStyles.workSection} aria-label="기록 정정">
          <h2 className={prizeStyles.sectionTitle}>잘못 스캔했다면 바로 정정하세요</h2>
        <ValidatedForm className="correction-form" onSubmit={(event) => { void correctLatest(event); }}>
          <p className="staff-direction-hint">잘못 처리했다면 사유를 입력하세요. 정정 대상은 이 참가자의 가장 최근 기록이며, 본인이 처리한 건만 정정할 수 있습니다.</p>
          <div className="form-field">
            <label htmlFor="correct-reason">정정 사유</label>
            <input
              id="correct-reason"
              type="text"
              maxLength={300}
              placeholder="예: 다른 분 티켓을 잘못 스캔함"
              value={correctReason}
              disabled={scanControlsLocked}
              onChange={(event) => setCorrectReason(event.target.value)}
            />
          </div>
          {correctUnknown ? (
            <p className={prizeStyles.nextStep} role="alert">응답을 확인하기 전까지 정정 대상·사유를 바꾸지 마세요. 같은 정정 요청으로 다시 시도하면 중복 정정 없이 확인할 수 있습니다.</p>
          ) : null}
          {correctUnknown ? (
            <button
              className="button button-primary"
              type="button"
              disabled={correcting}
              onClick={(event) => { void correctLatest(event, true); }}
            >
              {correcting ? "확인 중입니다" : "같은 요청으로 다시 시도"}
            </button>
          ) : (
            <button className={`button button-secondary ${prizeStyles.correctSubmit}`} type="submit" disabled={scanUnknown || correcting || orgChanged || assignmentStale || rewardCollectUncertain || receiptLock || receiptRefreshing || rewardLookupLoading || rewardCollectingId !== null || !correctReason.trim()}>
              {correcting ? "정정 중입니다" : "최신 기록 정정"}
            </button>
          )}
        </ValidatedForm>
        </section>
      ) : null}
      {correctNotice ? <p className="scan-result" role={correctUnknown ? "alert" : "status"}>{correctNotice}</p> : null}
      <section className={prizeStyles.workSection} aria-label="최근 처리 기록">
      <h2 className="activity-heading">최근 처리 · {activeTask === "booth" ? "부스 인증" : "데스크 체크인"}</h2>
      <p className={prizeStyles.nextStep}>{activeTask === "booth" ? "저장된 부스 인증을 최근 순서로 확인할 수 있습니다." : "같은 티켓을 다시 스캔하면 같은 결과가 나옵니다. 아래에서 처리된 내역을 확인하고 다음 참가자로 넘어가세요."}</p>
      {boothVisits.length ? (
        <ul className="activity-list">
          {boothVisits.map((visit) => (
            <li key={visit.id} className={prizeStyles.recentRow}>
              <span>{activeScope.booths.find((booth) => booth.id === visit.boothId)?.name || "부스"} · 인증 완료</span>
              {visit.at ? <time dateTime={visit.at}>{formatCheckTime(visit.at)}</time> : null}
            </li>
          ))}
        </ul>
      ) : activeTask === "desk" && !activeScope.checksAvailable ? (
        <p>출입 기록을 확인할 수 없습니다. 업무 정보를 다시 확인하세요.</p>
      ) : taskChecks.length ? (
        <ul className="activity-list">
          {taskChecks.slice(0, 10).map((check) => {
            const actionLabel = check.action === "IN" ? "입장" : check.action === "OUT" ? "퇴장" : check.action === "STAMP" ? "부스 인증" : check.action;
            const placeName = activeScope.desks.find((desk) => desk.id === check.deskId)?.name
              ?? activeScope.booths.find((booth) => booth.id === check.deskId)?.name
              ?? "";
            return (
              <li key={check.id} className={prizeStyles.recentRow}>
                <span>
                  {check.name} · {actionLabel}
                  {placeName ? ` · ${placeName}` : ""}
                  {check.at ? ` · ${formatCheckTime(check.at)}` : ""}
                  {check.corrected ? " (정정됨)" : ""}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  aria-label={`${check.name} 기록 확인 · 다음 참가자 입력 준비`}
                  disabled={submitting || scanUnknown || writeLocked}
                  onClick={prepareNextParticipant}
                >
                  다음 참가자
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>아직 처리 기록이 없습니다.</p>
      )}
      </section>
    </section>
  );
}
