"use client";
import ProductButton from "../../../../ui/ProductButton";

import ValidatedForm from "../../../../ui/ValidatedForm";


import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ProductLink from "../../../../ui/ProductLink";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../../lib/console-api";
import { abandonOperatorAttempt } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt } from "../../../../../lib/operator-receipts";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { roParticle } from "../../../../../lib/korean-particle";
import { exportAnswers, exportFields, exportFieldsComplete, exportParticipantComplete, participantCsv, participantExportFilename, participantExportRows, type ExportField } from "../../../../../lib/participant-export";
import { attendanceNeedsReview } from "../../../../../lib/attendance-state.cjs";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleToolbar from "../../../console-ui/ConsoleToolbar";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleRefreshButton from "../../../console-ui/ConsoleRefreshButton";
import NameTagPrint, { type NameTagIdentity } from "../../../../ui/NameTagPrint";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleChoiceGroup from "../../../console-ui/ConsoleChoiceGroup";
import uiStyles from "../../../console-ui/console-ui.module.css";
import { CheckIcon, ChevronRightIcon, CopyIcon, DownloadIcon, FilterIcon, MessageIcon, MoreIcon, PlusIcon, SearchIcon, UploadIcon, UsersIcon, XIcon } from "../../../console-ui/ConsoleIcons";
import { UNCONFIRMED_WRITE_CLOSE_MESSAGE, useConsoleDraftGuard } from "../../../console-draft-guard";
import { buildApprovedMessageHandoffHref } from "../../../console-handoff";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";
import { readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";
import styles from "./participants.module.css";
import ParticipantEditor from "./ParticipantEditor";
import ImportWizard from "./import/ImportWizard";
import CompanyField from "./CompanyField";
import { emailLooksValid } from "../../../../../lib/contact-normalize.cjs";
import BulkCancelDialog from "./BulkCancelDialog";
import TicketReissue from "./TicketReissue";
import PersonErase from "./PersonErase";
import ReviewedExit from "./ReviewedExit";
import { EntryNoticeButton, EntryOutcome, EntrySheetBlock, entryState, readEntryDesks, readEntryRecords, useOnsiteEntry, type EntryContext, type EntryDesk, type EntryRecords } from "./OnsiteEntry";
import CancellationConflictReview from "./CancellationConflictReview";
import CountTabs from "../../../console-ui/CountTabs";
import ConsoleAvatar from "../../../console-ui/ConsoleAvatar";
import ConsoleEmptyState from "../../../console-ui/ConsoleEmptyState";
import StatusPill, { type StatusPillTone } from "../../../console-ui/StatusPill";

// Shared dirty-dismiss copy for the roster dialogs: the guard asks on
// navigation, canClose asks on Escape/backdrop/Cancel.
const DIRTY_CLOSE_MESSAGE = "작성 중인 내용이 사라집니다. 닫을까요?";

type Person = {
  id: string;
  name: string;
  ticketRevision: number;
  ticketReview: TicketReview;
  cancellationConflictReview: string | null;
  ticketNeedsExplicitReissue: boolean;
  status: string;
  paymentStatus: string;
  phone: string;
  company: string;
  email: string;
  group: string;
  inside: boolean;
  everIn: boolean;
  presenceUnknown: boolean;
  attendanceReview: boolean;
  answers: Record<string, string | boolean>;
  consent: { version: number | null; at: string; noticeText: string | null } | null;
  // 개인정보 삭제(익명화)된 참가자. 이름이 ‘삭제된 참가자’로 바뀌어 있다.
  erased: boolean;
};
type TicketReview = "valid" | "cancelled" | "expired" | "revoked" | "unavailable" | "unknown";

function ticketReviewValue(value: unknown): TicketReview {
  return value === "valid" || value === "cancelled" || value === "expired" || value === "revoked" || value === "unavailable"
    ? value : "unknown";
}

function ticketReviewLabel(value: TicketReview): string {
  switch (value) {
    case "expired": return "티켓 만료";
    case "revoked": return "티켓 철회";
    case "unavailable": return "티켓 정보 확인 필요";
    case "unknown": return "상태 확인 안 됨";
    case "cancelled": return "취소 상태 확인 필요";
    default: return "티켓 유효";
  }
}
type BulkApprovalAttempt = { commandId: string; ids: string[]; names: string[]; reissueNames: string[]; sourceStatus: "PENDING" | "WAITLIST" };
type BulkApprovalRetry = { attempt: BulkApprovalAttempt; message: string };
type Membership = { accountId: string; eventId: string; write?: unknown };
type GroupPerson = { id: string; name: string; group: string; company: string; phone: string };
type GroupAttempt = { eventId: string; fingerprint: string; commandId: string; group: string; ids: string[]; names: string[]; people: GroupPerson[]; expectedGroups: Array<{ id: string; group: string }>; uncertain: boolean };
type GroupConflict = { before: GroupPerson[]; latest: GroupPerson[] | null; groups: string[]; loading: boolean; error: string | null };

type ListState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      closeSnapshot: CloseSnapshot;
      eventName: string;
      eventMeta: ConsoleEventMeta;
      eventStage: string;
      eventSlug: string;
      // Public intake is really open: the form is published (registrationOpen)
      // and the stage lets it accept (READY or LIVE).
      intakeOpen: boolean;
      people: Person[];
      publishedFields: ExportField[];
      exportIssue: "fields" | "roster" | "answers" | null;
      groups: string[];
      role: string;
      userId: string;
      memberships: Membership[];
      rewardFeature: boolean;
      // 현장 입장 처리 (2026-11-24): open IN desks and the latest entry per person; null = not readable.
      entryDesks: EntryDesk[] | null;
      entryRecords: EntryRecords | null;
    };

const STATUSES = ["PENDING", "APPROVED", "WAITLIST", "CANCELLED"] as const;

// Match the staff preview's fail-closed verification, using this event's
// scoped roster and the same permission gate as the inspector. Never print
// the inspector's potentially old copy after a failed or incomplete read.
async function readRosterNameTagIdentity(eventId: string, participantId: string, signal: AbortSignal): Promise<NameTagIdentity> {
  const unavailable = "최신 참가자 정보를 확인하지 못했습니다. 연결과 업무 권한을 확인한 뒤 다시 시도하세요.";
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, 8000);
  try {
    const meResponse = await consoleFetch("/api/auth/me", { cache: "no-store", signal: controller.signal });
    if (!meResponse.ok) throw new Error(unavailable);
    const me = await meResponse.json() as { user?: { id?: unknown; role?: unknown } };
    if (typeof me?.user?.id !== "string" || typeof me.user.role !== "string") throw new Error(unavailable);
    const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(unavailable);
    const body = await response.json() as { state?: { events?: unknown; workspaces?: Record<string, Record<string, unknown>>; memberships?: unknown } };
    const state = body?.state;
    if (controller.signal.aborted || !state || !Array.isArray(state.events) || !Array.isArray(state.memberships)) throw new Error(unavailable);
    const events = state.events.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item) && (item as Record<string, unknown>).id === eventId);
    const event = events[0];
    const workspace = state.workspaces?.[eventId];
    if (events.length !== 1 || typeof event.name !== "string" || !event.name.trim() || typeof event.stage !== "string" ||
        !workspace || !Array.isArray(workspace.participants)) throw new Error(unavailable);
    const capabilities = { role: me.user.role, userId: me.user.id, eventId, memberships: state.memberships };
    const stage = event.stage.toUpperCase();
    if (!["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"].includes(stage)) throw new Error(unavailable);
    if (!["DRAFT", "READY", "LIVE"].includes(stage) ||
        !(canWriteEvent(capabilities, "participant.status") || canWriteEvent(capabilities, "participant.update"))) {
      throw new Error("행사 상태나 업무 권한이 바뀌었습니다. 명단을 새로고침해 확인해 주세요.");
    }
    const matches = workspace.participants.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item) && (item as Record<string, unknown>).id === participantId);
    const person = matches[0];
    if (matches.length !== 1 || typeof person.name !== "string" || !person.name.trim() ||
        typeof person.company !== "string" || typeof person.status !== "string") throw new Error(unavailable);
    if (person.status !== "APPROVED") throw new Error("참가 확정 상태가 바뀌었습니다. 명단을 새로고침해 확인해 주세요.");
    return { name: person.name, company: person.company, eventName: event.name };
  } catch (failure) {
    if (signal.aborted) throw failure;
    if (failure instanceof Error && (failure.message === unavailable || failure.message.startsWith("행사 상태나") || failure.message.startsWith("참가 확정"))) throw failure;
    throw new Error(unavailable);
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function RosterNameTag({ eventId, person, eventName }: { eventId: string; person: Person; eventName: string }) {
  const [open, setOpen] = useState(false);
  const [identityChanged, setIdentityChanged] = useState(false);
  return <details className={styles.nametagDisclosure} onToggle={(event) => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (!next) setIdentityChanged(false);
  }}>
    <summary data-disclosure-indicator="">네임택 인쇄</summary>
    {open ? <>
      {identityChanged ? <p role="status">상세 창을 연 뒤 이름, 소속 또는 행사명이 변경됐습니다. 아래 최신 정보를 확인해 주세요.</p> : null}
      <NameTagPrint identity={{ name: person.name, company: person.company, eventName }} resolveIdentity={async (signal) => {
        try {
          const latest = await readRosterNameTagIdentity(eventId, person.id, signal);
          if (!signal.aborted) setIdentityChanged(latest.name !== person.name || latest.company !== person.company || latest.eventName !== eventName);
          return latest;
        } catch (error) {
          if (!signal.aborted) setIdentityChanged(false);
          throw error;
        }
      }} />
    </> : null}
  </details>;
}

