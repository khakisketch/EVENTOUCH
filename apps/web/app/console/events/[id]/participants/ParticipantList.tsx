"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../../auth-redirect";
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
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import { UNCONFIRMED_WRITE_CLOSE_MESSAGE, useConsoleDraftGuard } from "../../../console-draft-guard";
import { buildApprovedMessageHandoffHref } from "../../../console-handoff";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";
import { readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";
import styles from "./participants.module.css";

// Shared dirty-dismiss copy for the roster dialogs: the guard asks on
// navigation, canClose asks on Escape/backdrop/Cancel.
const DIRTY_CLOSE_MESSAGE = "작성 중인 내용이 사라집니다. 닫을까요?";

type Person = {
  id: string;
  name: string;
  status: string;
  paymentStatus: string;
  phone: string;
  company: string;
  email: string;
  group: string;
  inside: boolean;
  everIn: boolean;
};
type Membership = { accountId: string; eventId: string };

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
      people: Person[];
      groups: string[];
      canManage: boolean;
      rewardFeature: boolean;
    };

const STATUSES = ["PENDING", "APPROVED", "WAITLIST", "CANCELLED"] as const;

// Display-only attendance filter over existing check-in data: inside is the
// live presence flag, everIn records any entry so far. No new API, no new
// business rules — the overview links here with
// ?status=APPROVED&attendance=NOT_ENTERED to show confirmed non-entered
// people, a normal working state rather than an urgent error.
const ATTENDANCE = ["NOT_ENTERED", "INSIDE", "LEFT"] as const;

function attendanceLabel(attendance: string): string {
  switch (attendance) {
    case "NOT_ENTERED":
      return "미입장";
    case "INSIDE":
      return "입장 중";
    case "LEFT":
      return "퇴장";
    default:
      return "전체 출입";
  }
}

