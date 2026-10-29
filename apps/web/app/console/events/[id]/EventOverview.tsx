"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../auth-redirect";
import { eventStageClassName, eventStageLabel } from "../../../event-stage";
import { formatConsoleEventMeta } from "../../console-ui/ConsolePageHeader";
import ConsolePage from "../../console-ui/ConsolePage";
import ConsoleFeedback from "../../console-ui/ConsoleFeedback";
import ConsoleSection from "../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../console-ui/ConsoleStatePanel";
import { CopyIcon, CheckIcon } from "../../console-ui/ConsoleIcons";
import { eventCloseHref } from "../../console-event-close";
import styles from "./event-overview.module.css";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../lib/console-api";
import { isOverdueManualMessage } from "../../../../lib/message-attention";

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
  registered: number;
  approved: number;
  pendingApproval: number;
  waitlist: number;
  everIn: number;
  confirmedNotEntered: number;
  entryRate: number;
  periods: PeriodCounts;
  // Arbitrary-range analysis reuses the exact same definitions: cancelled
  // excluded applications (by createdAt) and uncorrected IN entries deduped
  // per participant (no cancelled filter on checks). Raw values only; the
  // range UI buckets them locally without refetching.
  trendApplications: string[];
  trendEntries: Array<{ at: string; key: string }>;
  recent: CheckRow[];
  registrationOpen: boolean;
  deskCount: number;
  deskAssignmentCount: number;
  formVersion: number;
  pagePublished: boolean;
  pageDraftDiffers: boolean;
  surveyResponseCount: number | null;
  reportCount: number;
  publishedReportCount: number;
  draftReportCount: number;
  programs: ScheduledProgram[];
  updatedAt: string;
  canManageEvent: boolean;
  overdueMessages: number;
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
      // Exactly three counts in a row. 정원/대기는 별도 설정 메타 행으로 둔다.
      return [
        { label: "신청", value: overview.registered, detail: "취소 제외 등록", href: participantsHref },
        { label: "참가 확정", value: overview.approved, detail: "승인된 참가자", href: `${participantsHref}?status=APPROVED` },
        { label: "승인 대기", value: overview.pendingApproval, detail: "검토가 필요한 신청", href: `${participantsHref}?status=PENDING` },
      ];
    default:
      return [];
  }
}

// 기간별 통계의 실제 집계와 정의를 한 곳에 둔다. DRAFT/READY에서는 준비
// 섹션과 나란한 독립 섹션에, LIVE/ENDED/ARCHIVED에서는 지표 섹션 안에 둔다.
function PeriodDetails({ rows, applications, entries }: {
  rows: Array<[string, PeriodCounts["today"]]>;
  applications: string[];
  entries: Array<{ at: string; key: string }>;
}) {
  return (
    <>
      <table className={styles.periodTable} aria-label="기간별 신청·입장">
        <thead>
          <tr>
            <th scope="col">기간</th>
            <th scope="col">신청</th>
            <th scope="col">입장</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, period]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{period.applications}명</td>
              <td>{period.entries}명</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className={styles.periodDefinitions}>
        <summary>집계 기준</summary>
        <p>신청은 취소된 신청을 제외합니다. 입장은 정정된 기록을 제외하며 같은 기간의 재입장은 중복 집계하지 않습니다.</p>
      </details>
      <CustomRangeAnalysis applications={applications} entries={entries} />
    </>
  );
}

// 임의 기간 분석: 위 고정 집계와 같은 정의를 브라우저 로컬 날짜의
// from/to에 그대로 적용한다. 일별 막대는 네이티브 SVG 하나이며, 같은 값을
// 담은 접근용 표와 요약 문장을 함께 둔다. 외부 차트 의존성 없음.
const RANGE_DAYS_CAP = 62;

function parseLocalDay(value: string): { key: string; start: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) return null;
  return { key: localDateKey(date), start: date };
}

function toLocalKey(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return localDateKey(new Date(time));
}