function consentTime(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "시각 확인 불가";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

// Display-only attendance filter over existing check-in data: inside is the
// live presence flag, everIn records any entry so far. No new API, no new
// business rules — the overview links here with
// ?status=APPROVED&attendance=NOT_ENTERED to show confirmed non-entered
// people, a normal working state rather than an urgent error.
const ATTENDANCE = ["NOT_ENTERED", "INSIDE", "LEFT", "REVIEW"] as const;

function attendanceLabel(attendance: string): string {
  switch (attendance) {
    case "NOT_ENTERED":
      return "입장 기록 없음";
    case "INSIDE":
      return "입장 중";
    case "LEFT":
      return "퇴장";
    case "REVIEW":
      return "출입 기록 확인 필요 (취소 제외)";
    default:
      return "전체 출입";
  }
}

function matchesAttendance(person: Person, attendance: string): boolean {
  if (attendance === "REVIEW") return person.status !== "CANCELLED" && person.attendanceReview;
  if (attendance && person.presenceUnknown) return false;
  switch (attendance) {
    case "NOT_ENTERED":
      return !person.attendanceReview && person.inside !== true && person.everIn !== true;
    case "INSIDE":
      return person.inside === true;
    case "LEFT":
      return person.everIn === true && person.inside !== true;
    default:
      return true;
  }
}

/** Pending approval is the only amber state; waitlist reads as info, cancelled as danger. */
function statusTone(status: string): StatusPillTone {
  switch (status) {
    case "APPROVED": return "ok";
    case "PENDING": return "wait";
    case "WAITLIST": return "info";
    case "CANCELLED": return "danger";
    default: return "neutral";
  }
}

function avatarTone(status: string): "ok" | "wait" | "info" | "neutral" {
  switch (status) {
    case "APPROVED": return "ok";
    case "PENDING": return "wait";
    case "WAITLIST": return "info";
    default: return "neutral";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "APPROVED":
      return "참가 확정";
    case "WAITLIST":
      return "대기 명단";
    case "CANCELLED":
      return "신청 취소";
    case "PENDING":
      return "승인 대기";
    default:
      return "상태 확인 필요";
  }
}

function isKnownStatus(status: string): status is (typeof STATUSES)[number] {
  return (STATUSES as readonly string[]).includes(status);
}

// Approval-time identity check: names collide, so the row carries the
// company and a masked contact next to the name. Full digits stay in the
// CSV export and the server, never on this screen.
// Name, company and phone text match as typed. A query made only of digits and
// phone separators ("010-1234", "010 1234 5678") is also compared by digits, so
// the hyphens or spaces an operator types or pastes do not hide the person.
function matchesRosterQuery(person: { name: string; company: string; phone: string }, search: string): boolean {
  if (!search) return true;
  const haystack = `${person.name} ${person.company} ${person.phone}`.toLocaleLowerCase("ko-KR");
  if (haystack.includes(search)) return true;
  if (!/^[\d\s\-().+]+$/.test(search)) return false;
  const digits = search.replace(/\D/g, "");
  return digits.length > 0 && person.phone.replace(/\D/g, "").includes(digits);
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "연락처 확인 필요";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

// 조회 시각은 시:분:초까지만 보여준다. 날짜·서버 시각이 아니라 이 화면이
// 마지막으로 읽은 시각이며, 실패한 새로고침은 이전 값을 그대로 둔다.
function formatClock(value: number): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function identityOrg(person: { company: string; group: string }): string {
  const parts = [person.company.trim() || "소속 미입력", person.group === "일반" ? "" : person.group]
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.join(" · ");
}

// Screen-only presence wording for the row details: the CSV export keeps its
// own "미도착" copy and the server contract is untouched.
function presenceLabel(person: { inside: boolean; everIn: boolean; status: string; presenceUnknown: boolean }): string {
  if (person.presenceUnknown) return "확인 필요";
  if (person.inside === true) return "입장 중";
  if (person.everIn === true) return "퇴장";
  return person.status === "APPROVED" ? "미입장" : "입장 기록 없음";
}

// Sentence form of the same state for the details sheet's 출입 section.
function presenceSentence(person: { inside: boolean; everIn: boolean; status: string; presenceUnknown: boolean }): string {
  if (person.presenceUnknown) return "현재 위치를 알 수 없습니다.";
  if (person.inside === true) return "지금 행사장 안에 있습니다.";
  if (person.everIn === true) return "입장했다가 퇴장했습니다.";
  if (person.status === "CANCELLED") return "신청이 취소되어 출입 대상이 아닙니다.";
  return person.status === "APPROVED" ? "아직 입장한 기록이 없습니다." : "참가 확정 전이라 출입 대상이 아닙니다.";
}

// One compact page of rows: search, filters, counts, selection, group
// assignment and the message handoff keep their filter-wide meanings — only
// the rendered slice and the prev/next position change here.
const PAGE_SIZE = 25;

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function isDefinitiveClientError(status: number): boolean {
  // 4xx (except 408/425/429) proves the server saw and rejected this exact
  // request, so retrying the same command id cannot help. 5xx, 408/425/429, network
  // failures and malformed success bodies stay ambiguous: the write may have
  // landed, so the retry must replay the SAME command id.
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function readRosterFilters(search: string): { status: string; group: string; query: string; attendance: string; ticket: string } {
  try {
    const params = new URLSearchParams(search);
    const rawStatus = params.get("status") ?? "";
    const rawAttendance = params.get("attendance") ?? "";
    return {
      status: (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : "",
      group: params.get("group") ?? "",
      query: params.get("query") ?? params.get("q") ?? "",
      attendance: (ATTENDANCE as readonly string[]).includes(rawAttendance) ? rawAttendance : "",
      ticket: params.get("ticket") === "review" ? "review" : "",
    };
  } catch {
    return { status: "", group: "", query: "", attendance: "", ticket: "" };
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function participantRecordMatches(value: unknown, id: string, status?: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.id !== id) return false;
  if (
    status !== undefined &&
    String(record.status ?? "").toUpperCase() !== status.toUpperCase()
  ) return false;
  return true;
}

export default function ParticipantList({ eventId }: { eventId: string }) {
  const [importOpen, setImportOpen] = useState(false);
  const closeHref = useEventCloseHandoff(eventId);
  const router = useRouter();
  const activeEventRef = useRef(eventId);
  activeEventRef.current = eventId;
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reviewedExitTarget, setReviewedExitTarget] = useState<string | null>(null);
  const [reconcileTarget, setReconcileTarget] = useState<string | null>(null);
  const [cancellationConflictTarget, setCancellationConflictTarget] = useState<string | null>(null);
  const [statusFeedbackId, setStatusFeedbackId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [rosterUnavailable, setRosterUnavailable] = useState(false);
  const rosterUnavailableRef = useRef(false);
  const rosterUtilitiesRef = useRef<HTMLDetailsElement | null>(null);
  const rosterGenerationRef = useRef(0);
  const rosterReadIdRef = useRef(0);
  const exportGateRef = useRef(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [attendanceFilter, setAttendanceFilter] = useState("");
  const [ticketFilter, setTicketFilter] = useState("");
  // Mobile disclosure for the three advanced selects: the search stays a
  // full-width row on every viewport, while status/group/attendance collapse
  // behind a compact filter toggle at <=768px (desktop keeps them inline via
  // CSS and hides the toggle). Values survive open/close; only an explicit
  // reset clears them, never the selection.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const advancedFiltersRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  // Opening snapshot for true-diff dirt: a pristine open form is not dirty,
  // only an actual change versus these values (or unsettled/pending work).
  const groupBaselineRef = useRef<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupUncertain, setGroupUncertain] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  // Group assignment acts on the selection reviewed when the dialog opened.
  // A background refresh must not silently update that selection or baseline.
  const groupPeopleRef = useRef<GroupPerson[] | null>(null);
  const [groupConflict, setGroupConflict] = useState<GroupConflict | null>(null);
  const groupConflictRef = useRef<GroupConflict | null>(null);
  const groupReadRef = useRef<AbortController | null>(null);
  const [rewardTarget, setRewardTarget] = useState<Person | null>(null);
  const [rewardDraft, setRewardDraft] = useState({ name: "", method: "ONSITE" });
  // Which participant a preserved reward draft belongs to: reopening the same
  // row restores unsent input (dirty dismissal never silently drops it),
  // opening another row or a proven success starts fresh.
  const rewardDraftOwnerRef = useRef<string | null>(null);
  const [rewardBusy, setRewardBusy] = useState(false);
  const [rewardUncertain, setRewardUncertain] = useState(false);
  const [rewardError, setRewardError] = useState<{ message: string; field: string | null } | null>(null);
  // Cancelling a registration voids the ticket, so it is confirmed in place
  // like every other irreversible command in the console.
  const [cancelConfirm, setCancelConfirm] = useState<{ id: string; name: string } | null>(null);
  // The cancel review opens inside the details sheet, often below the fold on a phone.
  useEffect(() => {
    if (!cancelConfirm) return;
    const frame = window.requestAnimationFrame(() => document.getElementById("roster-cancel-confirm")?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, [cancelConfirm]);
  // Row details open on demand on every viewport; the one-tap approval
  // stays directly visible on PENDING rows.
  const [toolsOpenId, setToolsOpenId] = useState<string | null>(null);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [eraseTarget, setEraseTarget] = useState<{ id: string; name: string } | null>(null);
  const [ticketTarget, setTicketTarget] = useState<(Pick<Person, "id" | "name" | "ticketRevision"> & { company: string; maskedPhone: string }) | null>(null);
  const [bulkCancelTargets, setBulkCancelTargets] = useState<Array<{ id: string; name: string; status: string; inside: boolean; company: string; phone: string }> | null>(null);
  const inspectorHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const inspectorStatusRef = useRef<HTMLSelectElement | null>(null);
  const inspectorReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  // Moving between people keeps the pressed previous/next button focused;
  // otherwise the sheet's heading takes focus (opening, arrow keys).
  const sheetNavFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!toolsOpenId) sheetNavFocusRef.current = null;
    else if (!sheetNavFocusRef.current && inspectorHeadingRef.current) {
      inspectorHeadingRef.current.focus({ preventScroll: true });
    }
  }, [toolsOpenId]);
  // Pagination position only: filters, counts, selection, group assignment
  // and the message handoff keep their filter-wide meanings.
  const [page, setPage] = useState(1);
  const [nameSort, setNameSort] = useState<"original" | "ascending" | "descending">("original");
  // Bulk approval: the server already applies one status to many ids, so the
  // roster can settle a pile of waiting applications in one action.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRetry, setBulkRetry] = useState<BulkApprovalRetry | null>(null);
  // Preserve both the receipt and the exact target payload, even if the
  // operator changes filters, selection or refreshes the visible list.
  const pendingBulkRef = useRef<BulkApprovalAttempt | null>(null);
  // Bulk-approval follow-up (UI only): the ids just approved, so the
  // operator can message exactly them. Set only on proven success;
  // cleared on every new attempt, every other success notice, and every
  // event switch, so a failed or stale attempt never offers the link.
  const [approvedHandoffIds, setApprovedHandoffIds] = useState<string[] | null>(null);
  // Adding one participant by hand is a first-class way to work, not a
  // side door: no file, no import wizard.
  const [addOpen, setAddOpen] = useState(false);
  // 사전 등록 is the default before the event runs; during it, people are added at the door.
  const addDefaultType = state.kind === "ready" && state.eventStage.toUpperCase() !== "LIVE" ? "PRE" : "ONSITE";
  const [addDraft, setAddDraft] = useState({ name: "", phone: "", company: "", email: "", registrationType: addDefaultType });
  useEffect(() => {
    setAddDraft((draft) => draft.registrationType !== addDefaultType && !draft.name && !draft.phone && !draft.company && !draft.email
      ? { ...draft, registrationType: addDefaultType } : draft);
  }, [addDefaultType]);
  // Reuse source label: the opened form names whose name/company it started
  // from. Cleared on close and on proven create; never stored or sent.
  const [reuseFrom, setReuseFrom] = useState<string | null>(null);
  const addDirty = addDraft.name.trim() !== "" || addDraft.phone.trim() !== "" || addDraft.company.trim() !== "" || addDraft.email.trim() !== "" || addDraft.registrationType !== addDefaultType;
  // An existing row seeds ONLY name + company into a new registration.
  // Phone, email, consent, ticket, attendance, rewards, results and files
  // are never copied; the operator types the contact fresh. A dirty or
  // outcome-unknown form is never overwritten: the guard reopens the form
  // to its pending work instead.
  function reuseForNewRegistration(person: Person): void {
    if (!canMutateStatus) return;
    if (addBusy || pendingAddRef.current !== null) {
      setAddOpen(true);
      setAddError({ message: "결과 미확인인 등록이 있습니다. 같은 내용으로 다시 시도한 뒤 새 등록을 선택하세요.", field: null });
      setReuseFrom(null);
      window.setTimeout(() => document.getElementById("participant-add-name")?.focus(), 0);
      return;
    }
    // A dirty draft is never overwritten — even with the dialog closed, the
    // draft is kept, so reopening it must resurface the pending work with
    // its receipt instead of replacing it with the row.
    if (addDirty) {
      setAddOpen(true);
      setAddError({ message: "작성 중인 새 등록 내용이 있습니다. 먼저 등록하거나 취소한 뒤 다시 선택하세요.", field: null });
      setReuseFrom(null);
      window.setTimeout(() => document.getElementById("participant-add-name")?.focus(), 0);
      return;
    }
    pendingAddRef.current = null;
    setAddDraft({ name: person.name, phone: "", company: person.company, email: "", registrationType: addDefaultType });
    setAddError(null);
    setReuseFrom(person.name);
    setAddOpen(true);
    window.setTimeout(() => document.getElementById("participant-add-phone")?.focus(), 0);
  }
  const [addBusy, setAddBusy] = useState(false);
  const [addUnconfirmed, setAddUnconfirmed] = useState(false);
  const [addError, setAddError] = useState<{ message: string; field: string | null } | null>(null);
  // One command id per distinct registration: a lost response replays the
  // same receipt instead of adding the person twice.
  const pendingAddRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  // Same-request retry state: an ambiguous write (network loss, 5xx, 408/425/429, or
  // an unparseable success body) keeps its command id so the retry replays
  // the original request instead of duplicating it. A definitive 4xx clears
  // the id. Failed inputs and selections stay on screen for the retry.
  const [statusRetry, setStatusRetry] = useState<{ person: Person; status: string } | null>(null);
  // Freshness: when the ready list was last read, silent-reload progress,
  // and a silent failure that keeps the ready list (with its selection)
  // instead of replacing it with the failed panel.
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const filtersReadyRef = useRef(false);
  const skipFirstSyncRef = useRef(true);
  // Synchronous same-turn in-flight gate: state flags (savingId/groupBusy/
  // rewardBusy) flip only on re-render, so a double activation in one turn
  // would slip past them. One shared ref is enough — status/group/reward
  // must never overlap. The fingerprint receipt ids are untouched by this.
  const writeBusyRef = useRef(false);
  const bulkBusyRef = useRef(false);
  const pendingStatusRef = useRef<{ fingerprint: string; commandId: string; uncertain: boolean } | null>(null);
  const pendingGroupRef = useRef<GroupAttempt | null>(null);
  const groupExecutionRef = useRef<{ eventId: string; commandId: string } | null>(null);
  const pendingRewardRef = useRef<{ fingerprint: string; commandId: string; target: Person; name: string; method: string; uncertain: boolean } | null>(null);
  // 현장 입장 처리 (2026-11-24): the person just registered at the door, so the success notice can
  // offer 바로 입장 처리. Tied to the notice text: any other notice makes the button go away.
  const [noticeEntry, setNoticeEntry] = useState<{ id: string; notice: string } | null>(null);
  const entry = useOnsiteEntry({
    eventId,
    gate: writeBusyRef,
    onRefresh: () => load(true),
    onDone: (info) => {
      setFailure(null);
      setApprovedHandoffIds(null);
      setNoticeEntry(null);
      setNotice(`${info.name}님을 입장 처리했습니다 · ${info.deskName}`);
    },
  });
  const eventReceipts = useEventReceipts(eventId);
  const externalReceipt = (command: string, ownIds: Array<string | undefined>) => eventReceipts.some((item) => item.command === command && !ownIds.includes(item.commandId));
  const unconfirmedAdd = externalReceipt("participant.create", [pendingAddRef.current?.commandId]);
  const unconfirmedStatus = externalReceipt("participant.status", [pendingStatusRef.current?.commandId, pendingBulkRef.current?.commandId]) ||
    externalReceipt("participant.bulk-cancel", []);
  const unconfirmedGroup = externalReceipt("group.assign", [pendingGroupRef.current?.commandId]);
  const unconfirmedReward = externalReceipt("reward.create", [pendingRewardRef.current?.commandId]);
  const unconfirmedUpdate = externalReceipt("participant.update", []);
  const unconfirmedTicket = externalReceipt("ticket.reissue", []) || externalReceipt("ticket.reissue-reviewed", []);
  const unconfirmedExit = externalReceipt("check.reviewed-exit", []);
  // Another screen's unresolved scan blocks only the entry buttons, not the whole roster.
  const unconfirmedEntry = externalReceipt("check.scan", [entry.pending?.commandId]);
  const unconfirmedReconciliation = externalReceipt("check.reconcile", []);
  const unconfirmedCancellationConflict = externalReceipt("participant.resolve-cancellation-conflict", []);
  const unresolvedRosterReceipt = unconfirmedAdd || unconfirmedStatus || unconfirmedGroup || unconfirmedReward || unconfirmedUpdate || unconfirmedTicket || unconfirmedExit || unconfirmedReconciliation || unconfirmedCancellationConflict;
  const previousReceiptScope = useRef({ eventId, pending: false });
  const [receiptNeedsRefresh, setReceiptNeedsRefresh] = useState(false);
  const [receiptRefreshing, setReceiptRefreshing] = useState(false);
  const receiptRefreshLock = receiptNeedsRefresh || (previousReceiptScope.current.eventId === eventId && previousReceiptScope.current.pending && !unresolvedRosterReceipt);
  useEffect(() => {
    if (previousReceiptScope.current.eventId === eventId && previousReceiptScope.current.pending && !unresolvedRosterReceipt) {
      setReceiptNeedsRefresh(true); setReceiptRefreshing(true);
      void load(true).then((ok) => { if (activeEventRef.current === eventId && ok) setReceiptNeedsRefresh(false); }).finally(() => { if (activeEventRef.current === eventId) setReceiptRefreshing(false); });
    }
    previousReceiptScope.current = { eventId, pending: unresolvedRosterReceipt };
    // Reload only when a scoped pointer leaves the shared recovery panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, unresolvedRosterReceipt]);

  // Unsaved dialog work guards navigation (not filters, query or selection):
  // true field diffs versus opening snapshots, plus unsettled or pending
  // writes whose outcome is unconfirmed. Lists themselves are never dirty.
  const groupBaseline = groupBaselineRef.current ?? "";
  const groupDiffers = groupDialogOpen && groupDraft !== groupBaseline;
  const rewardDiffers = rewardDraft.name.trim() !== "" || rewardDraft.method !== "ONSITE";
  useConsoleDraftGuard(
    addDirty ||
      addUnconfirmed ||
      groupDiffers ||
      groupConflict !== null ||
      rewardDiffers ||
      bulkRetry !== null ||
      bulkBusy ||
      pendingStatusRef.current !== null ||
      pendingGroupRef.current !== null ||
      pendingRewardRef.current !== null ||
      writeBusyRef.current,
    addUnconfirmed ? "참가자 등록 결과가 아직 확인되지 않았습니다. 화면을 벗어나면 같은 요청으로 다시 확인할 수 없습니다." : bulkRetry ? "승인 결과가 아직 확인되지 않았습니다. 화면을 벗어나면 같은 요청으로 다시 확인할 수 없습니다." : "작성 중인 참가자·그룹·경품 내용이 사라질 수 있습니다."
  );

  // Filters init from the URL (status allowlisted; group/query raw) and sync
  // back bidirectionally. Sync uses native history.replaceState — never
  // router navigation — so typing in the search box cannot trigger a route
  // refresh or refetch. Unrelated params are preserved; back/forward restores
  // the view through popstate without touching the selection.
  useEffect(() => {
    activeEventRef.current = eventId;
    try {
      const initial = readRosterFilters(window.location.search);
      setStatusFilter(initial.status);
      setGroupFilter(initial.group);
      setQuery(initial.query);
      setAttendanceFilter(initial.attendance);
      setTicketFilter(initial.ticket);
      // A shared link that arrives pre-filtered opens the disclosure so the
      // operator sees why the list is narrow. 상태는 탭(눌린 상태)으로 보이므로
      // 패널을 열지 않는다.
      if (initial.group || initial.attendance || initial.ticket) {
        setFiltersOpen(true);
      }
    } catch {
      // Keep the unfiltered list.
    }
    // Event switch resets explicit local workspace state (never a key
    // remount on metadata): stale dialogs, retries and banners from the
    // previous event must not leak into this one. Filters come from the URL.
    setSelectedIds([]);
    setEditTargetId(null);
    setTicketTarget(null);
    setEraseTarget(null);
    setCancellationConflictTarget(null);
    setBulkCancelTargets(null);
    setReceiptNeedsRefresh(false);
    setReceiptRefreshing(false);
    setGroupDialogOpen(false);
    setGroupDraft("");
    groupBaselineRef.current = null;
    groupPeopleRef.current = null;
    groupReadRef.current?.abort(); groupReadRef.current = null;
    groupConflictRef.current = null; setGroupConflict(null);
    setGroupError(null);
    setRewardTarget(null);
    setRewardError(null);
    setStatusRetry(null);
    setBulkRetry(null);
    pendingBulkRef.current = null;
    pendingStatusRef.current = null;
    if (groupExecutionRef.current) { groupExecutionRef.current = null; writeBusyRef.current = false; setGroupBusy(false); }
    pendingGroupRef.current = null;
    pendingRewardRef.current = null;
    setGroupUncertain(false);
    setRewardUncertain(false);
    setNotice(null);
    setNoticeEntry(null);
    setFailure(null);
    setFetchedAt(null);
    setRefreshError(null);
    setRosterUnavailable(false);
    rosterUnavailableRef.current = false;
    rosterGenerationRef.current += 1;
    setRefreshing(false);
    setApprovedHandoffIds(null);
    setPage(1);
    setNameSort("original");
    // Scrub invalid allowlisted values so the URL never contradicts the
    // unfiltered view; unrelated params are preserved.
    try {
      const params = new URLSearchParams(window.location.search);
      const rawStatus = params.get("status") ?? "";
      if (rawStatus && !(STATUSES as readonly string[]).includes(rawStatus)) {
        params.delete("status");
      }
      const rawAttendance = params.get("attendance") ?? "";
      if (rawAttendance && !(ATTENDANCE as readonly string[]).includes(rawAttendance)) {
        params.delete("attendance");
      }
      const scrubbed = params.toString();
      const current = new URLSearchParams(window.location.search).toString();
      if (scrubbed !== current) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${scrubbed ? `?${scrubbed}` : ""}${window.location.hash}`
        );
      }
    } catch {
      // Filtering still works; only the shareable URL keeps the stale value.
    }
    const onPopState = () => {
      try {
        const next = readRosterFilters(window.location.search);
        setStatusFilter(next.status);
        setGroupFilter(next.group);
        setQuery(next.query);
        setAttendanceFilter(next.attendance);
        setTicketFilter(next.ticket);
        // Back/forward into a filtered URL opens the disclosure for the same
        // reason as the initial load; an unfiltered URL never force-closes an
        // explicitly opened panel.
        if (next.group || next.attendance || next.ticket) {
          setFiltersOpen(true);
        }
      } catch {
        // Keep the current view.
      }
    };
    window.addEventListener("popstate", onPopState);
    filtersReadyRef.current = true;
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (activeEventRef.current === eventId) activeEventRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    if (!filtersReadyRef.current) return;
    // Skip the mount pass: the init effect above owns the first read, so the
    // sync must not strip a shared URL before that state lands.
    if (skipFirstSyncRef.current) {
      skipFirstSyncRef.current = false;
      return;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      if (statusFilter) params.set("status", statusFilter);
      else params.delete("status");
      if (groupFilter) params.set("group", groupFilter);
      else params.delete("group");
      if (attendanceFilter) params.set("attendance", attendanceFilter);
      else params.delete("attendance");
      if (ticketFilter) params.set("ticket", ticketFilter);
      else params.delete("ticket");
      if (query.trim()) params.set("query", query.trim());
      else {
        params.delete("query");
        params.delete("q");
      }
      const next = params.toString();
      const current = new URLSearchParams(window.location.search).toString();
      if (next !== current) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`
        );
      }
    } catch {
      // Filtering still works; only shareable URLs lose the sync.
    }
  }, [statusFilter, groupFilter, attendanceFilter, ticketFilter, query]);

  // Any filter or search change restarts at the first page; the checkbox
  // selection (including hidden and other-page rows) is untouched.
  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, groupFilter, attendanceFilter, ticketFilter]);

  async function load(silent = false): Promise<boolean> {
    const selectedEvent = eventId;
    const readId = ++rosterReadIdRef.current;
    const isCurrent = () => activeEventRef.current === selectedEvent && rosterReadIdRef.current === readId;
    const keepReady = silent && state.kind === "ready";
    if (!silent) { setState({ kind: "loading" }); setRefreshing(false); }
    if (keepReady) {
      setRefreshing(true);
      // An export started during a refresh must not use the previous read.
      rosterGenerationRef.current += 1;
      rosterUnavailableRef.current = true;
      setRosterUnavailable(true);
    }
    try {
      const [meRes, bootRes] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
      ]);
      if (!isCurrent()) return false;
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return false;
      }
      const me = (await meRes.json().catch(() => null)) as {
        user?: { id?: unknown; role?: unknown } | null;
      } | null;
      const boot = (await bootRes.json().catch(() => null)) as {
        state?: {
          events?: unknown;
          clients?: unknown;
          workspaces?: Record<string, Record<string, unknown>>;
          memberships?: unknown;
        } | null;
      } | null;
      if (!isCurrent()) return false;
      const bootstrap = boot?.state;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        if (keepReady) {
          setRefreshError("최신 목록을 불러오지 못했습니다. 내려받기는 최신 목록 확인 후 이용할 수 있습니다. 연결을 확인하고 새로고침하세요.");
          return false;
        }
        // A scoped 403/404 means the event is outside this identity's
        // readable scope (revoked assignment, wrong org), not a transient
        // failure: name the permission problem instead of promising that a
        // blind retry will fix it. The retry stays as an explicit path in
        // case access was granted meanwhile.
        setState({ kind: "failed", message: bootRes.status === 404 || bootRes.status === 403
          ? "행사를 찾을 수 없거나 접근 권한이 없습니다."
          : "참가자 목록을 불러오지 못했습니다." });
        return false;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      // Raw membership grants ride along untouched: the render gates below
      // re-check them per command (명단 vs 결과), mirroring the server's
      // single event-permissions map. Omitted write reads as full access,
      // an explicit [] as read-only — never invented here.
      const memberships: Membership[] = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const membership = item as Record<string, unknown>;
            if (typeof membership.accountId !== "string") return [];
            if (typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
          })
        : [];
      const event = Array.isArray(bootstrap.events)
        ? bootstrap.events.find(
            (item): item is Record<string, unknown> =>
              typeof item === "object" &&
              item !== null &&
              (item as Record<string, unknown>).id === eventId
          )
        : undefined;
      if (!event || !bootstrap.workspaces?.[eventId]) {
        setState({ kind: "failed", message: "행사를 찾을 수 없거나 접근 권한이 없습니다." });
        return false;
      }
      const eventSlug = typeof event.slug === "string" ? event.slug : "";
      const workspace = (bootstrap.workspaces?.[eventId] ?? {}) as Record<string, unknown>;
      const participants = workspace.participants;
      const availability = typeof workspace.reportSourceAvailability === "object" && workspace.reportSourceAvailability !== null && !Array.isArray(workspace.reportSourceAvailability)
        ? workspace.reportSourceAvailability as Record<string, unknown> : {};
      const participantCount = workspace.rosterExportParticipantCount;
      const participantCountKnown = typeof participantCount === "number" && Number.isSafeInteger(participantCount) && participantCount >= 0;
      const ids = new Set<string>();
      const rosterAvailable = (role === "STAFF" ? workspace.participantsAvailable === true : availability.participants === true) &&
        Array.isArray(participants) && (!participantCountKnown || participantCount === participants.length) && participants.every((person) => {
          if (typeof person !== "object" || person === null || Array.isArray(person)) return false;
          const id = (person as Record<string, unknown>).id;
          if (typeof id !== "string" || !id.trim() || id !== id.trim() || ids.has(id)) return false;
          ids.add(id);
          return true;
        });
      if (!rosterAvailable) {
        rosterGenerationRef.current += 1;
        rosterUnavailableRef.current = true;
        setRosterUnavailable(true);
        if (keepReady) {
          setRefreshError("참가자 명단을 확인할 수 없어 이전에 확인한 목록을 표시합니다. 내려받기는 최신 명단 확인 후 이용할 수 있습니다. 다시 시도해도 계속되면 조직 관리자에게 문의하세요.");
          return false;
        }
        setState({ kind: "failed", message: "참가자 명단을 완전히 확인할 수 없습니다. 다시 시도해도 계속되면 조직 관리자에게 문의하세요." });
        setRefreshError(null);
        return false;
      }
      const client = Array.isArray(bootstrap.clients)
        ? bootstrap.clients.find(
            (item): item is Record<string, unknown> =>
              typeof item === "object" && item !== null && item.id === event?.clientId
          )
        : undefined;
      const venue = typeof workspace.venue === "object" && workspace.venue !== null
        ? workspace.venue as Record<string, unknown>
        : null;
      const groups = Array.isArray(workspace.groups)
        ? workspace.groups.filter((value): value is string => typeof value === "string")
        : [];
      const features = Array.isArray(event && (event as Record<string, unknown>).features)
        ? ((event as Record<string, unknown>).features as unknown[])
        : [];
      const consentNotices = Array.isArray(workspace.consentNotices) ? workspace.consentNotices : [];
      const people: Person[] = Array.isArray(participants)
        ? participants.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const person = item as Record<string, unknown>;
            if (typeof person.id !== "string" || !person.id) return [];
            const consent = typeof person.consent === "object" && person.consent !== null && !Array.isArray(person.consent)
              ? person.consent as Record<string, unknown> : null;
            const consentVersion = typeof consent?.version === "number" && Number.isSafeInteger(consent.version) && consent.version > 0
              ? consent.version : null;
            const matchingNotices = typeof consent?.noticeId === "string" && consent.noticeId && consentVersion !== null
              ? consentNotices.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
                  (entry as Record<string, unknown>).id === consent.noticeId && (entry as Record<string, unknown>).version === consentVersion)
              : [];
            const notice = matchingNotices.length === 1 ? matchingNotices[0] as Record<string, unknown> : null;
            return [{
              id: person.id,
              name: typeof person.name === "string" ? person.name : "",
              ticketRevision: typeof person.ticketRevision === "number" && Number.isSafeInteger(person.ticketRevision) && person.ticketRevision >= 0
                ? person.ticketRevision : 0,
              ticketReview: ticketReviewValue(person.ticketReview),
              cancellationConflictReview: typeof person.cancellationConflictReview === "string" && /^[a-f0-9]{64}$/.test(person.cancellationConflictReview) ? person.cancellationConflictReview : null,
              ticketNeedsExplicitReissue: person.ticketNeedsExplicitReissue === true,
              erased: person.erased === true,
              status: typeof person.status === "string" ? person.status : "",
              paymentStatus:
                typeof person.paymentStatus === "string" ? person.paymentStatus : "",
              phone: typeof person.phone === "string" ? person.phone : "",
              company: typeof person.company === "string" ? person.company : "",
              email: typeof person.email === "string" ? person.email : "",
              group: typeof person.group === "string" && person.group.trim() ? person.group : "일반",
              inside: person.inside === true,
              everIn: person.everIn === true,
              presenceUnknown: (person.attendanceReview === true && person.inside !== true) || typeof person.inside !== "boolean" ||
                (person.inside !== true && Object.hasOwn(person, "everIn") && typeof person.everIn !== "boolean"),
              attendanceReview: attendanceNeedsReview(person),
              answers: exportAnswers(person.answers),
              consent: consent ? {
                version: consentVersion,
                at: typeof consent.at === "string" ? consent.at : "",
                noticeText: typeof notice?.text === "string" && notice.text ? notice.text : null,
              } : null,
            }];
          })
        : [];
      const fieldsComplete = workspace.rosterExportFieldsAvailable === true && exportFieldsComplete(workspace.publishedFields) &&
        Array.isArray(workspace.publishedFields) && workspace.rosterExportFieldCount === workspace.publishedFields.length;
      const publishedFields = fieldsComplete ? exportFields(workspace.publishedFields) : [];
      const exportIssue = !fieldsComplete ? "fields" : !participantCountKnown ? "roster" : participants.every((person) => exportParticipantComplete(person, publishedFields)) ? null : "answers";
      setState({
        kind: "ready",
        closeSnapshot: readCloseSnapshot(event, workspace),
        eventName:
          event && typeof event.name === "string" ? event.name : eventId,
        eventMeta: {
          clientName: stringValue(client?.name),
          date: stringValue(event?.date),
          start: stringValue(event?.start),
          end: stringValue(event?.end),
          venue: stringValue(venue?.name) || stringValue(event?.venue),
        },
        // Stage mirrors the server write gates: participant.* commands stop
        // at ENDED/ARCHIVED, domain commands (group.assign, reward.*) at
        // ARCHIVED. The UI hides what the server would reject; reads,
        // exports and CSV stay available on every stage.
        eventStage: typeof event?.stage === "string" ? event.stage : "",
        eventSlug,
        intakeOpen: workspace.registrationOpen === true && ["READY", "LIVE"].includes(typeof event?.stage === "string" ? event.stage.toUpperCase() : ""),
        people,
        publishedFields,
        exportIssue,
        groups,
        role,
        userId: myId,
        memberships,
        rewardFeature: features.includes("reward"),
        entryDesks: readEntryDesks(workspace),
        entryRecords: readEntryRecords(workspace),
      });
      setFetchedAt(Date.now());
      rosterGenerationRef.current += 1;
      rosterUnavailableRef.current = false;
      setRosterUnavailable(false);
      setRefreshError(null);
      // Drop selections for people who no longer exist; selections for
      // filtered-out people stay so they survive filter changes.
      const known = new Set(people.map((person) => person.id));
      setSelectedIds((current) => current.filter((id) => known.has(id)));
      return true;
    } catch {
      if (!isCurrent()) return false;
      if (keepReady) {
        setRefreshError("최신 목록을 불러오지 못했습니다. 내려받기는 최신 목록 확인 후 이용할 수 있습니다. 연결을 확인하고 새로고침하세요.");
        return false;
      }
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Focus/tab-visible/successful-write freshness: re-read only when there is
  // no unsaved work on screen. Dialog drafts (add/group/reward), an
  // in-flight or ambiguous write, and a pending status retry all block the
  // reload so focus never drops input or hides the retry. Query, filters and
  // selection survive the silent reload by design (load never touches them).
  // Re-subscribed every render so the guard closure stays fresh.
  useEffect(() =>
    subscribeConsoleFreshness(() => {
      if (writeBusyRef.current || pendingStatusRef.current || pendingBulkRef.current) return;
      if (groupBusy || addBusy || rewardBusy || bulkBusy) return;
      if (statusRetry) return;
      if (groupDialogOpen || addOpen || rewardTarget || editTargetId || bulkCancelTargets || ticketTarget || eraseTarget || cancellationConflictTarget) return;
      void load(true);
    })
  );

  // Manual refresh keeps the same silent contract as the focus reload: the
  // ready list and its selection stay until the new read lands.
  async function refreshQuietly() {
    if (refreshing) return;
    if (state.kind !== "ready") {
      await load();
      return;
    }
    await load(true);
  }

  // A popover left open during a failed refresh can cover the recovery
  // action below it. Close it when the failure becomes known, restoring
  // focus only if it was inside the popover.
  useEffect(() => {
    if (state.kind !== "ready" || refreshing || (!state.exportIssue && !rosterUnavailable)) return;
    const menu = rosterUtilitiesRef.current;
    if (!menu?.open) return;
    const restoreFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (restoreFocus) menu.querySelector("summary")?.focus();
  }, [state, refreshing, rosterUnavailable]);

  async function approveSelected(retry = false, sourceStatus: "PENDING" | "WAITLIST" = "PENDING") {
    if (bulkBusyRef.current || writeBusyRef.current) return;
    if (unconfirmedStatus) { setFailure("이전 참가자 상태 변경을 먼저 서버에서 확인하세요."); return; }
    if (!retry && pendingStatusRef.current?.uncertain) { setFailure("이전 참가자 상태 변경을 먼저 확인하세요."); return; }
    const hadUncertainAttempt = retry && pendingBulkRef.current !== null && bulkRetry !== null;
    let attempt = retry ? pendingBulkRef.current : null;
    if (!retry) {
      // Never replace an unresolved receipt with a new selection. Its retry
      // stays available separately until the server confirms the outcome.
      if (pendingBulkRef.current) return;
      const ids = effectiveSelection.filter((id) => {
        const person = state.kind === "ready" ? state.people.find((item) => item.id === id) : undefined;
        return person && person.status === sourceStatus && person.ticketReview !== "cancelled";
      });
      if (!ids.length) {
        setNotice(sourceStatus === "WAITLIST" ? "선택한 참가자 중 대기 명단에 있는 사람이 없습니다." : "선택한 참가자 중 승인 대기 중인 사람이 없습니다.");
        return;
      }
      const names = ids.map((id) => state.kind === "ready" ? state.people.find((person) => person.id === id)?.name ?? "" : "");
      const reissueNames = ids.flatMap((id) => {
        const person = state.kind === "ready" ? state.people.find((item) => item.id === id) : undefined;
        return person?.ticketNeedsExplicitReissue ? [person.name] : [];
      });
      attempt = { commandId: randomCommandId(), ids, names, reissueNames, sourceStatus };
      pendingBulkRef.current = attempt;
    }
    if (!attempt) return;
    const { ids } = attempt;
    setApprovedHandoffIds(null);
    writeBusyRef.current = true;
    bulkBusyRef.current = true;
    setBulkBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "participant.status",
            payload: { ids, status: "APPROVED", expectedStatus: attempt.sourceStatus },
          }),
        }
      );
      const data = await res.json().catch(() => null) as { error?: unknown; code?: unknown; participants?: unknown[] } | null;
      if (!res.ok) {
        const message = typeof data?.error === "string" ? data.error : "승인 결과를 확인하지 못했습니다.";
        if (res.status === 409 && ["PARTICIPANT_STATUS_CHANGED", "TICKET_STATUS_CONFLICT"].includes(String(data?.code))) {
          pendingBulkRef.current = null;
          setBulkRetry(null);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          setFailure(message);
          await load(true);
        } else if (isDefinitiveClientError(res.status) && !hadUncertainAttempt) {
          pendingBulkRef.current = null;
          setBulkRetry(null);
          setFailure(message);
        } else {
          setBulkRetry({ attempt, message });
        }
        return;
      }
      if (!Array.isArray(data?.participants) || data.participants.length !== ids.length ||
          !ids.every((id) => data.participants!.some((entry) => participantRecordMatches(entry, id, "APPROVED")))) {
        setBulkRetry({ attempt, message: "응답을 확인하지 못했습니다." });
        return;
      }
      pendingBulkRef.current = null;
      setBulkRetry(null);
      // Proven success only: failures and lost responses return above, so
      // the follow-up link below always names exactly this approval.
      setApprovedHandoffIds(ids);
      const applied = ids.length;
      // Name who was approved: a count alone cannot be checked against the
      // list the operator is looking at.
      const approvedNames = attempt.names.filter((name) => name.trim().length > 0);
      const nameSummary = approvedNames.length
        ? ` (${approvedNames.slice(0, 3).join(", ")}${approvedNames.length > 3 ? ` 외 ${approvedNames.length - 3}명` : ""})`
        : "";
      // A pending-only filter would hide the people just approved, so the
      // result must be visible in the list the operator is looking at.
      const filteredToSource = statusFilter === attempt.sourceStatus;
      if (filteredToSource) setStatusFilter("");
      const reissueNotice = attempt.reissueNames.length ? ` ${attempt.reissueNames.length}명의 기존 티켓은 무효 상태입니다. 참가자 상세에서 새 티켓을 발급해 전달하세요.` : "";
      const resultMessage = attempt.sourceStatus === "WAITLIST" ? `대기자 ${applied}명을 참가 확정했습니다.` : `${applied}명을 승인했습니다.`;
      const filterMessage = attempt.sourceStatus === "WAITLIST" ? "대기 명단 필터를 전체로 되돌려 확정된 사람을 보여 줍니다." : "승인 대기 필터를 전체로 되돌려 승인한 사람을 보여 줍니다.";
      setNotice(
        (filteredToSource
          ? `${resultMessage}${nameSummary} ${filterMessage}`
          : `${resultMessage}${nameSummary}`) + reissueNotice
      );
      // A selection made after the uncertain request belongs to the next
      // task and must not disappear when the earlier receipt is resolved.
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      await load(true);
    } catch {
      setBulkRetry({ attempt, message: "연결하지 못했습니다." });
    } finally {
      writeBusyRef.current = false;
      bulkBusyRef.current = false;
      setBulkBusy(false);
    }
  }

  async function createParticipant() {
    if (addBusy || writeBusyRef.current || unconfirmedAdd) return;
    const name = addDraft.name.trim();
    const phone = addDraft.phone.trim();
    if (!name || !phone) {
      setAddError({ message: "이름과 연락처를 입력하세요.", field: !name ? "name" : "phone" });
      return;
    }
    const fingerprint = JSON.stringify([
      "participant.create",
      eventId,
      name,
      phone,
      addDraft.company.trim(),
      addDraft.email.trim(),
      addDraft.registrationType,
    ]);
    if (pendingAddRef.current && pendingAddRef.current.fingerprint !== fingerprint) {
      setAddUnconfirmed(true);
      setAddError({ message: "등록 결과를 먼저 같은 요청으로 다시 확인하세요.", field: null });
      return;
    }
    const attempt = pendingAddRef.current?.fingerprint === fingerprint
      ? pendingAddRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingAddRef.current = attempt;
    writeBusyRef.current = true;
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "participant.create",
            payload: {
              name,
              phone,
              company: addDraft.company.trim(),
              email: addDraft.email.trim(),
              registrationType: addDraft.registrationType,
            },
          }),
        }
      );
      const data = await res.json().catch(() => null) as {
        error?: unknown;
        field?: unknown;
        participant?: { id?: unknown; name?: unknown; phone?: unknown };
      } | null;
      if (!res.ok) {
        // Ambiguous outcomes (the server may have applied the create before
        // the response was lost) keep the frozen id so the retry replays the
        // same receipt instead of duplicating the person. A definitive
        // rejection clears a first attempt only; it cannot settle an older
        // ambiguous one. The same submit button retries either way.
        const ambiguous = res.status >= 500 || [408, 425, 429].includes(res.status);
        // Once an earlier attempt may have committed, a later 4xx (for
        // example throttling) says nothing about that earlier outcome.
        const stillUnconfirmed = addUnconfirmed || ambiguous;
        if (!stillUnconfirmed) pendingAddRef.current = null;
        setAddUnconfirmed(stillUnconfirmed);
        setAddError({
          message: stillUnconfirmed
            ? "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요."
            : typeof data?.error === "string" ? data.error : "참가자를 추가하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : null,
        });
        return;
      }
      if (!data || typeof data.participant?.id !== "string" || !data.participant.id ||
          data.participant.name !== name || data.participant.phone !== phone.replace(/\D/g, "")) {
        setAddUnconfirmed(true);
        setAddError({ message: "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요.", field: null });
        return;
      }
      pendingAddRef.current = null;
      setAddUnconfirmed(false);
      const addedId = data.participant.id;
      const addedOnsite = addDraft.registrationType === "ONSITE" && state.kind === "ready" && state.eventStage.toUpperCase() === "LIVE" &&
        (data.participant as { status?: unknown }).status === "APPROVED";
      const added = typeof data?.participant?.name === "string" ? data.participant.name : name;
      setAddDraft({ name: "", phone: "", company: "", email: "", registrationType: addDefaultType });
      setReuseFrom(null);
      setAddOpen(false);
      setApprovedHandoffIds(null);
      setNotice(`${added}님을 등록했습니다.`);
      setNoticeEntry(addedOnsite ? { id: addedId, notice: `${added}님을 등록했습니다.` } : null);
      await load(true);
    } catch {
      if (pendingAddRef.current) {
        setAddUnconfirmed(true);
        setAddError({ message: "연결하지 못했습니다. 같은 내용으로 다시 시도하세요.", field: null });
      } else {
        setFailure("참가자는 등록됐지만 목록을 갱신하지 못했습니다. 새로고침해 확인하세요.");
      }
    } finally {
      writeBusyRef.current = false;
      setAddBusy(false);
    }
  }

  function copyRegistrationLink() {
    if (state.kind !== "ready" || !state.eventSlug) return;
    const link = `${window.location.origin}/event/${encodeURIComponent(state.eventSlug)}`;
    const copyFailed = () => { setNotice(null); setFailure("링크를 복사하지 못했습니다. 주소창에서 직접 복사해 주세요."); };
    // No clipboard API (plain-http venue LAN, older tablets): say so instead of staying silent.
    if (typeof navigator.clipboard?.writeText !== "function") { copyFailed(); return; }
    void navigator.clipboard
      .writeText(link)
      .then(() => setNotice("참가 신청 링크를 복사했습니다."))
      .catch(copyFailed);
  }

  async function changeStatus(person: Person, status: string) {
    if (writeBusyRef.current || savingId || status === person.status) return;
    // Cancellation voids the ticket: confirm it like the stage transitions
    // do. Approval stays one tap, and the row shows who is being approved.
    if (status === "CANCELLED") {
      setCancelConfirm({ id: person.id, name: person.name });
      return;
    }
    await applyStatus(person, status);
  }

  async function applyStatus(person: Person, status: string) {
    if (writeBusyRef.current || savingId) return;
    setStatusFeedbackId(person.id);
    if (unconfirmedStatus) { setFailure("이전 참가자 상태 변경을 먼저 서버에서 확인하세요."); return; }
    if (pendingBulkRef.current) { setFailure("이전 일괄 승인 결과를 먼저 확인하세요."); return; }
    const fingerprint = JSON.stringify(["participant.status", eventId, person.id, person.status, status]);
    if (pendingStatusRef.current?.uncertain && pendingStatusRef.current.fingerprint !== fingerprint) {
      setFailure("이전 참가자 상태 변경 결과를 먼저 확인하세요.");
      return;
    }
    writeBusyRef.current = true;
    setSavingId(person.id);
    setNotice(null);
    setFailure(null);
    // One command id per distinct status change: an ambiguous failure keeps
    // the id so the retry below replays the same request (the server receipt
    // replays the original result instead of applying twice).
    const attempt = pendingStatusRef.current?.fingerprint === fingerprint
      ? pendingStatusRef.current
      : { fingerprint, commandId: randomCommandId(), uncertain: false };
    pendingStatusRef.current = attempt;
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "participant.status",
            payload: { id: person.id, status, expectedStatus: person.status },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        participants?: unknown;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "변경하지 못했습니다.";
        if (res.status === 409 && ["PARTICIPANT_STATUS_CHANGED", "PARTICIPANT_INSIDE", "PARTICIPANT_PRESENCE_UNKNOWN", "TICKET_STATUS_CONFLICT"].includes(String(data?.code))) {
          pendingStatusRef.current = null;
          setStatusRetry(null);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          setFailure(serverMessage);
          await load(true);
        } else if (isDefinitiveClientError(res.status) && !attempt.uncertain) {
          pendingStatusRef.current = null;
          setStatusRetry(null);
          setFailure(serverMessage);
        } else {
          attempt.uncertain = true;
          setStatusRetry({ person, status });
          setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        }
        return;
      }
      if (!Array.isArray(data?.participants) || !data.participants.some((entry) => participantRecordMatches(entry, person.id, status))) {
        // 2xx without this person's updated record: the write may have
        // landed. Keep the id so the retry replays instead of duplicating.
        attempt.uncertain = true;
        setStatusRetry({ person, status });
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        return;
      }
      pendingStatusRef.current = null;
      setStatusRetry(null);
      setStatusFeedbackId(null);
      setApprovedHandoffIds(null);
      setNotice(`${person.name} 상태를 ‘${statusLabel(status)}’${roParticle(statusLabel(status))} 바꿨습니다.${status === "APPROVED" && person.ticketNeedsExplicitReissue ? " 기존 티켓은 무효 상태입니다. 새 티켓을 발급해 전달하세요." : ""}`);
      await load(true);
    } catch {
      attempt.uncertain = true;
      setStatusRetry({ person, status });
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
    } finally {
      writeBusyRef.current = false;
      setSavingId(null);
    }
  }

  // Single dismissal predicates: the shared dialog calls canClose ONCE on
  // Escape/backdrop and then the pure onClose below — never two confirms.
  // Cancel buttons consult the same predicate once. Busy refs (not state)
  // block pre-render writes too. Success closes bypass confirmation via the
  // pure closers directly.
  function canCloseGroupDialog(): boolean {
    if (writeBusyRef.current || groupBusy) return false;
    return (groupDraft === (groupBaselineRef.current ?? "") && !pendingGroupRef.current && !groupConflict) || window.confirm(pendingGroupRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  function closeGroupDialog(): void {
    setGroupDialogOpen(false);
    groupBaselineRef.current = null;
    groupPeopleRef.current = null;
    groupReadRef.current?.abort(); groupReadRef.current = null;
    groupConflictRef.current = null; setGroupConflict(null);
  }

  function canCloseRewardDialog(): boolean {
    if (writeBusyRef.current || rewardBusy) return false;
    const dirty = rewardDraft.name.trim() !== "" || rewardDraft.method !== "ONSITE";
    return (!dirty && !pendingRewardRef.current) || window.confirm(pendingRewardRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  function closeRewardDialog(): void {
    // The draft stays owned by its row so reopening restores unsent input;
    // a proven success clears it (see createReward).
    setRewardTarget(null);
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="participants" eventId={eventId}>
        <ConsoleStatePanel
          kind="loading" shape="list"
          message="참가자 목록을 불러오고 있습니다."
          onRetry={() => { void load(); }}
        />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="participants" eventId={eventId}>
        {/* ConsoleStatePanel dispatches eventouch:shell-reload and renders 다시 불러오기. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void load(); }}
        />
      </ConsolePage>
    );
  }
  // A duplicate-contact refusal names who already holds the number, so the operator
  // can open that person instead of guessing.
  const addPhoneDigits = addDraft.phone.replace(/\D/g, "");
  const existingForAdd = addError?.field === "phone" && addPhoneDigits
    ? state.people.find((person) => person.phone.replace(/\D/g, "") === addPhoneDigits) ?? null : null;
  const search = query.trim().toLocaleLowerCase("ko-KR");
  const visiblePeople = state.people.filter((person) => {
    const matchesQuery = matchesRosterQuery(person, search);
    const matchesGroup = !groupFilter || person.group === groupFilter;
    return matchesQuery && matchesGroup && matchesAttendance(person, attendanceFilter) && (!statusFilter || person.status === statusFilter) &&
      (!ticketFilter || (person.status.toUpperCase() !== "CANCELLED" && ["expired", "revoked", "unavailable", "unknown", "cancelled"].includes(person.ticketReview)));
  });

  // Selection is scoped to what is visible: group assignment only ever
  // touches rows the operator can see and count. The full selection survives
  // filter changes (back/forward never reselects); hidden rows are counted
  // next to the toolbar and the deselect clears everything explicitly.
  const visibleIds = new Set(visiblePeople.map((person) => person.id));
  const knownIds = new Set(state.people.map((person) => person.id));
  const effectiveSelection = selectedIds.filter((id) => visibleIds.has(id));
  const effectiveIds = new Set(effectiveSelection);
  const approvalCandidates = state.people.filter((person) => effectiveIds.has(person.id) && person.status === "PENDING" && person.ticketReview !== "cancelled");
  const waitlistCandidates = state.people.filter((person) => effectiveIds.has(person.id) && person.status === "WAITLIST" && person.ticketReview !== "cancelled");
  const approvalConflicts = state.people.filter((person) => effectiveIds.has(person.id) && ["PENDING", "WAITLIST"].includes(person.status) && person.ticketReview === "cancelled");
  const approvalReissues = [...approvalCandidates, ...waitlistCandidates].filter((person) => person.ticketNeedsExplicitReissue);
  const cancelCandidates = state.people.filter((person) => effectiveIds.has(person.id) && person.status !== "CANCELLED");
  const hiddenSelectedCount = selectedIds.filter(
    (id) => knownIds.has(id) && !visibleIds.has(id)
  ).length;
  // Page slice of the same filtered result: counts above keep meaning the
  // filter total versus the whole roster; the range below names this page.
  const totalPages = Math.max(1, Math.ceil(visiblePeople.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  // Reopened 2026-11-20: people waiting for approval are marked (amber edge and tint) instead of
  // being re-ordered, so a row never jumps away under the pointer while an operator approves,
  // selects or pages; the 승인 대기 tab is the queue view.
  const orderedPeople = nameSort === "original" ? visiblePeople : [...visiblePeople].sort((a, b) =>
    nameSort === "ascending" ? a.name.localeCompare(b.name, "ko") : b.name.localeCompare(a.name, "ko")
  );
  const pagePeople = orderedPeople.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  // Details open in an overlay sheet (right edge on desktop, bottom sheet on
  // phones) over the full-width table. The selected row stays the single
  // source for details; no row grows into a card and no second copy of the
  // actions exists.
  const selectedPerson = toolsOpenId
    ? state.people.find((person) => person.id === toolsOpenId) ?? null
    : null;
  // 소속 spellings in use (cancelled people excluded), for suggestions in add/edit and import.
  const companyCounts = new Map<string, number>();
  for (const person of state.people) {
    const company = person.company.trim();
    if (company && person.status !== "CANCELLED") companyCounts.set(company, (companyCounts.get(company) ?? 0) + 1);
  }
  // Quick presets ride the exact same setters as the selects (and therefore
  // the same URL sync, counts and selection scope): they are shortcuts, not
  // a second filter system. Counts ignore status/attendance so the chips
  // show the distribution instead of echoing their own filter.
  const presetBase = state.people.filter((person) => {
    return matchesRosterQuery(person, search) && (!groupFilter || person.group === groupFilter);
  });
  const presetCounts = {
    all: presetBase.length,
    pending: presetBase.filter((person) => person.status === "PENDING").length,
    approved: presetBase.filter((person) => person.status === "APPROVED").length,
    notEntered: presetBase.filter((person) => person.status === "APPROVED" && matchesAttendance(person, "NOT_ENTERED")).length,
    waitlist: presetBase.filter((person) => person.status === "WAITLIST").length,
    cancelled: presetBase.filter((person) => person.status === "CANCELLED").length,
  };
  type RosterPreset = { key: string; label: string; status: string; attendance: string; count: number };
  const rosterPresets: RosterPreset[] = [
    { key: "all", label: "전체", status: "", attendance: "", count: presetCounts.all },
    { key: "pending", label: "승인 대기", status: "PENDING", attendance: "", count: presetCounts.pending },
    { key: "approved", label: "참가 확정", status: "APPROVED", attendance: "", count: presetCounts.approved },
    { key: "not-entered", label: "확정자 중 미입장", status: "APPROVED", attendance: "NOT_ENTERED", count: presetCounts.notEntered },
    // 상태 선택이 필터에서 빠졌으므로 모든 상태를 탭으로 닿게 한다. 대기 명단은 있을 때만(또는 열려 있을 때만) 보인다.
    ...(presetCounts.waitlist > 0 || statusFilter === "WAITLIST"
      ? [{ key: "waitlist", label: "대기 명단", status: "WAITLIST", attendance: "", count: presetCounts.waitlist }] : []),
    { key: "cancelled", label: "취소된 신청", status: "CANCELLED", attendance: "", count: presetCounts.cancelled },
  ];
  function applyRosterPreset(preset: RosterPreset) {
    setStatusFilter(preset.status);
    setAttendanceFilter(preset.attendance);
    setTicketFilter("");
  }
  const pageIds = new Set(pagePeople.map((person) => person.id));
  const pageSelectedCount = selectedIds.filter((id) => pageIds.has(id)).length;
  // Selected under the same filter but on another page: kept, counted here,
  // and still inside the group-assignment scope (effectiveSelection).
  const otherPageSelectedCount = effectiveSelection.length - pageSelectedCount;
  const pageStart = visiblePeople.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(safePage * PAGE_SIZE, visiblePeople.length);
  // Disclosure badge: how many of the three advanced selects narrow the list,
  // and under which readable labels. The search box stays visible, so the
  // query is summarized only by the reset label, not the count.
  // 상태는 탭이 맡으므로 이 패널(그룹·출입·티켓)의 개수에는 세지 않는다.
  const advancedActiveCount = [groupFilter, attendanceFilter, ticketFilter].filter(Boolean).length;
  const advancedSummary = [
    groupFilter || "",
    attendanceFilter ? attendanceLabel(attendanceFilter) : "",
    ticketFilter ? "티켓 확인 필요" : "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" · ");
  const hasAnyFilter = Boolean(query.trim()) || Boolean(statusFilter) || advancedActiveCount > 0;
  const isAttendanceReviewOnly = attendanceFilter === "REVIEW" && !query.trim() && !statusFilter && !groupFilter && !ticketFilter;
  // Roster→message handoff: the full known selection, including filtered-out
  // hidden rows, travels as ?to=<comma-separated ids>. Visible-only group
  // assignment above is untouched.
  const handoffIds = selectedIds.filter((id) => knownIds.has(id));
  const handoffOverLimit = handoffIds.length > 200;
  const handoffHref = `/console/events/${encodeURIComponent(eventId)}/messages?to=${encodeURIComponent(handoffIds.join(","))}`;

  function toggleAdvancedFilters() {
    if (filtersOpen) {
      // Closing collapses the panel (display:none at <=768px), which removes
      // its tab stops: return focus to the toggle first so keyboard users are
      // never stranded on a hidden control.
      try {
        const active = document.activeElement;
        if (active && advancedFiltersRef.current?.contains(active)) {
          filterToggleRef.current?.focus();
        }
      } catch {
        // Focus recovery is best-effort; the toggle still works.
      }
    }
    setFiltersOpen(!filtersOpen);
  }

  // Reset clears ONLY the search and the three filters: the checkbox
  // selection (including hidden rows) is operator work that survives filter
  // changes, back/forward and this reset alike.
  function clearRosterFilters() {
    setQuery("");
    setStatusFilter("");
    setGroupFilter("");
    setAttendanceFilter("");
    setTicketFilter("");
  }

  function togglePerson(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }

  async function readLatestGroupPeople() {
    const conflict = groupConflictRef.current;
    if (!conflict || groupReadRef.current) return;
    const controller = new AbortController();
    groupReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const loading = { ...conflict, latest: null, groups: [], loading: true, error: null };
    groupConflictRef.current = loading; setGroupConflict(loading);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as { state?: { events?: unknown; workspaces?: Record<string, Record<string, unknown>> } };
      const bootstrap = body?.state;
      const eventExists = Array.isArray(bootstrap?.events) && bootstrap.events.some((event) => event && typeof event === "object" && (event as Record<string, unknown>).id === eventId);
      const workspace = bootstrap?.workspaces?.[eventId];
      if (!response.ok || !eventExists || !workspace || !Array.isArray(workspace.participants) ||
          !Array.isArray(workspace.groups) || workspace.groups.some((group) => typeof group !== "string")) throw new Error("incomplete roster");
      const latest = conflict.before.map((person) => {
        const matches = (workspace.participants as unknown[]).filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).id === person.id);
        if (matches.length !== 1) throw new Error("participant unavailable");
        const item = matches[0] as Record<string, unknown>;
        if (typeof item.name !== "string" || typeof item.group !== "string") throw new Error("incomplete participant");
        return { id: person.id, name: item.name, group: item.group,
          company: typeof item.company === "string" ? item.company : "", phone: typeof item.phone === "string" ? item.phone : "" };
      });
      if (controller.signal.aborted || activeEventRef.current !== eventId || groupReadRef.current !== controller) return;
      const resolved = { ...conflict, latest, groups: workspace.groups as string[], loading: false, error: null };
      groupConflictRef.current = resolved; setGroupConflict(resolved);
    } catch {
      if (activeEventRef.current !== eventId || groupReadRef.current !== controller) return;
      const failed = { ...conflict, latest: null, groups: [], loading: false, error: "최신 명단을 확인하지 못했습니다. 선택과 그룹은 그대로 있습니다. 연결과 참가자 상태를 확인하고 다시 시도하세요." };
      groupConflictRef.current = failed; setGroupConflict(failed);
    } finally {
      window.clearTimeout(timeout);
      if (groupReadRef.current === controller) groupReadRef.current = null;
    }
  }

  function acceptLatestGroups() {
    const conflict = groupConflictRef.current;
    if (!conflict?.latest || activeEventRef.current !== eventId) return;
    const latest = conflict.latest;
    const currentById = new Map(latest.map((person) => [person.id, person]));
    groupPeopleRef.current = latest;
    setState((current) => current.kind === "ready" ? { ...current, groups: conflict.groups,
      people: current.people.map((person) => currentById.has(person.id) ? { ...person, name: currentById.get(person.id)!.name, group: currentById.get(person.id)!.group } : person) } : current);
    if (!conflict.groups.includes(groupDraft)) setGroupDraft("");
    groupConflictRef.current = null; setGroupConflict(null);
    setGroupError(null);
    window.requestAnimationFrame(() => document.getElementById("group-pick")?.focus());
  }

  async function assignGroup(event: React.FormEvent) {
    event.preventDefault();
    if (writeBusyRef.current || groupBusy || unconfirmedGroup || groupConflictRef.current || (!pendingGroupRef.current && (!groupDraft || !groupPeopleRef.current?.length))) return;
    writeBusyRef.current = true;
    setGroupBusy(true);
    setGroupError(null);
    setNotice(null);
    // Preserve the exact group and participants, even if a closed dialog is
    // reopened after filters or selection have changed.
    const people = groupPeopleRef.current ?? [];
    const fingerprint = JSON.stringify(["group.assign", eventId, groupDraft, people.map(({ id, group }) => ({ id, group }))]);
    const attempt = pendingGroupRef.current?.uncertain
      ? pendingGroupRef.current
      : { eventId, fingerprint, commandId: randomCommandId(), group: groupDraft, ids: people.map((person) => person.id), people,
          names: people.map((person) => person.name), expectedGroups: people.map(({ id, group }) => ({ id, group })), uncertain: false };
    pendingGroupRef.current = attempt;
    groupExecutionRef.current = { eventId: attempt.eventId, commandId: attempt.commandId };
    const currentExecution = () => activeEventRef.current === attempt.eventId &&
      groupExecutionRef.current?.eventId === attempt.eventId && groupExecutionRef.current.commandId === attempt.commandId;
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(attempt.eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "group.assign",
            payload: { group: attempt.group, ids: attempt.ids, expectedGroups: attempt.expectedGroups },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown; participantIds?: unknown; group?: unknown } | null;
      if (!currentExecution()) return;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "그룹을 지정하지 못했습니다.";
        if (res.status === 409 && data?.code === "PARTICIPANT_GROUP_CHANGED") {
          // This specific guard is evaluated after receipt lookup, even on a
          // retry, so the original request is definitively not applied.
          abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
          pendingGroupRef.current = null; setGroupUncertain(false); setGroupError(null);
          const conflict: GroupConflict = { before: attempt.people, latest: null, groups: [], loading: false, error: null };
          groupConflictRef.current = conflict; setGroupConflict(conflict);
          window.requestAnimationFrame(() => document.getElementById("group-conflict-heading")?.focus());
        } else if (isDefinitiveClientError(res.status) && !attempt.uncertain) {
          pendingGroupRef.current = null;
          setGroupUncertain(false);
          setGroupError(serverMessage);
        } else {
          attempt.uncertain = true;
          setGroupUncertain(true);
          setGroupError(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        }
        return;
      }
      // Proven success carries this group's id set back, not just an array.
      const returnedIds = Array.isArray(data?.participantIds)
        ? data.participantIds.map((id) => String(id)).sort().join(",")
        : null;
      const expectedIds = [...attempt.ids].map((id) => String(id)).sort().join(",");
      if (data?.group !== attempt.group || returnedIds === null || returnedIds !== expectedIds) {
        attempt.uncertain = true;
        setGroupUncertain(true);
        setGroupError("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        return;
      }
      pendingGroupRef.current = null;
      setGroupUncertain(false);
      setApprovedHandoffIds(null);
      setNotice(`${attempt.ids.length}명을 ‘${attempt.group}’ 그룹${roParticle("그룹")} 지정했습니다.`);
      setSelectedIds((current) => current.filter((id) => !attempt.ids.includes(id)));
      setGroupDialogOpen(false);
      groupBaselineRef.current = null;
      await load(true);
    } catch {
      if (!currentExecution()) return;
      attempt.uncertain = true;
      setGroupUncertain(true);
      setGroupError("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
    } finally {
      if (currentExecution()) {
        groupExecutionRef.current = null;
        writeBusyRef.current = false;
        setGroupBusy(false);
      }
    }
  }

  async function createReward(event: React.FormEvent) {
    event.preventDefault();
    if (writeBusyRef.current || rewardBusy || unconfirmedReward || !rewardTarget || !rewardDraft.name.trim()) return;
    writeBusyRef.current = true;
    setRewardBusy(true);
    setRewardError(null);
    setNotice(null);
    const rewardName = rewardDraft.name.trim();
    // Reward ids are command ids. Keep target and input with an uncertain
    // result so reopening another row cannot accidentally create a duplicate.
    const fingerprint = JSON.stringify(["reward.create", eventId, rewardTarget.id, rewardName, rewardDraft.method]);
    const attempt = pendingRewardRef.current?.uncertain
      ? pendingRewardRef.current
      : { fingerprint, commandId: randomCommandId(), target: rewardTarget, name: rewardName, method: rewardDraft.method, uncertain: false };
    pendingRewardRef.current = attempt;
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "reward.create",
            payload: {
              participantId: attempt.target.id,
              name: attempt.name,
              method: attempt.method,
            },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        reward?: unknown;
      } | null;
      if (!res.ok) {
        const definitive = isDefinitiveClientError(res.status) && !attempt.uncertain;
        if (definitive) { pendingRewardRef.current = null; setRewardUncertain(false); }
        else { attempt.uncertain = true; setRewardUncertain(true); }
        setRewardError({
          field: definitive && typeof data?.field === "string" ? data.field : null,
          message: (() => {
            const base = typeof data?.error === "string" ? data.error : "경품을 등록하지 못했습니다.";
            return definitive ? base : `${base} 같은 요청으로 다시 시도하세요.`;
          })(),
        });
        return;
      }
      if (typeof data?.reward !== "object" || data?.reward === null) {
        attempt.uncertain = true;
        setRewardUncertain(true);
        setRewardError({ field: null, message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      // Proven success echoes this recipient on the created reward (the
      // reward id itself is the command id), not just any reward object.
      const created = data.reward as Record<string, unknown>;
      if (created.id !== attempt.commandId || created.participantId !== attempt.target.id || created.name !== attempt.name || created.method !== attempt.method) {
        attempt.uncertain = true;
        setRewardUncertain(true);
        setRewardError({ field: null, message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      pendingRewardRef.current = null;
      setRewardUncertain(false);
      setApprovedHandoffIds(null);
      setNotice(`${attempt.target.name}님의 경품을 등록했습니다. 경품 화면에서 지급 처리하세요.`);
      setRewardTarget(null);
      setRewardDraft({ name: "", method: "ONSITE" });
      rewardDraftOwnerRef.current = null;
    } catch {
      attempt.uncertain = true;
      setRewardUncertain(true);
      setRewardError({ field: null, message: "연결하지 못했습니다. 같은 요청으로 다시 시도하세요." });
    } finally {
      writeBusyRef.current = false;
      setRewardBusy(false);
    }
  }

  function downloadExport(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  function exportCsv() {
    if (state.kind !== "ready" || rosterUnavailableRef.current || state.exportIssue) return;
    const rows = participantExportRows(orderedPeople, state.publishedFields, statusLabel);
    downloadExport(new Blob([participantCsv(rows)], { type: "text/csv;charset=utf-8" }), participantExportFilename(state.eventName, "csv"));
  }
  async function exportXlsx() {
    if (exportGateRef.current || exporting || state.kind !== "ready" || rosterUnavailableRef.current || state.exportIssue) return;
    exportGateRef.current = true;
    const exportGeneration = rosterGenerationRef.current;
    const exportEventId = eventId;
    setExporting(true);
    setFailure(null);
    try {
      const rows = participantExportRows(orderedPeople, state.publishedFields, statusLabel);
      const XLSX = await import("xlsx");
      if (rosterUnavailableRef.current || rosterGenerationRef.current !== exportGeneration || activeEventRef.current !== exportEventId) {
        if (activeEventRef.current === exportEventId) setFailure("명단이 바뀌거나 확인되지 않아 내려받기를 취소했습니다. 최신 목록에서 다시 시도하세요.");
        return;
      }
      // Every cell is a string, including numbers, phone numbers and text
      // beginning with '=': no cell receives a formula property.
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = rows[0].map((header) => ({ wch: Math.max(14, Math.min(28, header.length * 2 + 4)) }));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "참가자");
      const bytes: ArrayBuffer = XLSX.write(book, { bookType: "xlsx", type: "array" });
      downloadExport(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), participantExportFilename(state.eventName, "xlsx"));
    } catch {
      setFailure("엑셀 파일을 만들지 못했습니다. 다시 시도하거나 CSV로 내려받으세요.");
    } finally { exportGateRef.current = false; setExporting(false); }
  }
  // Write gates mirror the server's single event-permissions map (role +
  // membership + per-command scope, re-checked server-side): the 명단 probe
  // covers 참가자 추가·상태 변경·가져오기·그룹 지정, the 결과 probe covers
  // the 경품 등록 row action. Hidden controls stay hidden; reads, the
  // filtered count, 새로고침 and CSV export stay on every membership.
  // participant.* writes stop at ENDED/ARCHIVED, domain writes
  // (group.assign, reward.create) at ARCHIVED.
  const capabilities = {
    role: state.role,
    userId: state.userId,
    memberships: state.memberships,
    eventId,
  };
  const canWriteRoster = canWriteEvent(capabilities, "participant.status");
  const canEditParticipant = canWriteEvent(capabilities, "participant.update");
  const canReissueTicket = canWriteEvent(capabilities, "ticket.reissue-reviewed");
  // 삭제 요청은 행사가 끝난 뒤에도 오므로 단계와 무관하게 연다(서버도 보관 행사에서 허용한다).
  const canEraseParticipant = canWriteEvent(capabilities, "participant.erase");
  const canResolveCancellationConflict = canWriteEvent(capabilities, "participant.resolve-cancellation-conflict");
  const canWriteGroup = canWriteEvent(capabilities, "group.assign");
  const canWriteReward = canWriteEvent(capabilities, "reward.create");
  const canReviewExit = canWriteEvent(capabilities, "check.reviewed-exit") && state.eventStage.toUpperCase() === "LIVE";
  const stageKey = state.eventStage.toUpperCase();
  // 현장 입장 처리: the same grant the server asks for check.scan ("onsite"); the stage, status and desk
  // rules are explained per person by entryState and enforced by the server.
  const entryContext: EntryContext = { eventId, stage: stageKey, canScan: canWriteEvent(capabilities, "check.scan"), desks: state.entryDesks, records: state.entryRecords };
  const participantsLocked = stageKey === "ENDED" || stageKey === "ARCHIVED";
  const archived = stageKey === "ARCHIVED";
  const canMutateStatus = canWriteRoster && !participantsLocked;
  const canAssignGroup = canWriteGroup && !archived;
  const canRewardHere = canWriteReward && state.rewardFeature && !archived;
  const showRowActions = canMutateStatus || (canEditParticipant && !participantsLocked) || canRewardHere || canReviewExit || canEraseParticipant;
  const readOnlyRows = !canAssignGroup;
  const rowClass = readOnlyRows
    ? `${styles.participantRow} ${styles.viewerRow}`
    : showRowActions
      ? styles.participantRow
      : `${styles.participantRow} ${styles.participantRowNoActions}`;
  const anySelected = effectiveSelection.length > 0 || hiddenSelectedCount > 0;
  function closeInspector(): void {
    sheetNavFocusRef.current = null;
    setToolsOpenId(null);
    window.requestAnimationFrame(() => {
      const trigger = inspectorReturnFocusRef.current;
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
      else document.getElementById("roster-search")?.focus({ preventScroll: true });
    });
  }
  // Previous/next person in the current filtered, sorted roster (all pages).
  const sheetIndex = toolsOpenId ? orderedPeople.findIndex((person) => person.id === toolsOpenId) : -1;
  function stepSheet(offset: number, source?: HTMLElement | null) {
    if (sheetIndex < 0 || (selectedPerson && savingId === selectedPerson.id)) return;
    const next = orderedPeople[sheetIndex + offset];
    if (!next) return;
    sheetNavFocusRef.current = source ?? null;
    const nextPage = Math.floor((sheetIndex + offset) / PAGE_SIZE) + 1;
    if (nextPage !== safePage) setPage(nextPage);
    setToolsOpenId(next.id);
    window.requestAnimationFrame(() => {
      const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-roster-detail]"))
        .find((button) => button.dataset.rosterDetail === next.id && button.getClientRects().length) ?? null;
      if (trigger) {
        inspectorReturnFocusRef.current = trigger;
        trigger.scrollIntoView({ block: "nearest" });
      }
    });
  }
  const sheetOpen = Boolean(showRowActions && selectedPerson && !rewardTarget && !addOpen && !groupDialogOpen && !editTargetId && !ticketTarget && !eraseTarget && !reviewedExitTarget && !reconcileTarget && !cancellationConflictTarget);
  // Up/Down move through the roster order while focus is in the sheet, except
  // where the arrow keys already mean something (fields, menus, disclosures).
  function sheetArrowKeys(event: React.KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if ((event.target as HTMLElement).closest("input, select, textarea, summary, [contenteditable='true'], [role='listbox']")) return;
    event.preventDefault();
    stepSheet(event.key === "ArrowDown" ? 1 : -1);
  }
  // A remounted sheet (after a nested dialog closes) starts on its heading,
  // never on a button from the previous mount.
  if (!sheetOpen) sheetNavFocusRef.current = null;
  function selectVisible() {
    const ids = visiblePeople.map((person) => person.id);
    setSelectedIds((current) => [...new Set([...current, ...ids])]);
  }

  function showRosterPage(nextPage: number) {
    setPage(nextPage);
    // Paging is a new slice, not a continuation at the old scroll position.
    // Land before its first row for pointer and keyboard users alike; the
    // page status announces the range and the next Tab enters the new rows.
    window.requestAnimationFrame(() => {
      const heading = document.getElementById("participants-list-heading");
      if (!heading) return;
      heading.setAttribute("tabindex", "-1");
      heading.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
      heading.focus({ preventScroll: true });
    });
  }

  function focusRosterPagination(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const next = document.getElementById("roster-next-page") as HTMLButtonElement | null;
    const previous = document.getElementById("roster-previous-page") as HTMLButtonElement | null;
    const target = next && !next.disabled ? next : previous && !previous.disabled ? previous : document.getElementById("roster-search");
    target?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
    target?.focus({ preventScroll: true });
  }
  function selectPage() {
    const ids = pagePeople.map((person) => person.id);
    setSelectedIds((current) => [...new Set([...current, ...ids])]);
  }
  function selectMobileScope(scope: "page" | "filter", trigger: HTMLButtonElement) {
    if (scope === "page") selectPage();
    else selectVisible();
    // The menu otherwise covers the newly revealed count and bulk actions.
    // Return keyboard focus to its disclosure instead of hiding focus inside.
    const disclosure = trigger.closest("details");
    if (disclosure) {
      disclosure.open = false;
      disclosure.querySelector("summary")?.focus({ preventScroll: true });
    }
  }
  function closeSelectionMenu(trigger: HTMLElement) {
    const disclosure = trigger.closest("details");
    if (!disclosure) return;
    disclosure.open = false;
    disclosure.querySelector("summary")?.focus({ preventScroll: true });
  }
  // The whole row opens the details for pointer users; keyboard and assistive
  // users keep the row's named detail button. Controls inside the row keep
  // their own meaning.
  function openDetailsFromRow(event: React.MouseEvent<HTMLElement>, personId: string) {
    if ((event.target as HTMLElement).closest("input, button, a, label, select, textarea, summary")) return;
    if (window.getSelection()?.toString()) return;
    inspectorReturnFocusRef.current = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    setToolsOpenId(personId);
  }
  // Bottom-of-list return: the sticky page bar sits below the toolbar, so
  // this moves scroll and keyboard focus back to the actual search input.
  function focusRosterSearch() {
    const field = document.getElementById("roster-search");
    if (!(field instanceof HTMLElement)) return;
    try {
      field.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      field.focus({ preventScroll: true });
    } catch {
      field.focus();
    }
  }
  return (
    <ConsolePage
      pageId="participants"
      closeSnapshot={state.closeSnapshot}
      eventId={eventId}
      eventName={state.eventName}
      meta={formatConsoleEventMeta(state.eventMeta)}
      className={styles.workbenchPage}
      toolbar={
        <div className={styles.workbenchControls}>
        <ConsoleToolbar
          filters={
            <>
              <label className={styles.searchField} data-toolbar-span="full">
                <span className="sr-only" id="roster-search-label">이름·소속·연락처 검색</span>
                <span className={styles.searchGlyph} aria-hidden="true"><SearchIcon /></span>
                <input
                  id="roster-search"
                  aria-labelledby="roster-search-label"
                  type="search"
                  placeholder="이름·소속·연락처 검색"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {/* Optional filters keep the same state at every width. */}
              <button
                type="button"
                id="roster-filter-toggle"
                ref={filterToggleRef}
                className={`pill ${styles.filterToggle}`}
                data-active={advancedActiveCount > 0 ? "true" : undefined}
                aria-expanded={filtersOpen}
                aria-controls="roster-advanced-filters"
                onClick={toggleAdvancedFilters}
              >
                <FilterIcon />
                <span>필터{advancedActiveCount > 0 ? ` · ${advancedActiveCount}개 적용 중` : ""}</span>
                {advancedSummary ? (
                  <span className={styles.filterToggleSummary}>{advancedSummary}</span>
                ) : null}
                <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none"><path d={filtersOpen ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} stroke="currentColor" strokeWidth="1.5" /></svg>
              </button>
              <div
                id="roster-advanced-filters"
                ref={advancedFiltersRef}
                className={styles.advancedFilters}
                data-open={filtersOpen ? "true" : "false"}
              >
              {state.groups.length ? (
                <label>
                  <span className="sr-only" id="roster-group-label">그룹별 보기</span>
                  <select aria-labelledby="roster-group-label" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
                    <option value="">전체 그룹</option>
                    {state.groups.map((group) => (
                      <option key={group} value={group}>{group}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                <span className="sr-only" id="roster-attendance-label">출입 상태별 보기</span>
                <select aria-labelledby="roster-attendance-label" value={attendanceFilter} onChange={(event) => setAttendanceFilter(event.target.value)}>
                  <option value="">전체 출입</option>
                  {ATTENDANCE.map((attendance) => (
                    <option key={attendance} value={attendance}>{attendanceLabel(attendance)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only" id="roster-ticket-label">티켓 상태별 보기</span>
                <select aria-labelledby="roster-ticket-label" value={ticketFilter} onChange={(event) => setTicketFilter(event.target.value)}>
                  <option value="">전체 티켓</option>
                  <option value="review">티켓 확인 필요</option>
                </select>
              </label>
              {hasAnyFilter ? (
                <ProductButton
                  type="button"
                  id="roster-filter-reset"
                  className={`button button-quiet ${styles.filterReset}`}
                  onClick={clearRosterFilters}
                >
                  검색·필터 초기화
                </ProductButton>
              ) : null}
              </div>
            </>
          }
          actions={
            <span data-toolbar-inline className={styles.utilityPair}>
              <details className={styles.rosterUtilities} ref={rosterUtilitiesRef}>
                <summary aria-label="내보내기·가져오기"><span className={styles.summaryDesktop}><DownloadIcon /><span className={styles.longAction}>내보내기</span><span className={styles.shortAction} aria-hidden="true">내보내기</span></span><span className={styles.summaryMore} aria-hidden="true"><MoreIcon /></span></summary>
                <div className={styles.utilityMenu}>
              <ProductButton type="button" className="button button-secondary" aria-label={`엑셀 내보내기 · 검색·필터 결과 ${visiblePeople.length}명`} aria-describedby={state.exportIssue ? "roster-export-unavailable" : undefined} title={`검색·필터 결과 ${visiblePeople.length}명을 현재 정렬 순서로 내보냅니다.`} disabled={exporting || rosterUnavailable || Boolean(state.exportIssue)} onClick={() => void exportXlsx()} icon={<DownloadIcon />}>

                {exporting ? "엑셀 준비 중…" : "엑셀 내보내기"}
              </ProductButton>
              <ProductButton type="button" className="button button-secondary" aria-label={`CSV 내보내기 · 검색·필터 결과 ${visiblePeople.length}명`} aria-describedby={state.exportIssue ? "roster-export-unavailable" : undefined} title={`검색·필터 결과 ${visiblePeople.length}명을 현재 정렬 순서로 내보냅니다.`} disabled={rosterUnavailable || Boolean(state.exportIssue)} onClick={exportCsv} icon={<DownloadIcon />}>

                CSV 내보내기
              </ProductButton>
              {/* Phones fold 명단 가져오기 into this menu (시안 A, 2026-11-21); the toolbar copy below is hidden there. */}
              {canMutateStatus ? <ProductButton type="button" variant="ghost" className={styles.menuImport} onClick={() => { if (rosterUtilitiesRef.current) rosterUtilitiesRef.current.open = false; setImportOpen(true); }} icon={<UploadIcon />}>명단 가져오기</ProductButton> : null}
              </div>
              </details>
              {canMutateStatus ? <ProductButton type="button" variant="ghost" onClick={() => setImportOpen(true)} className={styles.toolbarImport} icon={<UploadIcon />}>명단 가져오기</ProductButton> : null}
              {canMutateStatus ? (
                <ProductButton type="button" className="button button-primary" aria-label="참가자 추가" disabled={unconfirmedAdd} onClick={() => { setAddError(addUnconfirmed ? { message: "등록 결과가 확인되지 않았습니다. 같은 요청으로 다시 확인하세요.", field: null } : null); setAddOpen(true); }} icon={<PlusIcon />}>

                  <span className={styles.longAction}>참가자 추가</span><span className={styles.shortAction} aria-hidden="true">추가</span>
                </ProductButton>
              ) : null}
            </span>
          }

        />
        </div>
      }
      feedback={
        <>
          {state.exportIssue ? <ConsoleFeedback kind="warning" id="roster-export-unavailable">
            {state.exportIssue === "fields" ? "게시된 신청 항목을 확인할 수 없어" : state.exportIssue === "roster" ? "참가자 명단의 전체 범위를 확인할 수 없어" : "일부 참가자의 신청 정보를 확인할 수 없어"} 명단을 내려받을 수 없습니다. 다시 확인해도 계속되면 조직 관리자에게 문의하세요.{" "}
            <ProductButton type="button" className="button button-secondary" disabled={refreshing} onClick={() => void refreshQuietly()}>{refreshing ? "확인 중…" : "다시 확인"}</ProductButton>
          </ConsoleFeedback> : null}
          {unresolvedRosterReceipt ? <ConsoleFeedback kind="warning">이전 참가자 작업의 결과를 위의 처리 결과 확인에서 확인한 뒤 같은 종류의 새 작업을 할 수 있습니다.</ConsoleFeedback> : null}
          {receiptRefreshLock ? <ConsoleFeedback kind="warning">최신 참가자 목록을 불러온 뒤 수정할 수 있습니다. {!receiptRefreshing ? <ProductButton type="button" className="button button-secondary" onClick={() => { setReceiptRefreshing(true); void load(true).then((ok) => { if (ok) setReceiptNeedsRefresh(false); }).finally(() => setReceiptRefreshing(false)); }}>다시 불러오기</ProductButton> : null}</ConsoleFeedback> : null}
          {notice ? (
            <ConsoleFeedback kind="success">
              {notice}
              {approvedHandoffIds && approvedHandoffIds.length ? (
                <>
                  {" "}
                  <ProductLink
                    id="roster-approved-message"
                    className="button button-secondary"
                    href={closeHref(buildApprovedMessageHandoffHref(eventId, approvedHandoffIds))}
                  >
                    승인자 메시지 작성
                  </ProductLink>
                </>
              ) : null}
              {noticeEntry && notice === noticeEntry.notice ? (() => {
                const justAdded = state.people.find((item) => item.id === noticeEntry.id);
                return justAdded ? <EntryNoticeButton person={justAdded} state={entryState(justAdded, entryContext)} entry={entry}
                  locked={receiptRefreshLock || unconfirmedEntry} /> : null;
              })() : null}
            </ConsoleFeedback>
          ) : null}
          {entry.outcome && !(sheetOpen && selectedPerson?.id === entry.outcome.participantId) ? <EntryOutcome entry={entry} /> : null}
          {bulkRetry ? (
            <ConsoleFeedback kind="error" id="roster-bulk-retry-message">
              {bulkRetry.message} 이전 {bulkRetry.attempt.sourceStatus === "WAITLIST" ? "대기자 확정" : "승인"} 요청 {bulkRetry.attempt.ids.length}명
              {bulkRetry.attempt.names.length ? ` (${bulkRetry.attempt.names.slice(0, 3).join(", ")}${bulkRetry.attempt.names.length > 3 ? ` 외 ${bulkRetry.attempt.names.length - 3}명` : ""})` : ""}의 결과가 미확인입니다.
              선택을 바꿔도 이 버튼은 이전 요청을 그대로 확인합니다.{" "}
              <ProductButton type="button" className="button button-secondary" disabled={bulkBusy} onClick={() => void approveSelected(true)}>
                {bulkBusy ? "다시 시도 중…" : "같은 요청으로 다시 시도"}
              </ProductButton>
            </ConsoleFeedback>
          ) : null}
          {groupUncertain && pendingGroupRef.current && !groupDialogOpen ? <ConsoleFeedback kind="warning">
            이전 그룹 지정 {pendingGroupRef.current.ids.length}명의 결과가 미확인입니다.{" "}
            <ProductButton type="button" className="button button-secondary" onClick={() => { if (pendingGroupRef.current) setGroupDraft(pendingGroupRef.current.group); setGroupDialogOpen(true); }}>그룹 지정 다시 확인</ProductButton>
          </ConsoleFeedback> : null}
          {rewardUncertain && pendingRewardRef.current && !rewardTarget ? <ConsoleFeedback kind="warning">
            {pendingRewardRef.current.target.name}님의 경품 등록 결과가 미확인입니다.{" "}
            <ProductButton type="button" className="button button-secondary" onClick={() => { if (pendingRewardRef.current) setRewardTarget(pendingRewardRef.current.target); }}>경품 등록 다시 확인</ProductButton>
          </ConsoleFeedback> : null}
          {failure && !(toolsOpenId && selectedPerson?.id === statusFeedbackId && !rewardTarget && !addOpen && !groupDialogOpen && !editTargetId && !ticketTarget && !reviewedExitTarget) ? (
            <ConsoleFeedback kind="error">
              {failure}{" "}
              {statusRetry ? (
                <ProductButton
                  type="button"
                  className="button button-secondary"
                  disabled={savingId === statusRetry.person.id}
                  onClick={() => void changeStatus(statusRetry.person, statusRetry.status)}
                >
                  {savingId === statusRetry.person.id ? "다시 시도 중…" : "같은 요청으로 다시 시도"}
                </ProductButton>
              ) : null}
            </ConsoleFeedback>
          ) : null}
          {refreshError ? (
            <ConsoleFeedback kind="error">
              {refreshError}{" "}
              <ProductButton type="button" className="button button-secondary" onClick={() => void refreshQuietly()}>
                다시 시도
              </ProductButton>
            </ConsoleFeedback>
          ) : null}
          {!canWriteRoster ? (
            <ConsoleFeedback kind="warning">상태 변경 권한이 없습니다. 변경이 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {canWriteRoster && !canWriteReward && state.rewardFeature && !archived ? (
            <ConsoleFeedback kind="warning">경품 등록은 결과 쓰기 권한이 따로 필요합니다. 명단 변경과는 별개이며, 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {canWriteRoster && archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 변경할 수 없습니다. 목록 확인과 내려받기는 계속할 수 있습니다.</ConsoleFeedback>
          ) : null}
          {canWriteRoster && !archived && participantsLocked ? (
            <ConsoleFeedback kind="warning">종료된 행사는 참가자를 변경할 수 없습니다. 그룹 지정과 목록 내려받기는 계속할 수 있습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <ConsoleSection
        headingId="participants-list-heading"
        title="참가자 목록"
        surface="plain"
        width="full"
        className={styles.rosterSection}
      >
      <div className={styles.rosterTabs}>
      <CountTabs
        className={styles.quickPresets}
        ariaLabel="빠른 상태 보기"
        value={ticketFilter ? null : (rosterPresets.find((preset) => statusFilter === preset.status && attendanceFilter === preset.attendance)
          // An extra 출입 filter on top of a status keeps that status tab lit (the filter button shows the count).
          ?? rosterPresets.find((preset) => statusFilter === preset.status && preset.attendance === ""))?.key ?? null}
        onChange={(key) => { const preset = rosterPresets.find((item) => item.key === key); if (preset) applyRosterPreset(preset); }}
        items={rosterPresets.map((preset) => ({ key: preset.key, label: preset.label, count: preset.count, tone: preset.key === "pending" ? "wait" : "default", srLabel: `${preset.label} · ${preset.count}명` }))}
      />
      {ticketFilter && visiblePeople.some((person) => person.ticketReview === "unknown") ? <ConsoleFeedback kind="warning">일부 티켓의 상태를 불러오지 못해 확인 목록에 함께 표시했습니다. 최신 서버 연결을 확인한 뒤 명단을 새로고침하세요.</ConsoleFeedback> : null}
      <div className={styles.rosterMeta}>
      <p className="participant-count" role="status">
        <span className={styles.metaLong}>
        {statusFilter || groupFilter || attendanceFilter || ticketFilter || search
          ? `${visiblePeople.length}명 / 전체 ${state.people.length}명(취소 포함)`
          : `전체 ${state.people.length}명(취소 포함)`}
        {fetchedAt ? ` · 조회 ${formatClock(fetchedAt)}` : ""}
        {refreshing ? " · 새로고침 중…" : ""}
        </span>
        <span className={styles.metaShort} aria-hidden="true">
          {statusFilter || groupFilter || attendanceFilter || ticketFilter || search
            ? `${visiblePeople.length}명 / 전체 ${state.people.length}명(취소 포함)`
            : `전체 ${state.people.length}명(취소 포함)`}
          {fetchedAt && !refreshing ? ` · 조회 ${formatClock(fetchedAt)}` : ""}
          {refreshing ? " · 갱신 중" : ""}
        </span>
      </p>
      <ConsoleRefreshButton label="새로고침" busy={refreshing} onRefresh={refreshQuietly} />
      {canAssignGroup && visiblePeople.length > pagePeople.length ? (
        <details className={styles.mobileScope}>
          <summary>여러 명 선택</summary>
          <div className={styles.mobileScopeOptions}>
            <ProductButton type="button" className="button button-secondary" onClick={(event) => selectMobileScope("page", event.currentTarget)} aria-describedby="roster-page-position">이 페이지 {pagePeople.length}명 선택</ProductButton>
            <ProductButton type="button" className="button button-secondary" onClick={(event) => selectMobileScope("filter", event.currentTarget)} aria-describedby="roster-select-all-help">필터 결과 전체 {visiblePeople.length}명 선택</ProductButton>
            <p>필터 결과 전체에는 다른 페이지도 포함됩니다. 기존 선택은 유지됩니다.</p>
          </div>
        </details>
      ) : canAssignGroup && visiblePeople.length ? (
        <ProductButton type="button" className={`button button-quiet ${styles.mobileScopeSingle}`} onClick={selectVisible} aria-describedby="roster-select-all-help">전체 {visiblePeople.length}명 선택</ProductButton>
      ) : null}
      <span id="roster-select-all-help" className="sr-only">검색·필터에 맞는 전체를 선택합니다. 기존 선택은 유지됩니다.{visiblePeople.length > pagePeople.length ? " 다른 페이지의 결과도 포함됩니다." : ""}</span>
      </div>
      </div>
      {/* Reopened 2026-11-20: the scope suffix on 그룹 변경·메시지 작성·신청 취소 ("· 현재 필터 N명") is visible text, so it stays in
          the accessible name (WCAG 2.5.3 Label in Name; axe label-content-name-mismatch flagged it while it was aria-hidden). */}
      <div className={styles.selectionWorkbench} aria-label="선택한 참가자 작업">
{            anySelected && canAssignGroup ? (
              <>
                <span role="status" id="roster-selection-count">
                  <span className={styles.selectionHeadline}>선택 {handoffIds.length}명</span>{" "}
                  <span className={hiddenSelectedCount || otherPageSelectedCount ? styles.selectionScope : "sr-only"}>
                  {`현재 필터 ${effectiveSelection.length}명 · 이 페이지 ${pageSelectedCount}명`}
                  {otherPageSelectedCount > 0 ? ` · 다른 페이지 ${otherPageSelectedCount}명` : ""}
                  {hiddenSelectedCount ? ` · 필터 밖 ${hiddenSelectedCount}명` : ""}
                  <span className={hiddenSelectedCount ? styles.selectionPolicy : "sr-only"}>
                    {" · 승인·그룹은 현재 필터만, 메시지는 전체 선택"}
                  </span>
                  </span>
                </span>
                {visiblePeople.length > effectiveSelection.length ? (
                  <ProductButton type="button" variant="ghost" className={styles.selectionScopeAction} onClick={selectVisible} aria-describedby="roster-select-all-help">
                    필터 결과 전체 {visiblePeople.length}명 선택
                  </ProductButton>
                ) : null}
                <div className={styles.selectionActions} data-over-limit={handoffOverLimit ? "true" : undefined}>
                {handoffOverLimit ? <span role="status" id="roster-handoff-limit">
                  선택 {handoffIds.length}명 · 최대 200명까지 전송 가능 · 필터로 대상을 좁히거나 숨김 선택을 제외하세요
                </span> : null}
                {canMutateStatus && (approvalCandidates.length > 0 || waitlistCandidates.length === 0) ? (
                  <ProductButton
                    type="button"
                    id="roster-approve-selected"
                    className="button button-secondary"
                    icon={<CheckIcon />}
                    data-bulk="primary"
                    disabled={bulkBusy || Boolean(bulkRetry) || Boolean(statusRetry) || unconfirmedStatus || !approvalCandidates.length}
                    aria-describedby={bulkRetry ? "roster-bulk-retry-message" : undefined}
                    onClick={() => void approveSelected()}
                  >
                    {bulkBusy && pendingBulkRef.current?.sourceStatus === "PENDING" ? "승인 중입니다" : `신청 승인 ${approvalCandidates.length}`}
                  </ProductButton>
                ) : null}
                {canMutateStatus && waitlistCandidates.length > 0 ? (
                  <ProductButton type="button" id="roster-approve-waitlist" className="button button-secondary" icon={<CheckIcon />} data-bulk="primary"
                    disabled={bulkBusy || Boolean(bulkRetry) || Boolean(statusRetry) || unconfirmedStatus}
                    aria-describedby={bulkRetry ? "roster-bulk-retry-message" : undefined}
                    onClick={() => void approveSelected(false, "WAITLIST")}>
                    {bulkBusy && pendingBulkRef.current?.sourceStatus === "WAITLIST" ? "확정 중입니다" : `대기자 확정 ${waitlistCandidates.length}`}
                  </ProductButton>
                ) : null}
                <ProductButton
                  type="button"
                  className="button button-secondary"
                  aria-describedby="roster-group-scope"
                  icon={<UsersIcon />}
                  disabled={unconfirmedGroup || (!effectiveSelection.length && !pendingGroupRef.current)}
                  onClick={(event) => {
                    closeSelectionMenu(event.currentTarget);
                    if (pendingGroupRef.current?.uncertain) {
                      setGroupDraft(pendingGroupRef.current.group);
                    } else {
                      setGroupError(null);
                      setGroupDraft(state.groups[0] ?? "");
                      groupBaselineRef.current = state.groups[0] ?? "";
                      groupPeopleRef.current = effectiveSelection.flatMap((id) => {
                        const person = state.people.find((item) => item.id === id);
                        return person ? [{ id: person.id, name: person.name, group: person.group, company: person.company, phone: person.phone }] : [];
                      });
                    }
                    setGroupDialogOpen(true);
                  }}
                >
                  그룹 변경 <span>{hiddenSelectedCount ? `· 현재 필터 ${effectiveSelection.length}명` : ""}</span>
                </ProductButton>
                <p className="sr-only" id="roster-group-scope">현재 필터에서 선택한 {effectiveSelection.length}명 대상</p>
                {handoffOverLimit ? (
                  <>
                    <ProductButton
                      type="button"
                      id="roster-exclude-hidden"
                      className={`button button-secondary ${styles.selectionButton}`}
                      onClick={() => setSelectedIds((current) => current.filter((id) => visibleIds.has(id)))}
                    >
                      숨김 제외
                    </ProductButton>
                    <ProductButton
                      type="button"
                      id="roster-send-message"
                      className={`button button-secondary ${styles.selectionButton}`}
                      disabled
                      icon={<MessageIcon />}
                      aria-describedby="roster-message-scope"
                      title="대상이 너무 많습니다. 필터로 대상을 좁혀 주세요"
                    >
                      메시지 작성 <span>{hiddenSelectedCount ? `· 전체 ${handoffIds.length}명` : ""}</span>
                    </ProductButton>
                  </>
                ) : (
                  <ProductLink
                    id="roster-send-message"
                    className={`button button-secondary ${styles.selectionButton}`}
                    aria-describedby="roster-message-scope"
                    href={closeHref(handoffHref)}
                  >
                    <MessageIcon /> 메시지 작성 <span>{hiddenSelectedCount ? `· 전체 ${handoffIds.length}명` : ""}</span>
                  </ProductLink>
                )}
                <p className="sr-only" id="roster-message-scope">필터 밖을 포함한 선택 {handoffIds.length}명 대상{hiddenSelectedCount ? ` · 필터 밖 ${hiddenSelectedCount}명` : ""}</p>
                {canMutateStatus ? <>
                  <ProductButton type="button" className="button button-secondary" aria-describedby="roster-cancel-scope" icon={<XIcon />} data-bulk="danger" disabled={unconfirmedStatus || receiptRefreshLock || bulkBusy || Boolean(bulkRetry) || Boolean(statusRetry) || !cancelCandidates.length || cancelCandidates.length > 1000}
                    onClick={(event) => {
                      closeSelectionMenu(event.currentTarget);
                      setBulkCancelTargets(cancelCandidates.map(({ id, name, status, inside, company, phone }) => ({ id, name, status, inside, company, phone: maskPhone(phone) })));
                    }}>신청 취소 <span>{hiddenSelectedCount ? `· 현재 필터 ${cancelCandidates.length}명` : ""}</span></ProductButton>
                  <p className={cancelCandidates.length > 1000 ? styles.selectionActionHint : "sr-only"} id="roster-cancel-scope">{cancelCandidates.length > 1000 ? "한 번에 1,000명까지 취소할 수 있습니다. 필터로 대상을 나눠 주세요." : `현재 필터에서 선택한 미취소 참가자 ${cancelCandidates.length}명 대상`}</p>
                </> : null}
                <ProductButton type="button" className={`button button-quiet ${styles.selectionButton}`} onClick={() => {
                  setSelectedIds([]);
                  const heading = document.getElementById("participants-list-heading");
                  heading?.setAttribute("tabindex", "-1");
                  heading?.focus({ preventScroll: true });
                }}>
                  {hiddenSelectedCount ? `선택 해제 (숨김 ${hiddenSelectedCount}명 포함)` : "선택 해제"}
                </ProductButton>
                </div>
                {canMutateStatus && approvalConflicts.length ? <p className={styles.selectionNotice} role="status">취소 기록 확인이 필요한 {approvalConflicts.length}명은 승인·확정에서 제외됩니다. 참가자 상세에서 확인하세요.</p> : null}
                {canMutateStatus && approvalReissues.length ? <p className={styles.selectionNotice}>선택한 승인·확정 대상 중 {approvalReissues.length}명은 처리 후에도 새 티켓을 별도로 발급해야 합니다.</p> : null}
              </>
            ) : null}
      </div>
      {importOpen ? <ImportWizard eventId={eventId} knownCompanies={state.people.filter((person) => person.status !== "CANCELLED").map((person) => person.company)} onDismiss={() => setImportOpen(false)} onCommitted={() => void load(true)} /> : null}
      {visiblePeople.length ? (
        <>
          <div className={styles.rosterWorkbench}>
          <div className={styles.rosterMain}>
          <a className="skip-link" href="#roster-next-page" data-skip-to="roster-next-page" onClick={focusRosterPagination}>명단 페이지 이동으로 건너뛰기</a>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="참가자 명단 표">
          <table className={styles.rosterTable}>
            <caption className="sr-only">참가자 목록. 연락처는 마스킹되며, 이름 정렬과 이 페이지 선택을 사용할 수 있습니다.</caption>
            <thead className={styles.rosterHead}>
              <tr>
                {canAssignGroup ? <th scope="col" className={styles.selectColumn}>
                  <label className={styles.participantSelectTarget}>
                    <input type="checkbox" className={styles.participantSelect} aria-label="이 페이지 전체 선택"
                      checked={pagePeople.length > 0 && pageSelectedCount === pagePeople.length}
                      ref={(input) => { if (input) input.indeterminate = pageSelectedCount > 0 && pageSelectedCount < pagePeople.length; }}
                      onChange={(event) => { if (event.target.checked) selectPage(); else setSelectedIds((current) => current.filter((id) => !pageIds.has(id))); }} />
                  </label>
                </th> : null}
                <th scope="col" aria-sort={nameSort === "original" ? undefined : nameSort}>
                  <button type="button" className={styles.sortButton} onClick={() => { setNameSort((current) => current === "ascending" ? "descending" : "ascending"); setPage(1); }}>
                    참가자 <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none"><path d={nameSort === "descending" ? "M8 3v10m-4-4 4 4 4-4" : nameSort === "ascending" ? "M8 13V3m-4 4 4-4 4 4" : "M5.5 6.5L8 4l2.5 2.5M5.5 9.5L8 12l2.5-2.5"} stroke="currentColor" strokeWidth="1.5" /></svg>
                    <span className="sr-only">이름순 정렬</span>
                  </button>
                </th>
                <th scope="col">연락처</th><th scope="col" className={styles.rosterGroup}>그룹</th><th scope="col">신청 상태</th><th scope="col">출입</th>
                {ticketFilter ? <th scope="col">티켓 확인 사유</th> : null}
                {showRowActions ? <th scope="col" className={styles.actionColumn}>작업</th> : null}
              </tr>
            </thead>
            <tbody>
              {pagePeople.map((person) => {
                const detailsOpen = toolsOpenId === person.id;
                return <tr key={person.id} className={styles.rosterRow} data-pending={person.status === "PENDING" ? "true" : undefined} data-selected={effectiveSelection.includes(person.id) ? "true" : undefined} data-inspected={detailsOpen ? "true" : undefined} onClick={(event) => openDetailsFromRow(event, person.id)}>
                  {canAssignGroup ? <td className={styles.selectColumn}><label className={styles.participantSelectTarget}>
                    <input type="checkbox" className={styles.participantSelect} aria-label={`${person.name} 선택`} checked={effectiveSelection.includes(person.id)} onChange={() => togglePerson(person.id)} />
                  </label></td> : null}
                  <td><span className={styles.nameCell}><ConsoleAvatar name={person.name} tone={avatarTone(person.status)} /><span className={styles.tableIdentity}><span className={styles.nameLine}><strong id={`roster-name-desktop-${person.id}`}>{person.name}</strong>{person.erased || emailLooksValid(person.email) ? null : <small className={styles.ticketReviewLabel}>이메일 확인 필요</small>}</span><small>{person.company || "소속 미입력"}</small></span></span></td>
                  <td className={styles.rosterContact}>{maskPhone(person.phone)}</td><td className={styles.rosterGroup}>{person.group || "미지정"}</td>
                  <td><StatusPill className={styles.participantStatus} tone={statusTone(person.status)}>{statusLabel(person.status)}</StatusPill>{["PENDING", "WAITLIST"].includes(person.status) && person.ticketReview === "cancelled" ? <small className={styles.ticketReviewLabel}>취소 상태 확인 필요</small> : null}{["PENDING", "WAITLIST"].includes(person.status) && person.ticketNeedsExplicitReissue ? <small className={styles.ticketReviewLabel}>승인 후 티켓 재발급 필요</small> : null}</td>
                  <td><span className={person.inside ? styles.presenceInside : styles.presence}>{presenceLabel(person)}</span></td>
                  {ticketFilter ? <td><span className={styles.ticketReviewLabel}>{ticketReviewLabel(person.ticketReview)}</span></td> : null}
                  {showRowActions ? <td className={styles.actionColumn}><div className={styles.participantActions}>
                    {["PENDING", "WAITLIST"].includes(person.status) && person.ticketReview !== "cancelled" && canMutateStatus ? <ProductButton type="button" className="button button-secondary" aria-describedby={`roster-name-desktop-${person.id}`} disabled={savingId === person.id} onClick={() => changeStatus(person, "APPROVED")}>
                      {savingId === person.id ? (person.status === "WAITLIST" ? "확정 중…" : "승인 중…") : (person.status === "WAITLIST" ? "확정" : "승인")}
                    </ProductButton> : null}
                    <ProductButton type="button" className={`button button-quiet ${styles.rowToolsToggle}`} aria-expanded={detailsOpen} aria-haspopup="dialog"
                      aria-label={`${person.name} 참가자 상세`} data-roster-detail={person.id} onClick={(event) => { inspectorReturnFocusRef.current = event.currentTarget; setToolsOpenId(person.id); }}><ChevronRightIcon /></ProductButton>
                  </div></td> : null}
                </tr>;
              })}
            </tbody>
          </table>
          </div>
          <ul className={styles.participantList}>
            {pagePeople.map((person) => {
              const detailsOpen = toolsOpenId === person.id;
              const detailsId = `participant-details-${person.id}`;
              return (
                <li
                  className={rowClass}
                  data-pending={person.status === "PENDING" ? "true" : undefined}
                  data-selected={effectiveSelection.includes(person.id) ? "true" : undefined}
                  data-inspected={detailsOpen ? "true" : undefined}
                  key={person.id}
                  onClick={(event) => openDetailsFromRow(event, person.id)}
                >
                  {canAssignGroup ? (
                    <label className={styles.participantSelectTarget}>
                      <input
                        type="checkbox"
                        className={styles.participantSelect}
                        aria-label={`${person.name} 선택`}
                        checked={effectiveSelection.includes(person.id)}
                        onChange={() => togglePerson(person.id)}
                      />
                    </label>
                  ) : null}
                  <span className={styles.participantSummary}>
                    <span className={styles.nameLine}>
                      <strong className={styles.participantName} id={`roster-name-mobile-${person.id}`}>{person.name}</strong>
                      {person.erased || emailLooksValid(person.email) ? null : <small className={styles.ticketReviewLabel}>이메일 확인 필요</small>}
                    </span>
                    <small className={styles.participantIdentity}>{[identityOrg(person), presenceLabel(person)].filter(Boolean).join(" · ")}</small>
                    {ticketFilter || (["PENDING", "WAITLIST"].includes(person.status) && person.ticketReview === "cancelled") ? <small className={styles.ticketReviewLabel}>{ticketReviewLabel(person.ticketReview)}</small> : null}
                    {["PENDING", "WAITLIST"].includes(person.status) && person.ticketNeedsExplicitReissue ? <small className={styles.ticketReviewLabel}>승인 후 티켓 재발급 필요</small> : null}
                  </span>
                  <span className={styles.rosterContact}>{maskPhone(person.phone)}</span>
                  <StatusPill className={styles.participantStatus} tone={statusTone(person.status)}>{statusLabel(person.status)}</StatusPill>
                  {showRowActions ? (
                    <div className={styles.participantActions}>
                      {/* One always-visible primary per row: PENDING and
                          WAITLIST can be confirmed directly; other changes
                          use the details below,
                          which keep the full participant.status change
                          (including cancel with its confirm) under the same
                          ENDED/ARCHIVED gates. */}
                      {["PENDING", "WAITLIST"].includes(person.status) && person.ticketReview !== "cancelled" && canMutateStatus ? (
                        <ProductButton
                          type="button"
                          className="button button-secondary"
                          aria-describedby={`roster-name-mobile-${person.id}`}
                          disabled={savingId === person.id}
                          onClick={() => changeStatus(person, "APPROVED")}
                        >
                          {savingId === person.id ? (person.status === "WAITLIST" ? "확정 중…" : "승인 중…") : (person.status === "WAITLIST" ? "확정" : "승인")}
                        </ProductButton>
                      ) : null}
                      <ProductButton
                        type="button"
                        className={`button button-quiet ${styles.rowToolsToggle}`}
                        aria-expanded={detailsOpen}
                        aria-haspopup="dialog"
                        aria-controls={detailsOpen ? detailsId : undefined}
                        aria-label={`${person.name} 참가자 상세`}
                        data-roster-detail={person.id}
                        onClick={(event) => {
                          if (detailsOpen) {
                            closeInspector();
                            return;
                          }
                          inspectorReturnFocusRef.current = event.currentTarget;
                          setToolsOpenId(person.id);
                        }}
                      >
                        <ChevronRightIcon />
                      </ProductButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          </div>
          {sheetOpen && selectedPerson ? (
            <ConsoleDialog presentation="drawer" title={selectedPerson.name} titleId={`participant-details-${selectedPerson.id}`}
              description={[identityOrg(selectedPerson), maskPhone(selectedPerson.phone)].filter(Boolean).join(" · ")}
              initialFocusRef={sheetNavFocusRef.current ? sheetNavFocusRef : inspectorHeadingRef} busy={savingId === selectedPerson.id || entry.busy} onClose={closeInspector}
              footer={<ProductButton type="button" className="button button-secondary" disabled={savingId === selectedPerson.id || entry.busy} onClick={closeInspector}>닫기</ProductButton>}>
              <div className={styles.rosterSheet} onKeyDown={sheetArrowKeys}>
                <>
                  <div className={styles.sheetNav}>
                    <ProductButton type="button" variant="ghost" className={styles.sheetStep} aria-label="이전 참가자" icon={<ChevronRightIcon className={styles.chevronBack} />}
                      disabled={sheetIndex < 1 || savingId === selectedPerson.id} onClick={(event) => stepSheet(-1, event.currentTarget)}>이전</ProductButton>
                    <span role="status" className={styles.sheetPosition}>{sheetIndex >= 0 ? `${sheetIndex + 1} / ${orderedPeople.length}` : "목록 밖"}</span>
                    <ProductButton type="button" variant="ghost" className={styles.sheetStep} aria-label="다음 참가자"
                      disabled={sheetIndex < 0 || sheetIndex >= orderedPeople.length - 1 || savingId === selectedPerson.id} endContent={<ChevronRightIcon />} onClick={(event) => stepSheet(1, event.currentTarget)}>다음</ProductButton>
                  </div>
                  <ConsoleAvatar className={styles.sheetAvatar} name={selectedPerson.name} tone={avatarTone(selectedPerson.status)} size="lg" />
                  <p className={styles.sheetBadges}>
                    <StatusPill className={styles.participantStatus} tone={statusTone(selectedPerson.status)}>{statusLabel(selectedPerson.status)}</StatusPill>
                    <span className={selectedPerson.inside ? styles.presenceInside : styles.presence}>{presenceLabel(selectedPerson)}</span>
                  </p>
                  {["PENDING", "WAITLIST"].includes(selectedPerson.status) && selectedPerson.ticketReview !== "cancelled" && canMutateStatus ? (
                    <ProductButton type="button" variant="primary" className={styles.sheetPrimary} disabled={savingId === selectedPerson.id}
                      onClick={() => void changeStatus(selectedPerson, "APPROVED")}>
                      {savingId === selectedPerson.id ? (selectedPerson.status === "WAITLIST" ? "확정 중…" : "승인 중…") : (selectedPerson.status === "WAITLIST" ? "참가 확정" : "참가 승인")}
                    </ProductButton>
                  ) : null}
                  <EntrySheetBlock person={selectedPerson} state={entryState(selectedPerson, entryContext)} entry={entry} eventId={eventId}
                    locked={receiptRefreshLock || unconfirmedEntry || savingId === selectedPerson.id} />
                  <div className={styles.participantDetails}>
                    <section className={styles.sheetSection} aria-label="연락처와 이메일">
                      <h3 ref={inspectorHeadingRef} tabIndex={-1}>신청 정보</h3>
                      <dl className={styles.sheetFacts}>
                        <div><dt>연락처</dt><dd>{maskPhone(selectedPerson.phone)}</dd></div>
                        <div>
                          <dt>이메일</dt>
                          <dd>
                            {selectedPerson.email.trim() || "미입력"}
                            {selectedPerson.email.trim() && !emailLooksValid(selectedPerson.email) ? <span className={styles.sheetFlag}>형식 확인 필요</span> : null}
                          </dd>
                        </div>
                        <div><dt>그룹</dt><dd>{selectedPerson.group || "미지정"}</dd></div>
                      </dl>
                    </section>
                    <section className={styles.sheetSection} aria-label="출입">
                      <h4>출입</h4>
                      <p className={styles.sheetPresence}>{presenceSentence(selectedPerson)}</p>
                    </section>
                    {selectedPerson.ticketReview !== "valid" && (selectedPerson.ticketReview !== "cancelled" || selectedPerson.status.toUpperCase() !== "CANCELLED") ? <p role="note" id={`ticket-state-note-${selectedPerson.id}`}>
                      {selectedPerson.ticketReview === "expired" ? "티켓이 만료됐습니다." : selectedPerson.ticketReview === "revoked" ? "티켓이 철회됐습니다." : selectedPerson.ticketReview === "cancelled" ? "신청 상태와 취소 기록이 일치하지 않습니다." : "티켓 상태를 확인할 수 없습니다."}
                      {selectedPerson.ticketReview === "unknown" ? " 최신 목록을 새로고침한 뒤 다시 확인하세요." : selectedPerson.ticketReview === "cancelled" ? selectedPerson.cancellationConflictReview && canResolveCancellationConflict && !participantsLocked ? " 참가자의 의사를 확인한 뒤 아래에서 기록을 검토하세요." : " 행사 담당자나 조직 관리자에게 확인하세요." : canReissueTicket && !participantsLocked ? " 필요하면 아래 티켓 재발급을 이용하세요." : " 행사 담당자에게 확인하세요."}
                    </p> : null}
                    <section className={styles.consentRecord} aria-label="정보 수집 동의 기록">
                      <h4>정보 수집 동의</h4>
                      {selectedPerson.consent ? <>
                        <p>{selectedPerson.consent.version !== null ? `버전 ${selectedPerson.consent.version}` : "버전 확인 불가"} · {consentTime(selectedPerson.consent.at)}</p>
                        {selectedPerson.consent.noticeText !== null ? (
                          <details className={styles.nametagDisclosure}>
                            <summary>동의한 안내 보기</summary>
                            <p className={styles.consentNotice}>{selectedPerson.consent.noticeText}</p>
                          </details>
                        ) : <p>당시 동의 안내 원문은 확인할 수 없습니다.</p>}
                      </> : <p>동의 기록이 없습니다.</p>}
                    </section>
                    {selectedPerson.status === "APPROVED" && (canMutateStatus || (canEditParticipant && !participantsLocked)) ? (
                      <RosterNameTag key={selectedPerson.id} eventId={eventId} person={selectedPerson} eventName={state.eventName} />
                    ) : null}
                    {unresolvedRosterReceipt || receiptRefreshLock ? (
                      <p role="note">이전 작업의 처리 결과를 확인하는 중이라 일부 작업이 잠겨 있습니다. 시트를 닫고 명단 위 안내에서 확인한 뒤 다시 시도하세요.</p>
                    ) : null}
                    {selectedPerson.erased ? <p role="note">개인정보가 삭제된 참가자입니다. 이름·연락처·신청 답변은 남아 있지 않고 티켓은 쓸 수 없습니다.</p> : <div className={styles.detailActions}>
                      {canReviewExit && selectedPerson.attendanceReview ? <ProductButton type="button" className="button button-secondary" disabled={unconfirmedExit || unconfirmedReconciliation || receiptRefreshLock}
                        onClick={() => setReconcileTarget(selectedPerson.id)}>출입 상태 확인</ProductButton> : null}
                      {canReviewExit && selectedPerson.inside ? <ProductButton type="button" className="button button-secondary" disabled={unconfirmedExit || unconfirmedReconciliation || receiptRefreshLock}
                        onClick={() => setReviewedExitTarget(selectedPerson.id)}>확인 후 퇴장 기록</ProductButton> : null}
                      {canEditParticipant && !participantsLocked ? <ProductButton type="button" className="button button-secondary" disabled={unconfirmedUpdate || receiptRefreshLock} onClick={() => setEditTargetId(selectedPerson.id)}>신청 정보 수정</ProductButton> : null}
                      {canResolveCancellationConflict && !participantsLocked && selectedPerson.cancellationConflictReview && selectedPerson.ticketReview === "cancelled" && selectedPerson.status !== "CANCELLED" ? <ProductButton type="button" className="button button-secondary" disabled={unconfirmedCancellationConflict || receiptRefreshLock} onClick={() => setCancellationConflictTarget(selectedPerson.id)}>참가 취소 기록 확인</ProductButton> : null}
                      {canReissueTicket && !participantsLocked && selectedPerson.status !== "CANCELLED" && state.eventSlug ? (
                        <ProductButton type="button" className="button button-secondary" disabled={unconfirmedTicket || receiptRefreshLock || selectedPerson.ticketReview === "unknown" || selectedPerson.ticketReview === "cancelled"} aria-describedby={selectedPerson.ticketReview === "unknown" || selectedPerson.ticketReview === "cancelled" ? `ticket-state-note-${selectedPerson.id}` : undefined} onClick={() => {
                          if (!writeBusyRef.current) setTicketTarget({
                            id: selectedPerson.id,
                            name: selectedPerson.name,
                            ticketRevision: selectedPerson.ticketRevision,
                            company: selectedPerson.company,
                            maskedPhone: maskPhone(selectedPerson.phone),
                          });
                        }}>티켓 재발급</ProductButton>
                      ) : null}
                      {canMutateStatus ? (
                        <ProductButton
                          type="button"
                          className="button button-secondary"
                          onClick={() => reuseForNewRegistration(selectedPerson)}
                        >
                          이 정보로 새 참가자 등록
                        </ProductButton>
                      ) : null}
                      {selectedPerson.status === "APPROVED" && state.rewardFeature && canRewardHere ? (
                        <ProductButton
                          type="button"
                          className="button button-secondary"
                          disabled={unconfirmedReward}
                          onClick={() => {
                            if (pendingRewardRef.current?.uncertain) {
                              const pending = pendingRewardRef.current;
                              setRewardTarget(pending.target);
                              setRewardError({ field: null, message: "이전 경품 등록 결과를 먼저 확인하세요." });
                              return;
                            }
                            setRewardError(null);
                            if (rewardDraftOwnerRef.current !== selectedPerson.id) {
                              setRewardDraft({ name: "", method: "ONSITE" });
                            }
                            rewardDraftOwnerRef.current = selectedPerson.id;
                            setRewardTarget(selectedPerson);
                          }}
                        >
                          경품 등록
                        </ProductButton>
                      ) : null}
                      {canMutateStatus ? (
                        <select
                          ref={inspectorStatusRef}
                          key={`${selectedPerson.id}-${cancelConfirm?.id === selectedPerson.id ? "pending" : "idle"}`}
                          aria-label={`${selectedPerson.name} 상태 변경`}
                          aria-describedby={failure && selectedPerson.id === statusFeedbackId ? "roster-inspector-status-error" : undefined}
                          value={isKnownStatus(selectedPerson.status) ? selectedPerson.status : ""}
                          disabled={savingId === selectedPerson.id}
                          onChange={(event) => void changeStatus(selectedPerson, event.target.value)}
                        >
                          {!isKnownStatus(selectedPerson.status) ? (
                            <option value="" disabled>상태 확인 필요</option>
                          ) : null}
                          {STATUSES.map((status) => (
                            <option key={status} value={status} disabled={selectedPerson.ticketReview === "cancelled" && selectedPerson.status !== "CANCELLED" && status !== "CANCELLED" && status !== selectedPerson.status}>
                              {statusLabel(status)}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>}
                    {failure && selectedPerson.id === statusFeedbackId ? (
                      <ConsoleFeedback kind="error" id="roster-inspector-status-error">
                        {failure}{" "}
                        {statusRetry ? (
                          <ProductButton type="button" className="button button-secondary" disabled={savingId === statusRetry.person.id}
                            onClick={() => void changeStatus(statusRetry.person, statusRetry.status)}>
                            {savingId === statusRetry.person.id ? "다시 시도 중…" : "같은 요청으로 다시 시도"}
                          </ProductButton>
                        ) : null}
                      </ConsoleFeedback>
                    ) : selectedPerson.presenceUnknown && canMutateStatus ? (
                      <p role="note">출입 기록을 확인할 수 없습니다. 현장 기록을 확인해 주세요.</p>
                    ) : selectedPerson.inside && canMutateStatus ? (
                      <p role="note">입장 중에는 승인 대기·대기 명단 변경이나 신청 취소 전에 퇴장 처리해 주세요.</p>
                    ) : null}
                    {selectedPerson.attendanceReview && !selectedPerson.presenceUnknown ? (
                      <p role="note">현재 입장 상태와 누적 입장 기록을 함께 확인해 주세요.</p>
                    ) : null}
                  </div>
                  {cancelConfirm?.id === selectedPerson.id ? (
                    <div className={styles.rowConfirm} id="roster-cancel-confirm">
                      <ConsoleConfirm
                        summary={`${cancelConfirm.name}님의 신청을 취소하면 발급된 티켓은 무효화됩니다. ${selectedPerson.ticketReview === "cancelled" ? "취소 기록을 확인하기 전에는 다시 승인할 수 없습니다." : "되돌리려면 다시 승인해야 합니다."}`}
                        confirmLabel="신청 취소하기"
                        cancelLabel="돌아가기"
                        busy={savingId === selectedPerson.id}
                        onConfirm={() => {
                          const target = selectedPerson;
                          setCancelConfirm(null);
                          void applyStatus(target, "CANCELLED");
                        }}
                        onCancel={() => {
                          setCancelConfirm(null);
                          window.requestAnimationFrame(() => {
                            const status = inspectorStatusRef.current;
                            if (status?.isConnected && !status.disabled) status.focus({ preventScroll: true });
                            else inspectorHeadingRef.current?.focus({ preventScroll: true });
                          });
                        }}
                      />
                    </div>
                  ) : null}
                  {canEraseParticipant && !selectedPerson.erased ? (
                    <section className={styles.eraseZone} aria-label="개인정보 삭제">
                      <h4>개인정보 삭제</h4>
                      <p>참가자가 삭제를 요청했을 때만 사용하세요. 이름·연락처·신청 답변이 지워지며 되돌릴 수 없습니다.</p>
                      <ProductButton type="button" variant="destructive" disabled={unresolvedRosterReceipt || receiptRefreshLock}
                        onClick={() => setEraseTarget({ id: selectedPerson.id, name: selectedPerson.name })}>개인정보 삭제…</ProductButton>
                    </section>
                  ) : null}
                </>
              </div>
            </ConsoleDialog>
          ) : null}
          </div>
          <nav aria-label="참가자 목록 페이지" className={styles.paginationBar}>
              <span role="status" id="roster-page-position" className={styles.paginationPosition}>
                {pageStart}–{pageEnd} / {visiblePeople.length}명 · {safePage} / {totalPages} 페이지
                {pageSelectedCount > 0 ? ` · 이 페이지 ${pageSelectedCount}명 선택` : ""}
              </span>
              <span className={styles.paginationActions}>
                <ProductButton
                  type="button"
                  id="roster-previous-page"
                  variant="ghost"
                  className={styles.selectionButton}
                  disabled={safePage <= 1}
                  onClick={() => showRosterPage(safePage - 1)}
                >
                  이전
                </ProductButton>
                <ProductButton
                  type="button"
                  id="roster-next-page"
                  variant="ghost"
                  className={styles.selectionButton}
                  disabled={safePage >= totalPages}
                  onClick={() => showRosterPage(safePage + 1)}
                >
                  다음
                </ProductButton>
                <ProductButton
                  type="button"
                  variant="ghost"
                  className={styles.selectionButton}
                  onClick={focusRosterSearch}
                >
                  검색으로 이동
                </ProductButton>
              </span>
            </nav>
        </>
      ) : state.people.length ? (
        <ConsoleEmptyState
          kind="filtered"
          titleAs="h3"
          icon={isAttendanceReviewOnly ? <CheckIcon /> : undefined}
          title={isAttendanceReviewOnly ? "확인이 필요한 출입 기록이 없습니다." : "조건에 맞는 참가자가 없습니다."}
          description={isAttendanceReviewOnly ? "취소된 신청을 제외한 참가자에게 확인할 출입 기록이 없습니다." : "검색어·상태·그룹·출입 조건에 맞는 사람이 없습니다. 조건을 하나씩 지워보세요."}
          action={hasAnyFilter ? (
            <ProductButton type="button" className="button button-secondary" onClick={() => { clearRosterFilters(); window.requestAnimationFrame(() => document.getElementById("roster-search")?.focus({ preventScroll: true })); }}>
              {isAttendanceReviewOnly ? "전체 참가자 보기" : "검색·필터 초기화"}
            </ProductButton>
          ) : undefined}
        />
      ) : (
        <ConsoleEmptyState
          titleAs="h3"
          title="아직 등록된 참가자가 없습니다."
          description={state.intakeOpen
            ? "명단 가져오기로 여러 명을 한 번에 등록하거나, 참가 신청 링크를 보내 참가자가 직접 신청하게 하세요."
            : "명단 가져오기로 여러 명을 한 번에 등록하거나, 한 명씩 추가하세요. 참가자가 직접 신청하게 하려면 행사 설정에서 접수를 열어야 합니다."}
          action={canMutateStatus ? (
            <span className={styles.emptyActions}>
              <ProductButton type="button" variant="secondary" onClick={() => setImportOpen(true)} icon={<UploadIcon />}>
                명단 가져오기
              </ProductButton>
              <ProductButton type="button" variant="ghost" onClick={() => { setAddError(addUnconfirmed ? { message: "등록 결과가 확인되지 않았습니다. 같은 요청으로 다시 확인하세요.", field: null } : null); setAddOpen(true); }} icon={<PlusIcon />} disabled={unconfirmedAdd}>
                한 명 추가
              </ProductButton>
              {state.intakeOpen
                ? <ProductButton type="button" variant="ghost" onClick={copyRegistrationLink} icon={<CopyIcon />}>참가 신청 링크 복사</ProductButton>
                : <small className={styles.emptyNote}>접수를 열면 참가 신청 링크를 쓸 수 있어요.</small>}
            </span>
          ) : undefined}
        />
      )}
      {editTargetId ? <ParticipantEditor key={`${eventId}-${editTargetId}`} eventId={eventId} participantId={editTargetId} companyCounts={companyCounts} onClose={() => { setEditTargetId(null); window.requestAnimationFrame(() => inspectorHeadingRef.current?.focus({ preventScroll: true })); }} onRefresh={() => load(true)} /> : null}
      {reviewedExitTarget ? <ReviewedExit key={`${eventId}-${reviewedExitTarget}`} eventId={eventId} participantId={reviewedExitTarget}
        onRefresh={() => load(true)} onClose={() => { setReviewedExitTarget(null); window.requestAnimationFrame(() => inspectorHeadingRef.current?.focus({ preventScroll: true })); }}
        onDone={() => { setReviewedExitTarget(null); setFailure(null); setNotice("퇴장 기록을 저장했습니다. 최신 출입 상태를 확인하세요."); window.requestAnimationFrame(() => inspectorHeadingRef.current?.focus({ preventScroll: true })); }} /> : null}
      {reconcileTarget ? <ReviewedExit key={`${eventId}-reconcile-${reconcileTarget}`} eventId={eventId} participantId={reconcileTarget} mode="reconcile"
        onRefresh={() => load(true)} onClose={() => { setReconcileTarget(null); window.requestAnimationFrame(() => inspectorHeadingRef.current?.focus({ preventScroll: true })); }}
        onDone={() => { setReconcileTarget(null); setFailure(null); setNotice(`${selectedPerson?.name ? `${selectedPerson.name}님` : "참가자"}의 출입 상태를 복구했습니다. 최신 명단을 확인하세요.`); closeInspector(); }} /> : null}
      {cancellationConflictTarget ? <CancellationConflictReview key={`${eventId}-cancellation-${cancellationConflictTarget}`} eventId={eventId} participantId={cancellationConflictTarget}
        onRefresh={() => load(true)} onClose={() => { setCancellationConflictTarget(null); window.requestAnimationFrame(() => inspectorHeadingRef.current?.focus({ preventScroll: true })); }}
        onDone={() => { setCancellationConflictTarget(null); setFailure(null); setNotice("참가 취소 기록 확인을 저장했습니다. 기존 티켓은 무효 상태입니다. 필요하면 새 티켓을 발급해 전달하세요."); }} /> : null}
      {eraseTarget ? <PersonErase key={`${eventId}-erase-${eraseTarget.id}`} eventId={eventId} person={eraseTarget}
        onRefresh={() => load(true)} onClose={() => { setEraseTarget(null); window.requestAnimationFrame(() => inspectorHeadingRef.current?.focus({ preventScroll: true })); }}
        onDone={(name) => { setEraseTarget(null); setFailure(null); setNotice(`${name}님의 개인정보를 삭제했습니다. 명단에는 ‘삭제된 참가자’로 남습니다.`); closeInspector(); }} /> : null}
      {ticketTarget ? <TicketReissue key={`${eventId}-${ticketTarget.id}`} eventId={eventId} slug={state.eventSlug} eventName={state.eventName} person={ticketTarget}
        onRefresh={() => load(true)} onClose={() => setTicketTarget(null)}
        onIssued={(ticketRevision) => setState((current) => current.kind === "ready" ? {
          ...current,
          people: current.people.map((person) => person.id === ticketTarget.id && person.ticketRevision < ticketRevision
            ? { ...person, ticketRevision } : person),
        } : current)} /> : null}
      {bulkCancelTargets ? <BulkCancelDialog key={`${eventId}-cancel`} eventId={eventId} targets={bulkCancelTargets} onClose={() => setBulkCancelTargets(null)} onRefresh={() => load(true)} onResolved={(ids) => {
        setSelectedIds((current) => current.filter((id) => !ids.includes(id))); setBulkCancelTargets(null); setNotice(`${ids.length}명의 신청 취소를 확인했습니다.`);
      }} /> : null}
      {addOpen ? (
        <ConsoleDialog
          title="참가자 추가"
          description={reuseFrom ? `${reuseFrom}님의 이름·소속을 가져왔습니다. 연락처를 입력하세요. 다른 정보는 복사되지 않습니다.` : "한 명을 바로 등록합니다. 여러 명은 파일로 등록하세요."}
          onClose={() => { if (!addBusy) { setAddOpen(false); setAddError(null); setReuseFrom(null); } }}
          busy={addBusy}
          canClose={() => !addBusy}
          footer={
            <ConsoleFormActions>
              <ProductButton type="button" className="button button-secondary" disabled={addBusy} onClick={() => { setAddOpen(false); setAddError(null); setReuseFrom(null); }}>
                {addUnconfirmed ? "닫기" : "취소"}
              </ProductButton>
              <ProductButton type="submit" form="participant-add-form" className="button button-primary" disabled={addBusy || !addDraft.name.trim() || !addDraft.phone.trim()}>
                {addBusy ? "등록 중입니다" : addUnconfirmed ? "등록 결과 다시 확인" : "등록"}
              </ProductButton>
            </ConsoleFormActions>
          }
        >
          <ValidatedForm id="participant-add-form" className={uiStyles.formStack} onSubmit={(event) => { event.preventDefault(); void createParticipant(); }}>
            <fieldset className={`${uiStyles.formStack} ${styles.addFields}`} disabled={addBusy || addUnconfirmed}>
            <legend className="sr-only">참가자 정보</legend>
            <div>
              <label htmlFor="participant-add-name">이름</label>
              <input
                id="participant-add-name"
                type="text"
                maxLength={60}
                value={addDraft.name}
                aria-invalid={addError?.field === "name" || undefined}
                onChange={(event) => setAddDraft({ ...addDraft, name: event.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="participant-add-phone">연락처</label>
              <input
                id="participant-add-phone"
                type="tel"
                inputMode="numeric"
                maxLength={20}
                value={addDraft.phone}
                aria-invalid={addError?.field === "phone" || undefined}
                onChange={(event) => setAddDraft({ ...addDraft, phone: event.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="participant-add-company">소속 (선택)</label>
              <CompanyField id="participant-add-company" value={addDraft.company} counts={companyCounts}
                onChange={(company) => setAddDraft({ ...addDraft, company })} />
            </div>
            <div>
              <label htmlFor="participant-add-email">이메일 (선택)</label>
              <input
                id="participant-add-email"
                type="email"
                maxLength={120}
                value={addDraft.email}
                onChange={(event) => setAddDraft({ ...addDraft, email: event.target.value })}
              />
            </div>
            <ConsoleChoiceGroup id="participant-add-type" label="등록 방식" value={addDraft.registrationType}
              onChange={(value) => setAddDraft({ ...addDraft, registrationType: value })}
              options={[{ value: "ONSITE", label: "현장 등록" }, { value: "PRE", label: "사전 등록" }]}
              hint="사전 등록은 이름이 이미 정해진 명단, 현장 등록은 당일 현장에서 추가하는 참가자입니다." />
            </fieldset>
            {!addDraft.name.trim() || !addDraft.phone.trim() ? (
              <p className={styles.addHint} role="status">{!addDraft.name.trim() ? "이름을 입력하면 등록할 수 있어요." : "연락처를 입력하면 등록할 수 있어요."}</p>
            ) : null}
            {addError ? <ConsoleFeedback kind="error">{addError.message}{existingForAdd ? <>{" "}이미 등록된 사람은 {existingForAdd.name} ({maskPhone(existingForAdd.phone)})입니다.{" "}
              <ProductButton type="button" variant="ghost" onClick={() => { setAddOpen(false); setAddError(null); setReuseFrom(null); inspectorReturnFocusRef.current = null; setToolsOpenId(existingForAdd.id); }}>보기</ProductButton></> : null}</ConsoleFeedback> : null}
          </ValidatedForm>
        </ConsoleDialog>
      ) : null}
      {groupDialogOpen ? (
        <ConsoleDialog
          title="그룹 지정"
          description={groupUncertain && pendingGroupRef.current
            ? `이전 요청의 ${pendingGroupRef.current.ids.length}명${pendingGroupRef.current.names.filter(Boolean).length ? ` (${pendingGroupRef.current.names.filter(Boolean).slice(0, 3).join(", ")}${pendingGroupRef.current.ids.length > 3 ? " 외" : ""})` : ""}을 ${pendingGroupRef.current.group} 그룹으로 지정한 결과를 확인합니다. 현재 선택과는 별개입니다.`
            : `필터 범위에서 선택한 ${groupPeopleRef.current?.length ?? effectiveSelection.length}명의 그룹을 바꿉니다.${
            otherPageSelectedCount > 0 ? ` 다른 페이지에서 선택한 ${otherPageSelectedCount}명을 포함합니다.` : ""
          }${
            hiddenSelectedCount ? ` 화면 밖에서 선택한 ${hiddenSelectedCount}명은 이번 지정에 포함되지 않습니다.` : ""
          }`}
          onClose={closeGroupDialog}
          busy={groupBusy}
          canClose={canCloseGroupDialog}
          footer={
            <ConsoleFormActions>
              <ProductButton type="button" className="button button-secondary" disabled={groupBusy} onClick={() => { if (canCloseGroupDialog()) closeGroupDialog(); }}>
                {groupUncertain ? "닫기" : "취소"}
              </ProductButton>
              <ProductButton type="submit" form="group-assign-form" className="button button-primary" disabled={groupBusy || Boolean(groupConflict) || !groupDraft}>
                {groupBusy ? "지정 중…" : groupUncertain ? "같은 요청 다시 시도" : "지정"}
              </ProductButton>
            </ConsoleFormActions>
          }
        >
          <ValidatedForm id="group-assign-form" className={uiStyles.formStack} onSubmit={(event) => void assignGroup(event)}>
            {groupConflict ? <section className={styles.groupConflict} aria-labelledby="group-conflict-heading">
              <h3 id="group-conflict-heading" tabIndex={-1}>선택한 참가자의 그룹이 변경됐습니다</h3>
              <p>이번 지정은 반영되지 않았습니다. 선택한 참가자와 지정할 그룹은 그대로 있습니다. 최신 명단을 확인해 주세요.</p>
              {groupConflict.error ? <p role="alert">{groupConflict.error}</p> : null}
              {groupConflict.latest ? <>
                <p>변경된 참가자 {groupConflict.latest.filter((person, index) => person.group !== groupConflict.before[index].group).length}명</p>
                <ul className={styles.groupConflictList}>
                  {groupConflict.latest.map((person, index) => person.group !== groupConflict.before[index].group
                    ? <li key={person.id}><strong>{person.name || "이름 확인 필요"}</strong> · {person.company || "소속 없음"} · {maskPhone(person.phone)}<br />{groupConflict.before[index].group} → {person.group}</li> : null)}
                </ul>
                <p>기존에 선택한 {groupConflict.latest.length}명을 유지합니다. 확인만으로 지정되지 않습니다.</p>
                <ProductButton type="button" className="button button-secondary" onClick={acceptLatestGroups}>최신 명단으로 다시 검토</ProductButton>
              </> : <ProductButton type="button" className="button button-secondary" disabled={groupConflict.loading || groupBusy} onClick={() => void readLatestGroupPeople()}>{groupConflict.loading ? "최신 명단 확인 중…" : "최신 명단 확인"}</ProductButton>}
            </section> : null}
            <div>
              <label htmlFor="group-pick">그룹</label>
              <select
                id="group-pick"
                required
                value={groupDraft}
                disabled={groupBusy || groupUncertain || Boolean(groupConflict)}
                onChange={(event) => {
                  setGroupDraft(event.target.value);
                }}
              >
                <option value="">선택하세요</option>
                {state.groups.map((group) => (
                  <option key={group} value={group}>{group}</option>
                ))}
              </select>
            </div>
            {groupError ? <ConsoleFeedback kind="error">{groupError}</ConsoleFeedback> : null}
          </ValidatedForm>
        </ConsoleDialog>
      ) : null}
      {rewardTarget ? (
        <ConsoleDialog
          title={`경품 등록 · ${rewardTarget.name}`}
          onClose={closeRewardDialog}
          busy={rewardBusy}
          canClose={canCloseRewardDialog}
          footer={
            <ConsoleFormActions>
              <ProductButton type="button" className="button button-secondary" disabled={rewardBusy} onClick={() => { if (canCloseRewardDialog()) closeRewardDialog(); }}>
                {rewardUncertain ? "닫기" : "취소"}
              </ProductButton>
              <ProductButton type="submit" form="reward-create-form" className="button button-primary" disabled={rewardBusy || !rewardDraft.name.trim()}>
                {rewardBusy ? "등록 중…" : rewardUncertain ? "같은 요청 다시 시도" : "등록"}
              </ProductButton>
            </ConsoleFormActions>
          }
        >
          <ValidatedForm id="reward-create-form" className={uiStyles.formStack} onSubmit={(event) => void createReward(event)}>
            <div>
              <label htmlFor="reward-name">경품명 (필수)</label>
              <input
                id="reward-name"
                type="text"
                maxLength={80}
                required
                value={rewardDraft.name}
                readOnly={rewardBusy || rewardUncertain}
                aria-invalid={rewardError?.field === "name"}
                onChange={(event) => setRewardDraft({ ...rewardDraft, name: event.target.value })}
              />
              {rewardError?.field === "name" ? <ConsoleFeedback kind="error">{rewardError.message}</ConsoleFeedback> : null}
            </div>
            <div>
              <label htmlFor="reward-method">지급 방식</label>
              <select
                id="reward-method"
                value={rewardDraft.method}
              disabled={rewardBusy || rewardUncertain}
                onChange={(event) => setRewardDraft({ ...rewardDraft, method: event.target.value })}
              >
                <option value="ONSITE">현장 수령</option>
                <option value="GIFT">기프티콘 (모의 코드)</option>
              </select>
              <p className="landing-note">기프티콘은 v1 제외 항목이라 모의 코드만 발급됩니다.</p>
            </div>
            {rewardError && !rewardError.field ? <ConsoleFeedback kind="error">{rewardError.message}</ConsoleFeedback> : null}
          </ValidatedForm>
        </ConsoleDialog>
      ) : null}
      </ConsoleSection>
    </ConsolePage>
  );
}
