"use client";

import ProductButton from "../../../ui/ProductButton";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "../../../ui/ProductLink";
import { loginHrefForLocation } from "../../../auth-redirect";
import { eventStageLabel } from "../../../event-stage";
import { formatConsoleEventMeta } from "../../console-ui/ConsolePageHeader";
import ConsolePage from "../../console-ui/ConsolePage";
import ConsoleFeedback from "../../console-ui/ConsoleFeedback";
import ConsoleSection from "../../console-ui/ConsoleSection";
import ConsoleRefreshButton from "../../console-ui/ConsoleRefreshButton";
import ConsoleTaskQueue, { type ConsoleTask } from "../../console-ui/ConsoleTaskQueue";
import { participationSnapshot, type ParticipationSnapshot } from "../../../../lib/participation-work";
import ConsoleStatePanel from "../../console-ui/ConsoleStatePanel";
import ConsoleAvatar from "../../console-ui/ConsoleAvatar";
import ConsoleEmptyState from "../../console-ui/ConsoleEmptyState";
import ListRow from "../../console-ui/ListRow";
import StatusPill, { type StatusPillTone } from "../../console-ui/StatusPill";
import { ArrowRightIcon, CopyIcon, CheckIcon, ExternalLinkIcon, PlusIcon, RefreshIcon } from "../../console-ui/ConsoleIcons";
import { eventCloseHref, readCloseSnapshot } from "../../console-event-close";
import styles from "./event-overview.module.css";
import board from "./event-overview-board.module.css";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../lib/console-api";
import { hasValidScheduledInstant, messageNeedsAttention } from "../../../../lib/message-attention";
import { attendanceNeedsReview, attendanceNotEntered } from "../../../../lib/attendance-state.cjs";
import { cancellationNeedsReview } from "../../../../lib/cancellation-state.cjs";
import { countRewardAttention } from "../../../../lib/reward-status";

type CheckRow = {
  id: string;
  name: string;
  action: string;
  at: string;
  deskName: string;
};

type ScheduledProgram = {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  place: string;
};

// Calendar-day buckets for the operator's situational awareness. Applications
// count participants (cancelled excluded) and entries count unique
// participants with an uncorrected IN record in the period.
type PeriodCounts = {
  today: { applications: number; entries: number };
  yesterday: { applications: number; entries: number };
  last7: { applications: number; entries: number };
};

type Overview = {
  name: string;
  slug: string;
  clientName: string;
  date: string;
  start: string;
  end: string;
  venue: string;
  stage: string;
  capacity: number;
  capacityKnown: boolean;
  registered: number;
  approved: number;
  pendingApproval: number;
  waitlist: number;
  waitlistOpportunity: { count: number; remaining: number | null; uncertain: boolean; excluded: number } | null;
  everIn: number;
  confirmedNotEntered: number;
  attendanceReview: number;
  cancellationReview: number;
  participantsAvailable: boolean;
  checksAvailable: boolean;
  modulesAvailable: boolean;
  entryRate: number;
  periods: PeriodCounts;
  // Arbitrary-range analysis reuses the exact same definitions: cancelled
  // excluded applications (by createdAt) and uncorrected IN entries deduped
  // per participant (no cancelled filter on checks). Raw values only; the
  // range UI buckets them locally without refetching.
  recent: CheckRow[];
  registrationOpen: boolean;
  openEntryDeskCount: number;
  formVersion: number;
  pagePublished: boolean;
  pageDraftDiffers: boolean;
  surveyResponseCount: number | null;
  reportCount: number;
  publishedReportCount: number;
  draftReportCount: number;
  programs: ScheduledProgram[];
  participation: ParticipationSnapshot;
  updatedAt: string;
  canManageEvent: boolean;
  messageAttention: number;
  messageAttentionBase: number;
  messageDueAt: number[];
  allMessageDueAt: number[];
  messageClockAt: number;
  messageReviewIncomplete: boolean;
  // 확인 필요 prizes, or null while the 경품 feature is off or unreadable.
  rewardAttention: number | null;
  // 지급 대기 prizes (same bucket as 현장 모드 rewardsWaiting), or null while 경품 is off or unreadable.
  rewardWaiting: number | null;
  messageConnection: "connected" | "disconnected" | "unknown";
};

type OverviewState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; overview: Overview };

type Metric = {
  label: string;
  value: string | number;
  detail: string;
  href: string;
};

const STAGE_ORDER = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];
const CHECK_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const UPDATED_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const LIVE_CHECK_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const LIVE_CHECK_INTERVAL_MS = 15000;
const LIVE_FULL_READ_INTERVAL_MS = 60000;
const OVERVIEW_READ_TIMEOUT_MS = 8000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const result = asRecord(item);
        return result ? [result] : [];
      })
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function formatEventDate(value: string): string {
  if (!value) return "일정 미정";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}

function formatCheckTime(value: string): string {
  if (!value) return "시각 정보 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : CHECK_TIME_FORMAT.format(date);
}

const CHECK_CLOCK_FORMAT = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const CHECK_DAY_FORMAT = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });

// Today's records show only the clock; older ones add a small date line.
function checkClock(value: string, now: Date): { clock: string; day: string | null } | null {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return null;
  return {
    clock: CHECK_CLOCK_FORMAT.format(date),
    day: localDateKey(date) === localDateKey(now) ? null : CHECK_DAY_FORMAT.format(date),
  };
}