function matchesAttendance(person: Person, attendance: string): boolean {
  switch (attendance) {
    case "NOT_ENTERED":
      return person.everIn !== true;
    case "INSIDE":
      return person.inside === true;
    case "LEFT":
      return person.everIn === true && person.inside !== true;
    default:
      return true;
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
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "연락처 확인 필요";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function identityOrg(person: { company: string; group: string }): string {
  const parts = [person.company, person.group === "일반" ? "" : person.group]
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.join(" · ");
}

// Screen-only presence wording for the row details: the CSV export keeps its
// own "미도착" copy and the server contract is untouched.
function presenceLabel(person: { inside: boolean; everIn: boolean }): string {
  if (person.inside === true) return "입장 중";
  if (person.everIn === true) return "퇴장";
  return "미입장";
}

// One compact page of rows: search, filters, counts, selection, group
// assignment and the message handoff keep their filter-wide meanings — only
// the rendered slice and the prev/next position change here.
const PAGE_SIZE = 25;

// Spreadsheet formula injection guard: a cell starting with = + - @ (or
// tab/CR) would execute on open in Excel/Sheets. The leading single quote is
// the standard text marker — hidden by spreadsheets, data preserved.
function csvCell(cell: string): string {
  const guarded = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function isDefinitiveClientError(status: number): boolean {
  // 4xx (except 408 timeout) proves the server saw and rejected this exact
  // request, so retrying the same command id cannot help. 5xx, 408, network
  // failures and malformed success bodies stay ambiguous: the write may have
  // landed, so the retry must replay the SAME command id.
  return status >= 400 && status < 500 && status !== 408;
}

function readRosterFilters(search: string): { status: string; group: string; query: string; attendance: string } {
  try {
    const params = new URLSearchParams(search);
    const rawStatus = params.get("status") ?? "";
    const rawAttendance = params.get("attendance") ?? "";
    return {
      status: (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : "",
      group: params.get("group") ?? "",
      query: params.get("query") ?? params.get("q") ?? "",
      attendance: (ATTENDANCE as readonly string[]).includes(rawAttendance) ? rawAttendance : "",
    };
  } catch {
    return { status: "", group: "", query: "", attendance: "" };
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
  const closeHref = useEventCloseHandoff(eventId);
  const router = useRouter();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [attendanceFilter, setAttendanceFilter] = useState("");
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
  const [groupError, setGroupError] = useState<string | null>(null);
  const [rewardTarget, setRewardTarget] = useState<Person | null>(null);
  const [rewardDraft, setRewardDraft] = useState({ name: "", method: "ONSITE" });
  // Which participant a preserved reward draft belongs to: reopening the same
  // row restores unsent input (dirty dismissal never silently drops it),
  // opening another row or a proven success starts fresh.
  const rewardDraftOwnerRef = useRef<string | null>(null);
  const [rewardBusy, setRewardBusy] = useState(false);
  const [rewardError, setRewardError] = useState<{ message: string; field: string | null } | null>(null);
  // Cancelling a registration voids the ticket, so it is confirmed in place
  // like every other irreversible command in the console.
  const [cancelConfirm, setCancelConfirm] = useState<{ id: string; name: string } | null>(null);
  // Row details open on demand on every viewport; the one-tap approval
  // stays directly visible on PENDING rows.
  const [toolsOpenId, setToolsOpenId] = useState<string | null>(null);
  // Pagination position only: filters, counts, selection, group assignment
  // and the message handoff keep their filter-wide meanings.
  const [page, setPage] = useState(1);
  // Bulk approval: the server already applies one status to many ids, so the
  // roster can settle a pile of waiting applications in one action.
  const [bulkBusy, setBulkBusy] = useState(false);
  const pendingBulkRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  // Bulk-approval follow-up (UI only): the ids just approved, so the
  // operator can message exactly them. Set only on proven success;
  // cleared on every new attempt, every other success notice, and every
  // event switch, so a failed or stale attempt never offers the link.
  const [approvedHandoffIds, setApprovedHandoffIds] = useState<string[] | null>(null);
  // Adding one participant by hand is a first-class way to work, not a
  // side door: no file, no import wizard.
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState({ name: "", phone: "", company: "", email: "", registrationType: "ONSITE" });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<{ message: string; field: string | null } | null>(null);
  // One command id per distinct registration: a lost response replays the
  // same receipt instead of adding the person twice.
  const pendingAddRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  // Same-request retry state: an ambiguous write (network loss, 5xx, 408, or
  // an unparseable success body) keeps its command id so the retry replays
  // the original request instead of duplicating it. A definitive 4xx clears
  // the id. Failed inputs and selections stay on screen for the retry.
  const [statusRetry, setStatusRetry] = useState<{ person: Person; status: string } | null>(null);
  const filtersReadyRef = useRef(false);
  const skipFirstSyncRef = useRef(true);
  // Synchronous same-turn in-flight gate: state flags (savingId/groupBusy/
  // rewardBusy) flip only on re-render, so a double activation in one turn
  // would slip past them. One shared ref is enough — status/group/reward
  // must never overlap. The fingerprint receipt ids are untouched by this.
  const writeBusyRef = useRef(false);
  const bulkBusyRef = useRef(false);
  const pendingStatusRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const pendingGroupRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const pendingRewardRef = useRef<{ fingerprint: string; commandId: string } | null>(null);

  // Unsaved dialog work guards navigation (not filters, query or selection):
  // true field diffs versus opening snapshots, plus unsettled or pending
  // writes whose outcome is unconfirmed. Lists themselves are never dirty.
  const groupBaseline = groupBaselineRef.current ?? "";
  const groupDiffers = groupDialogOpen && groupDraft !== groupBaseline;
  const rewardDiffers = rewardDraft.name.trim() !== "" || rewardDraft.method !== "ONSITE";
  useConsoleDraftGuard(
    groupDiffers ||
      rewardDiffers ||
      pendingStatusRef.current !== null ||
      pendingGroupRef.current !== null ||
      pendingRewardRef.current !== null ||
      writeBusyRef.current,
    "작성 중인 그룹·경품 내용이 사라질 수 있습니다."
  );

  // Filters init from the URL (status allowlisted; group/query raw) and sync
  // back bidirectionally. Sync uses native history.replaceState — never
  // router navigation — so typing in the search box cannot trigger a route
  // refresh or refetch. Unrelated params are preserved; back/forward restores
  // the view through popstate without touching the selection.
  useEffect(() => {
    try {
      const initial = readRosterFilters(window.location.search);
      setStatusFilter(initial.status);
      setGroupFilter(initial.group);
      setQuery(initial.query);
      setAttendanceFilter(initial.attendance);
      // A shared link that arrives pre-filtered (e.g. the overview approval
      // CTA with ?status=PENDING) opens the disclosure so the operator sees
      // why the list is narrow instead of an unexplained short roster.
      if (initial.status || initial.group || initial.attendance) {
        setFiltersOpen(true);
      }
    } catch {
      // Keep the unfiltered list.
    }
    // Event switch resets explicit local workspace state (never a key
    // remount on metadata): stale dialogs, retries and banners from the
    // previous event must not leak into this one. Filters come from the URL.
    setSelectedIds([]);
    setGroupDialogOpen(false);
    setGroupDraft("");
    groupBaselineRef.current = null;
    setGroupError(null);
    setRewardTarget(null);
    setRewardError(null);
    setStatusRetry(null);
    setNotice(null);
    setFailure(null);
    setApprovedHandoffIds(null);
    setPage(1);
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
        // Back/forward into a filtered URL opens the disclosure for the same
        // reason as the initial load; an unfiltered URL never force-closes an
        // explicitly opened panel.
        if (next.status || next.group || next.attendance) {
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
  }, [statusFilter, groupFilter, attendanceFilter, query]);

  // Any filter or search change restarts at the first page; the checkbox
  // selection (including hidden and other-page rows) is untouched.
  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, groupFilter, attendanceFilter]);

  async function load(silent = false) {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return;
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
      const bootstrap = boot?.state;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        setState({ kind: "failed", message: "참가자 목록을 불러오지 못했습니다." });
        return;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      const memberships: Membership[] = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const membership = item as Record<string, unknown>;
            if (typeof membership.accountId !== "string") return [];
            if (typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId }];
          })
        : [];
      const canManage =
        role === "AGENCY" ||
        (role === "MANAGER" &&
          memberships.some(
            (membership) =>
              membership.accountId === myId && membership.eventId === eventId
          ));
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
        return;
      }
      const eventSlug = typeof event.slug === "string" ? event.slug : "";
      const workspace = (bootstrap.workspaces?.[eventId] ?? {}) as Record<string, unknown>;
      const participants = workspace.participants;
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
      const people: Person[] = Array.isArray(participants)
        ? participants.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const person = item as Record<string, unknown>;
            if (typeof person.id !== "string" || !person.id) return [];
            return [{
              id: person.id,
              name: typeof person.name === "string" ? person.name : "",
              status: typeof person.status === "string" ? person.status : "PENDING",
              paymentStatus:
                typeof person.paymentStatus === "string" ? person.paymentStatus : "",
              phone: typeof person.phone === "string" ? person.phone : "",
              company: typeof person.company === "string" ? person.company : "",
              email: typeof person.email === "string" ? person.email : "",
              group: typeof person.group === "string" ? person.group : "",
              inside: person.inside === true,
              everIn: person.everIn === true,
            }];
          })
        : [];
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
        people,
        groups,
        canManage,
        rewardFeature: features.includes("reward"),
      });
      // Drop selections for people who no longer exist; selections for
      // filtered-out people stay so they survive filter changes.
      const known = new Set(people.map((person) => person.id));
      setSelectedIds((current) => current.filter((id) => known.has(id)));
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function approveSelected() {
    if (bulkBusy || writeBusyRef.current) return;
    setApprovedHandoffIds(null);
    const ids = effectiveSelection.filter((id) => {
      const person = state.kind === "ready" ? state.people.find((item) => item.id === id) : undefined;
      return person && person.status === "PENDING";
    });
    if (!ids.length) {
      setNotice("선택한 참가자 중 승인 대기 중인 사람이 없습니다.");
      return;
    }
    const fingerprint = JSON.stringify(["participant.status", eventId, "APPROVED", [...ids].sort()]);
    const attempt = pendingBulkRef.current?.fingerprint === fingerprint
      ? pendingBulkRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingBulkRef.current = attempt;
    bulkBusyRef.current = true;
    setBulkBusy(true);
    setFailure(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "participant.status",
            payload: { ids, status: "APPROVED" },
          }),
        }
      );
      const data = await res.json().catch(() => null) as { error?: unknown; participants?: unknown[] } | null;
      if (!res.ok) {
        setFailure(typeof data?.error === "string" ? data.error : "승인하지 못했습니다.");
        return;
      }
      pendingBulkRef.current = null;
      // Proven success only: failures and lost responses return above, so
      // the follow-up link below always names exactly this approval.
      setApprovedHandoffIds(ids);
      const applied = Array.isArray(data?.participants) ? data.participants.length : ids.length;
      // Name who was approved: a count alone cannot be checked against the
      // list the operator is looking at.
      const approvedNames = ids
        .map((id) => (state.kind === "ready" ? state.people.find((item) => item.id === id)?.name : undefined))
        .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
      const nameSummary = approvedNames.length
        ? ` (${approvedNames.slice(0, 3).join(", ")}${approvedNames.length > 3 ? ` 외 ${approvedNames.length - 3}명` : ""})`
        : "";
      // A pending-only filter would hide the people just approved, so the
      // result must be visible in the list the operator is looking at.
      const filteredToPending = statusFilter === "PENDING";
      if (filteredToPending) setStatusFilter("");
      setNotice(
        filteredToPending
          ? `${applied}명을 승인했습니다.${nameSummary} 승인 대기 필터를 전체로 되돌려 승인한 사람을 보여 줍니다.`
          : `${applied}명을 승인했습니다.${nameSummary}`
      );
      setSelectedIds([]);
      await load(true);
    } catch {
      setFailure("연결하지 못했습니다. 같은 내용으로 다시 시도하세요.");
    } finally {
      bulkBusyRef.current = false;
      setBulkBusy(false);
    }
  }

  async function createParticipant() {
    if (addBusy || writeBusyRef.current) return;
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
    const attempt = pendingAddRef.current?.fingerprint === fingerprint
      ? pendingAddRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingAddRef.current = attempt;
    writeBusyRef.current = true;
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await fetch(
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
        participant?: { name?: unknown };
      } | null;
      if (!res.ok) {
        setAddError({
          message: typeof data?.error === "string" ? data.error : "참가자를 추가하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : null,
        });
        return;
      }
      pendingAddRef.current = null;
      const added = typeof data?.participant?.name === "string" ? data.participant.name : name;
      setAddDraft({ name: "", phone: "", company: "", email: "", registrationType: "ONSITE" });
      setAddOpen(false);
      setApprovedHandoffIds(null);
      setNotice(`${added}님을 등록했습니다.`);
      await load(true);
    } catch {
      setAddError({ message: "연결하지 못했습니다. 같은 내용으로 다시 시도하세요.", field: null });
    } finally {
      writeBusyRef.current = false;
      setAddBusy(false);
    }
  }

  function copyRegistrationLink() {
    if (state.kind !== "ready" || !state.eventSlug) return;
    const link = `${window.location.origin}/event/${encodeURIComponent(state.eventSlug)}`;
    void navigator.clipboard
      ?.writeText(link)
      .then(() => setNotice("참가 신청 링크를 복사했습니다."))
      .catch(() => setFailure("링크를 복사하지 못했습니다. 주소창에서 직접 복사해 주세요."));
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
    writeBusyRef.current = true;
    setSavingId(person.id);
    setNotice(null);
    setFailure(null);
    // One command id per distinct status change: an ambiguous failure keeps
    // the id so the retry below replays the same request (the server receipt
    // replays the original result instead of applying twice).
    const fingerprint = JSON.stringify(["participant.status", eventId, person.id, status]);
    const attempt = pendingStatusRef.current?.fingerprint === fingerprint
      ? pendingStatusRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingStatusRef.current = attempt;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "participant.status",
            payload: { id: person.id, status },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        participants?: unknown;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "변경하지 못했습니다.";
        if (isDefinitiveClientError(res.status)) {
          pendingStatusRef.current = null;
          setStatusRetry(null);
          setFailure(serverMessage);
        } else {
          setStatusRetry({ person, status });
          setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        }
        return;
      }
      if (!Array.isArray(data?.participants) || !data.participants.some((entry) => participantRecordMatches(entry, person.id, status))) {
        // 2xx without this person's updated record: the write may have
        // landed. Keep the id so the retry replays instead of duplicating.
        setStatusRetry({ person, status });
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        return;
      }
      pendingStatusRef.current = null;
      setStatusRetry(null);
      setApprovedHandoffIds(null);
      setNotice(`${person.name} 상태를 ${statusLabel(status)}(으)로 바꿨습니다.`);
      await load(true);
    } catch {
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
    return (groupDraft === (groupBaselineRef.current ?? "") && !pendingGroupRef.current) || window.confirm(pendingGroupRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  function closeGroupDialog(): void {
    setGroupDialogOpen(false);
    groupBaselineRef.current = null;
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
          kind="loading"
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
  const search = query.trim().toLocaleLowerCase("ko-KR");
  const visiblePeople = state.people.filter((person) => {
    const haystack = `${person.name} ${person.company} ${person.phone}`.toLocaleLowerCase("ko-KR");
    const matchesQuery = !search || haystack.includes(search);
    const matchesGroup = !groupFilter || person.group === groupFilter;
    return matchesQuery && matchesGroup && matchesAttendance(person, attendanceFilter) && (!statusFilter || person.status === statusFilter);
  });

  // Selection is scoped to what is visible: group assignment only ever
  // touches rows the operator can see and count. The full selection survives
  // filter changes (back/forward never reselects); hidden rows are counted
  // next to the toolbar and the deselect clears everything explicitly.
  const visibleIds = new Set(visiblePeople.map((person) => person.id));
  const knownIds = new Set(state.people.map((person) => person.id));
  const effectiveSelection = selectedIds.filter((id) => visibleIds.has(id));
  const hiddenSelectedCount = selectedIds.filter(
    (id) => knownIds.has(id) && !visibleIds.has(id)
  ).length;
  // Page slice of the same filtered result: counts above keep meaning the
  // filter total versus the whole roster; the range below names this page.
  const totalPages = Math.max(1, Math.ceil(visiblePeople.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pagePeople = visiblePeople.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
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
  const advancedActiveCount = [statusFilter, groupFilter, attendanceFilter].filter(Boolean).length;
  const advancedSummary = [
    statusFilter ? statusLabel(statusFilter) : "",
    groupFilter || "",
    attendanceFilter ? attendanceLabel(attendanceFilter) : "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" · ");
  const hasAnyFilter = Boolean(query.trim()) || advancedActiveCount > 0;
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
  }

  function togglePerson(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }

  async function assignGroup(event: React.FormEvent) {
    event.preventDefault();
    if (writeBusyRef.current || groupBusy || !groupDraft || !effectiveSelection.length) return;
    writeBusyRef.current = true;
    setGroupBusy(true);
    setGroupError(null);
    // Same fingerprint (group + visible ids) reuses the command id across
    // ambiguous failures; editing the group or the selection mints a new one.
    // The selection is preserved on failure so the retry is the same request.
    const fingerprint = JSON.stringify(["group.assign", eventId, groupDraft, [...effectiveSelection].sort()]);
    const attempt = pendingGroupRef.current?.fingerprint === fingerprint
      ? pendingGroupRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingGroupRef.current = attempt;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "group.assign",
            payload: { group: groupDraft, ids: effectiveSelection },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as { error?: unknown; participantIds?: unknown; group?: unknown } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "그룹을 지정하지 못했습니다.";
        if (isDefinitiveClientError(res.status)) {
          pendingGroupRef.current = null;
          setGroupError(serverMessage);
        } else {
          setGroupError(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        }
        return;
      }
      // Proven success carries this group's id set back, not just an array.
      const returnedIds = Array.isArray(data?.participantIds)
        ? data.participantIds.map((id) => String(id)).sort().join(",")
        : null;
      const expectedIds = [...effectiveSelection].map((id) => String(id)).sort().join(",");
      if (data?.group !== groupDraft || returnedIds === null || returnedIds !== expectedIds) {
        setGroupError("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        return;
      }
      pendingGroupRef.current = null;
      setApprovedHandoffIds(null);
      setNotice(`${effectiveSelection.length}명을 ${groupDraft}(으)로 지정했습니다.`);
      setSelectedIds([]);
      setGroupDialogOpen(false);
      groupBaselineRef.current = null;
      await load(true);
    } catch {
      setGroupError("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
    } finally {
      writeBusyRef.current = false;
      setGroupBusy(false);
    }
  }

  async function createReward(event: React.FormEvent) {
    event.preventDefault();
    if (writeBusyRef.current || rewardBusy || !rewardTarget || !rewardDraft.name.trim()) return;
    writeBusyRef.current = true;
    setRewardBusy(true);
    setRewardError(null);
    const rewardName = rewardDraft.name.trim();
    // Reward ids are the command ids: replaying the same id after an
    // ambiguous failure returns the original reward instead of minting a
    // second one. Editing name/method/target mints a new id.
    const fingerprint = JSON.stringify(["reward.create", eventId, rewardTarget.id, rewardName, rewardDraft.method]);
    const attempt = pendingRewardRef.current?.fingerprint === fingerprint
      ? pendingRewardRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingRewardRef.current = attempt;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: attempt.commandId,
            command: "reward.create",
            payload: {
              participantId: rewardTarget.id,
              name: rewardName,
              method: rewardDraft.method,
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
        if (isDefinitiveClientError(res.status)) pendingRewardRef.current = null;
        setRewardError({
          field: typeof data?.field === "string" ? data.field : null,
          message: (() => {
            const base = typeof data?.error === "string" ? data.error : "경품을 등록하지 못했습니다.";
            return isDefinitiveClientError(res.status) ? base : `${base} 같은 요청으로 다시 시도하세요.`;
          })(),
        });
        return;
      }
      if (typeof data?.reward !== "object" || data?.reward === null) {
        setRewardError({ field: null, message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      // Proven success echoes this recipient on the created reward (the
      // reward id itself is the command id), not just any reward object.
      const created = data.reward as Record<string, unknown>;
      if (typeof created.id !== "string" || !created.id || created.participantId !== rewardTarget.id) {
        setRewardError({ field: null, message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      pendingRewardRef.current = null;
      setApprovedHandoffIds(null);
      setNotice(`${rewardTarget.name}님의 경품을 등록했습니다. 경품 화면에서 지급 처리하세요.`);
      setRewardTarget(null);
      setRewardDraft({ name: "", method: "ONSITE" });
      rewardDraftOwnerRef.current = null;
    } catch {
      setRewardError({ field: null, message: "연결하지 못했습니다. 같은 요청으로 다시 시도하세요." });
    } finally {
      writeBusyRef.current = false;
      setRewardBusy(false);
    }
  }

  function exportCsv() {
    const rows = visiblePeople.map((person) => [
      person.name,
      person.company,
      person.phone,
      person.email,
      person.group,
      statusLabel(person.status),
      person.inside ? "입장 중" : person.everIn ? "퇴장" : "미도착",
    ]);
    const escaped = [["이름", "소속", "연락처", "이메일", "그룹", "등록 상태", "현장 상태"], ...rows]
      .map((row) => row.map((cell) => csvCell(cell)).join(","))
      .join("\r\n");
    const blob = new Blob(["﻿" + escaped], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "EVENTOUCH_participants.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  // Write gates mirror the current server enforcement (role+membership via
  // canManage, plus stage): participant.* writes stop at ENDED/ARCHIVED,
  // domain writes (group.assign, reward.create) at ARCHIVED. Hidden controls
  // stay hidden; reads, the filtered count and CSV export stay on every
  // stage. No granular write-permission policy is invented here.
  const stageKey = state.eventStage.toUpperCase();
  const participantsLocked = stageKey === "ENDED" || stageKey === "ARCHIVED";
  const archived = stageKey === "ARCHIVED";
  const canMutateStatus = state.canManage && !participantsLocked;
  const canAssignGroup = state.canManage && !archived;
  const canRewardHere = state.canManage && state.rewardFeature && !archived;
  // Row-action columns stay consistent between header and rows: full tracks
  // when actions can show, a narrower 3-track grid when only selection
  // applies, and the 2-track viewer grid when read-only — never an empty
  // action column and never drifted auto tracks.
  const showRowActions = canMutateStatus || canRewardHere;
  const readOnlyRows = !canAssignGroup;
  const headClass = readOnlyRows
    ? `${styles.rosterHead} ${styles.viewerHead}`
    : showRowActions
      ? styles.rosterHead
      : `${styles.rosterHead} ${styles.rosterHeadNoActions}`;
  const rowClass = readOnlyRows
    ? `${styles.participantRow} ${styles.viewerRow}`
    : showRowActions
      ? styles.participantRow
      : `${styles.participantRow} ${styles.participantRowNoActions}`;
  const anySelected = effectiveSelection.length > 0 || hiddenSelectedCount > 0;
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
      toolbar={
        <ConsoleToolbar
          filters={
            <>
              <label data-toolbar-span="full">
                <span className="sr-only" id="roster-search-label">이름·소속·연락처 검색</span>
                <input
                  id="roster-search"
                  aria-labelledby="roster-search-label"
                  type="search"
                  placeholder="이름·소속·연락처 검색"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {/* Mobile disclosure for the advanced selects: always rendered
                  (no media-query JS, no hydration split) — CSS hides the
                  toggle on desktop and the panel when closed at <=768px. */}
              <button
                type="button"
                id="roster-filter-toggle"
                ref={filterToggleRef}
                className={`button button-secondary ${styles.filterToggle}`}
                aria-expanded={filtersOpen}
                aria-controls="roster-advanced-filters"
                onClick={toggleAdvancedFilters}
              >
                <span>필터{advancedActiveCount > 0 ? ` · ${advancedActiveCount}개 적용 중` : ""}</span>
                {advancedSummary ? (
                  <span className={styles.filterToggleSummary}>{advancedSummary}</span>
                ) : null}
                <span aria-hidden="true">{filtersOpen ? " ▲" : " ▼"}</span>
              </button>
              <div
                id="roster-advanced-filters"
                ref={advancedFiltersRef}
                className={styles.advancedFilters}
                data-open={filtersOpen ? "true" : "false"}
              >
              <label>
                <span className="sr-only" id="roster-status-label">상태별 보기</span>
                <select aria-labelledby="roster-status-label" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="">전체 상태</option>
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>{statusLabel(status)}</option>
                  ))}
                </select>
              </label>
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
              {hasAnyFilter ? (
                <button
                  type="button"
                  id="roster-filter-reset"
                  className={`button button-secondary ${styles.filterReset}`}
                  onClick={clearRosterFilters}
                >
                  검색·필터 초기화
                </button>
              ) : null}
              </div>
            </>
          }
          actions={
            <span data-toolbar-inline className={styles.utilityPair}>
              <button type="button" className="button button-secondary" onClick={exportCsv}>
                목록 CSV · {visiblePeople.length}명
              </button>
              {canMutateStatus ? (
                <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants/import`}>
                  파일로 등록
                </Link>
              ) : null}
            </span>
          }
          selection={
            anySelected && canAssignGroup ? (
              <>
                <span role="status" id="roster-selection-count">
                  현재 표시 {pageSelectedCount}명 선택 · 전체 선택 {handoffIds.length}명 · 최대 200명
                  {hiddenSelectedCount ? ` · 숨김 ${hiddenSelectedCount}명(그룹 지정 제외)` : ""}
                  {otherPageSelectedCount > 0 ? ` · 다른 페이지 ${otherPageSelectedCount}명 포함` : ""}
                  {` · 선택 승인·그룹 지정: 필터 범위 ${effectiveSelection.length}명`}
                </span>
                {canMutateStatus ? (
                  <button
                    type="button"
                    id="roster-approve-selected"
                    className="button button-secondary"
                    disabled={bulkBusy || !effectiveSelection.length}
                    onClick={() => void approveSelected()}
                  >
                    {bulkBusy ? "승인 중입니다" : "선택 승인"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!effectiveSelection.length}
                  onClick={() => {
                    setGroupError(null);
                    setGroupDraft(state.groups[0] ?? "");
                    groupBaselineRef.current = state.groups[0] ?? "";
                    setGroupDialogOpen(true);
                  }}
                >
                  그룹 지정
                </button>
                {handoffOverLimit ? (
                  <>
                    <span role="status" id="roster-handoff-limit">
                      선택 {handoffIds.length}명 · 최대 200명까지 전송 가능 · 필터로 대상을 좁히거나 숨김 선택을 제외하세요
                    </span>
                    <button
                      type="button"
                      id="roster-exclude-hidden"
                      className={`button button-secondary ${styles.selectionButton}`}
                      onClick={() => setSelectedIds((current) => current.filter((id) => visibleIds.has(id)))}
                    >
                      숨김 제외
                    </button>
                    <button
                      type="button"
                      id="roster-send-message"
                      className={`button button-secondary ${styles.selectionButton}`}
                      disabled
                      title="대상이 너무 많습니다. 필터로 대상을 좁혀 주세요"
                    >
                      메시지 보내기
                    </button>
                  </>
                ) : (
                  <Link
                    id="roster-send-message"
                    className={`button button-secondary ${styles.selectionButton}`}
                    href={closeHref(handoffHref)}
                  >
                    메시지 보내기
                  </Link>
                )}
                <button type="button" className={`button button-secondary ${styles.selectionButton}`} onClick={() => setSelectedIds([])}>
                  {hiddenSelectedCount ? `선택 해제 (숨김 ${hiddenSelectedCount}명 포함)` : "선택 해제"}
                </button>
              </>
            ) : undefined
          }
        />
      }
      feedback={
        <>
          {notice ? (
            <ConsoleFeedback kind="success">
              {notice}
              {approvedHandoffIds && approvedHandoffIds.length ? (
                <>
                  {" "}
                  <Link
                    id="roster-approved-message"
                    className="button button-secondary"
                    href={closeHref(buildApprovedMessageHandoffHref(eventId, approvedHandoffIds))}
                  >
                    승인자에게 안내 보내기
                  </Link>
                </>
              ) : null}
            </ConsoleFeedback>
          ) : null}
          {failure ? (
            <ConsoleFeedback kind="error">
              {failure}{" "}
              {statusRetry ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={savingId === statusRetry.person.id}
                  onClick={() => void changeStatus(statusRetry.person, statusRetry.status)}
                >
                  {savingId === statusRetry.person.id ? "다시 시도 중…" : "같은 요청으로 다시 시도"}
                </button>
              ) : null}
            </ConsoleFeedback>
          ) : null}
          {!state.canManage ? (
            <ConsoleFeedback kind="warning">상태 변경 권한이 없습니다. 변경이 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {state.canManage && archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 변경할 수 없습니다. 목록 확인과 내려받기는 계속할 수 있습니다.</ConsoleFeedback>
          ) : null}
          {state.canManage && !archived && participantsLocked ? (
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
        action={canMutateStatus ? (
          <button type="button" className="button button-primary" onClick={() => { setAddError(null); setAddOpen(true); }}>
            참가자 추가
          </button>
        ) : undefined}
      >
      <p className="participant-count" role="status">
        {statusFilter || groupFilter || attendanceFilter || search
          ? `${visiblePeople.length}명 / 전체 ${state.people.length}명(취소 포함)`
          : `전체 ${state.people.length}명(취소 포함)`}
        {canAssignGroup && !anySelected ? (
          <>
            {" "}
            <button
              type="button"
              className={`button button-secondary ${styles.selectionButton}`}
              onClick={selectVisible}
            >
              표시 {visiblePeople.length}명 선택
            </button>
          </>
        ) : null}
      </p>
      {visiblePeople.length ? (
        <>
          <a className="skip-link" href="#roster-next-page" data-skip-to="roster-next-page" onClick={focusRosterPagination}>명단 페이지 이동으로 건너뛰기</a>
          <div className={headClass} aria-hidden="true">
            {canAssignGroup ? <span>선택</span> : null}
            <span>참가자</span>
            <span className={styles.rosterHeadContact}>연락처</span>
            <span className={styles.rosterHeadStatus}>상태</span>
            {showRowActions ? <span className={styles.rosterHeadAction}>작업</span> : null}
          </div>
          <ul className={styles.participantList}>
            {pagePeople.map((person) => {
              const tone = person.status === "APPROVED" ? "good" : person.status === "WAITLIST" ? "wait" : person.status === "CANCELLED" ? "bad" : "info";
              const detailsOpen = toolsOpenId === person.id;
              const detailsId = `participant-details-${person.id}`;
              const detailFacts = [
                `연락처 ${maskPhone(person.phone)}`,
                person.email.trim() ? `이메일 ${person.email.trim()}` : "",
                `출입 ${presenceLabel(person)}`,
              ]
                .map((part) => part.trim())
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  className={rowClass}
                  key={person.id}
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
                    <strong className={styles.participantName}>{person.name}</strong>
                    <small className={styles.participantIdentity}>{identityOrg(person)}</small>
                    <small className={styles.mobileContact}>{maskPhone(person.phone)}</small>
                  </span>
                  <span className={styles.rosterContact}>{maskPhone(person.phone)}</span>
                  <span className={`status-chip ${tone} ${styles.participantStatus}`}>{statusLabel(person.status)}</span>
                  {showRowActions ? (
                    <div className={styles.participantActions}>
                      {/* One always-visible primary per row: PENDING approves
                          directly, everything else opens the details below,
                          which keep the full participant.status change
                          (including cancel with its confirm) under the same
                          ENDED/ARCHIVED gates. */}
                      {person.status === "PENDING" && canMutateStatus ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={savingId === person.id}
                          onClick={() => changeStatus(person, "APPROVED")}
                        >
                          {savingId === person.id ? "승인 중…" : "승인"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`button button-secondary ${styles.rowToolsToggle}`}
                        aria-expanded={detailsOpen}
                        aria-controls={detailsOpen ? detailsId : undefined}
                        aria-label={`${person.name} 참가자 작업 더보기`}
                        onClick={() => setToolsOpenId((current) => (current === person.id ? null : person.id))}
                      >
                        더보기
                      </button>
                    </div>
                  ) : null}
                  {showRowActions && detailsOpen ? (
                    <div id={detailsId} className={styles.participantDetails}>
                      <p className={styles.detailFacts}>{detailFacts}</p>
                      <div className={styles.detailActions}>
                        {person.status === "APPROVED" && state.rewardFeature && canRewardHere ? (
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => {
                              setRewardError(null);
                              if (rewardDraftOwnerRef.current !== person.id) {
                                setRewardDraft({ name: "", method: "ONSITE" });
                              }
                              rewardDraftOwnerRef.current = person.id;
                              setRewardTarget(person);
                            }}
                          >
                            경품 등록
                          </button>
                        ) : null}
                        {canMutateStatus ? (
                          <select
                            key={`${person.id}-${cancelConfirm?.id === person.id ? "pending" : "idle"}`}
                            aria-label={`${person.name} 상태 변경`}
                            value={isKnownStatus(person.status) ? person.status : ""}
                            disabled={savingId === person.id}
                            onChange={(event) => void changeStatus(person, event.target.value)}
                          >
                            {!isKnownStatus(person.status) ? (
                              <option value="" disabled>상태 확인 필요</option>
                            ) : null}
                            {STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {statusLabel(status)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {cancelConfirm?.id === person.id ? (
                    <div className={styles.rowConfirm}>
                      <ConsoleConfirm
                        summary={`${cancelConfirm.name}님의 신청을 취소하면 발급된 티켓은 무효화됩니다. 되돌리려면 다시 승인해야 합니다.`}
                        confirmLabel="신청 취소"
                        busy={savingId === person.id}
                        onConfirm={() => {
                          const target = person;
                          setCancelConfirm(null);
                          void applyStatus(target, "CANCELLED");
                        }}
                        onCancel={() => setCancelConfirm(null)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <nav aria-label="참가자 목록 페이지" className={styles.paginationBar}>
              <button
                type="button"
                id="roster-previous-page"
                className={`button button-secondary ${styles.selectionButton}`}
                disabled={safePage <= 1}
                onClick={() => showRosterPage(safePage - 1)}
              >
                이전
              </button>
              <button
                type="button"
                id="roster-next-page"
                className={`button button-secondary ${styles.selectionButton}`}
                disabled={safePage >= totalPages}
                onClick={() => showRosterPage(safePage + 1)}
              >
                다음
              </button>
              <span role="status" className={styles.paginationPosition}>
                {safePage} / {totalPages} 페이지 · {pageStart}–{pageEnd} / {visiblePeople.length}명
                {pageSelectedCount > 0 ? ` · 이 페이지 ${pageSelectedCount}명 선택` : ""}
              </span>
              <span className={styles.paginationActions}>
                <button
                  type="button"
                  className={`button button-secondary ${styles.selectionButton}`}
                  onClick={selectPage}
                >
                  이 페이지 {pagePeople.length}명 선택
                </button>
                <button
                  type="button"
                  className={`button button-secondary ${styles.selectionButton}`}
                  onClick={focusRosterSearch}
                >
                  검색으로 이동
                </button>
              </span>
            </nav>
        </>
      ) : state.people.length ? (
        <div className={styles.emptyState}>
          <h3>조건에 맞는 참가자가 없습니다.</h3>
          <p>검색어를 바꾸거나 다른 상태 필터에서 찾아보세요.</p>
        </div>
      ) : (
        <div className={styles.emptyState}>
          <h3>등록된 참가자가 없습니다.</h3>
          <p>참가자를 직접 추가하거나 파일로 등록할 수 있습니다.</p>
          {canMutateStatus ? (
            <p>
              <button type="button" className="button button-primary" onClick={() => { setAddError(null); setAddOpen(true); }}>
                참가자 추가
              </button>
            </p>
          ) : null}
          <p>
            참가자가 스스로 신청하게 하려면 행사 설정의 참가 접수를 열어 주세요.
            {canMutateStatus ? (
              <>
                {" "}
                <button type="button" className="button button-secondary" onClick={copyRegistrationLink}>
                  참가 신청 링크 복사
                </button>
              </>
            ) : null}
          </p>
        </div>
      )}
      {addOpen ? (
        <ConsoleDialog
          title="참가자 추가"
          description="한 명을 바로 등록합니다. 여러 명은 파일로 등록하세요."
          onClose={() => { if (!addBusy) { setAddOpen(false); setAddError(null); } }}
          busy={addBusy}
          canClose={() => !addBusy}
          footer={
            <ConsoleFormActions>
              <button type="submit" form="participant-add-form" className="button button-primary" disabled={addBusy || !addDraft.name.trim() || !addDraft.phone.trim()}>
                {addBusy ? "등록 중입니다" : "등록"}
              </button>
              <button type="button" className="button button-secondary" disabled={addBusy} onClick={() => { setAddOpen(false); setAddError(null); }}>
                취소
              </button>
            </ConsoleFormActions>
          }
        >
          <form id="participant-add-form" onSubmit={(event) => { event.preventDefault(); void createParticipant(); }}>
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
              <input
                id="participant-add-company"
                type="text"
                maxLength={200}
                value={addDraft.company}
                onChange={(event) => setAddDraft({ ...addDraft, company: event.target.value })}
              />
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
            <div>
              <label htmlFor="participant-add-type">등록 방식</label>
              <select
                id="participant-add-type"
                value={addDraft.registrationType}
                onChange={(event) => setAddDraft({ ...addDraft, registrationType: event.target.value })}
              >
                <option value="ONSITE">현장 등록</option>
                <option value="PRE">사전 등록</option>
              </select>
              <p className={styles.help}>사전 등록은 이름이 이미 정해진 명단, 현장 등록은 당일 현장에서 추가하는 참가자입니다.</p>
            </div>
            {addError ? <ConsoleFeedback kind="error">{addError.message}</ConsoleFeedback> : null}
          </form>
        </ConsoleDialog>
      ) : null}
      {groupDialogOpen ? (
        <ConsoleDialog
          title="그룹 지정"
          description={`필터 범위에서 선택한 ${effectiveSelection.length}명의 그룹을 바꿉니다.${
            otherPageSelectedCount > 0 ? ` 다른 페이지에서 선택한 ${otherPageSelectedCount}명을 포함합니다.` : ""
          }${
            hiddenSelectedCount ? ` 화면 밖에서 선택한 ${hiddenSelectedCount}명은 이번 지정에 포함되지 않습니다.` : ""
          }`}
          onClose={closeGroupDialog}
          busy={groupBusy}
          canClose={canCloseGroupDialog}
          footer={
            <ConsoleFormActions>
              <button type="submit" form="group-assign-form" className="button button-primary" disabled={groupBusy || !groupDraft}>
                {groupBusy ? "지정 중…" : "지정"}
              </button>
              <button type="button" className="button button-secondary" disabled={groupBusy} onClick={() => { if (canCloseGroupDialog()) closeGroupDialog(); }}>
                취소
              </button>
            </ConsoleFormActions>
          }
        >
          <form id="group-assign-form" onSubmit={(event) => void assignGroup(event)}>
            <div>
              <label htmlFor="group-pick">그룹</label>
              <select
                id="group-pick"
                required
                value={groupDraft}
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
          </form>
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
              <button type="submit" form="reward-create-form" className="button button-primary" disabled={rewardBusy || !rewardDraft.name.trim()}>
                {rewardBusy ? "등록 중…" : "등록"}
              </button>
              <button type="button" className="button button-secondary" disabled={rewardBusy} onClick={() => { if (canCloseRewardDialog()) closeRewardDialog(); }}>
                취소
              </button>
            </ConsoleFormActions>
          }
        >
          <form id="reward-create-form" onSubmit={(event) => void createReward(event)}>
            <div>
              <label htmlFor="reward-name">경품명 (필수)</label>
              <input
                id="reward-name"
                type="text"
                maxLength={80}
                required
                value={rewardDraft.name}
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
                onChange={(event) => setRewardDraft({ ...rewardDraft, method: event.target.value })}
              >
                <option value="ONSITE">현장 수령</option>
                <option value="GIFT">기프티콘 (모의 코드)</option>
              </select>
              <p className="landing-note">기프티콘은 v1 제외 항목이라 모의 코드만 발급됩니다.</p>
            </div>
            {rewardError && !rewardError.field ? <ConsoleFeedback kind="error">{rewardError.message}</ConsoleFeedback> : null}
          </form>
        </ConsoleDialog>
      ) : null}
      </ConsoleSection>
    </ConsolePage>
  );
}
