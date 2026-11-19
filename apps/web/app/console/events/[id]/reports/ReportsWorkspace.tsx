"use client";

import ProductButton from "../../../../ui/ProductButton";
import ValidatedForm from "../../../../ui/ValidatedForm";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import ProductLink from "../../../../ui/ProductLink";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { closeHandoffHref, closePrerequisite, eventCloseHref, readCloseSnapshot } from "../../../console-event-close";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleSectionNav, { requestConsoleTask } from "../../../console-ui/ConsoleSectionNav";
import { ArrowRightIcon, BackIcon, DocumentIcon, DownloadIcon, PrinterIcon } from "../../../console-ui/ConsoleIcons";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleRefreshButton from "../../../console-ui/ConsoleRefreshButton";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ui from "../../../console-ui/console-ui.module.css";
import styles from "./reports.module.css";
import EventCloseFlow from "./EventCloseFlow";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { attendanceNeedsReview } from "../../../../../lib/attendance-state.cjs";
import { cancellationNeedsReview } from "../../../../../lib/cancellation-state.cjs";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsReportCommand, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";

type ReportSnapshot = {
  event?: { name?: unknown; date?: unknown; start?: unknown; end?: unknown; venue?: unknown; client?: unknown };
  metrics?: { total?: unknown; pending?: unknown; approved?: unknown; checked?: unknown; inside?: unknown; rate?: unknown; attendanceReview?: unknown; attendanceReviewVersion?: unknown; cancellationReview?: unknown };
  groups?: Array<{ name?: unknown; count?: unknown }>;
  booths?: Array<{ name?: unknown; used?: unknown; capacity?: unknown }>;
  programs?: Array<{ name?: unknown; type?: unknown; responses?: unknown }>;
  survey?: Array<{ name?: unknown; count?: unknown; average?: unknown | null; questions?: Array<{ name?: unknown; average?: unknown | null; count?: unknown }> }>;
  photos?: Array<{ image?: unknown; caption?: unknown }>;
  capturedAt?: unknown;
  revision?: unknown;
};

type Report = {
  id: string;
  title: string;
  subtitle: string;
  coverNote: string;
  summary: string;
  sections: string[];
  color: string;
  status: string;
  version: number;
  createdAt: string;
  publishedAt: string;
  familyId?: string;
  snapshot?: ReportSnapshot | null;
};

const REPORT_SOURCE_LABELS = {
  venue: "행사 장소", participants: "참가자", checks: "입장 기록", responses: "응답",
  modules: "참여 콘텐츠", groups: "참가자 그룹", booths: "부스", questions: "질문",
  photos: "사진", survey: "설문 응답", draw: "추첨",
} as const;
type ReportSource = keyof typeof REPORT_SOURCE_LABELS;
type ReportSources = Record<ReportSource, boolean>;

function reportSources(value: unknown): ReportSources {
  const source = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(REPORT_SOURCE_LABELS).map((key) => [key, source[key] === true])) as ReportSources;
}

type Ready = {
  kind: "ready";
  eventName: string;
  eventMeta?: string;
  archived: boolean;
  stage: string;
  registrationOpen: boolean;
  archiveAvailable: boolean;
  openModules: Array<{ name: string; type: string }>;
  features: string[];
  sources: ReportSources;
  cancellationReviewSupported: boolean;
  metrics: { total: number; pending: number; approved: number; checked: number; inside: number; rate: number; attendanceReview: number; cancellationReview: number };
  groups: Array<{ name: string; count: number }>;
  booths: Array<{ name: string; used: number; capacity: number }>;
  programs: Array<{ name: string; type: string; responses: number }>;
  surveys: Array<{ name: string; count: number; average: string | null; questions: Array<{ name: string; average: string | null; count: number }> }>;
  photoCount: number;
  photoCaptions: string[];
  reports: Report[];
  role: string;
  userId: string;
  memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
};

type State = { kind: "loading" } | { kind: "failed"; message: string } | Ready;
type ReportFailure = { message: string; field?: string; code?: string; attendanceReadAt?: string };
type ReportAttendance = Pick<Ready["metrics"], "total" | "pending" | "approved" | "checked" | "inside" | "attendanceReview" | "cancellationReview">;
type ReportAttempt = { eventId: string; command: string; payload: Record<string, unknown>; fingerprint: string; commandId: string; successMessage: string; fromDialog: boolean; uncertain: boolean };

const SECTION_LABELS: Array<{ id: string; label: string }> = [
  { id: "overview", label: "운영 요약" },
  { id: "attendance", label: "참가·입장" },
  { id: "programs", label: "프로그램·부스" },
  { id: "survey", label: "만족도" },
  { id: "photos", label: "승인 사진" },
];

const MODULE_TYPE_LABELS: Record<string, string> = {
  poll: "투표",
  quiz: "퀴즈",
  qa: "Q&A",
  draw: "추첨",
  survey: "만족도",
  stamp: "스탬프",
  photo: "사진",
  board: "게시판",
};

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// A frozen report may predate a field or contain an unreadable value.
// Missing is not the same as a saved zero or an empty list.
function snapshotRecords(value: unknown): { items: Record<string, unknown>[] | null; invalid: boolean } {
  if (!Array.isArray(value)) return { items: null, invalid: false };
  const items = value.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item));
  return { items, invalid: items.length !== value.length };
}

function snapshotValue(value: unknown, unit: string, maximum?: number): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && (maximum === undefined || value <= maximum)
    ? `${value}${unit}` : "확인 불가";
}

function snapshotAverage(value: unknown): string {
  if (value === null) return "없음";
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 5 ? `${value} / 5` : "확인 불가";
}