function CustomRangeAnalysis({ applications, entries }: { applications: string[]; entries: Array<{ at: string; key: string }> }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const [fromInput, setFromInput] = useState(localDateKey(weekAgo));
  const [toInput, setToInput] = useState(localDateKey(today));

  const parsedFrom = parseLocalDay(fromInput);
  const parsedTo = parseLocalDay(toInput);
  let rangeError: string | null = null;
  let days: string[] = [];
  let effectiveTo = parsedTo;
  let clamped = false;
  if (!parsedFrom || !parsedTo) {
    rangeError = "날짜를 YYYY-MM-DD 형식으로 입력하세요.";
  } else if (parsedFrom.start.getTime() > parsedTo.start.getTime()) {
    rangeError = "시작 날짜가 끝 날짜보다 늦습니다. 순서를 바꾸세요.";
  } else {
    const span = Math.round((parsedTo.start.getTime() - parsedFrom.start.getTime()) / 86_400_000) + 1;
    if (span > RANGE_DAYS_CAP) {
      clamped = true;
      const capped = new Date(parsedFrom.start);
      capped.setDate(parsedFrom.start.getDate() + RANGE_DAYS_CAP - 1);
      effectiveTo = { key: localDateKey(capped), start: capped };
    }
    const cursor = new Date(parsedFrom.start);
    const endKey = (effectiveTo ?? parsedTo).key;
    for (;;) {
      const key = localDateKey(cursor);
      days.push(key);
      if (key === endKey || days.length > RANGE_DAYS_CAP) break;
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const appByDay = new Map<string, number>();
  for (const createdAt of applications) {
    const key = toLocalKey(createdAt);
    if (key !== null) appByDay.set(key, (appByDay.get(key) ?? 0) + 1);
  }
  const entriesByDay = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = toLocalKey(entry.at);
    if (key === null) continue;
    const set = entriesByDay.get(key) ?? new Set<string>();
    set.add(entry.key);
    entriesByDay.set(key, set);
  }
  const points = days.map((key) => ({
    key,
    label: key.slice(5).replace("-", "/"),
    applications: appByDay.get(key) ?? 0,
    entries: entriesByDay.get(key)?.size ?? 0,
  }));
  // Zero-only days dominate short ranges (e.g. 6 zero rows + 1 spike).
  // Fold them behind one toggle: the chart keeps the full range so the
  // spike stays in context, while the table shows only days with activity.
  const [showZeroDays, setShowZeroDays] = useState(false);
  const zeroPoints = points.filter((point) => point.applications === 0 && point.entries === 0);
  const activePoints = points.filter((point) => point.applications > 0 || point.entries > 0);
  const tablePoints = showZeroDays || zeroPoints.length === 0 ? points : activePoints;
  const periodApplications = points.reduce((sum, point) => sum + point.applications, 0);
  const dailyEntriesSum = points.reduce((sum, point) => sum + point.entries, 0);
  const periodUnique = new Set<string>();
  for (const key of days) {
    for (const id of entriesByDay.get(key) ?? []) periodUnique.add(id);
  }

  const maxValue = Math.max(1, ...points.map((point) => Math.max(point.applications, point.entries)));
  const chartWidth = 640;
  const chartHeight = 200;
  const axisPad = 8;
  const plotTop = 12;
  const plotBottom = chartHeight - 28;
  const pairGap = Math.max(2, Math.min(10, Math.floor((chartWidth - axisPad * 2) / Math.max(1, points.length) / 4)));
  const slot = points.length ? (chartWidth - axisPad * 2) / points.length : 0;
  const barWidth = Math.max(2, Math.min(26, (slot - pairGap) / 2));
  const bar = (value: number) => Math.round((value / maxValue) * (plotBottom - plotTop));
  const tickPoints = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, index) => index);

  return (
    <div className={styles.rangeBlock}>
      <h3 className={styles.rangeTitle}>임의 기간 분석</h3>
      <p className={styles.rangeNote}>위 고정 집계와 같은 기준을 입력한 기간에 적용합니다. 날짜는 이 브라우저의 달력 날짜입니다.</p>
      <div className={styles.rangeFields}>
        <div>
          <label htmlFor="range-from">시작일</label>
          <input
            id="range-from"
            type="date"
            value={fromInput}
            max={toInput}
            onChange={(event) => setFromInput(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="range-to">종료일</label>
          <input
            id="range-to"
            type="date"
            value={toInput}
            min={fromInput}
            onChange={(event) => setToInput(event.target.value)}
          />
        </div>
      </div>
      {rangeError ? <p className={styles.rangeError} role="alert">{rangeError}</p> : null}
      {clamped && !rangeError ? <p className={styles.rangeNote} role="status">최대 {RANGE_DAYS_CAP}일까지만 봅니다. 종료일을 {effectiveTo?.key}로 맞췄습니다.</p> : null}
      {!rangeError && points.length > 0 ? (
        <>
          <p className={styles.rangeSummary} role="status">
            기간 신청 {periodApplications}명 · 일별 입장 합 {dailyEntriesSum}명 · 기간 고유 입장 {periodUnique.size}명(중복 제거)
          </p>
          <svg className={styles.rangeChart} viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`선택 기간 일별 신청·입장 막대그래프. 기간 신청 ${periodApplications}명, 일별 입장 합 ${dailyEntriesSum}명, 기간 고유 입장 ${periodUnique.size}명.`}>
            {[0, 0.5, 1].map((fraction) => {
              const y = plotBottom - (plotBottom - plotTop) * fraction;
              const value = Math.round(maxValue * fraction);
              return (
                <g key={fraction}>
                  <line x1={axisPad} x2={chartWidth - axisPad} y1={y} y2={y} className={styles.rangeGrid} />
                  <text x={axisPad} y={Math.max(10, y - 3)} className={styles.rangeAxis}>{value}</text>
                </g>
              );
            })}
            {points.map((point, index) => {
              const x = axisPad + index * slot + (slot - barWidth * 2 - pairGap) / 2;
              const appHeight = bar(point.applications);
              const entryHeight = bar(point.entries);
              return (
                <g key={point.key}>
                  <rect x={x} y={plotBottom - appHeight} width={barWidth} height={appHeight} className={styles.rangeBarApplications}>
                    <title>{`${point.key} 신청 ${point.applications}명`}</title>
                  </rect>
                  <rect x={x + barWidth + pairGap} y={plotBottom - entryHeight} width={barWidth} height={entryHeight} className={styles.rangeBarEntries}>
                    <title>{`${point.key} 입장 ${point.entries}명(일별 고유)`}</title>
                  </rect>
                </g>
              );
            })}
            {tickPoints.map((index) => {
              const point = points[index];
              if (!point) return null;
              return (
                <text
                  key={`tick-${point.key}`}
                  x={axisPad + index * slot + slot / 2}
                  y={chartHeight - 8}
                  textAnchor="middle"
                  className={styles.rangeAxis}
                >
                  {point.label}
                </text>
              );
            })}
          </svg>
          <ul className={styles.rangeLegend} aria-label="막대그래프 범례">
            <li><span className={`${styles.rangeSwatch} ${styles.rangeBarApplications}`} aria-hidden="true" />신청</li>
            <li><span className={`${styles.rangeSwatch} ${styles.rangeBarEntries}`} aria-hidden="true" />입장(일별 고유)</li>
          </ul>
          <table className={styles.periodTable} aria-label="선택 기간 일별 신청·입장">
            <thead>
              <tr>
                <th scope="col">날짜</th>
                <th scope="col">신청</th>
                <th scope="col">입장(일별 고유)</th>
              </tr>
            </thead>
            <tbody>
              {tablePoints.map((point) => (
                <tr key={point.key}>
                  <th scope="row">{point.key}</th>
                  <td>{point.applications}명</td>
                  <td>{point.entries}명</td>
                </tr>
              ))}
            </tbody>
          </table>
          {zeroPoints.length > 0 ? (
            <p>
              <button
                type="button"
                className="button button-quiet"
                aria-expanded={showZeroDays}
                onClick={() => setShowZeroDays((current) => !current)}
              >
                {showZeroDays ? `0명 ${zeroPoints.length}일 접기` : `0명 ${zeroPoints.length}일 보기`}
              </button>
            </p>
          ) : null}
          <p className={styles.rangeNote}>일별 입장은 그 날의 고유 입장자 수이며, 기간 고유 입장은 선택한 전체 기간의 중복 제거 수라서 일별 합의 합과 다를 수 있습니다. 취소 제외·정정 제외 기준은 위 고정 집계와 같습니다.</p>
        </>
      ) : null}
    </div>
  );
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // Copy affordance mirrors the notice: a check replaces the copy icon once
  // the link lands on the clipboard, so the boxed button itself confirms the
  // outcome next to the action (the header feedback still announces it).
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => subscribeConsoleFreshness(() => setReloadTick((tick) => tick + 1)), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setRefreshing(true);
      try {
        const res = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            clients?: unknown;
            accounts?: unknown;
            workspaces?: Record<string, Record<string, unknown> | undefined>;
          } | null;
        } | null;
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
          const message = "운영 현황을 불러오지 못했습니다.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
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
        const participantRows = records(workspace.participants).filter(
          (person) => person.status !== "CANCELLED"
        );
        const approved = participantRows.filter((person) => person.status === "APPROVED");
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
        const deskCount = records(workspace.desks).length;
        const deskAssignmentCount = records(workspace.assignments).filter(
          (assignment) => text(assignment.type) === "DESK"
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
            deskName: deskMap.get(text(check.deskId)) ?? "",
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
            registered,
            approved: approved.length,
            pendingApproval: participantRows.filter((person) => person.status === "PENDING").length,
            waitlist: participantRows.filter((person) => person.status === "WAITLIST").length,
            everIn,
            confirmedNotEntered: approved.filter((person) => person.everIn !== true).length,
            entryRate: registered ? Math.round((everIn / registered) * 100) : 0,
            periods,
            trendApplications: participantRows.map((person) => text(person.createdAt)).filter((value) => value !== ""),
            trendEntries: checkRecords
              .filter((check) => check.action === "IN")
              .map((check) => ({ at: check.at, key: check.participantId || check.id })),
            recent: checks,
            registrationOpen: workspace.registrationOpen === true,
            deskCount,
            deskAssignmentCount,
            formVersion: number(workspace.publishedVersion),
            pagePublished: Boolean(text(pageExperience?.publishedAt)),
            pageDraftDiffers: number(pageExperience?.draftVersion) !== number(pageExperience?.publishedVersion),
            surveyResponseCount,
            reportCount: reportRows.length,
            publishedReportCount,
            draftReportCount,
            programs: programRows,
            updatedAt: now.toISOString(),
            canManageEvent,
            overdueMessages: records(workspace.messages).filter((message) => isOverdueManualMessage(message)).length,
          },
        });
        setRefreshError(null);
        setLinkNotice(null);
        setLinkCopied(false);
      } catch {
        if (!cancelled) {
          const message = "연결하지 못했습니다. 다시 시도하세요.";
          setRefreshError(message);
          setState((current) => current.kind === "ready" ? current : { kind: "failed", message });
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [eventId, router, reloadTick]);

  function reloadOverview() {
    requestOverviewReload();
    window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
  }

  function requestOverviewReload() {
    setRefreshError(null);
    setReloadTick((tick) => tick + 1);
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
          kind="loading"
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
  const showApprovalAlert = overview.pendingApproval > 0 && !["ENDED", "ARCHIVED"].includes(currentStage);
  const preparing = ["DRAFT", "READY"].includes(currentStage);
  const finished = ["ENDED", "ARCHIVED"].includes(currentStage);
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const metrics = metricsForStage(overview, currentStage, base);
  const entryProgress = Math.max(0, Math.min(100, overview.entryRate));
  const periodRows: Array<[string, PeriodCounts["today"]]> = [
    ["오늘", overview.periods.today],
    ["어제", overview.periods.yesterday],
    ["최근 7일", overview.periods.last7],
  ];
  const schedule = overview.canManageEvent
    ? upcomingPrograms(overview.programs, new Date())
    : [];
  const now = new Date();
  const runbookDate = /^\d{4}-\d{2}-\d{2}$/.test(overview.date)
    ? overview.date
    : localDateKey(now);
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
  const liveBlocked = overview.deskCount === 0 || overview.deskAssignmentCount === 0;
  const intakeShort = overview.registrationOpen
    ? `접수 중 · 양식 버전 ${overview.formVersion}`
    : "접수 마감";

  const stageBadges = (
        <>
          <span className={`${eventStageClassName(currentStage)} ${styles.stagePill}`}>{stageText}</span>
          <span className={`${styles.intakeBadge} ${overview.registrationOpen ? styles.intakeOpen : styles.intakeClosed}`}>
            {overview.registrationOpen ? "접수 중" : "접수 마감"}
          </span>
          {dDay ? (
            <span className={styles.dDay} title="일정 표시이며 단계는 자동 변경되지 않습니다.">
              {dDay}
            </span>
          ) : null}
        </>
  );
  const headerActions = overview.canManageEvent && participantPageHref ? (
        <>
          {currentStage === "LIVE" ? (
            <Link className="button button-secondary" href={eventCloseHref(eventId)}>
              행사 마감
            </Link>
          ) : null}
          {/* DRAFT는 비공개(공개 화면 404)이므로 여는 링크를 두지 않는다. READY부터 기본 디자인으로 열린다. */}
          {stageKnown && currentStage !== "DRAFT" ? (
            <span className="console-header-group">
              <Link className="button button-secondary" href={participantPageHref} target="_blank" rel="noreferrer">
                참가자 페이지 열기
              </Link>
              <button
                type="button"
                className="button button-secondary console-icon-button"
                aria-label="참가자 페이지 링크 복사"
                onClick={() => void copyParticipantLink(overview.slug)}
              >
                {linkCopied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </span>
          ) : null}
        </>
      ) : null;

  // "지금 할 일" ledger: open items as quiet tiles with secondary actions.
  // The overview keeps zero primary actions by contract: navigation and
  // work queues stay secondary links so the single-primary rule applies to
  // committing workspaces, not this status surface.
  type NowItem = { key: string; title: string; count: string | null; hint: string; action: string; href: string };
  const nowItems: NowItem[] = [];
  if (overview.canManageEvent && currentStage !== "ARCHIVED") {
    if (showApprovalAlert) {
      nowItems.push({
        key: "approval",
        title: "승인 대기",
        count: `${overview.pendingApproval}명`,
        hint: "검토가 필요한 신청입니다.",
        action: "승인 대기 처리",
        href: `${base}/participants?status=PENDING`,
      });
    }
    if (overview.overdueMessages > 0) {
      nowItems.push({
        key: "manual",
        title: "수동 예약",
        count: `${overview.overdueMessages}건`,
        hint: "예약 시각이 지났습니다. 자동 발송되지 않으므로 내용을 확인한 뒤 직접 실행하세요.",
        action: "예약 확인",
        href: `${base}/messages?attention=1`,
      });
    }
    if (currentStage === "READY" && liveBlocked) {
      nowItems.push({
        key: "readiness",
        title: "현장 준비",
        count: null,
        hint: `등록 데스크 ${overview.deskCount}개 · 데스크 배정 ${overview.deskAssignmentCount}건 — 부족합니다.`,
        action: "현장 운영 확인",
        href: `${base}/operations`,
      });
    }
    if (currentStage === "DRAFT") {
      nowItems.push({
        key: "intake",
        title: "참가 접수",
        count: null,
        hint: intakeShort,
        action: "접수 설정",
        href: `${base}/settings#settings-intake`,
      });
    }
    if (currentStage === "READY" && !liveBlocked && !showApprovalAlert && overview.overdueMessages === 0) {
      nowItems.push({
        key: "golive",
        title: "진행 중 전환",
        count: null,
        hint: `등록 데스크 ${overview.deskCount}개 · 데스크 배정 ${overview.deskAssignmentCount}건 — 조건 충족.`,
        action: "진행 단계 설정",
        href: `${base}/settings#settings-stage`,
      });
    }
    if (currentStage === "LIVE" && !showApprovalAlert && overview.overdueMessages === 0) {
      nowItems.push({
        key: "operations",
        title: "현장 운영",
        count: null,
        hint: `등록 데스크 ${overview.deskCount}개 · 데스크 배정 ${overview.deskAssignmentCount}건.`,
        action: "현장 운영 열기",
        href: `${base}/operations`,
      });
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
  }

  // Lead with actionable work; the adjacent metrics explain its context.
  const nowSection = nowItems.length ? (
    <ConsoleSection
      headingId="event-now-heading"
      title="지금 할 일"
      className={styles.regionQueue}
    >
      <ul className={styles.nowList}>
        {nowItems.map((item) => (
          <li className={styles.nowTile} key={item.key}>
            <div className={styles.nowTileCopy}>
              <div className={styles.nowTileHead}>
                <p className={styles.nowTileTitle}>{item.title}</p>
                {item.count ? <span className={styles.nowTileCount}>{item.count}</span> : null}
              </div>
              <p className={styles.nowTileHint}>{item.hint}</p>
            </div>
            {/* Every tile carries the same boxed affordance: the first
                tile is not more committal than the rest, so rank must
                not masquerade as hierarchy. Navigation stays a link. */}
            <div className={styles.nowTileAction}>
              <Link className="button button-secondary" href={item.href}>
                {item.action}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </ConsoleSection>
  ) : (
    <ConsoleSection
      headingId="event-now-heading"
      title="지금 할 일"
      className={styles.regionQueue}
    >
      <p className={styles.nowEmpty} role="status">현재 표시할 운영 항목이 없습니다.</p>
    </ConsoleSection>
  );

  return (
    <ConsolePage pageId="overview" eventId={eventId} eventName={overview.name || "이름 없는 행사"}
      meta={eventMeta} badges={stageBadges} headerActions={headerActions}
      feedback={linkNotice ? <ConsoleFeedback kind="info">{linkNotice}</ConsoleFeedback> : undefined}>
      <div className={overview.canManageEvent ? styles.overviewCanvas : styles.overviewSingle}>
      {refreshError ? <p className={`${styles.refreshAlert} state-error`} role="alert">{refreshError} 이전에 불러온 내용은 유지됩니다.</p> : null}
      {overview.canManageEvent ? (
        <>
          {preparing ? (
            <div className={`${styles.topReadiness} ${styles.regionStatus}`}>
              <p className={styles.stageBand}>
                <span>현재 <strong>{stageText}</strong><span aria-hidden="true"> → </span><span className={styles.stageNext}>다음 {nextStageText}</span></span>
                <Link href={`${base}/settings#settings-stage`}>진행 단계 설정</Link>
              </p>
              {currentStage === "READY" ? (
                <p className={`${styles.nextCondition} ${liveBlocked ? styles.nextConditionBlocked : ""}`}>
                  <strong>다음 진행 중 조건</strong>
                  <span>등록 데스크 {overview.deskCount}개 · 데스크 배정 {overview.deskAssignmentCount}건 · {liveBlocked ? "부족 — 현장 운영에서 등록·배정하세요" : "충족"}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          {finished ? (
            <ConsoleSection headingId="event-close-status-heading" title={currentStage === "ARCHIVED" ? "보관된 행사 마감 확인" : "행사 마감"} description="자동으로 단계를 바꾸지 않습니다." className={styles.regionStatus}>
              <div className={styles.closeStatus}>
                <p>{overview.registrationOpen ? "접수 중" : "접수 마감"} · 보고서 {getReportStatus(overview)} · {stageText}</p>
                <Link className="button button-secondary" href={eventCloseHref(eventId)}>{currentStage === "ARCHIVED" ? "행사 마감 확인" : "행사 마감 시작"}</Link>
              </div>
            </ConsoleSection>
          ) : null}
          <div className={styles.primaryColumn}>
            {nowSection}
          <ConsoleSection
            headingId="event-runbook-heading"
            title={runbookIsToday ? "오늘의 일정" : "행사 일정"}
            description={<span className={styles.runbookMeta}>{runbookIsToday ? `${UPDATED_TIME_FORMAT.format(now)} 기준` : formatEventDate(runbookDate)}</span>}
            action={<Link className="button button-secondary" href={`${base}/content`}>프로그램 일정</Link>}
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
                    <span className={styles.runbookStatus}>
                      {cue.status === "current" ? "현재" : cue.status === "done" ? "완료" : "예정"}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.runbookEmpty}>
                행사일에 등록된 프로그램이 없습니다.
              </p>
            )}
          </ConsoleSection>
          {preparing ? (
            <ConsoleSection headingId="event-readiness-heading" title="행사 준비 확인" className={styles.regionReadiness}>
              <ul className={styles.readinessIndex}>
                <li>
                  <span className={styles.readinessLabel}>참가 접수</span>
                  <span className={styles.readinessStatus}>{intakeShort}</span>
                  <Link className={styles.readinessLink} href={`${base}/settings#settings-intake`}>접수 설정</Link>
                </li>
                <li>
                  <span className={styles.readinessLabel}>현장 준비</span>
                  <span className={styles.readinessStatus}>데스크 {overview.deskCount} · 배정 {overview.deskAssignmentCount}{liveBlocked ? " — 부족" : ""}</span>
                  <Link className={styles.readinessLink} href={`${base}/operations`}>현장 운영 확인</Link>
                </li>
                <li>
                  <span className={styles.readinessLabel}>참가자 디자인 · 선택 사항</span>
                  <span className={styles.readinessStatus}>{overview.pagePublished ? (overview.pageDraftDiffers ? "게시됨 · 새 초안 있음" : "게시됨") : "기본 디자인 사용 중 · 꾸미기는 선택 사항입니다"}</span>
                  <Link className={styles.readinessLink} href={`${base}/page`}>디자인 편집</Link>
                </li>
              </ul>
            </ConsoleSection>
          ) : null}
          </div>
          <div className={styles.contextColumn}>
          <ConsoleSection
            headingId="event-metrics-heading"
            title={currentStage === "LIVE" ? "입장 진행" : currentStage === "ENDED" || currentStage === "ARCHIVED" ? "최종 요약" : "주요 지표"}
            className={styles.regionMetrics}
          >
            {["LIVE", "ENDED", "ARCHIVED"].includes(currentStage) ? (
              <div className={styles.entryProgress}>
              <div className={styles.entrySummary}>
                <div className={styles.entryMain}>
                  <span className={styles.metricLabel}>{currentStage === "LIVE" ? "누적 입장" : "최종 누적 입장"}</span>
                  <div className={styles.entryValues}>
                    <strong className={styles.entryCount}>
                      {overview.everIn}<span>/{overview.registered}명</span>
                    </strong>
                    <span className={styles.entrySeparator} aria-hidden="true">·</span>
                    <strong className={styles.entryRate}>{overview.entryRate}%</strong>
                  </div>
                </div>
                {currentStage === "ARCHIVED" ? (
                  <span className={styles.readOnlyNote}>보관된 행사는 읽기 전용입니다.</span>
                ) : null}
              </div>
              <div
                className={styles.entryTrack}
                role="progressbar"
                aria-label={`입장 진행 ${overview.everIn}/${overview.registered}명, 취소 제외 등록 대비 ${overview.entryRate}%`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={entryProgress}
              >
                <span className={styles.entryFill} style={{ width: `${entryProgress}%` }} />
              </div>
              <div className={styles.entryFoot}>
                <span>취소 제외 등록 대비 입장률 · 결과 보고서와 같은 정의</span>
                {currentStage === "ARCHIVED" ? null : (
                  <Link
                    className={styles.notEntered}
                    href={`${base}/participants?status=APPROVED&attendance=NOT_ENTERED`}
                  >
                    <span>확정자 중 미입장</span>
                    <strong>{overview.confirmedNotEntered}명</strong>
                  </Link>
                )}
                <Link href={`${base}/reports`}>결과 보고서 보기</Link>
              </div>
              {currentStage !== "LIVE" ? (
                <div className={styles.summaryFacts}>
                  {currentStage === "ARCHIVED" ? (
                    <Link className={styles.summaryFact} href={`${base}/participants`}>
                      <span>취소 제외 등록</span>
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
              ) : null}
            </div>
          ) : metrics.length ? (
            <>
            <div className={styles.metricGrid}>
              {metrics.map((metric) => (
                <Link className={styles.metricCard} href={metric.href} key={metric.label}>
                  <span className={styles.metricLabel}>{metric.label}</span>
                  <strong className={styles.metricValue}>{metric.value}</strong>
                  <span className={styles.metricDetail}>{metric.detail}</span>
                </Link>
              ))}
            </div>
            <p className={styles.metricConfig}>
              {overview.capacity > 0 ? (
                <span>
                  정원 <strong>{overview.capacity}명</strong> · 대기 <strong>{overview.waitlist}명</strong>
                  {" "}<Link href={`${base}/participants?status=WAITLIST`}>대기 명단</Link>
                </span>
              ) : (
                <span>정원 제한 없음 · 대기 <strong>{overview.waitlist}명</strong></span>
              )}
            </p>
            </>
          ) : (
            <p className={styles.restrictedNote}>확인 가능한 단계 지표가 없습니다.</p>
          )}
            <details className={styles.analysisDetails}>
              <summary>기간 분석</summary>
              <div className={styles.periodBlock}>
                <PeriodDetails rows={periodRows} applications={overview.trendApplications} entries={overview.trendEntries} />
              </div>
            </details>
        </ConsoleSection>
          <aside className={`${styles.rail} ${styles.regionSecondary}`}>
          <div className={styles.monitorHead}>
            <span className={styles.monitorLive} data-live={currentStage === "LIVE"}><i aria-hidden="true" /> {stageText}</span>
            <time dateTime={overview.updatedAt}>조회 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time>
          </div>

          {schedule.length > 0 ? (
            <ConsoleSection
              headingId="event-schedule-heading"
              title="현재·다음 일정"
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
                    <span className={styles.scheduledBadge}>예정</span>
                  </li>
                ))}
              </ol>
            </ConsoleSection>
          ) : null}
          </aside>
          </div>
      </>
      ) : (
        <p className={styles.restrictedNote}>행사 지표는 행사 운영자에게 표시됩니다.</p>
      )}

      {preparing && overview.recent.length === 0 ? (
        <div className={`${styles.recentCompact} ${styles.regionRecent}`}>
          <h2 id="event-recent-heading" className={styles.recentCompactTitle}>
            {overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
          </h2>
          <span className={styles.recentCount}>0건</span>
          <span className={styles.recentCompactMeta}>
            다른 화면에서 돌아오면 갱신 · <time dateTime={overview.updatedAt}>마지막 갱신 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time>
          </span>
          <button
            type="button"
            className={`button button-secondary ${styles.refreshButton}`}
            onClick={reloadOverview}
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label="새로고침"
            title="새로고침"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
              <path d="M20 7v5h-5" />
              <path d="M19.1 12a7.1 7.1 0 1 1-2.08-5.02L20 9" />
            </svg>
          </button>
          {refreshing ? <p className={styles.refreshStatus} role="status">최신 운영 현황을 불러오고 있습니다.</p> : null}
          <p className={styles.recentCompactEmpty}>
            {overview.canManageEvent
              ? "아직 입퇴장 기록이 없습니다. 현장 운영의 데스크에서 입장을 기록하면 여기에 표시됩니다."
              : "배정된 데스크에 아직 입퇴장 기록이 없습니다. 담당 데스크에서 입장 기록이 생기면 여기에 표시됩니다."}
          </p>
        </div>
      ) : (
      <ConsoleSection
        headingId="event-recent-heading"
        title={overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
        className={styles.regionRecent}
        description={<time dateTime={overview.updatedAt}>마지막 갱신 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time>}
        action={(
          <div className={styles.recentActions}>
            <span className={styles.recentCount}>{overview.recent.length}건</span>
            <button
              type="button"
              className={`button button-secondary ${styles.refreshButton}`}
              onClick={reloadOverview}
              disabled={refreshing}
              aria-busy={refreshing}
              aria-label="새로고침"
              title="새로고침"
            >
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                <path d="M20 7v5h-5" />
                <path d="M19.1 12a7.1 7.1 0 1 1-2.08-5.02L20 9" />
              </svg>
            </button>
          </div>
        )}
      >
        {refreshing ? <p className={styles.refreshStatus} role="status">최신 운영 현황을 불러오고 있습니다.</p> : null}
        {overview.recent.length ? (
          <ul className={styles.activityList}>
            {overview.recent.map((check) => (
              <li key={check.id}>
                <div className={styles.checkDetails}>
                  <strong>{check.name || "이름 없음"}</strong>
                  <span className={`${styles.checkAction} ${check.action === "IN" ? styles.checkIn : check.action === "OUT" ? styles.checkOut : styles.checkOther}`}>
                    {check.action === "IN" ? "입장" : check.action === "OUT" ? "퇴장" : "기록"}
                  </span>
                  {check.deskName ? <span className={styles.deskName}>{check.deskName}</span> : null}
                </div>
                <time className={styles.timestamp} dateTime={check.at || undefined}>
                  {formatCheckTime(check.at)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            {overview.canManageEvent
              ? "아직 입퇴장 기록이 없습니다. 현장 운영의 데스크에서 입장을 기록하면 여기에 표시됩니다."
              : "배정된 데스크에 아직 입퇴장 기록이 없습니다. 담당 데스크에서 입장 기록이 생기면 여기에 표시됩니다."}
          </p>
        )}
      </ConsoleSection>
      )}
      </div>
    </ConsolePage>
  );
}