function relativeAgo(value: string, now: Date): string | null {
  const minutes = Math.floor((now.getTime() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  if (minutes < 1) return "방금 전";
  return minutes < 60 ? `${minutes}분 전` : `${Math.floor(minutes / 60)}시간 전`;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateDistance(value: string, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    target.getFullYear() !== Number(match[1]) ||
    target.getMonth() !== Number(match[2]) - 1 ||
    target.getDate() !== Number(match[3])
  ) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function dDayLabel(value: string, now: Date): string | null {
  const distance = dateDistance(value, now);
  if (distance === null) return null;
  if (distance === 0) return "D-day";
  return distance > 0 ? `D-${distance}` : `D+${Math.abs(distance)}`;
}

function timeInMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function upcomingPrograms(programs: ScheduledProgram[], now: Date): ScheduledProgram[] {
  const today = localDateKey(now);
  const minuteNow = now.getHours() * 60 + now.getMinutes();
  const ordered = programs
    .filter((program) => /^\d{4}-\d{2}-\d{2}$/.test(program.date) && program.date >= today)
    .slice()
    .sort((left, right) =>
      left.date.localeCompare(right.date) ||
      (timeInMinutes(left.start) ?? -1) - (timeInMinutes(right.start) ?? -1) ||
      left.title.localeCompare(right.title, "ko")
    );
  const todayPrograms = ordered.filter((program) => program.date === today);
  const currentIndex = todayPrograms.findIndex((program) => {
    const start = timeInMinutes(program.start);
    const end = timeInMinutes(program.end);
    return start !== null && start <= minuteNow && (end === null || end >= minuteNow);
  });

  if (currentIndex >= 0) {
    const current = todayPrograms[currentIndex];
    const next = ordered
      .filter((program) => {
        if (program.id === current.id) return false;
        if (program.date > today) return true;
        const start = timeInMinutes(program.start);
        return program.date === today && start !== null && start > minuteNow;
      })
      .slice(0, 2);
    return [current, ...next];
  }

  return ordered
    .filter((program) => {
      if (program.date > today) return true;
      const start = timeInMinutes(program.start);
      return program.date === today && (start === null || start >= minuteNow);
    })
    .slice(0, 3);
}

function formatProgramTime(program: ScheduledProgram): string {
  if (program.start && program.end) return `${program.start}–${program.end}`;
  return program.start || program.end || "시간 미정";
}

type RunbookStatus = "done" | "current" | "upcoming";
type RunbookCue = ScheduledProgram & { status: RunbookStatus };

/**
 * The overview's runbook is the event day's full program order, not only the
 * current/next pair. A future event shows every cue as upcoming; today's
 * event marks completed and current cues against the browser clock. No
 * server-derived live flag is invented here: status is display-only.
 */
function runbookCues(programs: ScheduledProgram[], eventDate: string, now: Date): RunbookCue[] {
  const today = localDateKey(now);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : today;
  const minuteNow = now.getHours() * 60 + now.getMinutes();
  const isToday = date === today;
  const isPast = date < today;
  return programs
    .filter((program) => program.date === date)
    .slice()
    .sort((left, right) =>
      (timeInMinutes(left.start) ?? -1) - (timeInMinutes(right.start) ?? -1) ||
      left.title.localeCompare(right.title, "ko")
    )
    .map((program) => {
      let status: RunbookStatus = "upcoming";
      if (isPast) status = "done";
      if (isToday) {
        const start = timeInMinutes(program.start);
        const end = timeInMinutes(program.end);
        if (start !== null && end !== null && end < minuteNow) status = "done";
        else if (start !== null && start <= minuteNow && (end === null || end >= minuteNow)) status = "current";
      }
      return { ...program, status };
    });
}

/** Stage pill colour: live reads as the brand, ended as ink, planning as info. */
function stageTone(stage: string): StatusPillTone {
  switch (stage) {
    case "LIVE": return "live";
    case "READY": return "info";
    case "ENDED": return "ink";
    default: return "neutral";
  }
}

function getReportStatus(overview: Overview): string {
  if (overview.reportCount === 0) return "미작성";
  if (overview.publishedReportCount > 0 && overview.draftReportCount > 0) {
    return `공유 ${overview.publishedReportCount} · 초안 ${overview.draftReportCount}`;
  }
  if (overview.publishedReportCount > 0) return "공유됨";
  if (overview.draftReportCount === overview.reportCount) return "초안";
  return "상태 확인 필요";
}

function metricsForStage(overview: Overview, stage: string, base: string): Metric[] {
  const participantsHref = `${base}/participants`;

  switch (stage) {
    case "DRAFT":
    case "READY":
      // Exactly three peer counts. 정원/대기는 별도 설정 메타 행으로 둔다.
      return [
        { label: "신청", value: overview.registered, detail: overview.cancellationReview ? "신청 상태 기준" : "취소 제외 등록", href: participantsHref },
        { label: overview.cancellationReview ? "승인 상태" : "참가 확정", value: overview.approved, detail: overview.cancellationReview ? "취소 확인 필요 인원 포함" : "승인된 참가자", href: `${participantsHref}?status=APPROVED` },
        { label: "승인 대기", value: overview.pendingApproval, detail: "검토가 필요한 신청", href: `${participantsHref}?status=PENDING` },
      ];
    default:
      return [];
  }
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reloadRequest, setReloadRequest] = useState({ sequence: 0, automatic: false });
  const lastFullRead = useRef<{ eventId: string; version: string | null; at: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // Copy affordance mirrors the notice: a check replaces the copy icon once
  // the link lands on the clipboard, so the boxed button itself confirms the
  // outcome next to the action (the header feedback still announces it).
  const [linkCopied, setLinkCopied] = useState(false);
  const lastShellAttention = useRef<{ eventId: string; count: number; due: number } | null>(null);

  const monitoring = state.kind === "ready" && state.overview.stage === "LIVE" && state.overview.canManageEvent;
  const attentionCount = state.kind === "ready" ? state.overview.messageAttention : null;
  const dueCount = state.kind === "ready" ? state.overview.allMessageDueAt.filter((at) => at <= state.overview.messageClockAt).length : null;

  useEffect(() => {
    if (attentionCount === null || dueCount === null) return;
    const previous = lastShellAttention.current;
    lastShellAttention.current = { eventId, count: attentionCount, due: dueCount };
    if (previous && previous.eventId === eventId && (previous.count !== attentionCount || previous.due !== dueCount)) {
      window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
    }
  }, [eventId, attentionCount, dueCount]);

  useEffect(() => subscribeConsoleFreshness(() => {
    setReloadRequest(({ sequence }) => ({ sequence: sequence + 1, automatic: false }));
  }), []);

  useEffect(() => {
    if (!monitoring || refreshing) return;
    let timer: number | undefined;
    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      const delay = !lastFullRead.current?.version ? LIVE_FULL_READ_INTERVAL_MS
        : refreshError ? LIVE_CHECK_INTERVAL_MS * 2 : LIVE_CHECK_INTERVAL_MS;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          setReloadRequest((current) => current.sequence === reloadRequest.sequence
            ? { sequence: current.sequence + 1, automatic: true } : current);
        }
      }, delay);
    }
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [monitoring, refreshing, refreshError, reloadRequest]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), OVERVIEW_READ_TIMEOUT_MS);
    async function load() {
      setRefreshing(true);
      try {
        const previous = lastFullRead.current;
        // Regular full reads also refresh time-based items such as overdue
        // messages, whose display can change without an event write.
        const version = reloadRequest.automatic && previous?.eventId === eventId
          && performance.now() - previous.at < LIVE_FULL_READ_INTERVAL_MS ? previous.version : null;
        const endpoint = `/api/events/${encodeURIComponent(eventId)}/bootstrap`;
        const res = await consoleFetch(version ? `${endpoint}?ifVersion=${encodeURIComponent(version)}&messageRecipientReview=1` : `${endpoint}?messageRecipientReview=1`, {
          cache: "no-store", signal: controller.signal,
        });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        if (res.status === 403 || res.status === 404) {
          lastFullRead.current = null;
          setState({ kind: "failed", message: res.status === 404 ? "행사를 찾을 수 없습니다." : "행사에 대한 접근 권한을 확인하세요." });
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
            unchanged?: unknown;
            refreshVersion?: unknown;
            events?: unknown;
            clients?: unknown;
            accounts?: unknown;
            integrations?: unknown;
            messageSchedule?: unknown;
            messageReadObservedAt?: unknown;
            recipientReviewVersions?: unknown;
            workspaces?: Record<string, Record<string, unknown> | undefined>;
          } | null;
        } | null;
        if (cancelled) return;
        if (controller.signal.aborted) throw controller.signal.reason;
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
          const message = "운영 현황을 불러오지 못했습니다.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
          return;
        }
        if (version && bootstrap.unchanged === true && bootstrap.refreshVersion === version) {
          const updatedAt = new Date().toISOString();
          const observed = Date.parse(text(bootstrap.messageReadObservedAt));
          const messageClockAt = Number.isFinite(observed) ? observed : Date.now();
          setState((current) => current.kind === "ready" ? { kind: "ready", overview: {
            ...current.overview,
            messageAttention: current.overview.messageAttentionBase + current.overview.messageDueAt.filter((at) => at <= messageClockAt).length,
            messageClockAt,
            updatedAt,
          } } : current);
          setRefreshError(null);
          return;
        }
        const event = records(bootstrap.events).find((item) => item.id === eventId);
        const workspace = bootstrap.workspaces?.[eventId];
        if (!event || !workspace) {
          const message = "행사를 찾을 수 없습니다.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
          return;
        }

        const accounts = records(bootstrap.accounts);
        // Bootstrap returns only the staff account to STAFF users; managers
        // and agency owners receive their operator account in this projection.
        // This display gate never replaces the server's command authorization.
        const canManageEvent = accounts.some((account) =>
          ["AGENCY", "MANAGER"].includes(text(account.role))
        );
        const clients = records(bootstrap.clients);
        const client = clients.find((item) => item.id === event.clientId);
        const sourceAvailability = asRecord(workspace.reportSourceAvailability);
        const completeRecords = (value: unknown) => Array.isArray(value) && records(value).length === value.length;
        const participantsAvailable = (canManageEvent ? sourceAvailability?.participants === true : workspace.participantsAvailable === true) && completeRecords(workspace.participants);
        const checksAvailable = (canManageEvent ? sourceAvailability?.checks === true : workspace.checksAvailable === true) && completeRecords(workspace.checks);
        const modulesAvailable = readCloseSnapshot(event, workspace).modulesAvailable;
        const participantRows = records(workspace.participants).filter(
          (person) => String(person.status || "").toUpperCase() !== "CANCELLED"
        );
        const approved = participantRows.filter((person) => person.status === "APPROVED");
        const waitlistRows = participantRows.filter((person) => person.status === "WAITLIST");
        const waiting = waitlistRows.filter((person) => typeof person.id === "string" && person.id.trim() !== "" &&
          (person.cancelled === undefined || person.cancelled === false));
        const waitlistUncertain = waitlistRows.some((person) => typeof person.id !== "string" || person.id.trim() === "" ||
          (person.cancelled !== undefined && typeof person.cancelled !== "boolean"));
        const capacityValue = event.capacity;
        const capacityKnown = (typeof capacityValue === "number" && Number.isSafeInteger(capacityValue) && capacityValue >= 0) ||
          (typeof capacityValue === "string" && /^\d+$/.test(capacityValue) && Number.isSafeInteger(Number(capacityValue)));
        const statusesKnown = participantsAvailable && records(workspace.participants).every((person) =>
          typeof person.id === "string" && person.id.trim() !== "" &&
          ["APPROVED", "PENDING", "WAITLIST", "CANCELLED"].includes(text(person.status)) &&
          (person.cancelled === undefined || typeof person.cancelled === "boolean")
        );
        const capacityCount = capacityKnown ? Number(capacityValue) : 0;
        const availableSeats = capacityCount > 0 ? Math.max(0, capacityCount - approved.length) : null;
        const waitlistOpportunity = (waiting.length || waitlistUncertain) && participantsAvailable &&
          (!capacityKnown || !statusesKnown || waitlistUncertain || capacityCount === 0 || (availableSeats !== null && availableSeats > 0))
          ? { count: waiting.length, remaining: availableSeats, uncertain: !capacityKnown || !statusesKnown || waitlistUncertain,
              excluded: participantRows.filter((person) => person.status === "WAITLIST" && cancellationNeedsReview(person)).length }
          : null;
        const everIn = participantRows.filter((person) => person.everIn === true).length;
        const registered = participantRows.length;
        const modules = records(workspace.modules);
        const responseRows = records(workspace.responses);
        const surveyModuleIds = new Set(
          modules.filter((module) => module.type === "survey").map((module) => text(module.id)).filter(Boolean)
        );
        const surveyResponseCount = surveyModuleIds.size
          ? responseRows.filter((response) => surveyModuleIds.has(text(response.moduleId))).length
          : null;
        const reportRows = records(workspace.reports);
        const publishedReportCount = reportRows.filter((report) => report.status === "PUBLISHED").length;
        const draftReportCount = reportRows.filter((report) => report.status === "DRAFT").length;
        const deskMap = new Map<string, string>();
        records(workspace.desks).forEach((desk) => {
          if (typeof desk.id === "string") deskMap.set(desk.id, text(desk.name));
        });
        // Same condition as the server's 진행 중 전환: one running entry desk (assignment is optional).
        const openEntryDeskCount = records(workspace.desks).filter(
          (desk) => desk.open !== false && text(desk.action).toUpperCase() === "IN"
        ).length;
        const programRows: ScheduledProgram[] = records(workspace.program).flatMap((program, index) => {
          const title = text(program.title);
          if (!title) return [];
          return [{
            id: text(program.id) || `program-${index}`,
            title,
            date: text(program.date),
            start: text(program.start),
            end: text(program.end),
            place: text(program.place),
          }];
        });
        const checkRecords = records(workspace.checks)
          .filter((check) => typeof check.id === "string" && check.id && check.corrected !== true)
          .map((check) => ({
            id: String(check.id),
            name: text(check.name),
            action: text(check.action),
            at: text(check.at),
            deskName: check.source === "REVIEWED_EXIT" ? "운영자 확인" : deskMap.get(text(check.deskId)) ?? "",
            participantId: text(check.participantId),
          }))
          .sort((left, right) => {
            const leftTime = Date.parse(left.at);
            const rightTime = Date.parse(right.at);
            return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
          });
        const checks: CheckRow[] = checkRecords.slice(0, 8);
        const workspaceVenue = asRecord(workspace.venue);
        const pageExperience = asRecord(workspace.pageExperience);
        const now = new Date();
        const messageRows = records(workspace.messages).filter((message) => typeof message.id === "string");
        const schedule = asRecord(bootstrap.messageSchedule);
        const blocked = new Set(records(schedule?.blocked).filter((item) => typeof item.id === "string").map((item) => String(item.id)));
        const hasRealReservations = messageRows.some((message) => message.status === "SCHEDULED" && message.simulate !== true);
        const messageReviewIncomplete = hasRealReservations && (!Array.isArray(schedule?.blocked) || !asRecord(bootstrap.recipientReviewVersions));
        // A reservation can become due even when the server revision is
        // unchanged. Keep only validated timestamps, not message contents,
        // so the next lightweight refresh can update the count locally.
        let messageAttentionBase = 0;
        const messageDueAt: number[] = [];
        const allMessageDueAt: number[] = [];
        for (const message of messageRows) {
          if (message.status === "SCHEDULED" && typeof message.scheduled === "string" && hasValidScheduledInstant(message.scheduled)) {
            allMessageDueAt.push(Date.parse(message.scheduled));
          }
          if (messageNeedsAttention(message, Number.NEGATIVE_INFINITY, blocked.has(text(message.id)))) {
            messageAttentionBase += 1;
          } else if (message.status === "SCHEDULED" && typeof message.scheduled === "string") {
            messageDueAt.push(Date.parse(message.scheduled));
          }
        }
        const observed = Date.parse(text(schedule?.observedAt));
        const messageClockAt = Number.isFinite(observed) ? observed : Date.now();
        const messageAttention = messageAttentionBase + messageDueAt.filter((at) => at <= messageClockAt).length;
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setDate(todayStart.getDate() + 1);
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(todayStart.getDate() - 1);
        const weekStart = new Date(todayStart);
        weekStart.setDate(todayStart.getDate() - 6);
        const within = (value: string, start: Date, end: Date) => {
          const time = Date.parse(value);
          return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
        };
        const entriesIn = (start: Date, end: Date) => new Set(
          checkRecords
            .filter((check) => check.action === "IN" && within(check.at, start, end))
            .map((check) => check.participantId || check.id)
        ).size;
        const applicationsIn = (start: Date, end: Date) => participantRows
          .filter((person) => within(text(person.createdAt), start, end))
          .length;
        const periods: PeriodCounts = {
          today: {
            applications: applicationsIn(todayStart, tomorrowStart),
            entries: entriesIn(todayStart, tomorrowStart),
          },
          yesterday: {
            applications: applicationsIn(yesterdayStart, todayStart),
            entries: entriesIn(yesterdayStart, todayStart),
          },
          last7: {
            applications: applicationsIn(weekStart, tomorrowStart),
            entries: entriesIn(weekStart, tomorrowStart),
          },
        };

        lastFullRead.current = { eventId, version: text(bootstrap.refreshVersion) || null, at: performance.now() };
        setState({
          kind: "ready",
          overview: {
            name: text(event.name) || "이름 없는 행사",
            slug: text(event.slug),
            clientName: text(client?.name),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue: text(workspaceVenue?.name) || text(event.venue),
            stage: text(event.stage),
            capacity: number(event.capacity),
            capacityKnown,
            registered,
            approved: approved.length,
            pendingApproval: participantRows.filter((person) => person.status === "PENDING").length,
            waitlist: participantRows.filter((person) => person.status === "WAITLIST").length,
            waitlistOpportunity,
            everIn,
            confirmedNotEntered: approved.filter(attendanceNotEntered).length,
            attendanceReview: participantRows.filter((person) => attendanceNeedsReview(person)).length,
            cancellationReview: participantRows.filter(cancellationNeedsReview).length,
            participantsAvailable,
            checksAvailable,
            modulesAvailable,
            entryRate: registered ? Math.round((everIn / registered) * 100) : 0,
            periods,
            recent: checks,
            registrationOpen: workspace.registrationOpen === true,
            openEntryDeskCount,
            formVersion: number(workspace.publishedVersion),
            pagePublished: Boolean(text(pageExperience?.publishedAt)),
            pageDraftDiffers: number(pageExperience?.draftVersion) !== number(pageExperience?.publishedVersion),
            surveyResponseCount,
            reportCount: reportRows.length,
            publishedReportCount,
            draftReportCount,
            programs: programRows,
            participation: participationSnapshot(workspace, Array.isArray(event.features) ? event.features.filter((feature): feature is string => typeof feature === "string") : []),
            updatedAt: now.toISOString(),
            canManageEvent,
            messageAttention,
            messageAttentionBase,
            messageDueAt,
            allMessageDueAt,
            messageClockAt,
            messageReviewIncomplete,
            rewardAttention: Array.isArray(event.features) && event.features.includes("reward")
              ? countRewardAttention(workspace)?.attention ?? null : null,
            rewardWaiting: Array.isArray(event.features) && event.features.includes("reward")
              ? countRewardAttention(workspace)?.waiting ?? null : null,
            messageConnection: asRecord(bootstrap.integrations)?.connected === true ? "connected"
              : asRecord(bootstrap.integrations)?.connected === false ? "disconnected" : "unknown",
          },
        });
        setRefreshError(null);
        if (!reloadRequest.automatic) {
          setLinkNotice(null);
          setLinkCopied(false);
        }
      } catch {
        if (!cancelled) {
          const message = controller.signal.aborted ? "운영 현황 확인이 지연되고 있습니다." : "연결하지 못했습니다. 다시 시도하세요.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
        }
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setRefreshing(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [eventId, router, reloadRequest]);

  function reloadOverview() {
    requestOverviewReload();
    window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
  }

  function requestOverviewReload() {
    setReloadRequest(({ sequence }) => ({ sequence: sequence + 1, automatic: false }));
  }

  async function copyParticipantLink(slug: string) {
    const href = `${window.location.origin}/event/${encodeURIComponent(slug)}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(href);
      } else {
        const field = document.createElement("textarea");
        field.value = href;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("copy unavailable");
      }
      setLinkNotice("참가자 페이지 링크를 복사했습니다.");
      setLinkCopied(true);
    } catch {
      setLinkNotice("링크를 복사하지 못했습니다. 참가자 페이지를 열어 주소를 확인하세요.");
      setLinkCopied(false);
    }
  }

  const currentStage = state.kind === "ready" ? state.overview.stage.toUpperCase() : "";

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="overview" eventId={eventId}>
        <ConsoleStatePanel
          kind="loading" shape="overview"
          message="운영 현황을 불러오고 있습니다."
          onRetry={requestOverviewReload}
        />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="overview" eventId={eventId}>
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={requestOverviewReload}
        />
      </ConsolePage>
    );
  }

  const overview = state.overview;
  const stageKnown = STAGE_ORDER.includes(currentStage);
  const stageText = stageKnown ? eventStageLabel(currentStage) : "단계 미정";
  const showApprovalAlert = overview.participantsAvailable && overview.pendingApproval > 0 && !["ENDED", "ARCHIVED"].includes(currentStage);
  const live = currentStage === "LIVE";
  const preparing = ["DRAFT", "READY"].includes(currentStage);
  const finished = ["ENDED", "ARCHIVED"].includes(currentStage);
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const metrics = metricsForStage(overview, currentStage, base);
  const entryProgress = Math.max(0, Math.min(100, overview.entryRate));
  const entryTrack = (
    <div className={styles.entryTrack} role="progressbar"
      aria-label={`입장 진행 ${overview.everIn}/${overview.registered}명, ${overview.cancellationReview ? "신청 상태 기준" : "취소 제외"} 등록 대비 ${overview.entryRate}%`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={entryProgress}>
      <span className={styles.entryFill} style={{ width: `${entryProgress}%` }} />
    </div>
  );
  const approvedRosterHref = `${base}/participants?status=APPROVED`;
  const notEnteredRosterHref = `${approvedRosterHref}&attendance=NOT_ENTERED`;
  const entryBasis = overview.cancellationReview ? <p className={styles.entryBasis}>신청 상태 기준 · 취소 기록 확인 필요 인원 포함</p> : null;
  // One legend ties the figures to the bar; a single link opens the roster that matters now.
  // Archived events are read-only, so they point at the confirmed roster instead of the no-shows.
  const entryLegend = (showNotEntered: boolean) => (
    <div className={styles.liveRosterLinks}>
      <p className={styles.liveLegend}>
        <span><i className={styles.legendDot} aria-hidden="true" />입장 <strong>{overview.everIn}명</strong></span>
        {showNotEntered ? <span><i className={`${styles.legendDot} ${styles.legendDotOpen}`} aria-hidden="true" />{overview.cancellationReview ? "승인 상태 중 미입장" : "확정자 중 미입장"} <strong>{overview.confirmedNotEntered}명</strong></span> : null}
      </p>
      <Link href={showNotEntered ? notEnteredRosterHref : approvedRosterHref} aria-label={showNotEntered ? "미입장 명단 보기" : "참가 확정 명단 보기"}>
        <span className={styles.rosterGo}>명단 보기 <ArrowRightIcon /></span>
      </Link>
    </div>
  );
  const now = new Date();
  const runbookDate = /^\d{4}-\d{2}-\d{2}$/.test(overview.date)
    ? overview.date
    : localDateKey(now);
  const schedule = overview.canManageEvent
    ? upcomingPrograms(overview.programs.filter((program) => program.date !== runbookDate), now)
    : [];
  const runbookIsToday = runbookDate === localDateKey(now);
  const runbook = overview.canManageEvent
    ? runbookCues(overview.programs, runbookDate, now)
    : [];
  const dDay = dDayLabel(overview.date, now);
  const participantPageHref = overview.slug
    ? `/event/${encodeURIComponent(overview.slug)}`
    : "";
  const eventMeta = formatConsoleEventMeta({
    clientName: overview.clientName,
    date: overview.date,
    start: overview.start,
    end: overview.end,
    venue: overview.venue,
  });

  // 준비 단계의 다음 행동 판단 재료. 공개·접수·디자인은 서로 독립적이다:
  // DRAFT는 비공개, READY부터 기본 디자인으로 공개되며, 접수는 양식 게시로
  // 열리고, 꾸미기 미게시는 미완료가 아니라 선택 사항이다.
  const stageIndex = STAGE_ORDER.indexOf(currentStage);
  const nextStage = stageIndex >= 0 && stageIndex < STAGE_ORDER.length - 1
    ? STAGE_ORDER[stageIndex + 1]
    : null;
  const nextStageText = nextStage ? eventStageLabel(nextStage) : "없음";
  const liveBlocked = overview.openEntryDeskCount === 0;
  // A published form alone cannot receive applications while the event is
  // still private, and an ended event cannot receive them either. Distinguish
  // the saved intake setting from what an attendee can actually do.
  const publicIntakeOpen = ["READY", "LIVE"].includes(currentStage) && overview.registrationOpen;
  const intakeBadgeText = publicIntakeOpen
    ? "접수 중"
    : currentStage === "DRAFT"
      ? "접수 공개 전"
      : finished
        ? "접수 종료"
        : stageKnown ? "접수 닫힘" : "접수 상태 확인 필요";

  const stageBadges = (
        <>
          <StatusPill tone={stageTone(currentStage)} dot={live}>{stageText}</StatusPill>
          <span className={`${styles.intakeBadge} ${publicIntakeOpen ? styles.intakeOpen : styles.intakeClosed}`}>
            {intakeBadgeText}
          </span>
          {dDay && dDay !== "D-day" && !finished ? (
            <span className={styles.dDay} title="일정 표시이며 단계는 자동 변경되지 않습니다.">
              {dDay}
            </span>
          ) : null}
        </>
  );
  const headerActions = overview.canManageEvent && participantPageHref ? (
        <>
          <span className={`${styles.overviewUpdated} console-header-updated`}>
            <time dateTime={overview.updatedAt}>
              <span className={styles.updatedLabel}>{monitoring ? (refreshError ? "마지막 확인" : "자동 확인") : "갱신"} </span>
              {(monitoring ? LIVE_CHECK_TIME_FORMAT : UPDATED_TIME_FORMAT).format(new Date(overview.updatedAt))}
            </time>
            <ConsoleRefreshButton label="새로고침" busy={refreshing && !reloadRequest.automatic} onRefresh={reloadOverview} />
          </span>
          {/* 비가역 마감은 헤더가 아닌 본문 마감 구역의 단일 진입점으로만 둔다. 헤더 Quiet 링크는 가벼운 동작으로 읽혀 오조작 위험이 있다. */}
          {/* DRAFT는 비공개(공개 화면 404)이므로 여는 링크를 두지 않는다. READY부터 기본 디자인으로 열린다. */}
          {stageKnown && currentStage !== "DRAFT" ? (
            <span className="console-header-group">
              <Link variant="ghost" className={styles.pageLink} href={participantPageHref} target="_blank" rel="noreferrer" aria-label="참가자 페이지 열기">
                <span className={styles.pageLinkFull}>참가자 페이지 열기</span><ExternalLinkIcon className={styles.pageLinkIcon} />
              </Link>
              <ProductButton
                type="button"
                className="button button-quiet console-icon-button"
                aria-label="참가자 페이지 링크 복사"
                title="참가자 페이지 링크 복사"
                onClick={() => void copyParticipantLink(overview.slug)}
              >
                {linkCopied ? <CheckIcon /> : <CopyIcon />}
              </ProductButton>
            </span>
          ) : null}
        </>
      ) : null;

  // "지금 할 일" ledger: open items as quiet tiles with secondary actions.
  // The overview keeps zero primary actions by contract: navigation and
  // work queues stay secondary links so the single-primary rule applies to
  // committing workspaces, not this status surface.
  type NowItem = ConsoleTask;
  const nowItems: NowItem[] = [];
  if (overview.canManageEvent && currentStage !== "ARCHIVED") {
    if (overview.participantsAvailable && overview.cancellationReview > 0 && !finished) {
      nowItems.push({ key: "cancellation-review", title: "취소 기록 확인", count: `${overview.cancellationReview}명`, hint: "신청 상태와 다른 취소 기록을 확인하세요.", action: "티켓 확인 필요 명단", href: `${base}/participants?ticket=review` });
    }
    if (showApprovalAlert) {
      nowItems.push({
        key: "approval",
        title: "승인 대기",
        count: `${overview.pendingApproval}명`,
        hint: live ? "신청 내역을 확인하고 참가를 확정하세요." : "",
        action: "승인 대기 처리",
        href: `${base}/participants?status=PENDING`,
      });
    }
    if ((preparing || live) && overview.waitlistOpportunity) {
      const opportunity = overview.waitlistOpportunity;
      nowItems.push({
        key: "waitlist-review",
        title: "대기자 확인",
        count: opportunity.count ? `${opportunity.count}명${opportunity.uncertain ? " 이상" : ""}` : null,
        hint: (opportunity.uncertain
          ? "정원 또는 참가 상태를 확인한 뒤 대기자를 검토하세요."
          : opportunity.remaining === null
            ? "정원 제한 없음 · 운영자가 직접 확정합니다."
            : `${overview.cancellationReview ? "승인 상태" : "확정"} ${overview.approved}명 기준 ${opportunity.remaining}자리 · 자동 확정되지 않습니다.${overview.pendingApproval ? " 승인 대기는 별도입니다." : ""}`) +
          (opportunity.excluded ? ` 취소 기록 확인 ${opportunity.excluded}명은 제외했습니다.` : ""),
        action: "대기 명단 보기",
        href: `${base}/participants?status=WAITLIST`,
      });
    }
    if (overview.messageAttention > 0 || overview.messageReviewIncomplete) {
      nowItems.push({
        key: "message-attention",
        title: "발송 확인 필요",
        count: overview.messageAttention > 0 ? `${overview.messageAttention}건${overview.messageReviewIncomplete ? " 이상" : ""}` : null,
        hint: overview.messageReviewIncomplete ? "일부 예약 상태를 확인하지 못했습니다. 발송 기록 전체를 확인하세요." : "발송 결과와 예약 상태를 확인하세요.",
        action: "발송 확인",
        href: overview.messageReviewIncomplete ? `${base}/messages` : `${base}/messages?attention=1`,
      });
    }
    // 접수와 현장 준비(데스크)는 준비 화면의 체크 카드가 맡는다. 같은 일을 두 번 띄우지 않는다.
    if (currentStage === "READY" && overview.participantsAvailable && !liveBlocked && !showApprovalAlert && !overview.allMessageDueAt.some((at) => at <= overview.messageClockAt)) {
      nowItems.push({
        key: "golive",
        title: "진행 중 전환",
        count: null,
        hint: `가동 중인 입장 데스크 ${overview.openEntryDeskCount}개 — 조건 충족.`,
        action: "진행 단계 설정",
        href: `${base}/settings#settings-stage`,
      });
    }
    for (const task of overview.modulesAvailable ? overview.participation.tasks : []) {
      nowItems.push({ ...task, href: `${base}/programs?review=${task.review}&from=overview` });
    }
    if (currentStage === "ENDED") {
      nowItems.push({
        key: "reports",
        title: "결과 보고서",
        count: null,
        hint: `보고서 ${getReportStatus(overview)}.`,
        action: "결과 보고서 보기",
        href: `${base}/reports`,
      });
    }
    // Reopened 2026-11-24 (owner: 경품 대기 한 줄): 지급 대기 prizes during the event use the
    // same count as 현장 모드. A ghost link, never a new primary.
    if (live && overview.rewardWaiting !== null && overview.rewardWaiting > 0) {
      nowItems.push({
        key: "reward-waiting",
        title: "경품 지급 대기",
        count: `${overview.rewardWaiting}건`,
        hint: "",
        action: "경품 지급",
        href: `${base}/rewards`,
      });
    }
    // Last on purpose: a quiet row that never outranks the stage's own work.
    if (overview.rewardAttention !== null && overview.rewardAttention > 0) {
      nowItems.push({
        key: "reward-attention",
        title: "경품 확인 필요",
        count: `${overview.rewardAttention}건`,
        hint: "수령자나 참가 상태를 확인해야 지급할 수 있는 경품이 있습니다.",
        action: "경품 지급 현황",
        href: `${base}/rewards`,
      });
    }
  }

  const fieldOperationsLink = (
    <Link variant={live ? "primary" : "ghost"} href={live ? `${base}/live` : `${base}/operations`}>
      {live ? "현장 모드 열기" : "입장·스태프 열기"} <ArrowRightIcon />
    </Link>
  );

  // 경품 대기만 있을 때는 호박색 한 줄("지금 할 일 N · 경품 지급 대기 M건 · 경품 지급 →").
  const nowWarnLine = live && nowItems.length === 1 && nowItems[0].key === "reward-waiting";
  const nowSection = (
    <ConsoleSection headingId="event-now-heading" title={nowWarnLine ? `지금 할 일 ${nowItems.length}` : "지금 할 일"} className={`${styles.regionQueue} ${live && !nowItems.length ? styles.queueIdle : ""} ${nowWarnLine ? styles.queueWarn : ""}`}
      action={(nowItems.length && !nowWarnLine) || currentStage !== "LIVE" ? (
        <div className={styles.queueActions}>
          {nowItems.length ? <span className={styles.queueCount}>{nowItems.length}가지</span> : null}
          {currentStage !== "LIVE" && currentStage !== "ARCHIVED" ? fieldOperationsLink : null}
        </div>
      ) : undefined}>
      <ConsoleTaskQueue items={nowItems} label="지금 할 일" empty={overview.participantsAvailable && overview.modulesAvailable ? "지금 확인할 운영 항목이 없습니다." : "일부 업무 자료를 확인할 수 없어 할 일을 모두 판단할 수 없습니다."} variant={live ? "live-overview" : undefined} />
    </ConsoleSection>
  );


  // ---- 행사 전: 준비도. 한 번에 "다 준비됐나"에 답하고, 비어 있는 항목은 카드로 따로 띄운다. ----
  type ReadyItem = { key: string; label: string; state: "done" | "todo" | "optional"; text: string; action: string; href: string };
  const readyItems: ReadyItem[] = [
    {
      key: "intake",
      label: "참가 접수",
      state: publicIntakeOpen ? "done" : "todo",
      text: publicIntakeOpen ? `접수 중 · 양식 버전 ${overview.formVersion}` : currentStage === "DRAFT"
        ? (overview.registrationOpen ? "접수 설정됨 · 운영 준비로 전환하면 공개됩니다" : "양식을 게시하고 접수를 여세요") : "접수가 닫혀 있습니다",
      action: currentStage === "DRAFT" && overview.registrationOpen ? "운영 준비 단계 확인" : "접수 설정",
      href: currentStage === "DRAFT" && overview.registrationOpen ? `${base}/settings#settings-stage` : `${base}/settings#settings-intake`,
    },
    {
      key: "desk",
      label: "현장 준비",
      state: !liveBlocked ? "done" : currentStage === "READY" ? "todo" : "optional",
      text: liveBlocked ? "가동 중인 입장 데스크가 없습니다" : `입장 데스크 ${overview.openEntryDeskCount}개 가동`,
      action: "입장·스태프 확인",
      href: `${base}/operations`,
    },
    {
      key: "program",
      label: "프로그램 일정",
      state: overview.programs.length ? "done" : "optional",
      text: overview.programs.length ? `${overview.programs.length}개 등록` : "등록된 프로그램이 없습니다",
      action: "일정 관리",
      href: `${base}/content`,
    },
    {
      key: "page",
      label: "참가자 페이지",
      state: overview.pagePublished ? "done" : "optional",
      text: overview.pagePublished ? (overview.pageDraftDiffers ? "게시됨 · 새 초안 있음" : "게시됨") : "기본 디자인 사용 중 · 꾸미기는 선택 사항입니다",
      action: "디자인 편집",
      href: `${base}/page`,
    },
    {
      key: "message",
      label: "안내 발송",
      state: overview.messageConnection === "connected" ? "done" : "optional",
      text: overview.messageConnection === "connected" ? "발송 연결됨 · 도달은 별도 확인" : overview.messageConnection === "disconnected" ? "미연결 · 실제 발송 불가" : "발송 연결 상태 확인 필요",
      action: "발송 확인",
      href: `${base}/messages`,
    },
  ];
  const readyRequired = readyItems.filter((item) => item.state === "todo");
  // Reopened 2026-11-24 (owner: 링 필수 기준): required = 접수, and from 운영 준비 the 현장 준비; the rest is 선택.
  // The ring, its accessible name and the supporting line all count required items, like the headline.
  const requiredKeys = currentStage === "READY" ? ["intake", "desk"] : ["intake"];
  const requiredItems = readyItems.filter((item) => requiredKeys.includes(item.key));
  const optionalItems = readyItems.filter((item) => !requiredKeys.includes(item.key));
  const requiredDone = requiredItems.filter((item) => item.state === "done").length;
  const optionalDone = optionalItems.filter((item) => item.state === "done").length;
  const readyPercent = requiredItems.length ? Math.round((requiredDone / requiredItems.length) * 100) : 0;
  const readyHeadline = readyRequired.length
    ? `${currentStage === "DRAFT" ? "접수를 열기까지" : `${nextStageText} 단계로 넘어가기까지`} ${readyRequired.length}가지 남았습니다`
    : currentStage === "DRAFT" ? "접수를 열 준비가 됐습니다" : "진행 중으로 전환할 준비가 됐습니다";
  const readySub = `필수 ${requiredDone}/${requiredItems.length} · 선택 ${optionalDone}/${optionalItems.length}.${optionalDone < optionalItems.length ? " 선택 항목은 나중에 해도 됩니다." : ""}`;
  const countsUnavailable = !overview.participantsAvailable;

  const prepHero = preparing ? (
    <section className={board.prepHero} aria-labelledby="event-metrics-heading">
      <h2 id="event-metrics-heading" className="sr-only">준비 현황과 주요 지표</h2>
      <div className={board.prepTop}>
        <div className={board.ring} style={{ "--p": readyPercent } as CSSProperties} role="img" aria-label={`필수 항목 ${requiredItems.length}개 중 ${requiredDone}개 완료, 선택 항목 ${optionalItems.length}개 중 ${optionalDone}개 완료`}>
          <div><strong>{requiredDone}</strong><span>/{requiredItems.length} 필수</span></div>
        </div>
        <div className={board.prepCopy}>
          <p className={board.stageBand}>
            <span>현재 <strong>{stageText}</strong><span aria-hidden="true"> → </span><span>다음 {nextStageText}</span></span>
            <Link variant="ghost" href={`${base}/settings#settings-stage`}>진행 단계 설정</Link>
          </p>
          <p className={board.headline}>{readyHeadline}</p>
          <p className={board.sub}>{readySub}</p>
        </div>
      </div>
      {countsUnavailable ? (
        <p className={styles.restrictedNote}>집계를 표시할 수 없습니다.</p>
      ) : (
        <>
          <div className={board.chips}>
            {metrics.map((metric) => (
              <Link className={board.chip} href={metric.href} key={metric.label}>
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
              </Link>
            ))}
            <Link className={board.chip} href={`${base}/settings`}>
              <strong>{overview.capacityKnown && overview.capacity > 0 ? `${Math.min(100, Math.round((overview.registered / overview.capacity) * 100))}%` : "—"}</strong>
              <span>{overview.capacityKnown ? (overview.capacity > 0 ? `정원 ${overview.capacity}명 대비` : "정원 제한 없음") : "정원 확인 필요"}</span>
            </Link>
          </div>
          {!overview.capacityKnown ? (
            <p className={styles.metricConfig}>정원을 확인할 수 없습니다. <Link href={`${base}/settings`}>행사 설정 확인</Link></p>
          ) : null}
          {overview.checksAvailable ? <p className={styles.metricConfig}>
            누적 입장 <strong>{overview.everIn}명</strong> · {" "}
            <Link href={`${base}/participants?status=APPROVED&attendance=NOT_ENTERED`}>{overview.cancellationReview ? "승인 상태 중 미입장" : "확정자 중 미입장"} {overview.confirmedNotEntered}명</Link>
            {" "}· 대기 <strong>{overview.waitlist}명</strong>{overview.waitlist ? <>{" "}<Link href={`${base}/participants?status=WAITLIST`}>대기 명단</Link></> : null}
          </p> : null}
        </>
      )}
      {overview.checksAvailable && overview.attendanceReview > 0 ? (
        <p className={styles.metricConfig}>
          일부 출입 기록이 명확하지 않아 입장 수와 입장률이 실제와 다를 수 있습니다.
          {" "}<Link href={`${base}/participants?attendance=REVIEW`}>출입 기록 확인 필요 {overview.attendanceReview}명</Link>
        </p>
      ) : null}
    </section>
  ) : null;

  const prepCards = preparing ? (
    <ConsoleSection headingId="event-readiness-heading" title="행사 준비 확인" className={styles.regionReadiness}>
      <ul className={board.checklist}>
        {readyItems.map((item) => (
          <ListRow
            as="li"
            key={item.key}
            className={board.checkRow}
            title={item.label}
            meta={item.text}
            leading={<StatusPill tone={item.state === "done" ? "ok" : item.state === "todo" ? "wait" : "neutral"}>{item.state === "done" ? "완료" : item.state === "todo" ? "필요" : "선택"}</StatusPill>}
            trailing={<Link className={board.cardLink} href={item.href}>{item.action} <ArrowRightIcon /></Link>}
          />
        ))}
      </ul>
    </ConsoleSection>
  ) : null;

  // ---- 행사 중: 상황판. 누적 입장을 가장 크게, 신청·확정·승인 대기·미입장은 카드로. ----
  const liveAvailable = overview.participantsAvailable && overview.checksAvailable;
  const liveBoard = live ? (
    <section className={board.live} aria-labelledby="event-metrics-heading">
      <h2 id="event-metrics-heading" className="sr-only">입장 진행</h2>
      {!liveAvailable ? <p className={styles.restrictedNote}>집계를 표시할 수 없습니다.</p> : (
        <>
          <div className={board.liveMain}>
            <div className={board.liveDark}>
              <div className={board.liveTop}>
                <span className={board.liveChip}><i aria-hidden="true" />진행 중{dDay === "D-day" ? " · 오늘" : ""}</span>
                {fieldOperationsLink}
              </div>
              <p className={board.liveLabel}>누적 입장</p>
              <p className={board.liveCount}>
                <strong>{overview.everIn}<span>명</span></strong>
                <span className={board.liveTotal}>/ {overview.registered}명</span>
                <span className={board.liveRate}>{overview.entryRate}%</span>
              </p>
              <div className={board.liveTrack} role="progressbar"
                aria-label={`입장 진행 ${overview.everIn}/${overview.registered}명, ${overview.cancellationReview ? "신청 상태 기준" : "취소 제외"} 등록 대비 ${overview.entryRate}%`}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={entryProgress}>
                <span style={{ width: `${entryProgress}%` }} />
              </div>
            </div>
            <div className={board.liveFoot}>
              {entryBasis}
              {entryLegend(true)}
            </div>
          </div>
          <div className={board.kpis} role="group" aria-label="신청과 입장 현황">
            <ListRow as="div" href={`${base}/participants`} chevron title="신청" meta={overview.cancellationReview ? "신청 상태 기준" : "취소 제외 등록"} trailing={<strong className={board.kpiValue}>{overview.registered}<small>명</small></strong>} />
            <ListRow as="div" href={approvedRosterHref} chevron title={overview.cancellationReview ? "승인 상태" : "참가 확정"} meta={overview.cancellationReview ? "취소 확인 필요 인원 포함" : "승인된 참가자"} trailing={<strong className={board.kpiValue}>{overview.approved}<small>명</small></strong>} />
            <ListRow as="div" href={`${base}/participants?status=PENDING`} chevron title="승인 대기" meta="검토가 필요한 신청" trailing={<><StatusPill tone="wait" size="sm">{overview.pendingApproval > 0 ? "검토 필요" : "없음"}</StatusPill><strong className={board.kpiValue}>{overview.pendingApproval}<small>명</small></strong></>} />
            <ListRow as="div" href={notEnteredRosterHref} chevron title={overview.cancellationReview ? "승인 상태 중 미입장" : "확정자 중 미입장"} meta="아직 입장하지 않음" trailing={<strong className={board.kpiValue}>{overview.confirmedNotEntered}<small>명</small></strong>} />
          </div>
          {overview.attendanceReview > 0 ? (
            <p className={`${styles.metricConfig} ${board.liveNote}`}>
              일부 출입 기록이 명확하지 않아 입장 수와 입장률이 실제와 다를 수 있습니다.
              {" "}<Link href={`${base}/participants?attendance=REVIEW`}>출입 기록 확인 필요 {overview.attendanceReview}명</Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  ) : null;

  const boardStage = preparing || live;

  return (
    <ConsolePage pageId="overview" eventId={eventId} eventName={overview.name || "이름 없는 행사"}
      meta={eventMeta} badges={stageBadges} headerActions={headerActions}
      feedback={linkNotice || (overview.participantsAvailable && overview.cancellationReview > 0) || !overview.participantsAvailable || !overview.checksAvailable || !overview.modulesAvailable ? <>
        {linkNotice ? <ConsoleFeedback kind="info">{linkNotice}</ConsoleFeedback> : null}
        {overview.canManageEvent && (!overview.participantsAvailable || !overview.checksAvailable || !overview.modulesAvailable) ? <ConsoleFeedback kind="warning">{[!overview.participantsAvailable ? "참가자" : "", !overview.checksAvailable ? "출입 기록" : "", !overview.modulesAvailable ? "참여 콘텐츠" : ""].filter(Boolean).join(" · ")} 자료를 확인할 수 없어 일부 현황을 표시할 수 없습니다. 새로고침해도 계속되면 조직 관리자에게 문의하세요.</ConsoleFeedback> : null}
        {overview.participantsAvailable && overview.cancellationReview > 0 ? <ConsoleFeedback kind="warning">취소 기록과 신청 상태가 다른 {overview.cancellationReview}명이 등록 집계에 포함돼 있습니다. 참가 여부를 확인해야 하며 승인 상태·입장 집계에도 반영될 수 있습니다. {finished ? "종료 이후에는 참가자 상태를 변경할 수 없습니다. " : ""}<Link href={`${base}/participants?ticket=review`}>티켓 확인 필요 명단 보기</Link></ConsoleFeedback> : null}
      </> : undefined}>
      <div className={overview.canManageEvent ? [styles.overviewCanvas, styles.cardDeck, boardStage ? board.boardLayout : "", currentStage === "LIVE" ? styles.liveOverview : "", currentStage === "ARCHIVED" ? styles.overviewArchived : ""].filter(Boolean).join(" ") : styles.overviewSingle} data-stage={preparing ? "prep" : live ? "live" : "done"}>
      {refreshError ? <p className={`${styles.refreshAlert} state-error`} role="alert">{refreshError} 이전에 불러온 내용은 유지됩니다.</p> : null}
      {overview.canManageEvent ? (
        <>
          {prepHero}
          {liveBoard}
          {prepCards}
          {finished ? (
            <ConsoleSection headingId="event-close-status-heading" title={currentStage === "ARCHIVED" ? "보관된 행사 마감 확인" : "행사 마감"} description="자동으로 단계를 바꾸지 않습니다." className={styles.regionStatus}>
              <div className={styles.closeStatus}>
                <p>공개 접수 종료{overview.registrationOpen ? " · 접수 설정 열림" : ""} · 보고서 {getReportStatus(overview)} · {stageText}</p>
                <Link className="button button-secondary" href={eventCloseHref(eventId)}>{currentStage === "ARCHIVED" ? "행사 마감 확인" : "행사 마감 시작"}</Link>
              </div>
            </ConsoleSection>
          ) : null}
          {currentStage !== "ARCHIVED" ? nowSection : null}
          {!boardStage ? <ConsoleSection
            headingId="event-metrics-heading"
            title={currentStage === "LIVE" ? "입장 진행" : currentStage === "ENDED" || currentStage === "ARCHIVED" ? "최종 요약" : "주요 지표"}
            className={styles.regionMetrics}
            action={currentStage === "LIVE" ? fieldOperationsLink : undefined}
          >
            <div className={finished ? styles.entryMetricsLayout : undefined}>
            {!overview.participantsAvailable || ((live || finished) && !overview.checksAvailable) ? (
              <p className={styles.restrictedNote}>집계를 표시할 수 없습니다.</p>
            ) : finished ? (
              <div className={styles.entryProgress}>
              <div className={styles.endTop}>
              <div className={board.ring} style={{ "--p": overview.entryRate } as CSSProperties} role="img" aria-label={`최종 입장률 ${overview.entryRate}%`}>
                <div><strong>{overview.entryRate}%</strong><span>최종 입장률</span></div>
              </div>
              <div className={styles.entrySummary}>
                <div className={styles.entryMain}>
                  <span className={styles.metricLabel}>최종 누적 입장</span>
                  <div className={styles.entryValues}>
                    <strong className={styles.entryCount}>
                      {overview.everIn}<span> / {overview.registered}명</span>
                    </strong>
                    <span className={styles.entrySeparator} aria-hidden="true">·</span>
                    <strong className={styles.entryRate}>{overview.entryRate}%</strong>
                  </div>
                </div>
                {currentStage === "ARCHIVED" ? (
                  <span className={styles.readOnlyNote}>보관된 행사는 읽기 전용입니다.</span>
                ) : null}
              </div>
              </div>
              {entryTrack}
              {entryBasis}
              {entryLegend(currentStage !== "ARCHIVED")}
                <div className={styles.summaryFacts}>
                  {currentStage === "ARCHIVED" ? (
                    <Link className={styles.summaryFact} href={`${base}/participants`}>
                      <span>{overview.cancellationReview ? "신청 상태 기준 등록" : "취소 제외 등록"}</span>
                      <strong>{overview.registered}명</strong>
                    </Link>
                  ) : null}
                  {overview.surveyResponseCount !== null ? (
                    <Link className={styles.summaryFact} href={`${base}/reports`}>
                      <span>설문 응답</span>
                      <strong>{overview.surveyResponseCount}건</strong>
                    </Link>
                  ) : null}
                  <Link className={styles.summaryFact} href={`${base}/reports`}>
                    <span>보고서 상태</span>
                    <strong>{getReportStatus(overview)}</strong>
                  </Link>
                </div>
            </div>
          ) : (
            <p className={styles.restrictedNote}>확인 가능한 단계 지표가 없습니다.</p>
          )}

            {overview.checksAvailable && overview.attendanceReview > 0 ? (
              <p className={styles.metricConfig}>
                일부 출입 기록이 명확하지 않아 입장 수와 입장률이 실제와 다를 수 있습니다.
                {" "}<Link href={`${base}/participants?attendance=REVIEW`}>출입 기록 확인 필요 {overview.attendanceReview}명</Link>
              </p>
            ) : null}
            </div>
        </ConsoleSection> : null}
          <ConsoleSection
            headingId="event-runbook-heading"
            title={runbookIsToday ? "오늘의 일정" : "행사 일정"}
            description={runbook.length ? <span className={styles.runbookMeta}>{runbookIsToday ? `${UPDATED_TIME_FORMAT.format(now)} 기준` : formatEventDate(runbookDate)}</span> : undefined}
            action={runbook.length ? (
              <Link variant="ghost" href={`${base}/content`}>프로그램 일정</Link>
            ) : (
              <Link variant="ghost" className={styles.addIconLink} href={`${base}/content`} aria-label="일정 추가" title="일정 추가">
                <PlusIcon />
              </Link>
            )}
            className={[styles.regionRunbook, runbook.length ? undefined : styles.runbookIdle].filter(Boolean).join(" ")}
          >
            {runbook.length ? (
              <ol className={styles.runbookList}>
                {runbook.map((cue) => (
                  <li
                    key={cue.id}
                    className={`${styles.runbookCue} ${styles[cue.status]}`}
                    aria-current={cue.status === "current" ? "step" : undefined}
                  >
                    <time dateTime={cue.start ? `${cue.date}T${cue.start}` : undefined}>{cue.start || "--:--"}</time>
                    <span className={styles.runbookDot} aria-hidden="true" />
                    <div className={styles.runbookCopy}>
                      <strong>{cue.title}</strong>
                      <span>{cue.place || "장소 미정"} · {formatProgramTime(cue)}</span>
                    </div>
                    <StatusPill className={styles.runbookStatus} tone={cue.status === "current" ? "live" : cue.status === "done" ? "ok" : "neutral"} dot={cue.status === "current"}>
                      {cue.status === "current" ? "현재 시간" : cue.status === "done" ? "지난 일정" : "예정"}
                    </StatusPill>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.runbookEmpty}>
                행사일에 등록된 프로그램이 없습니다.
              </p>
            )}
          </ConsoleSection>
          {schedule.length > 0 ? (
          <aside className={`${styles.rail} ${styles.regionSecondary}`}>
          {schedule.length > 0 ? (
            <ConsoleSection
              headingId="event-schedule-heading"
              title="현재·다음 일정"
              description="다른 행사일의 예정된 일정입니다."
              className={styles.scheduleRail}
            >
              <ol className={styles.programList}>
                {schedule.map((program) => (
                  <li key={program.id}>
                    <div className={styles.programTime}>
                      <span>{formatEventDate(program.date)}</span>
                      <span>{formatProgramTime(program)}</span>
                    </div>
                    <div className={styles.programInfo}>
                      <strong>{program.title}</strong>
                      {program.place ? <span>{program.place}</span> : null}
                    </div>
                    <StatusPill tone="neutral">예정</StatusPill>
                  </li>
                ))}
              </ol>
            </ConsoleSection>
          ) : null}
          </aside>
          ) : null}
      </>
      ) : (
        <p className={styles.restrictedNote}>행사 지표는 행사 운영자에게 표시됩니다.</p>
      )}

      {preparing && overview.canManageEvent && overview.checksAvailable && overview.recent.length === 0 ? null : preparing && overview.checksAvailable && overview.recent.length === 0 ? (
        <div className={`${styles.recentCompact} ${styles.regionRecent}`}>
          <h2 id="event-recent-heading" className={styles.recentCompactTitle}>
            {overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
          </h2>
          <span className={styles.recentCount}>0건</span>
          <span className={styles.recentCompactMeta}>
            다른 화면에서 돌아오면 갱신 · <time dateTime={overview.updatedAt}>마지막 갱신 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time>
          </span>
          <ProductButton
            type="button"
            className={`button button-secondary ${styles.refreshButton}`}
            onClick={reloadOverview}
            busy={refreshing}
            aria-label="입퇴장 기록 새로고침"
            title="입퇴장 기록 새로고침"
          >
            <RefreshIcon />
          </ProductButton>
          {refreshing ? <p className={styles.refreshStatus} role="status">최신 운영 현황을 불러오고 있습니다.</p> : null}
          <p className={styles.recentCompactEmpty}>
            {overview.canManageEvent
              ? "아직 입퇴장 기록이 없습니다. 입장·스태프의 데스크에서 입장을 기록하면 여기에 표시됩니다."
              : "배정된 데스크에 아직 입퇴장 기록이 없습니다. 담당 데스크에서 입장 기록이 생기면 여기에 표시됩니다."}
          </p>
        </div>
      ) : (
      <ConsoleSection
        headingId="event-recent-heading"
        title={overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
        className={styles.regionRecent}
        description={!overview.canManageEvent ? <time dateTime={overview.updatedAt}>마지막 갱신 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time> : undefined}
        action={(
          <div className={styles.recentActions}>
            <span className={styles.recentCount}>{overview.checksAvailable ? `${overview.recent.length}건` : "확인 불가"}</span>
            <ProductButton
              type="button"
              className={`button button-secondary ${styles.refreshButton}`}
              onClick={reloadOverview}
              busy={refreshing}
              aria-label="입퇴장 기록 새로고침"
              title="입퇴장 기록 새로고침"
            >
              <RefreshIcon />
            </ProductButton>
          </div>
        )}
      >
        {refreshing ? <p className={styles.refreshStatus} role="status">최신 운영 현황을 불러오고 있습니다.</p> : null}
        {!overview.checksAvailable ? <ConsoleEmptyState kind="error-soft" title="출입 기록을 확인할 수 없습니다" description="새로고침해도 계속되면 조직 관리자에게 문의하세요." /> : overview.recent.length ? (
          <ul className={styles.activityList}>
            {overview.recent.map((check) => {
              const when = checkClock(check.at, now);
              const ago = relativeAgo(check.at, now);
              const where = [check.deskName, ago].filter(Boolean).join(" · ");
              const kind = check.action === "IN" ? "입장" : check.action === "OUT" ? "퇴장" : "기록";
              return (
                <ListRow
                  as="li"
                  key={check.id}
                  density="dense"
                  leading={<ConsoleAvatar name={check.name || "?"} tone={check.action === "IN" ? "ok" : "neutral"} />}
                  title={<span className={styles.checkLine}><strong>{check.name || "이름 없음"}</strong><StatusPill tone={check.action === "IN" ? "ok" : "neutral"} size="sm">{kind}</StatusPill></span>}
                  meta={where || undefined}
                  trailing={(
                    <time className={styles.checkTime} dateTime={check.at || undefined}>
                      {when ? <><span>{when.clock}</span>{when.day ? <small>{when.day}</small> : null}</> : formatCheckTime(check.at)}
                    </time>
                  )}
                />
              );
            })}
          </ul>
        ) : (
          <ConsoleEmptyState
            title="아직 입퇴장 기록이 없습니다"
            description={overview.canManageEvent
              ? "입장·스태프의 데스크에서 입장을 기록하면 여기에 표시됩니다."
              : "담당 데스크에서 입장 기록이 생기면 여기에 표시됩니다."}
          />
        )}
      </ConsoleSection>
      )}
      {overview.canManageEvent ? (
        <div className={styles.regionAnalysis}>
          <div className={styles.periodLine}>
            {overview.participantsAvailable && overview.checksAvailable ? (
              <>
                <p className={styles.periodTitle}>{preparing ? "신청 흐름" : "신청·입장 흐름"}</p>
                <div className={styles.periodStats}>
                  <span className={styles.periodStat}><small>오늘 신청</small><strong>{overview.periods.today.applications}<em>명</em></strong></span>
                  {preparing ? (
                    <span className={styles.periodStat}><small>어제 신청</small><strong>{overview.periods.yesterday.applications}<em>명</em></strong></span>
                  ) : (
                    <span className={styles.periodStat}><small>오늘 입장</small><strong>{overview.periods.today.entries}<em>명</em></strong></span>
                  )}
                  <span className={styles.periodStat}><small>최근 7일 신청</small><strong>{overview.periods.last7.applications}<em>명</em></strong></span>
                </div>
              </>
            ) : <span className={styles.periodMuted}>참가자 또는 출입 기록을 확인할 수 없어 기간 집계를 표시할 수 없습니다.</span>}
            <Link className={styles.periodLink} href={`${base}/analysis`}>
              <span className={styles.rosterGo}>기간 분석 보기 <ArrowRightIcon /></span>
            </Link>
          </div>
        </div>
      ) : null}
      </div>
    </ConsolePage>
  );
}