function averageLabel(values: number[]): string | null {
  if (!values.length) return null;
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

const ATTENDANCE_LABELS = [
  ["total", "등록 (취소 제외)"],
  ["approved", "참가 확정"],
  ["pending", "승인 대기"],
  ["checked", "누적 입장"],
  ["inside", "현재 입장"],
  ["attendanceReview", "출입 기록 확인 필요"],
  ["cancellationReview", "취소 기록 확인 필요"],
] as const;

function reportAttendance({ total, pending, approved, checked, inside, attendanceReview, cancellationReview }: Ready["metrics"]): ReportAttendance {
  return { total, pending, approved, checked, inside, attendanceReview, cancellationReview };
}

function needsAttendanceReview(reviewed: ReportAttendance, latest: ReportAttendance, failure: ReportFailure | null) {
  return failure?.field === "expectedAttendance" || ATTENDANCE_LABELS.some(([key]) => reviewed[key] !== latest[key]);
}

function ReportAttendanceReview({ reviewed, latest, failure, loadedAt, refreshing, refreshFailure, busy, eventId, participantChangesLocked, onRefresh, onAccept }: {
  reviewed: ReportAttendance;
  latest: ReportAttendance;
  failure: ReportFailure | null;
  loadedAt: string;
  refreshing: boolean;
  refreshFailure: string | null;
  busy: boolean;
  eventId: string;
  participantChangesLocked: boolean;
  onRefresh: () => void;
  onAccept: () => void;
}) {
  const needsReview = needsAttendanceReview(reviewed, latest, failure);
  const needsRefresh = Boolean(refreshFailure) || failure?.attendanceReadAt === loadedAt;
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const requiresFocus = failure?.field === "expectedAttendance";
  useEffect(() => {
    if (requiresFocus) feedbackRef.current?.focus();
  }, [requiresFocus]);

  return (
    <div className={styles.form} role="group" aria-label="보고서에 반영할 참가 집계">
      <p className={styles.help}><strong>보고서에 반영할 참가 집계</strong></p>
      {needsReview ? (
        <p className={styles.alert} ref={feedbackRef} tabIndex={-1} role="status">
          참가 집계가 바뀌었습니다. 최신 값을 확인하고 사용하세요.
          {refreshFailure ? <> {refreshFailure} 작성한 입력은 유지됩니다.</> : null}
        </p>
      ) : null}
      <dl className={styles.closeFacts}>
        {ATTENDANCE_LABELS.filter(([key]) => key !== "cancellationReview" || reviewed.cancellationReview > 0 || latest.cancellationReview > 0).map(([key, label]) => (
          <div key={key}>
            <dt>{key === "approved" && (reviewed.cancellationReview > 0 || latest.cancellationReview > 0) ? "승인 상태" : key === "total" && (reviewed.cancellationReview > 0 || latest.cancellationReview > 0) ? "등록 (신청 상태 기준)" : label}</dt>
            <dd>{reviewed[key]}명{reviewed[key] !== latest[key] ? <> → 최신 {latest[key]}명</> : null}</dd>
          </div>
        ))}
      </dl>
      {reviewed.cancellationReview > 0 ? <ConsoleFeedback kind="warning">취소 기록과 신청 상태가 다른 {reviewed.cancellationReview}명이 등록 집계에 포함돼 있습니다. 참가 여부를 확인해야 하며 승인 상태·입장 집계에도 반영될 수 있습니다. {participantChangesLocked ? "종료 이후에는 참가자 상태를 변경할 수 없으며 이 상태가 보고서에 남습니다. " : ""}<ProductLink href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인 필요 명단 보기</ProductLink></ConsoleFeedback> : null}
      {needsReview ? (
        <div>
          {needsRefresh || refreshing
            ? <ProductButton type="button" variant="secondary" disabled={busy || refreshing} onClick={onRefresh}>{refreshing ? "최신 집계 확인 중" : "최신 집계 다시 불러오기"}</ProductButton>
            : <ProductButton type="button" variant="secondary" disabled={busy} onClick={onAccept}>최신 집계 사용</ProductButton>}
        </div>
      ) : null}
    </div>
  );
}

function attendanceChanges(report: Report | null | undefined, latest: Ready["metrics"]) {
  const snapshot = report?.snapshot?.metrics;
  return ATTENDANCE_LABELS.flatMap(([key, label]) => {
    const saved = snapshot?.[key];
    return typeof saved === "number" && Number.isSafeInteger(saved) && saved >= 0 && saved !== latest[key]
      ? [{ label, saved, current: latest[key] }] : [];
  });
}

// Frozen snapshot timestamps render as a compact local wall time so the
// 집계 기준 stays distinct from date-only shared/published stamps.
function capturedLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function snapshotImageFileId(image: unknown): string {
  if (typeof image !== "object" || image === null || Array.isArray(image)) return "";
  const fileId = (image as Record<string, unknown>).fileId;
  return typeof fileId === "string" ? fileId : "";
}

function reportFragment(id: string): string {
  return `report-${encodeURIComponent(id)}`;
}

// Client-only file read, used to inline an approved event photo into a PPTX
// slide (pptxgenjs needs a data URL or raw bytes, not a same-origin <img src>).
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

// Three colors reserved for distinguishing registration groups by series,
// dataviz-skill validated (apps/web/app/tokens.css: --series-blue/orange/aqua).
// Never used for anything else on this screen.
const SERIES_COLORS = ["var(--series-blue)", "var(--series-orange)", "var(--series-aqua)"];

// A chart segment is only ever drawn from fully verified counts: any
// missing, non-integer, or negative count (or an empty/zero total) cancels
// the whole chart, never a partially fabricated bar. The existing per-item
// text line (snapshotValue) keeps showing "확인 불가" regardless.
function reportGroupChart(items: Array<{ name?: unknown; count?: unknown }>): Array<{ name: string; count: number; color: string }> | null {
  if (!items.length) return null;
  const counts = items.map((item) => item.count);
  if (counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) return null;
  if ((counts as number[]).reduce((sum, count) => sum + count, 0) <= 0) return null;
  return items.map((item, index) => ({
    name: text(item.name) || "이름 확인 불가",
    count: item.count as number,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  }));
}

// Keeps both saved/current points inside a [12,88]% band so end labels never
// clip, scaled per-row (each metric has its own range, not a shared domain).
function dumbbellPercents(saved: number, current: number): { a: number; b: number } {
  const max = Math.max(saved, current, 1);
  const span = 76;
  return { a: 12 + (saved / max) * span, b: 12 + (current / max) * span };
}

function programChartRows(items: Array<{ name?: unknown; responses?: unknown }>): Array<{ name: string; value: number }> {
  return items.flatMap((item) => {
    const value = item.responses;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? [{ name: text(item.name) || "이름 확인 불가", value }]
      : [];
  });
}

// An aggregate satisfaction meter is only shown when every module's own
// average is itself a verified number; otherwise it stays silent instead of
// averaging over an unknown or "확인 불가" value.
function overallSurveyAverage(items: Array<{ average?: unknown }>): number | null {
  if (!items.length) return null;
  const values = items.map((item) => {
    const value = item.average;
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    return NaN;
  });
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 5)) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export default function ReportsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReportFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editReport, setEditReport] = useState<Report | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishIntent, setPublishIntent] = useState<{ id: string; version: number } | null>(null);
  const [successorId, setSuccessorId] = useState<string | null>(null);
  const [successorSource, setSuccessorSource] = useState("current");
  const [successorAttendance, setSuccessorAttendance] = useState<ReportAttendance | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [closeReportId, setCloseReportId] = useState<string | null>(null);
  const closeCreateRef = useRef(false);
  const detailFocusRef = useRef(false);
  const closePublishedFocusRef = useRef(false);
  const pendingCommandsRef = useRef(new Map<string, string>());
  const sendingRef = useRef(false);
  const [pendingReport, setPendingReport] = useState<ReportAttempt | null>(null);
  const pendingReportRef = useRef<ReportAttempt | null>(null);
  const activeEventRef = useRef(eventId);
  activeEventRef.current = eventId;
  const [checkingReport, setCheckingReport] = useState(false);
  const [pptxBusy, setPptxBusy] = useState(false);
  const [abandonReportConfirm, setAbandonReportConfirm] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const otherReportReceipt = useEventReceipts(eventId).some((item) =>
    ["report.create", "report.update", "report.publish", "report.successor"].includes(item.command) && item.commandId !== pendingReportRef.current?.commandId);
  useEffect(() => {
    if (!pendingReport || pendingReport.eventId !== eventId) return;
    return manageOperatorReceipt(pendingReport.commandId);
  }, [eventId, pendingReport]);
  // Tracks a dialog save whose outcome is still unknown (ambiguous failure
  // kept its idempotent key). Dismissal must warn that it may already have
  // applied instead of claiming a cancel.
  const dialogUnresolvedRef = useRef(false);

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 읽기·내보내기(내용 보기·JSON 저장·인쇄)만 둡니다.
  // 보고서 작성·게시(report.*)는 결과 쓰기 권한이 필요하며, 서버가 매번 다시
  // 확인합니다. 읽기와 마감 지도·전제 확인은 구성원 자격이면 열립니다.
  const reportCapability = state.kind === "ready"
    ? { role: state.role, userId: state.userId, memberships: state.memberships, eventId }
    : null;
  const canWriteReports = reportCapability
    ? canWriteEvent(reportCapability, "report.create")
    : false;
  const permissionWriteLocked = state.kind === "ready" && (state.archived || !canWriteReports);
  const writeLocked = permissionWriteLocked || Boolean(pendingReport) || otherReportReceipt;
  useConsoleDraftGuard(Boolean(pendingReport), "보고서가 이미 저장되었을 수 있습니다. 화면을 떠나면 원래 입력은 복원되지 않습니다.");
  useEffect(() => {
    if (pendingReportRef.current && pendingReportRef.current.eventId !== eventId) {
      pendingReportRef.current = null;
      setPendingReport(null);
      pendingCommandsRef.current.clear();
      dialogUnresolvedRef.current = false;
      setRecoveryError(null);
      setAbandonReportConfirm(false);
    }
  }, [eventId]);
  const hadOtherReportReceipt = useRef(false);
  useEffect(() => {
    if (hadOtherReportReceipt.current && !otherReportReceipt && !pendingReportRef.current) setReloadTick((tick) => tick + 1);
    hadOtherReportReceipt.current = otherReportReceipt && !sendingRef.current;
  }, [eventId, otherReportReceipt]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    function readFailed(message: string) {
      setRefreshFailure(message);
      setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
    }
    async function load() {
      setRefreshing(true);
      try {
        const [meRes, res] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal }),
        ]);
        if (cancelled) return;
        if (meRes.status === 401 || res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const me = (await meRes.json().catch(() => null)) as {
          user?: { id?: unknown; role?: unknown } | null;
        } | null;
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            clients?: unknown;
            workspaces?: Record<string, Record<string, unknown>>;
            memberships?: unknown;
          } | null;
        } | null;
        if (cancelled) return;
        const bootstrap = data?.state;
        if (!meRes.ok || !res.ok || !me?.user || !bootstrap) {
          const message = "결과 데이터를 불러오지 못했습니다.";
          if ([403, 404].some((status) => res.status === status || meRes.status === status)) setState({ kind: "failed", message });
          else readFailed(message);
          return;
        }
        const role = typeof me.user.role === "string" ? me.user.role : "";
        const userId = typeof me.user.id === "string" ? me.user.id : "";
        // Raw membership grants ride along untouched (omitted write is full
        // access, [] is read-only); the results probe below re-checks report
        // commands through the capability helper. Reads stay open to members.
        const memberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const membership = item as Record<string, unknown>;
              if (typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
            })
          : [];
        const event = (Array.isArray(bootstrap.events) ? bootstrap.events : []).find(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null &&
            (item as Record<string, unknown>).id === eventId
        );
        const workspace = bootstrap.workspaces?.[eventId];
        if (!event || !workspace) {
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        const asList = (value: unknown): Record<string, unknown>[] =>
          Array.isArray(value)
            ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
            : [];
        // A truncated response must not turn an absent projected list into a
        // credible zero, even if its availability marker survived.
        const sources = reportSources(workspace.reportSourceAvailability);
        for (const key of ["participants", "checks", "responses", "modules", "booths", "questions", "photos"] as const) {
          sources[key] = sources[key] && Array.isArray(workspace[key]) && asList(workspace[key]).length === workspace[key].length;
        }
        sources.groups = sources.groups && Array.isArray(workspace.groups) && workspace.groups.every((group) => typeof group === "string");
        sources.venue = sources.venue && typeof workspace.venue === "object" && workspace.venue !== null && !Array.isArray(workspace.venue);
        sources.survey = sources.survey && sources.modules && sources.responses;
        sources.draw = sources.draw && sources.modules;
        const people = asList(workspace.participants).filter((person) => String(person.status || "").toUpperCase() !== "CANCELLED");
        const responses = asList(workspace.responses);
        const modules = asList(workspace.modules);
        const questions = asList(workspace.questions);
        const photos = asList(workspace.photos).filter((photo) => photo.status === "APPROVED");
        const clients = asList(bootstrap.clients);
        const clientName = clients.find((client) => client.id === event.clientId)?.name;
        const surveys = modules
          .filter((module) => module.type === "survey")
          .map((module) => {
            const moduleResponses = responses.filter((response) => response.moduleId === module.id);
            const values = moduleResponses.flatMap((response) =>
              Object.values(
                typeof response.ratings === "object" && response.ratings !== null
                  ? (response.ratings as Record<string, unknown>)
                  : {}
              ).map(Number).filter((value) => Number.isFinite(value))
            );
            const names = Array.isArray(module.questions) && module.questions.length
              ? module.questions.filter((name): name is string => typeof name === "string")
              : [];
            return {
              name: text(module.title),
              count: moduleResponses.length,
              average: averageLabel(values),
              questions: names.map((name) => {
                const ratings = moduleResponses
                  .map((response) => {
                    const ratings = response.ratings;
                    if (typeof ratings !== "object" || ratings === null) return undefined;
                    return (ratings as Record<string, unknown>)[name];
                  })
                  .filter((value) => value !== undefined)
                  .map(Number)
                  .filter((value) => Number.isFinite(value));
                return { name, average: averageLabel(ratings), count: ratings.length };
              }),
            };
          });
        const venue = typeof workspace.venue === "object" && workspace.venue !== null
          ? (workspace.venue as Record<string, unknown>)
          : {};
        if (!cancelled) {
          setRefreshFailure(null);
          setLoadedAt(new Date().toISOString());
          setState({
            kind: "ready",
            eventName: text(event.name) || "이름 없는 행사",
            eventMeta: formatConsoleEventMeta({
              clientName: text(clientName),
              date: text(event.date),
              start: text(event.start),
              end: text(event.end),
              venue: text(venue.name),
            }),
            archived: text(event.stage).toUpperCase() === "ARCHIVED",
            stage: text(event.stage).toUpperCase(),
            role,
            userId,
            memberships,
            sources,
            cancellationReviewSupported: workspace.reportCancellationReviewVersion === 1,
            // Live archive prerequisites, kept apart from the frozen
            // snapshots below: intake state and still-open programs are
            // what the settings stage gate checks before 보관.
            registrationOpen: workspace.registrationOpen === true,
            archiveAvailable: readCloseSnapshot(event, workspace).archiveAvailable,
            features: Array.isArray(event.features) ? event.features.filter((feature): feature is string => typeof feature === "string") : [],
            openModules: modules
              .filter((module) => text(module.status).toUpperCase() === "OPEN")
              .map((module) => ({ name: text(module.title) || "이름 없는 프로그램", type: text(module.type) })),
            metrics: {
              total: people.length,
              pending: people.filter((person) => person.status === "PENDING").length,
              approved: people.filter((person) => person.status === "APPROVED").length,
              checked: people.filter((person) => person.everIn === true).length,
              inside: people.filter((person) => person.inside === true).length,
              attendanceReview: people.filter((person) => attendanceNeedsReview(person)).length,
              cancellationReview: people.filter(cancellationNeedsReview).length,
              rate: people.length
                ? Math.round((people.filter((person) => person.everIn === true).length / people.length) * 100)
                : 0,
            },
            groups: (Array.isArray(workspace.groups) ? workspace.groups : [])
              .filter((name): name is string => typeof name === "string")
              .map((name) => ({ name, count: people.filter((person) => person.group === name).length })),
            booths: asList(workspace.booths).map((booth) => ({
              name: text(booth.name),
              used: num(booth.used),
              capacity: num(booth.capacity),
            })),
            programs: modules.map((module) => ({
              name: text(module.title),
              type: text(module.type),
              responses: text(module.type) === "qa"
                ? questions.filter((question) => question.moduleId === module.id).length
                : text(module.type) === "draw"
                  ? asList(module.drawHistory).reduce(
                      (sum, result) => sum + asList(result.winners).length,
                      0
                    )
                  : responses.filter((response) => response.moduleId === module.id).length,
            })),
            surveys,
            photoCount: photos.length,
            photoCaptions: photos.map((photo) => text(photo.caption)).filter(Boolean).slice(0, 20),
            reports: asList(workspace.reports).flatMap((item) =>
              typeof item.id === "string" && item.id
                ? [{
                    id: item.id,
                    title: text(item.title),
                    subtitle: text(item.subtitle),
                    coverNote: text(item.coverNote),
                    summary: text(item.summary),
                    sections: Array.isArray(item.sections)
                      ? item.sections.filter((section): section is string => typeof section === "string")
                      : [],
                    color: /^#[0-9a-f]{6}$/i.test(text(item.color)) ? text(item.color).toUpperCase() : "#E76D26",
                    status: text(item.status) || "DRAFT",
                    version: Number(item.version) || 1,
                    createdAt: text(item.createdAt),
                    publishedAt: text(item.publishedAt),
                    familyId: typeof item.familyId === "string" ? item.familyId : undefined,
                    snapshot: (typeof item.snapshot === "object" && item.snapshot !== null
                      ? (item.snapshot as ReportSnapshot)
                      : null),
                  }]
                : []
            ),
          });
        }
      } catch {
        if (!cancelled) {
          readFailed("연결하지 못했습니다. 다시 시도하세요.");
        }
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setRefreshing(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [eventId, router, reloadTick]);

  const detail = useMemo(() => {
    if (state.kind !== "ready" || !detailId) return null;
    return state.reports.find((report) => report.id === detailId) ?? null;
  }, [state, detailId]);

  function openReport(id: string) {
    detailFocusRef.current = true;
    setDetailId(id);
    setPublishIntent(null);
    setSuccessorId(null);
    const url = new URL(window.location.href);
    url.hash = reportFragment(id);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  useEffect(() => {
    const readSelection = () => setCloseReportId(new URLSearchParams(window.location.search).get("closeReport"));
    readSelection();
    window.addEventListener("popstate", readSelection);
    return () => window.removeEventListener("popstate", readSelection);
  }, [eventId]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const focusTarget = () => {
      if (closePublishedFocusRef.current && detail?.status === "PUBLISHED") {
        const next = document.querySelector<HTMLAnchorElement>("[data-close-report-next]");
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: "center" });
        closePublishedFocusRef.current = false;
        return;
      }
      // A returned fragment may be repeated by client navigation. Keep the
      // public hub anchor canonical, including subsequent hash-only jumps.
      if (/^#event-close(?:#event-close)+$/.test(window.location.hash)) {
        const url = new URL(window.location.href);
        url.hash = "event-close";
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      const target = detailFocusRef.current && detail ? "report-detail" : window.location.hash === "#event-close" ? "event-close" : null;
      if (!target) return;
      const heading = document.getElementById(target);
      heading?.setAttribute("tabindex", "-1");
      heading?.scrollIntoView({ block: "start" });
      heading?.focus({ preventScroll: true });
      detailFocusRef.current = false;
    };
    const frame = requestAnimationFrame(focusTarget);
    window.addEventListener("hashchange", focusTarget);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", focusTarget); };
  }, [state, detail]);

  // The open report stays addressable: the hash carries the detail id, so a
  // checklist deep-link round-trip (or a copied URL) restores the same open
  // report instead of dropping the operator back at the list. Section
  // anchors (#reports-*) are never touched; only #report-* is managed here.
  useEffect(() => {
    const readDetail = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#report-")) return;
      setPublishIntent(null);
      setSuccessorId(null);
      try {
        const match = /^#report-([^#]+)$/.exec(hash);
        if (match?.[1]) setDetailId(decodeURIComponent(match[1]));
        else setDetailId(null);
      } catch {
        setDetailId(null);
      }
    };
    readDetail();
    window.addEventListener("hashchange", readDetail);
    window.addEventListener("popstate", readDetail);
    return () => {
      window.removeEventListener("hashchange", readDetail);
      window.removeEventListener("popstate", readDetail);
    };
  }, [eventId]);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (detailId) {
        url.hash = reportFragment(detailId);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      } else if (/^#report-/.test(url.hash)) {
        url.hash = "";
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // The address bar stays as-is; the open report still renders.
    }
  }, [detailId]);

  async function runCommand(
    command: string,
    payload: Record<string, unknown>,
    successMessage: string,
    fromDialog = false
  ): Promise<boolean> {
    if (sendingRef.current) return false;
    if (permissionWriteLocked) {
      setFailure({ message: "보관된 행사는 읽기 전용입니다." });
      return false;
    }
    const attempt = JSON.stringify([eventId, command, payload]);
    const prior = pendingReportRef.current;
    if ((prior && prior.fingerprint !== attempt) || (!prior && otherReportReceipt)) {
      setFailure({ message: "이전 보고서 처리 결과를 먼저 확인하세요." });
      return false;
    }
    sendingRef.current = true;
    const commandId = pendingCommandsRef.current.get(attempt) ?? randomCommandId();
    pendingCommandsRef.current.set(attempt, commandId);
    const request: ReportAttempt = prior ?? { eventId, command, payload: structuredClone(payload), fingerprint: attempt, commandId, successMessage, fromDialog, uncertain: false };
    const markUncertain = () => {
      request.uncertain = true;
      if (activeEventRef.current === request.eventId) {
        pendingReportRef.current = request;
        setPendingReport(request);
        dialogUnresolvedRef.current = request.fromDialog;
      }
    };
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const res = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        code?: unknown;
        report?: { id?: unknown };
      } | null;
      if (activeEventRef.current !== request.eventId) return false;
      if (!res.ok) {
        const attendanceConflict = res.status === 409 && data?.field === "expectedAttendance";
        const uncertain = !attendanceConflict && (request.uncertain || res.status >= 500 || [408, 425, 429].includes(res.status));
        if (uncertain) markUncertain(); else pendingCommandsRef.current.delete(attempt);
        if (attendanceConflict) {
          acknowledgeOperatorReceipt(commandId);
          forgetOperatorReceipt(commandId);
          pendingReportRef.current = null;
          setPendingReport(null);
          dialogUnresolvedRef.current = false;
          setReloadTick((tick) => tick + 1);
        } else if (!uncertain && res.status === 409 && data?.field === "expectedVersion") {
          if (command === "report.publish") setPublishIntent(null);
          setReloadTick((tick) => tick + 1);
        }
        setFailure({
          message: uncertain ? "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요." : typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
          field: !uncertain && typeof data?.field === "string" ? data.field : undefined,
          code: !uncertain && typeof data?.code === "string" ? data.code : undefined,
          attendanceReadAt: attendanceConflict ? loadedAt ?? "" : undefined,
        });
        return false;
      }
      if (!data || typeof data.report?.id !== "string" || !confirmsReportCommand(command, commandId, payload, data)) {
        markUncertain();
        setFailure({ message: "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요." });
        return false;
      }
      pendingCommandsRef.current.delete(attempt);
      acknowledgeOperatorReceipt(commandId);
      forgetOperatorReceipt(commandId);
      if (activeEventRef.current === request.eventId) {
        pendingReportRef.current = null;
        setPendingReport(null);
        dialogUnresolvedRef.current = false;
      }
      if (command === "report.publish" && payload.id === closeReportId) closePublishedFocusRef.current = true;
      if (command === "report.create" && closeCreateRef.current) {
        setCloseReportId(data.report.id);
        const url = new URL(window.location.href);
        url.searchParams.set("closeReport", data.report.id);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        openReport(data.report.id);
        closeCreateRef.current = false;
      }
      setNotice(successMessage);
      setReloadTick((tick) => tick + 1);
      return true;
    } catch (error) {
      if (activeEventRef.current !== request.eventId) return false;
      if (isOrganizationContextBlock(error) && !request.uncertain) {
        pendingCommandsRef.current.delete(attempt);
        setFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        markUncertain();
        setFailure({ message: "연결하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요." });
      }
      return false;
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  async function resolveReportAttempt(mode: "status" | "retry") {
    const attempt = pendingReportRef.current;
    if (!attempt || attempt.eventId !== eventId || checkingReport || sendingRef.current) return;
    setCheckingReport(true);
    setRecoveryError(null);
    try {
      if (mode === "retry") {
        const ok = await runCommand(attempt.command, attempt.payload, attempt.successMessage, attempt.fromDialog);
        if (!ok) { setRecoveryError("결과를 아직 확인하지 못했습니다. 원래 요청은 유지됩니다."); return; }
      } else {
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
        const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
        if (activeEventRef.current !== attempt.eventId) return;
        if (response.ok && data?.status === "UNCONFIRMED") {
          setRecoveryError("아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요."); return;
        }
        if (!response.ok || data?.status !== "APPLIED" || data.command !== attempt.command) {
          setRecoveryError(response.status >= 500 || [425, 429].includes(response.status)
            ? "일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요."
            : "결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
          return;
        }
        pendingCommandsRef.current.delete(attempt.fingerprint);
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        pendingReportRef.current = null;
        setPendingReport(null);
        dialogUnresolvedRef.current = false;
        if (attempt.command === "report.publish" && attempt.payload.id === closeReportId) closePublishedFocusRef.current = true;
        if (attempt.command === "report.create" && closeCreateRef.current) {
          setCloseReportId(attempt.commandId);
          const url = new URL(window.location.href);
          url.searchParams.set("closeReport", attempt.commandId);
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          openReport(attempt.commandId);
          closeCreateRef.current = false;
        }
        setNotice("보고서 처리가 서버에 반영된 것을 확인했습니다. 최신 내용을 확인하세요.");
        setReloadTick((tick) => tick + 1);
      }
      if (activeEventRef.current !== attempt.eventId) return;
      if (attempt.fromDialog) setCreateOpen(false);
      setFailure(null);
      setPublishIntent(null);
      setSuccessorId(null);
    } catch {
      setRecoveryError("서버에 연결하지 못했습니다. 보고서 요청은 다시 보내지 않았습니다.");
    } finally { setCheckingReport(false); }
  }

  function reportRecovery(): ReactNode {
    if (!pendingReport) return null;
    return <section className={styles.recovery} aria-labelledby="report-recovery-heading">
      <h2 id="report-recovery-heading">보고서 처리 확인 필요</h2>
      <p>서버 확인은 보고서를 다시 만들거나 변경하지 않습니다.</p>
      {recoveryError ? <p role="alert">{recoveryError}</p> : null}
      <div className={styles.recoveryActions}>
        <ProductButton type="button" variant="secondary" disabled={checkingReport || busy || abandonReportConfirm} onClick={() => void resolveReportAttempt("status")}>서버 처리 확인</ProductButton>
        <ProductButton type="button" variant="secondary" disabled={checkingReport || busy || abandonReportConfirm} onClick={() => void resolveReportAttempt("retry")}>같은 요청 다시 시도</ProductButton>
        <ProductButton type="button" variant="secondary" disabled={checkingReport || busy || abandonReportConfirm} onClick={() => setAbandonReportConfirm(true)}>확인 전 그만두기</ProductButton>
      </div>
      {abandonReportConfirm ? <ConsoleConfirm
        summary="이미 반영된 보고서 처리는 취소되지 않습니다. 입력 화면을 닫고 최신 목록을 확인할까요?"
        confirmLabel="확인 그만두기"
        onConfirm={() => {
          const attempt = pendingReportRef.current;
          if (!attempt) return;
          pendingCommandsRef.current.delete(attempt.fingerprint);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          pendingReportRef.current = null;
          setPendingReport(null);
          dialogUnresolvedRef.current = false;
          setAbandonReportConfirm(false);
          if (attempt.fromDialog) setCreateOpen(false);
          closeCreateRef.current = false;
          setPublishIntent(null);
          setSuccessorId(null);
          setFailure(null);
          setNotice("확인을 그만두었습니다. 서버 처리는 취소되지 않았으므로 최신 보고서를 확인하세요.");
          setReloadTick((tick) => tick + 1);
        }}
        onCancel={() => setAbandonReportConfirm(false)}
      /> : null}
    </section>;
  }

  const articleRef = useRef<HTMLElement>(null);
  // Local view only: A4 portrait (default) or 16:9 presentation width for
  // the selected frozen article. It changes on-screen measure only — never
  // the stored report version, payload, snapshot, or live analysis — and
  // adds no command, receipt, or template editing. Printing always prints
  // the frozen article as-is with natural pagination; paper orientation
  // follows the browser print dialog (see the note below the toggle).
  const [printLayout, setPrintLayout] = useState<"a4" | "wide">("a4");

  function cleanupReportPrint() {
    if (typeof document === "undefined") return;
    document.getElementById("eventouch-report-print")?.remove();
    document.body.classList.remove("report-printing");
  }

  const printCleanupRef = useRef<(() => void) | null>(null);
  const [printPreparation, setPrintPreparation] = useState<{ id: string; version: number; state: "preparing" | "failed" } | null>(null);
  const printStatus = printPreparation?.id === detail?.id && printPreparation?.version === detail?.version
    ? printPreparation?.state : undefined;

  // Print the chosen saved snapshot. Prepare images in the hidden clone before
  // entering print mode, where the live analysis and console stay hidden.
  async function printReport(report: Report, omitPhotos = false) {
    const source = articleRef.current;
    if (!source || printCleanupRef.current) return;
    cleanupReportPrint();
    const clone = source.cloneNode(true) as HTMLElement;
    clone.id = "eventouch-report-print";
    clone.dataset.layout = printLayout;
    clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    const photos = Array.from(clone.querySelectorAll("img"));
    const retryKey = printStatus === "failed" ? String(Date.now()) : null;
    for (const photo of photos) {
      if (omitPhotos) {
        photo.replaceWith(document.createTextNode("사진은 제외했습니다."));
      } else {
        photo.loading = "eager";
        if (retryKey) {
          const url = new URL(photo.src);
          url.searchParams.set("printRetry", retryKey);
          photo.src = url.href;
        }
      }
    }

    const media = window.matchMedia("print");
    let timeout: number | undefined;
    const finish = () => {
      if (printCleanupRef.current !== finish) return;
      printCleanupRef.current = null;
      window.removeEventListener("afterprint", finish);
      window.removeEventListener("pagehide", handlePageHide);
      media.removeEventListener("change", handleMedia);
      cleanupReportPrint();
    };
    const handleMedia = () => {
      if (!media.matches) finish();
    };
    const handlePageHide = () => {
      finish();
      setPrintPreparation(null);
    };
    printCleanupRef.current = finish;
    window.addEventListener("afterprint", finish);
    window.addEventListener("pagehide", handlePageHide);
    media.addEventListener("change", handleMedia);
    document.body.appendChild(clone);

    if (!omitPhotos && photos.length > 0) {
      setPrintPreparation({ id: report.id, version: report.version, state: "preparing" });
      try {
        await Promise.race([
          Promise.all(photos.map(photo => photo.decode())),
          new Promise<never>((_, reject) => {
            timeout = window.setTimeout(() => reject(new Error("Photo load timed out")), 8000);
          }),
        ]);
      } catch {
        if (printCleanupRef.current === finish) {
          finish();
          setPrintPreparation({ id: report.id, version: report.version, state: "failed" });
        }
        return;
      } finally {
        window.clearTimeout(timeout);
      }
    }
    if (printCleanupRef.current !== finish) return;
    if (!source.isConnected || source.closest("[hidden]")) {
      finish();
      setPrintPreparation(null);
      return;
    }

    if (!omitPhotos) setPrintPreparation(null);
    document.body.classList.add("report-printing");
    window.print();
  }

  useEffect(() => {
    setPrintPreparation(null);
    return () => printCleanupRef.current?.();
  }, [detail?.id, detail?.version]);

  function exportJson(report: Report) {
    const blob = new Blob(
      [JSON.stringify({ ...report, exportedAt: new Date().toISOString() }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `EVENTOUCH_report_v${report.version}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // PPTX export is client-only, like the participant roster's xlsx export:
  // no server route or command. pptxgenjs is dynamically imported so it never
  // loads on the server bundle. This is a simple one-shot fill of a cover
  // slide plus a few body slides from the already-frozen snapshot; decorating
  // the result is explicitly left to PowerPoint/Keynote/Canva (see the export
  // note beside the button). A photo that fails to load only drops that one
  // photo — it never blocks the rest of the file.
  async function exportPptx(report: Report) {
    if (pptxBusy) return;
    setPptxBusy(true);
    setFailure(null);
    try {
      const PptxGenJS = (await import("pptxgenjs")).default;
      const pres = new PptxGenJS();
      pres.defineLayout({ name: "EVENTOUCH_16x9", width: 10, height: 5.63 });
      pres.layout = "EVENTOUCH_16x9";
      const FONT = "Pretendard";
      const snapshot = report.snapshot;
      const metricsRaw = snapshot?.metrics;
      const metrics = typeof metricsRaw === "object" && metricsRaw !== null && !Array.isArray(metricsRaw)
        ? metricsRaw as Record<string, unknown> : null;
      const eventFacts = [text(snapshot?.event?.name), text(snapshot?.event?.date), text(snapshot?.event?.client), text(snapshot?.event?.venue)]
        .filter(Boolean).join(" · ");

      const cover = pres.addSlide();
      cover.background = { color: "1E2026" };
      cover.addText("EVENTOUCH · 결과 보고서", { x: 0.6, y: 0.9, w: 8.8, h: 0.5, fontSize: 14, bold: true, color: "EA552E", fontFace: FONT });
      cover.addText(report.title || "결과 보고서", { x: 0.6, y: 1.5, w: 8.8, h: 1.4, fontSize: 36, bold: true, color: "FFFFFF", fontFace: FONT });
      if (report.subtitle) cover.addText(report.subtitle, { x: 0.6, y: 2.9, w: 8.8, h: 0.6, fontSize: 18, color: "C9CDD3", fontFace: FONT });
      if (eventFacts) cover.addText(eventFacts, { x: 0.6, y: 3.5, w: 8.8, h: 0.5, fontSize: 13, color: "A9AEB6", fontFace: FONT });
      cover.addText(
        `집계 기준 ${capturedLabel(snapshot?.capturedAt) || "확인 필요"} · 버전 ${report.version}`,
        { x: 0.6, y: 4.9, w: 8.8, h: 0.4, fontSize: 11, color: "8A939F", fontFace: FONT }
      );

      const summarySlide = pres.addSlide();
      summarySlide.addText("핵심 숫자", { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 22, bold: true, color: "1E2026", fontFace: FONT });
      if (report.summary) summarySlide.addText(report.summary, { x: 0.5, y: 1.0, w: 9, h: 0.7, fontSize: 13, color: "61656C", fontFace: FONT });
      if (metrics) {
        const cells: Array<[string, string]> = [
          ["등록", snapshotValue(metrics.total, "명")],
          ["누적 입장", snapshotValue(metrics.checked, "명")],
          ["현재 입장", snapshotValue(metrics.inside, "명")],
          ["입장률", snapshotValue(metrics.rate, "%", 100)],
        ];
        cells.forEach(([label, value], index) => {
          const x = 0.5 + (index % 2) * 4.6;
          const y = 2.0 + Math.floor(index / 2) * 1.3;
          summarySlide.addText(value, { x, y, w: 4.2, h: 0.7, fontSize: 28, bold: true, color: "EA552E", fontFace: FONT });
          summarySlide.addText(label, { x, y: y + 0.7, w: 4.2, h: 0.4, fontSize: 13, color: "61656C", fontFace: FONT });
        });
      } else {
        summarySlide.addText("저장된 참가·입장 집계를 확인할 수 없습니다.", { x: 0.5, y: 2.0, w: 9, h: 0.5, fontSize: 14, color: "81520E", fontFace: FONT });
      }

      const programs = snapshotRecords(snapshot?.programs).items;
      if (report.sections.includes("programs") && programs?.length) {
        const slide = pres.addSlide();
        slide.addText("참여 콘텐츠", { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 22, bold: true, color: "1E2026", fontFace: FONT });
        programs.slice(0, 8).forEach((program, index) => {
          const y = 1.2 + index * 0.5;
          slide.addText(
            `${text(program.name) || "이름 확인 불가"} · ${snapshotValue(program.responses, "건")}`,
            { x: 0.5, y, w: 9, h: 0.45, fontSize: 14, color: "1E2026", fontFace: FONT }
          );
        });
      }

      const surveys = snapshotRecords(snapshot?.survey).items;
      if (report.sections.includes("survey") && surveys?.length) {
        const slide = pres.addSlide();
        slide.addText("행사 만족도", { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 22, bold: true, color: "1E2026", fontFace: FONT });
        surveys.slice(0, 8).forEach((survey, index) => {
          const y = 1.2 + index * 0.5;
          slide.addText(
            `${text(survey.name) || "이름 확인 불가"} · 평균 ${snapshotAverage(survey.average)} · 응답 ${snapshotValue(survey.count, "명")}`,
            { x: 0.5, y, w: 9, h: 0.45, fontSize: 14, color: "1E2026", fontFace: FONT }
          );
        });
      }

      const photoRecords = report.sections.includes("photos") ? snapshotRecords(snapshot?.photos).items ?? [] : [];
      const inlinedPhotos: Array<{ data: string; caption: string }> = [];
      for (const photo of photoRecords.slice(0, 6)) {
        const fileId = snapshotImageFileId(photo.image);
        if (!fileId) continue;
        try {
          const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}`, { cache: "no-store" });
          if (!response.ok) continue;
          const data = await blobToDataUrl(await response.blob());
          inlinedPhotos.push({ data, caption: text(photo.caption) || "설명 없음" });
        } catch {
          // Skip only this photo; the rest of the export still proceeds.
        }
      }
      for (let i = 0; i < inlinedPhotos.length; i += 2) {
        const slide = pres.addSlide();
        slide.addText("행사 사진", { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 22, bold: true, color: "1E2026", fontFace: FONT });
        inlinedPhotos.slice(i, i + 2).forEach((entry, index) => {
          const x = 0.5 + index * 4.6;
          slide.addImage({ data: entry.data, x, y: 1.2, w: 4.2, h: 3.0, sizing: { type: "cover", w: 4.2, h: 3.0 } });
          slide.addText(entry.caption, { x, y: 4.25, w: 4.2, h: 0.4, fontSize: 12, color: "61656C", fontFace: FONT });
        });
      }

      const blob = (await pres.write({ outputType: "blob" })) as Blob;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `EVENTOUCH_report_v${report.version}.pptx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailure({ message: "PPTX 파일을 만들지 못했습니다. 다시 시도하거나 JSON 원본으로 내려받으세요." });
    } finally {
      setPptxBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="reports" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="결과 데이터를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="reports" eventId={eventId}>
        {/* Shared panel dispatches eventouch:shell-reload before calling this page's retry. */}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }

  const sectionLabel = (id: string) =>
    SECTION_LABELS.find((section) => section.id === id)?.label ?? "항목 확인 필요";
  const sources = state.sources;
  const attendanceAvailable = sources.participants && sources.checks;
  const reportSourcesAvailable = Object.values(sources).every(Boolean) && state.cancellationReviewSupported;
  const missingSources = (Object.keys(REPORT_SOURCE_LABELS) as ReportSource[])
    .filter((key) => !sources[key] && !(key === "survey" && (!sources.modules || !sources.responses)) && !(key === "draw" && !sources.modules))
    .map((key) => REPORT_SOURCE_LABELS[key]);
  const missingSourceText = [...missingSources, ...(!state.cancellationReviewSupported ? ["취소 기록 검토"] : [])].join(" · ") || "행사";
  const closeReport = state.reports.find((report) => report.id === closeReportId);
  // One quiet line above the report switcher: where the close flow stands
  // and the way back to its map. The full 7-step map stays in 행사 마감.
  const closeStatus = (() => {
    if (!(attendanceAvailable && sources.modules && state.archiveAvailable)) return null;
    const step = closePrerequisite({ stage: state.stage, pending: state.metrics.pending, registrationOpen: state.registrationOpen, openModules: state.openModules, features: state.features });
    const frozenReport = closeReport?.status === "PUBLISHED";
    const position = step === "pending" ? 1 : step === "features" || step === "programs" ? 2 : step === "intake" ? 3 : step === "stage" ? 4 : step === "archived" ? 7 : frozenReport ? 6 : 5;
    const label = step === "pending" ? "승인 대기 처리하기"
      : step === "features" || step === "programs" ? "진행 프로그램 정리하기"
        : step === "intake" ? "참가 접수 닫기"
          : step === "stage" ? "행사 종료 확인하기"
            : step === "archived" ? "보관 완료"
              : frozenReport ? "결과 안내 작성·확인하기" : "보고서 검토·동결하기";
    return { position, label, done: step === "archived" };
  })();
  const detailAttendanceChanges = attendanceAvailable ? attendanceChanges(detail, state.metrics) : [];
  const savedPrograms = snapshotRecords(detail?.snapshot?.programs);
  const savedBooths = snapshotRecords(detail?.snapshot?.booths);
  const savedSurveys = snapshotRecords(detail?.snapshot?.survey);
  const savedPhotos = snapshotRecords(detail?.snapshot?.photos);
  const savedGroups = snapshotRecords(detail?.snapshot?.groups);
  // Visual layer only: every chart below is derived from the same saved*
  // values above and renders nothing the existing text lines do not already
  // say. A null/empty result silently omits the chart, never a fabricated one.
  const groupChart = savedGroups.items ? reportGroupChart(savedGroups.items) : null;
  const groupChartTotal = groupChart ? groupChart.reduce((sum, segment) => sum + segment.count, 0) : 0;
  const programChart = [
    ...(savedPrograms.items ? programChartRows(savedPrograms.items) : []),
    ...(savedBooths.items ? programChartRows(savedBooths.items.map((booth) => ({ name: booth.name, responses: booth.used }))) : []),
  ];
  const programChartMax = programChart.length ? Math.max(...programChart.map((row) => row.value), 1) : 1;
  const surveyOverall = savedSurveys.items ? overallSurveyAverage(savedSurveys.items) : null;
  const boothCapacityRows = state.booths.filter((booth) => Number.isSafeInteger(booth.capacity) && booth.capacity > 0);

  // The deliverable owns its creation: the 만들기 control lives in the
  // list header instead of a separate toolbar strip, so 결과 문서 reads
  // as one unit (heading + action + rows) rather than label row + list.
  function openReportCreate() {
    if (writeLocked || !reportSourcesAvailable) return;
    closeCreateRef.current = false;
    setEditReport(null);
    setDetailId(null);
    setFailure(null);
    dialogUnresolvedRef.current = false;
    setCreateOpen(true);
  }

  return (
    <ConsolePage
      pageId="reports"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      sectionNav={
        <div className={styles.navIndex}>
          <p className={styles.navIndexLabel} aria-hidden="true">보고서 작업</p>
          {/* 2026-11-15 redesign: 결과 분석·보고서 내용 are no longer their
              own tab — both render inside the always-visible 보고서 panel
              (desk + rail), so the shared nav keeps only the two real
              destinations. A selected report still gets its own address via
              reportFragment/the #report-<id> hash handled below. */}
          <ConsoleSectionNav mode="tabs" initialId="reports-list"
            label="결과 보고서 구역"
            onNavigate={(id) => {
              if (id === "reports-list" || printStatus !== "preparing") return;
              printCleanupRef.current?.();
              setPrintPreparation(null);
            }}
            items={[
              { id: "event-close", label: "행사 마감" },
              { id: "reports-list", label: "보고서", fragment: detail ? reportFragment(detail.id) : "reports-list" },
            ]}
          />
        </div>
      }
      feedback={
        <>
          {failure && !createOpen && (failure.field !== "expectedVersion" || !detail) &&
            (failure.field !== "expectedAttendance" || !successorId) ? <ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback> : null}
          {refreshFailure && !createOpen ? <ConsoleFeedback kind="error">{refreshFailure} 마지막으로 확인한 내용을 표시합니다.</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {otherReportReceipt && !pendingReport ? <ConsoleFeedback kind="warning">이전 보고서의 처리 결과를 위에서 확인한 뒤 변경할 수 있습니다.</ConsoleFeedback> : null}
          {state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 분석과 보고서를 볼 수 있지만 만들거나 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
          {!state.archived && !canWriteReports ? (
            <ConsoleFeedback kind="warning">보고서 만들기·게시는 결과 쓰기 권한이 필요합니다. 분석 보기와 마감 전제 확인은 그대로 할 수 있습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      {pendingReport && !(pendingReport.fromDialog && createOpen) ? reportRecovery() : null}
      {attendanceAvailable && sources.modules && state.archiveAvailable ? <EventCloseFlow eventId={eventId}
        inputs={{ stage: state.stage, pending: state.metrics.pending, registrationOpen: state.registrationOpen, openModules: state.openModules, features: state.features }}
        loadedAt={loadedAt ? capturedLabel(loadedAt) : ""}
        report={closeReport ? {
          ...closeReport,
          capturedAt: capturedLabel(closeReport.snapshot?.capturedAt),
          attendanceChanged: attendanceAvailable && attendanceChanges(closeReport, state.metrics).length > 0,
        } : null}
        hasReports={state.reports.length > 0}
        cancellationReview={state.metrics.cancellationReview}
        canCreate={!writeLocked && reportSourcesAvailable}
        creationIssue={!reportSourcesAvailable ? missingSourceText : undefined}
        onCreate={() => { if (writeLocked || !reportSourcesAvailable) return; closeCreateRef.current = true; setEditReport(null); setDetailId(null); setFailure(null); dialogUnresolvedRef.current = false; setCreateOpen(true); }}
        onReview={() => { if (closeReportId) { openReport(closeReportId); setReloadTick((tick) => tick + 1); } }}
        refreshing={refreshing} onRefresh={() => setReloadTick((tick) => tick + 1)} /> : (
        <ConsoleSection headingId="event-close" title="행사 마감" action={<ConsoleRefreshButton label="마감 상태 새로고침" busy={refreshing} onRefresh={() => setReloadTick((tick) => tick + 1)} />}>
          <ConsoleFeedback kind="warning">참가자, 접수 또는 참여 콘텐츠 자료를 확인할 수 없어 마감 상태를 확인할 수 없습니다. 새로고침해도 계속되면 시스템 관리자에게 문의하세요.</ConsoleFeedback>
        </ConsoleSection>
      )}
      <ConsoleSection
        headingId="reports-list"
        title="보고서"
        description="생성 시점 고정 · 파일 전달 후 공유 완료 기록"
        action={(
          <div className={ui.recordActions}>
          {!reportSourcesAvailable ? <ConsoleRefreshButton label="보고서 자료 다시 확인" busy={refreshing} onRefresh={() => setReloadTick((tick) => tick + 1)} /> : null}
          <ProductButton type="button" variant={state.reports.length ? "secondary" : "primary"} disabled={writeLocked || !reportSourcesAvailable}
            onClick={openReportCreate}>
            보고서 만들기
          </ProductButton>
          </div>
        )}
      >
        {!reportSourcesAvailable ? <ConsoleFeedback kind="warning">{missingSourceText} 자료를 확인할 수 없어 현재 집계로 보고서를 만들 수 없습니다. 새로고침해도 계속되면 시스템 관리자에게 문의하세요. 기존 보고서는 확인할 수 있습니다.</ConsoleFeedback> : null}
        {/* 2026-11-15 redesign: the saved-report list is an ink-underline
            switcher (title + status dot/text), not a row list — picking a
            report and reading its content/analysis is now one always-visible
            view instead of three separately-reached sections. */}
        {closeStatus ? (
          <div className={styles.statusLine}>
            <span className={styles.statusDot} aria-hidden="true" />
            <strong>마감 {closeStatus.position}/7 · {closeStatus.label}</strong>
            {closeStatus.done ? null : (
              <ProductLink variant="ghost" href={eventCloseHref(eventId, closeReportId)} onNavigate={() => requestConsoleTask("event-close", true)}>
                마감 지도 보기 <ArrowRightIcon />
              </ProductLink>
            )}
          </div>
        ) : null}
        {state.reports.length ? (
          <div className={styles.switchbar} role="tablist" aria-label="보고서 선택">
            {state.reports.map((report) => (
              <button key={report.id} type="button" role="tab" aria-selected={detail?.id === report.id}
                className={styles.reportTab} onClick={() => openReport(report.id)}>
                <span className={styles.reportTabTitle}>{report.title}</span>
                <span className={`${styles.badge} ${report.status === "PUBLISHED" ? styles.badgePublished : styles.badgeDraft}`}>
                  {report.status === "PUBLISHED" ? "공유 완료" : "초안"}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.content}>
          <div className={styles.deskColumn}>
            {detail ? (
              <>
                <div className={styles.pageDesk}>
                  <article ref={articleRef} id="report-detail"
                    className={`${styles.reportDoc} ${printLayout === "wide" ? styles.reportDocWide : styles.reportDocA4}`} data-layout={printLayout}>
                    <div className={styles.cardBand} style={{ background: detail.color }} aria-hidden="true" />
                    <div className={styles.cardPad}>
                    <header className={styles.reportCover}>
                      <p className="eyebrow">EVENTOUCH · 결과 보고서</p>
                      <h3>{detail.title}</h3>
                      {detail.subtitle ? <p className={styles.reportSubtitle}>{detail.subtitle}</p> : null}
                      {detail.snapshot?.event ? (
                        <p className={styles.help}>
                          {[text(detail.snapshot.event.name), text(detail.snapshot.event.date), text(detail.snapshot.event.client), text(detail.snapshot.event.venue)].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                      <p className={styles.help}>버전 {detail.version} · {detail.status === "PUBLISHED" ? `공유 완료 기록 · 편집 잠김${detail.publishedAt ? ` · ${capturedLabel(detail.publishedAt)}` : ""}` : "초안"}</p>
                      {capturedLabel(detail.snapshot?.capturedAt) ? (
                        <p className={styles.help}>집계 기준 {capturedLabel(detail.snapshot?.capturedAt)}</p>
                      ) : null}
                      {detail.coverNote ? <p>{detail.coverNote}</p> : null}
                    </header>
                    {detail.sections.includes("overview") ? (
                      <section><h3>운영 요약</h3><p>{detail.summary || "운영 요약을 작성해주세요."}</p></section>
                    ) : null}
                    {detail.sections.includes("attendance") ? (
                      <section>
                        <h3>참가·입장</h3>
                        {detail.snapshot?.metrics && typeof detail.snapshot.metrics === "object" && !Array.isArray(detail.snapshot.metrics) ? <>
                        {groupChart ? (
                          <>
                            <div className={styles.stack} role="img" aria-label={groupChart.map((segment) => `${segment.name} ${segment.count}명`).join(", ")}>
                              {groupChart.map((segment) => (
                                <i key={segment.name} style={{ width: `${(segment.count / groupChartTotal) * 100}%`, background: segment.color }} />
                              ))}
                            </div>
                            <div className={styles.legend}>
                              {groupChart.map((segment) => (
                                <span key={segment.name}><em style={{ background: segment.color }} />{segment.name} · <b>{segment.count}명</b></span>
                              ))}
                            </div>
                          </>
                        ) : null}
                        <p>등록 {snapshotValue(detail.snapshot.metrics.total, "명")} · 누적 입장 {snapshotValue(detail.snapshot.metrics.checked, "명")} · 현재 입장 {snapshotValue(detail.snapshot.metrics.inside, "명")} · 입장률 {snapshotValue(detail.snapshot.metrics.rate, "%", 100)}</p>
                        {typeof detail.snapshot.metrics.attendanceReview !== "number" || !Number.isSafeInteger(detail.snapshot.metrics.attendanceReview) || detail.snapshot.metrics.attendanceReview < 0 ? (
                          <p>저장 당시 출입 기록의 확인 필요 여부는 이 보고서에서 확인할 수 없습니다.</p>
                        ) : detail.snapshot.metrics.attendanceReview > 0 ? (
                          <p>출입 기록 확인 필요 {detail.snapshot.metrics.attendanceReview}명 · 입장 수와 입장률이 실제와 다를 수 있습니다.</p>
                        ) : null}
                        {typeof detail.snapshot.metrics.attendanceReview === "number" && detail.snapshot.metrics.attendanceReviewVersion !== 2 ? (
                          <p>저장 당시 최근 출입 이력과의 일치 여부는 확인할 수 없습니다.</p>
                        ) : null}
                        {typeof detail.snapshot.metrics.cancellationReview !== "number" || !Number.isSafeInteger(detail.snapshot.metrics.cancellationReview) || detail.snapshot.metrics.cancellationReview < 0 ? (
                          <p>취소 기록과 신청 상태를 확인한 결과가 저장되지 않았습니다.</p>
                        ) : detail.snapshot.metrics.cancellationReview > 0 ? (
                          <p>취소 기록과 신청 상태가 다른 {detail.snapshot.metrics.cancellationReview}명이 등록 집계에 포함돼 있습니다. 참가 여부는 확인이 필요하며 승인 상태·입장 집계에도 반영될 수 있습니다.</p>
                        ) : null}
                        {savedGroups.items?.length ? (
                          <p className={groupChart ? "sr-only" : undefined}>{savedGroups.items.map((group) => `${text(group.name) || "이름 확인 불가"} ${snapshotValue(group.count, "명")}`).join(" · ")}</p>
                        ) : null}
                        {savedGroups.items === null || savedGroups.invalid ? <p className={styles.reportUnavailable}>저장된 참가자 분류 정보의 전부 또는 일부를 확인할 수 없습니다.</p> : null}
                        </> : <p className={styles.reportUnavailable}>저장된 참가·입장 집계를 확인할 수 없습니다.</p>}
                      </section>
                    ) : null}
                    {detail.sections.includes("programs") ? (
                      <section>
                        <h3>참여 콘텐츠</h3>
                        {savedPrograms.items === null && savedBooths.items === null ? <p className={styles.reportUnavailable}>저장된 참여 콘텐츠와 부스 정보를 확인할 수 없습니다.</p> : null}
                        {savedPrograms.items && savedBooths.items && !savedPrograms.invalid && !savedBooths.invalid && !savedPrograms.items.length && !savedBooths.items.length ? <p className={styles.reportEmpty}>기록된 참여 콘텐츠와 부스가 없습니다.</p> : null}
                        {savedPrograms.items === null && savedBooths.items !== null ? <p className={styles.reportUnavailable}>저장된 참여 콘텐츠 정보를 확인할 수 없습니다.</p> : null}
                        {savedBooths.items === null && savedPrograms.items !== null ? <p className={styles.reportUnavailable}>저장된 부스 정보를 확인할 수 없습니다.</p> : null}
                        {programChart.length ? (
                          <div className={styles.barlist}>
                            {programChart.map((row) => (
                              <div key={row.name} className={styles.barlistRow}>
                                <span className={styles.barlistKey}>{row.name}</span>
                                <span className={styles.barlistTrack}><i style={{ width: `${(row.value / programChartMax) * 100}%` }} /></span>
                                <span className={styles.barlistValue}>{row.value}건</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {(savedPrograms.items ?? []).map((program, index) => (
                          <p key={index} className={programChart.length ? "sr-only" : undefined}>{text(program.name) || "이름 확인 불가"} · {snapshotValue(program.responses, "건")}</p>
                        ))}
                        {(savedBooths.items ?? []).map((booth, index) => (
                          <p key={`booth-${index}`} className={programChart.length ? "sr-only" : undefined}>{text(booth.name) || "이름 확인 불가"} · {snapshotValue(booth.used, "건")}</p>
                        ))}
                        {savedPrograms.invalid ? <p className={styles.reportUnavailable}>일부 참여 콘텐츠 정보를 확인할 수 없습니다.</p> : null}
                        {savedBooths.invalid ? <p className={styles.reportUnavailable}>일부 부스 정보를 확인할 수 없습니다.</p> : null}
                      </section>
                    ) : null}
                    {detail.sections.includes("survey") ? (
                      <section>
                        <h3>만족도</h3>
                        {savedSurveys.items === null ? <p className={styles.reportUnavailable}>저장된 만족도 정보를 확인할 수 없습니다.</p> : null}
                        {savedSurveys.items && !savedSurveys.items.length && !savedSurveys.invalid ? <p className={styles.reportEmpty}>저장 시점에 만족도 조사가 없습니다.</p> : null}
                        {surveyOverall !== null ? (
                          <div className={styles.meter}>
                            <div className={styles.meterTrack}><i style={{ width: `${(surveyOverall / 5) * 100}%` }} /></div>
                            <div className={styles.meterValue}><span>5점 만점 평균</span><b>{surveyOverall.toFixed(1)}</b></div>
                          </div>
                        ) : null}
                        {(savedSurveys.items ?? []).map((survey, index) => {
                          const questions = snapshotRecords(survey.questions);
                          return <div key={index}>
                            <p><strong>{text(survey.name) || "이름 확인 불가"}</strong> · 응답 {snapshotValue(survey.count, "명")} · 평균 {snapshotAverage(survey.average)}</p>
                            {(questions.items ?? []).map((question, questionIndex) => (
                              <p key={questionIndex}>{text(question.name) || "항목 확인 불가"} · 평균 {snapshotAverage(question.average)} · {snapshotValue(question.count, "명")}</p>
                            ))}
                            {questions.items === null || questions.invalid ? <p className={styles.reportUnavailable}>만족도 항목의 전부 또는 일부를 확인할 수 없습니다.</p> : null}
                          </div>;
                        })}
                        {savedSurveys.invalid ? <p className={styles.reportUnavailable}>일부 만족도 정보를 확인할 수 없습니다.</p> : null}
                      </section>
                    ) : null}
                    {detail.sections.includes("photos") ? (
                      <section>
                        <h3>행사 사진</h3>
                        {savedPhotos.items === null || (savedPhotos.invalid && !savedPhotos.items.length) ? <p className={styles.reportUnavailable}>저장된 승인 사진 정보를 확인할 수 없습니다.</p> : <p>{savedPhotos.invalid ? "확인 가능한 사진 기록" : "승인 사진"} {savedPhotos.items.length}건</p>}
                        {savedPhotos.invalid && savedPhotos.items?.length ? <p className={styles.reportUnavailable}>일부 승인 사진 정보를 확인할 수 없습니다.</p> : null}
                        {savedPhotos.items?.length ? (
                          <ul className={styles.snapshotPhotos}>
                            {savedPhotos.items.map((photo, index) => {
                              const fileId = snapshotImageFileId(photo.image);
                              const caption = text(photo.caption);
                              return (
                                <li key={index}>
                                  {fileId ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}`}
                                      alt={caption || "승인된 행사 사진"}
                                      loading="lazy"
                                    />
                                  ) : null}
                                  <p>{caption || "설명 없음"}</p>
                                  {!fileId ? <p>원본 파일을 확인할 수 없습니다.</p> : null}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </section>
                    ) : null}
                    </div>
                  </article>
                </div>
                {!attendanceAvailable ? <ConsoleFeedback kind="warning">최근 참가·입장 집계를 확인할 수 없어 저장된 보고서와 비교할 수 없습니다. 아래 보고서는 생성 시점의 내용입니다.</ConsoleFeedback> : null}
                {detailAttendanceChanges.length > 0 ? (
                  <div className={styles.reportComparison}>
                    <p><strong>보고서와 최근 참가 집계가 다릅니다.</strong></p>
                    <div className={styles.dumbbell}>
                      {detailAttendanceChanges.map(({ label, saved, current }) => {
                        const { a, b } = dumbbellPercents(saved, current);
                        return (
                          <div key={label} className={styles.dbrow}>
                            <span className={styles.dbkey}>{label}</span>
                            <div className={styles.dbtrack} style={{ "--a": `${a}%`, "--b": `${b}%` } as React.CSSProperties}>
                              <span className={styles.dbline} />
                              <span className={`${styles.dbdot} ${styles.dbdotBase}`} />
                              <span className={`${styles.dbdot} ${styles.dbdotNow}`} />
                              <span className={styles.dblabel} style={{ left: `${a}%` }}>{saved}</span>
                              <span className={`${styles.dblabel} ${styles.dblabelNow}`} style={{ left: `${b}%` }}>{current}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <details className={styles.diff}>
                      <summary>보고서-최근 집계 비교표 보기</summary>
                      <table className={styles.dataTable} aria-label="보고서와 최근 참가 집계 비교">
                        <thead><tr><th scope="col">항목</th><th scope="col" className={styles.num}>보고서</th><th scope="col" className={styles.num}>최근 집계</th></tr></thead>
                        <tbody>{detailAttendanceChanges.map(({ label, saved, current }) => (
                          <tr key={label}><th scope="row">{label}</th><td className={styles.num}>{saved}명</td><td className={styles.num}>{current}명</td></tr>
                        ))}</tbody>
                      </table>
                    </details>
                    <p className={styles.help}>
                      최근 집계 확인 {capturedLabel(loadedAt)}.{" "}
                      {!state.archived && canWriteReports ? "최신 집계를 담으려면 새 보고서를 만드세요. " : null}
                      인쇄와 원본 저장은 아래 보고서의 수치를 사용합니다.
                    </p>
                  </div>
                ) : null}
                {/* Only one checklist: the hub above owns current prerequisites.
                    Keep this handoff outside the frozen article and print clone. */}
                <div className={styles.archiveCheck} role="note" aria-label="보관 전제 · 조회 시점">
                  {closeReportId === detail.id ? <p className={styles.archiveLead} data-close-report-progress><strong>마감 5/7 · 보고서 검토·동결{detail.status === "PUBLISHED" ? " · 완료" : ""}</strong></p> : null}
                  <p className={styles.archiveLead}>
                    위 보고서는 생성 시점 그대로 유지됩니다. 단계·접수·승인 대기·진행 프로그램의 전체 전제는 ‘행사 마감’ 지도에서 선택해서 확인할 수 있습니다. 작업을 마치면 다음 단계로 바로 이어가세요.
                  </p>
                  {closeReportId === detail.id && detail.status !== "PUBLISHED" ? <p className={styles.help}>이 버전의 공유 완료·잠금은 아직 기록하지 않았습니다. 내용 검토·동결 전에도 이동은 가능하며 자동으로 완료 처리하지 않습니다.</p> : null}
                </div>
              </>
            ) : (
              <p className={styles.help}>{state.reports.length ? "보고서를 선택해 내용을 확인하세요." : "아직 보고서가 없습니다. 보고서 만들기 버튼으로 첫 버전을 생성하세요."}</p>
            )}
          </div>
          <aside className={styles.railSide}>
            <div className={styles.analysisBox} id="reports-analysis" data-workspace-section="reports-analysis" aria-label="결과 분석 (조회 기준)">
              <div className={styles.analysisBoxHead}>
                <h3 className={styles.analysisBoxTitle}>결과 분석</h3>
                <ConsoleRefreshButton label="결과 분석 새로고침" busy={refreshing} onRefresh={() => setReloadTick((tick) => tick + 1)} />
              </div>
              <p className={styles.stamp}>{state.metrics.cancellationReview > 0 ? "신청 상태 기준 · 취소 기록 확인 필요 인원 포함" : "취소 제외 등록 기준"} · 조회 기준 시각 {loadedAt ? capturedLabel(loadedAt) : "확인 중"}</p>
              {attendanceAvailable && !reportSourcesAvailable ? <ConsoleFeedback kind="warning">{missingSourceText} 자료를 확인할 수 없습니다. 다른 집계는 확인 가능한 자료를 표시합니다. 새로고침해도 계속되면 시스템 관리자에게 문의하세요.</ConsoleFeedback> : null}
              <div className={styles.analysisSubheads}>
              {/* Headline first: the outcome rate leads at double width, the
                  supporting counts follow. Same five values, same labels, only
                  reading order and proportion change. */}
              {attendanceAvailable ? <div className={styles.metricGrid}>
                <div className={`${styles.metricCard} ${styles.metricLead}`}>
                  <strong>{state.metrics.rate}<span aria-hidden="true">%</span></strong><span>누적 입장률</span>
                  <div className={styles.meter}>
                    <div className={styles.meterTrack}><i style={{ width: `${state.metrics.rate}%` }} /></div>
                  </div>
                </div>
                <div className={styles.metricCard}><strong>{state.metrics.checked}</strong><span>누적 입장 (명)</span></div>
                <div className={styles.metricCard}><strong>{state.metrics.total}</strong><span>{state.metrics.cancellationReview > 0 ? "신청 상태 기준 등록 (명)" : "취소 제외 등록 (명)"}</span></div>
                <div className={styles.metricCard}><strong>{state.metrics.inside}</strong><span>현재 입장 (명)</span></div>
                {state.metrics.pending > 0 ? (
                  <div className={styles.metricCard}>
                    <strong>{state.metrics.pending}</strong>
                    <span>승인 대기 (명)</span>
                  </div>
                ) : null}
              </div> : <ConsoleFeedback kind="warning">참가·입장 자료를 확인할 수 없어 집계를 표시할 수 없습니다. 새로고침해도 계속되면 시스템 관리자에게 문의하세요.</ConsoleFeedback>}
              {attendanceAvailable && state.metrics.attendanceReview > 0 ? (
                <ConsoleFeedback kind="warning">
                  일부 출입 기록이 명확하지 않아 입장 수와 입장률이 실제와 다를 수 있습니다.{" "}
                  <ProductLink href={`/console/events/${encodeURIComponent(eventId)}/participants?attendance=REVIEW`}>출입 기록 확인 필요 {state.metrics.attendanceReview}명</ProductLink>
                </ConsoleFeedback>
              ) : null}
              {attendanceAvailable && state.metrics.cancellationReview > 0 ? (
                <ConsoleFeedback kind="warning">취소 기록과 신청 상태가 다른 {state.metrics.cancellationReview}명이 등록 집계에 포함돼 있습니다. 참가 여부를 확인해야 하며 승인 상태·입장 집계에도 반영될 수 있습니다. <ProductLink href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인 필요 명단 보기</ProductLink></ConsoleFeedback>
              ) : null}
              <details className={styles.analysisNote}>
                <summary>집계 기준</summary>
                <p>누적 입장은 한 번 이상 입장한 참가자 기준이며 재입장을 중복 집계하지 않습니다. 신청 상태가 취소인 신청은 제외합니다.{state.metrics.cancellationReview > 0 ? " 신청 상태와 취소 기록이 다른 사람은 확인 전까지 신청 상태 기준 집계에 포함합니다." : ""}</p>
              </details>
              <details className={styles.analysisDetails}>
                <summary>그룹·부스·프로그램별 상세 집계</summary>
              <div className={styles.subgroup}>
              <h3>등록 그룹</h3>
              {!sources.participants || !sources.groups ? <p className={styles.help}>참가자 그룹 집계를 확인할 수 없습니다.</p> : state.groups.length ? (
                <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="등록 그룹별 인원 표">
                  <table className={styles.dataTable}>
                    <thead><tr><th scope="col">그룹</th><th scope="col" className={styles.num}>인원</th></tr></thead>
                    <tbody>
                      {state.groups.map((group) => (
                        <tr key={group.name}><td>{group.name}</td><td className={styles.num}>{group.count}명</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.help}>등록 그룹이 없습니다.</p>
              )}
              </div>
              <div className={styles.subgroup}>
              <h3>부스 이용</h3>
              {!sources.booths ? <p className={styles.help}>부스 집계를 확인할 수 없습니다.</p> : state.booths.length ? (
                <>
                <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="부스별 인증 수 표">
                  <table className={styles.dataTable}>
                    <thead><tr><th scope="col">부스</th><th scope="col" className={styles.num}>인증</th></tr></thead>
                    <tbody>
                      {state.booths.map((booth) => (
                        <tr key={booth.name}><td>{booth.name}</td><td className={styles.num}>{booth.used}건</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {boothCapacityRows.length ? (
                  <div className={styles.boothBarList} aria-label="부스 이용률 — 정원 대비">
                    {boothCapacityRows.map((booth) => (
                      <div key={booth.name} className={styles.boothBarRow}>
                        <span>{booth.name}</span>
                        <span className={styles.boothBarTrack}><i style={{ width: `${Math.min(100, (booth.used / booth.capacity) * 100)}%` }} /></span>
                        <span className={styles.boothBarValue}>{booth.used} / {booth.capacity}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                </>
              ) : (
                <p className={styles.help}>부스 데이터가 없습니다.</p>
              )}
              </div>
              <div className={styles.subgroup}>
              <h3>프로그램 응답</h3>
              {!sources.modules || !sources.responses || !sources.questions || !sources.draw ? <p className={styles.help}>참여 콘텐츠 집계를 확인할 수 없습니다.</p> : state.programs.length ? (
                <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="프로그램별 응답 표">
                  <table className={styles.dataTable}>
                    <thead><tr><th scope="col">프로그램</th><th scope="col">종류</th><th scope="col" className={styles.num}>응답</th></tr></thead>
                    <tbody>
                      {state.programs.map((program) => (
                        <tr key={`${program.type}-${program.name}`}>
                          <td>{program.name}</td>
                          <td>{MODULE_TYPE_LABELS[program.type] ?? "항목 확인 필요"}</td>
                          <td className={styles.num}>{program.responses}건</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.help}>참여 기록이 없습니다.</p>
              )}
              </div>
              <div className={styles.subgroup}>
              <h3>만족도</h3>
              {!sources.modules || !sources.responses || !sources.survey ? <p className={styles.help}>만족도 집계를 확인할 수 없습니다.</p> : state.surveys.length ? (
                state.surveys.map((survey) => (
                  <div key={survey.name} className={styles.surveyGroup}>
                    <p><strong>{survey.name}</strong> · 응답 {survey.count}명 · 평균 {survey.average === null ? "응답 없음" : `${survey.average} / 5`}</p>
                    <div className={styles.tableScroll} role="region" tabIndex={0} aria-label={`${survey.name} 만족도 항목별 결과 표`}>
                      <table className={styles.dataTable}>
                        <thead><tr><th scope="col">항목</th><th scope="col" className={styles.num}>평균</th><th scope="col" className={styles.num}>응답</th></tr></thead>
                        <tbody>
                          {survey.questions.map((question) => (
                            <tr key={question.name}>
                              <td>{question.name}</td>
                              <td className={styles.num}>{question.average === null ? "—" : `${question.average} / 5`}</td>
                              <td className={styles.num}>{question.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              ) : (
                <p className={styles.help}>만족도 데이터가 없습니다.</p>
              )}
              </div>
              <div className={styles.subgroup}>
                <h3>행사 사진</h3>
                <p className={styles.help}>{sources.photos ? <>승인 사진 {state.photoCount}건{state.photoCaptions.length ? ` · ${state.photoCaptions.slice(0, 3).join(" · ")}` : ""}</> : "사진 자료를 확인할 수 없습니다."}</p>
              </div>
              </details>
              </div>
            </div>
            {detail ? (
              <div className={styles.actionBox}>
                <div className={styles.nextAction}>
                  {closeReportId === detail.id ? (
                      <ProductLink variant="primary" data-close-report-next
                        href={closeHandoffHref(`/console/events/${encodeURIComponent(eventId)}/messages`, eventId, detail.id)}
                        onNavigate={() => window.dispatchEvent(new Event("eventouch:shell-reload"))}><ArrowRightIcon /> 다음: 결과 안내</ProductLink>
                    ) : null}
                </div>
                {failure?.field === "expectedVersion" && !createOpen ? (
                  <>
                    <ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback>
                    {refreshFailure ? <ProductButton type="button" variant="secondary" disabled={refreshing} onClick={() => setReloadTick((tick) => tick + 1)}>보고서 내용 다시 확인</ProductButton> : null}
                  </>
                ) : null}
                <div className={styles.primaryActions}>
                <ConsoleFormActions>
                  {detail.status === "DRAFT" ? (
                    <>
                      <ProductButton type="button" variant="secondary" disabled={writeLocked} onClick={() => { setEditReport(detail); setFailure(null); dialogUnresolvedRef.current = false; setCreateOpen(true); }}>
                        내용 편집
                      </ProductButton>
                      {publishIntent?.id === detail.id && publishIntent.version === detail.version ? (
                        <>
                          <span className={styles.help}>완료로 표시하면 이 버전은 편집할 수 없습니다. 고객사에 자동 전송되지는 않습니다.</span>
                          <ProductButton
                            type="button"
                            variant="primary"
                            disabled={busy || writeLocked}
                            onClick={async () => {
                              const ok = await runCommand("report.publish", { id: publishIntent.id, expectedVersion: publishIntent.version }, "공유 완료를 기록하고 이 버전을 잠갔습니다. 고객사에 자동 전송되지는 않습니다.");
                              if (ok) { setPublishIntent(null); setDetailId(detail.id); }
                            }}
                          >
                            {busy ? "기록 중입니다" : "공유 완료·잠금"}
                          </ProductButton>
                          <ProductButton type="button" variant="secondary" onClick={() => setPublishIntent(null)}>
                            취소
                          </ProductButton>
                        </>
                      ) : (
                        <>
                          {publishIntent?.id === detail.id ? <span className={styles.help} role="status">보고서가 변경됐습니다. 최신 내용을 검토한 뒤 공유 완료를 다시 확인하세요.</span> : null}
                          <ProductButton type="button" variant="primary" disabled={writeLocked || refreshing || (failure?.field === "expectedVersion" && Boolean(refreshFailure))} onClick={() => { setFailure(null); setPublishIntent({ id: detail.id, version: detail.version }); }}>
                            공유 완료로 표시
                          </ProductButton>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {successorId === detail.id ? (
                        <>
                          <label className={styles.check}>
                            <input
                              type="radio"
                              name="successor-source"
                              value="current"
                              checked={successorSource === "current"}
                              disabled={!reportSourcesAvailable}
                              onChange={() => {
                                setSuccessorSource("current");
                                setSuccessorAttendance(reportAttendance(state.metrics));
                                setFailure(null);
                              }}
                            />
                            현재 집계를 새로 반영
                          </label>
                          {!reportSourcesAvailable || failure?.code === "REPORT_SOURCE_UNAVAILABLE" ? <div>
                            <p className={styles.help}>{reportSourcesAvailable ? "보고서 자료가 변경됐을 수 있습니다." : `${missingSourceText} 자료를 확인할 수 없어 현재 집계는 사용할 수 없습니다.`} 기존 보고서의 집계는 유지할 수 있습니다.</p>
                            <ProductButton type="button" variant="secondary" disabled={refreshing || busy} onClick={() => { setFailure(null); setReloadTick((tick) => tick + 1); }}>{refreshing ? "자료 확인 중" : "자료 다시 확인"}</ProductButton>
                          </div> : null}
                          <label className={styles.check}>
                            <input
                              type="radio"
                              name="successor-source"
                              value="snapshot"
                              checked={successorSource === "snapshot"}
                              onChange={() => { setSuccessorSource("snapshot"); setFailure(null); }}
                            />
                            이 보고서의 집계 유지
                          </label>
                          {successorSource === "current" && reportSourcesAvailable && successorAttendance ? (
                            <ReportAttendanceReview reviewed={successorAttendance} latest={state.metrics}
                              failure={failure} loadedAt={loadedAt ?? ""} refreshing={refreshing} refreshFailure={refreshFailure}
                              busy={busy || writeLocked} eventId={eventId} participantChangesLocked={["ENDED", "ARCHIVED"].includes(state.stage)} onRefresh={() => setReloadTick((tick) => tick + 1)}
                              onAccept={() => { setSuccessorAttendance(reportAttendance(state.metrics)); setFailure(null); }} />
                          ) : null}
                          <ProductButton
                            type="button"
                            variant="primary"
                            disabled={busy || writeLocked || (successorSource === "current" &&
                              (!reportSourcesAvailable || !successorAttendance || needsAttendanceReview(successorAttendance, state.metrics, failure)))}
                            onClick={async () => {
                              const ok = await runCommand(
                                "report.successor",
                                { id: detail.id, source: successorSource,
                                  ...(successorSource === "current" ? { expectedAttendance: successorAttendance } : {}) },
                                "새 보고서 버전을 만들었습니다."
                              );
                              if (ok) setSuccessorId(null);
                            }}
                          >
                            {busy ? "만드는 중입니다" : "새 버전 만들기"}
                          </ProductButton>
                          <ProductButton type="button" variant="secondary" onClick={() => setSuccessorId(null)}>
                            취소
                          </ProductButton>
                        </>
                      ) : (
                        <ProductButton type="button" variant={closeReportId === detail.id ? "secondary" : "primary"} disabled={writeLocked} onClick={() => {
                          setSuccessorId(detail.id);
                          setSuccessorSource(reportSourcesAvailable ? "current" : "snapshot");
                          setSuccessorAttendance(reportAttendance(state.metrics));
                          setFailure(null);
                        }}>
                          새 버전 만들기
                        </ProductButton>
                      )}
                    </>
                  )}
                  <ProductButton type="button" variant="secondary" onClick={() => { setDetailId(null); setPublishIntent(null); setSuccessorId(null); }}>
                    닫기
                  </ProductButton>
                </ConsoleFormActions>
                </div>
                {printStatus === "preparing" ? (
                  <ConsoleFeedback kind="info" id="report-print-status">인쇄할 사진을 준비하고 있습니다.</ConsoleFeedback>
                ) : printStatus === "failed" ? (
                  <ConsoleFeedback kind="error" id="report-print-status">
                    보고서 사진을 불러오지 못했습니다. 다시 시도하거나 사진을 제외하고 인쇄하세요.
                  </ConsoleFeedback>
                ) : null}
                <p className={styles.exportScope} id="report-export-scope-help">
                  <strong>JSON 원본</strong>에는 화면에서 제외한 항목을 포함해 저장된 자료가 들어갑니다. 공유하기 전에 내용을 확인하세요.
                  선택한 항목만 전달하려면 인쇄에서 PDF로 저장할 수 있습니다.
                  PPTX는 선택한 항목만 담습니다.
                </p>
                <div className={styles.exportGroup}>
                  <p className={styles.toolbarLabel}>내보내기</p>
                  <ConsoleFormActions>
                    <ProductButton type="button" variant="ghost" icon={<DownloadIcon />} disabled={pptxBusy} onClick={() => void exportPptx(detail)}>
                      {pptxBusy ? "PPTX 만드는 중" : "PPTX로 내보내기"}
                    </ProductButton>
                    <ProductButton type="button" variant="ghost" icon={<DocumentIcon />} aria-describedby="report-export-scope-help" onClick={() => exportJson(detail)}>
                      원본 파일 저장 (JSON)
                    </ProductButton>
                    <ProductButton type="button" variant="ghost" icon={<PrinterIcon />} aria-disabled={printStatus === "preparing" || undefined}
                      aria-describedby={printStatus ? "report-print-status" : undefined} onClick={() => void printReport(detail)}>
                      {printStatus === "preparing" ? "인쇄 준비 중" : "인쇄하기"}
                    </ProductButton>
                    {printStatus === "failed" ? (
                      <ProductButton type="button" variant="ghost" onClick={() => void printReport(detail, true)}>
                        사진 제외하고 인쇄
                      </ProductButton>
                    ) : null}
                  </ConsoleFormActions>
                  <p className={styles.exportNote}>PPTX는 저장된 집계 기준(표지의 일시)으로 한 번 채워 내려받습니다. 선택 해제한 항목은 제외되며, 참여 콘텐츠·만족도는 각 최대 8개, 사진은 최대 6개까지 담기고 불러오지 못한 사진은 건너뜁니다. 꾸미기는 파워포인트·키노트·캔바에서 이어가세요.</p>
                </div>
                <div className={styles.viewGroup}>
                  <p className={styles.toolbarLabel}>보기</p>
                  <div className={styles.reportViewBar} role="group" aria-label="보고서 보기 방식">
                    <span className="sr-only">보기: {printLayout === "wide" ? "발표용 16:9" : "A4 세로"}</span>
                    <button
                      type="button"
                      className="pill"
                      aria-pressed={printLayout === "a4"}
                      onClick={() => setPrintLayout("a4")}
                    >
                      A4 세로
                    </button>
                    <button
                      type="button"
                      className="pill"
                      aria-pressed={printLayout === "wide"}
                      onClick={() => setPrintLayout("wide")}
                    >
                      발표용 16:9
                    </button>
                  </div>
                  <p className={styles.help}>보기는 화면 표시만 바꿉니다. 저장된 보고서 내용·버전은 그대로이며, PPT를 만들거나 서식을 편집하지 않습니다. 인쇄·PDF는 아래 인쇄 버튼 뒤 브라우저 대화상자에서 용지 방향을 고르세요. 긴 내용은 페이지가 나뉘어 모두 인쇄됩니다.</p>
                </div>
                <div className={styles.closeBack}>
                  <ProductLink variant="ghost" href={eventCloseHref(eventId, detail.id)}
                    onClick={() => setCloseReportId(detail.id)} onNavigate={() => requestConsoleTask("event-close", true)} data-report-close-return>
                    <BackIcon /> {closeReportId === detail.id ? "마감으로 돌아가기" : "이 보고서로 마감 이어가기"}
                  </ProductLink>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </ConsoleSection>

      {createOpen ? (
        <CreateDialog
          key={editReport?.id ?? "new"}
          initial={editReport}
          latest={editReport ? state.reports.find((item) => item.id === editReport.id) ?? null : null}
          refreshing={refreshing}
          refreshFailure={refreshFailure}
          busy={busy || checkingReport}
          failure={failure}
          attendance={state.metrics}
          sourcesAvailable={reportSourcesAvailable}
          missingSourceText={missingSourceText}
          loadedAt={loadedAt ?? ""}
          pendingApproval={state.metrics.pending}
          participantChangesLocked={["ENDED", "ARCHIVED"].includes(state.stage)}
          eventId={eventId}
          submitGateRef={sendingRef}
          unresolvedRef={dialogUnresolvedRef}
          locked={writeLocked}
          recovery={pendingReport?.fromDialog ? reportRecovery() : null}
          onClose={() => { if (!sendingRef.current) setCreateOpen(false); }}
          onRefresh={() => setReloadTick((tick) => tick + 1)}
          onRebase={(report) => { setEditReport(report); setFailure(null); }}
          onAcceptAttendance={() => setFailure(null)}
          onSubmit={async (payload) => {
            if (editReport) {
              const ok = await runCommand("report.update", { ...payload, id: editReport.id, expectedVersion: editReport.version }, "보고서를 수정했습니다.", true);
              if (ok) setCreateOpen(false);
            } else {
              const ok = await runCommand("report.create", payload, "보고서 초안을 만들었습니다.", true);
              if (ok) setCreateOpen(false);
            }
          }}
        />
      ) : null}
    </ConsolePage>
  );
}

function CreateDialog({
  initial,
  latest,
  refreshing,
  refreshFailure,
  busy,
  failure,
  attendance,
  loadedAt,
  pendingApproval,
  sourcesAvailable,
  missingSourceText,
  participantChangesLocked,
  eventId,
  submitGateRef,
  unresolvedRef,
  locked,
  recovery,
  onClose,
  onRefresh,
  onRebase,
  onAcceptAttendance,
  onSubmit,
}: {
  initial: Report | null;
  latest: Report | null;
  refreshing: boolean;
  refreshFailure: string | null;
  busy: boolean;
  failure: ReportFailure | null;
  attendance: Ready["metrics"];
  loadedAt: string;
  pendingApproval: number;
  sourcesAvailable: boolean;
  missingSourceText: string;
  participantChangesLocked: boolean;
  eventId: string;
  submitGateRef: { current: boolean };
  unresolvedRef: { current: boolean };
  locked: boolean;
  recovery: ReactNode;
  onClose: () => void;
  onRefresh: () => void;
  onRebase: (report: Report) => void;
  onAcceptAttendance: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? "");
  const [coverNote, setCoverNote] = useState(initial?.coverNote ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [color, setColor] = useState(
    initial && /^#[0-9a-f]{6}$/i.test(initial.color) ? initial.color : "#E76D26"
  );
  const [sections, setSections] = useState<string[]>(
    initial?.sections.length ? [...initial.sections] : SECTION_LABELS.map((section) => section.id)
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [reviewedAttendance, setReviewedAttendance] = useState(() => reportAttendance(attendance));
  const titleRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  // Cross-route guard: the dialog holds unsaved report input until it is
  // submitted or explicitly closed. Compared against the opened baseline so
  // a pristine dialog never blocks navigation.
  const defaultSections = SECTION_LABELS.map((section) => section.id);
  const sectionNames = (items: string[]) => (items.length ? items : defaultSections)
    .map((id) => SECTION_LABELS.find((section) => section.id === id)?.label ?? id).join(" · ");
  const versionChanged = Boolean(initial && latest && (latest.version !== initial.version || latest.status !== initial.status));
  const needsReview = Boolean(initial && (!latest || versionChanged || failure?.field === "expectedVersion"));
  const attendanceNeedsReview = !initial && needsAttendanceReview(reviewedAttendance, attendance, failure);
  const changedFields = initial && latest && versionChanged ? [
    { label: "보고서 제목", base: initial.title, server: latest.title, mine: title, useServer: () => setTitle(latest.title) },
    { label: "표지 부제목", base: initial.subtitle, server: latest.subtitle, mine: subtitle, useServer: () => setSubtitle(latest.subtitle) },
    { label: "표지 문구", base: initial.coverNote, server: latest.coverNote, mine: coverNote, useServer: () => setCoverNote(latest.coverNote) },
    { label: "운영 요약", base: initial.summary, server: latest.summary, mine: summary, useServer: () => setSummary(latest.summary) },
    { label: "테마 색", base: initial.color.toUpperCase(), server: latest.color.toUpperCase(), mine: color.toUpperCase(), useServer: () => setColor(latest.color) },
    { label: "포함할 항목", base: sectionNames(initial.sections), server: sectionNames(latest.sections), mine: sectionNames(sections), useServer: () => setSections(latest.sections.length ? [...latest.sections] : defaultSections) },
  ].filter((field) => field.base !== field.server) : [];
  const overlaps = changedFields.filter((field) => field.mine !== field.base && field.mine !== field.server);

  function applyLatest(keepMine: boolean) {
    if (!latest || latest.status !== "DRAFT" || locked || busy || refreshing) return;
    for (const field of changedFields) {
      if (!keepMine || !overlaps.includes(field)) field.useServer();
    }
    onRebase(latest);
    window.requestAnimationFrame(() => saveRef.current?.focus());
  }

  const pristine = initial
    ? title === initial.title &&
      subtitle === initial.subtitle &&
      coverNote === initial.coverNote &&
      summary === initial.summary &&
      color.toUpperCase() === initial.color.toUpperCase() &&
      sections.length === initial.sections.length &&
      sections.every((section) => initial.sections.includes(section))
    : title === "" &&
      subtitle === "" &&
      coverNote === "" &&
      summary === "" &&
      color.toUpperCase() === "#E76D26" &&
      sections.length === defaultSections.length &&
      sections.every((section) => defaultSections.includes(section));
  useConsoleDraftGuard(!pristine, "작성 중인 보고서 내용이 있습니다.");

  // Shared dismissal gate for Escape, backdrop and Cancel, mirroring
  // CreateEventDialog: in-flight writes block on the sync ref, an
  // unresolved save warns that it may already have applied, edited input
  // confirms, pristine dialogs close without a confirm.
  function confirmDialogClose(): boolean {
    if (submitGateRef.current || busy) return false;
    if (unresolvedRef.current) {
      return window.confirm("보고서 저장 결과를 아직 확인하지 못했습니다. 이미 저장되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
    }
    if (pristine) return true;
    return window.confirm("작성 중인 보고서 내용이 있습니다. 닫을까요?");
  }

  function toggleSection(id: string, checked: boolean) {
    setSections((prev) => checked ? [...new Set([...prev, id])] : prev.filter((section) => section !== id));
  }

  return (
    <ConsoleDialog
      title={initial ? "보고서 내용 편집" : "결과 보고서 만들기"}
      onClose={onClose}
      busy={busy}
      canClose={confirmDialogClose}
      initialFocusRef={titleRef}
      description={initial ? "내용을 수정해도 이 보고서의 집계는 생성 시점 그대로 유지합니다." : "현재 집계와 승인 사진을 보관합니다. 이후 변경은 자동 반영되지 않습니다."}
    >
      <ValidatedForm
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || locked || needsReview || attendanceNeedsReview || (!initial && !sourcesAvailable)) return;
          if (summary.length > 2000) {
            setFormError("기존 운영 요약이 2,000자를 넘습니다. 저장 전에 2,000자 이하로 줄여주세요.");
            summaryRef.current?.focus();
            return;
          }
          if (!sections.length) {
            setFormError("보고서 항목을 하나 이상 선택하세요.");
            return;
          }
          setFormError(null);
          void onSubmit({ title, subtitle, coverNote, summary, color, sections,
            ...(!initial ? { expectedAttendance: reviewedAttendance } : {}) });
        }}
      >
          {!initial && !sourcesAvailable ? <div>
            <ConsoleFeedback kind="warning">{missingSourceText} 자료를 확인할 수 없어 현재 집계로 보고서를 만들 수 없습니다. 다시 확인해도 계속되면 시스템 관리자에게 문의하세요.</ConsoleFeedback>
            <ProductButton type="button" variant="secondary" disabled={refreshing || busy} onClick={onRefresh}>{refreshing ? "자료 확인 중" : "자료 다시 확인"}</ProductButton>
          </div> : null}
          {!initial && sourcesAvailable ? (
            <ReportAttendanceReview reviewed={reviewedAttendance} latest={attendance} failure={failure} loadedAt={loadedAt}
              refreshing={refreshing} refreshFailure={refreshFailure} busy={busy || locked} eventId={eventId} participantChangesLocked={participantChangesLocked} onRefresh={onRefresh}
              onAccept={() => {
                setReviewedAttendance(reportAttendance(attendance));
                onAcceptAttendance();
                window.requestAnimationFrame(() => saveRef.current?.focus());
              }} />
          ) : null}
          {!initial && sourcesAvailable && pendingApproval > 0 ? (
            <div className={styles.help} role="status">
              승인 대기 {pendingApproval}명이 남아 있습니다. 보고서는 지금 집계로 고정되므로 이후 승인은 반영되지 않습니다.{" "}
              {participantChangesLocked ? (
                <span>종료 이후에는 참가자 승인 상태를 변경할 수 없습니다. 현재 상태 그대로 취소 제외 등록 집계에 포함됩니다.</span>
              ) : (
                <ProductLink href={closeHandoffHref(`/console/events/${encodeURIComponent(eventId)}/participants?status=PENDING`, eventId)}>
                  참가자에서 승인 처리하기
                </ProductLink>
              )}
            </div>
          ) : null}
          <fieldset className={styles.draftFields} disabled={locked || busy}>
          <legend className="sr-only">보고서 내용</legend>
          <div>
            <label htmlFor="report-title">보고서 제목 (필수)</label>
            <input
              id="report-title"
              ref={titleRef}
              type="text"
              maxLength={100}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={failure?.field === "title" || undefined}
              aria-describedby={failure?.field === "title" ? "report-dialog-error" : undefined}
              required
            />
          </div>
          <div>
            <label htmlFor="report-subtitle">표지 부제목</label>
            <input
              id="report-subtitle"
              type="text"
              maxLength={100}
              value={subtitle}
              onChange={(event) => setSubtitle(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-cover-note">표지 문구</label>
            <textarea data-resize-none="true"
              id="report-cover-note"
              maxLength={500}
              value={coverNote}
              onChange={(event) => setCoverNote(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-summary">운영 요약</label>
            <textarea data-resize-none="true"
              id="report-summary"
              ref={summaryRef}
              maxLength={2000}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-color">보고서 테마 색</label>
            <input
              id="report-color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
          <fieldset>
            <legend>화면·인쇄에 포함할 항목</legend>
            <p className={styles.help}>선택하지 않은 항목도 JSON 원본에 포함됩니다.</p>
            {SECTION_LABELS.map((section) => (
              <label key={section.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={sections.includes(section.id)}
                  onChange={(event) => toggleSection(section.id, event.target.checked)}
                />
                {section.label}
              </label>
            ))}
          </fieldset>
          </fieldset>
          {needsReview ? (
            <div className={`${styles.recovery} ${styles.reportVersionReview}`}>
              {latest?.status === "PUBLISHED" ? <p role="status">다른 운영자가 이 버전을 공유 완료로 잠갔습니다. 작성한 내용은 이 화면에서 확인하고 복사할 수 있습니다.</p>
                : versionChanged && latest ? (
                  <>
                    <p role="status">다른 운영자가 버전 {latest.version}을 저장했습니다. 따로 수정한 내용은 유지됩니다.</p>
                    {overlaps.length ? <dl className={styles.reportConflicts}>
                      {overlaps.map(({ label, server, mine }) => <div key={label}>
                        <dt>{label}</dt><dd>최근 저장 · {server || "비어 있음"}</dd><dd>내 입력 · {mine || "비어 있음"}</dd>
                      </div>)}
                    </dl> : null}
                    <div className={styles.recoveryActions}>
                      <ProductButton type="button" variant="secondary" disabled={busy || locked || refreshing} onClick={() => applyLatest(false)}>
                        {overlaps.length ? "겹친 항목은 최근 저장 사용" : "최근 변경 반영"}
                      </ProductButton>
                      {overlaps.length ? <ProductButton type="button" variant="secondary" disabled={busy || locked || refreshing} onClick={() => applyLatest(true)}>겹친 항목은 내 입력 유지</ProductButton> : null}
                    </div>
                  </>
                ) : (
                  <>
                    <p role="status">보고서가 변경됐습니다. 최신 내용을 확인한 뒤 계속 편집할 수 있습니다.</p>
                    {refreshFailure ? <p role="status">{refreshFailure} 작성한 입력은 유지됩니다.</p> : null}
                    <ProductButton type="button" variant="secondary" disabled={refreshing || busy} onClick={onRefresh}>{refreshing ? "최신 내용 확인 중" : "최신 내용 다시 확인"}</ProductButton>
                  </>
                )}
            </div>
          ) : null}
          {formError ? <p role="alert" className={styles.alert}>{formError}</p> : null}
          {failure && failure.field !== "expectedAttendance" && !(needsReview && failure.field === "expectedVersion") ? <p id="report-dialog-error" role="alert" className={styles.alert}>{failure.message}</p> : null}
          {!initial && sourcesAvailable && failure?.code === "REPORT_SOURCE_UNAVAILABLE" ? <ProductButton type="button" variant="secondary" disabled={refreshing || busy} onClick={() => { onAcceptAttendance(); onRefresh(); }}>{refreshing ? "자료 확인 중" : "자료 다시 확인"}</ProductButton> : null}
          {recovery}
          <ConsoleFormActions>
            <ProductButton
              type="button"
              variant="secondary"
              onClick={() => { if (!busy && confirmDialogClose()) onClose(); }}
              disabled={busy}
            >
              취소
            </ProductButton>
            <ProductButton type="submit" ref={saveRef} variant="primary" disabled={busy || locked || needsReview || attendanceNeedsReview || (!initial && !sourcesAvailable)}>
              {busy ? "저장 중입니다" : initial ? "수정 저장" : "보고서 만들기"}
            </ProductButton>
          </ConsoleFormActions>
        </ValidatedForm>
    </ConsoleDialog>
  );
}
