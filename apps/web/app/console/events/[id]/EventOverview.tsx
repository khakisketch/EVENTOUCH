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
import styles from "./event-overview.module.css";

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
  recent: CheckRow[];
  registrationOpen: boolean;
  surveyResponseCount: number | null;
  reportCount: number;
  publishedReportCount: number;
  draftReportCount: number;
  programs: ScheduledProgram[];
  updatedAt: string;
  canManageEvent: boolean;
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
      return [
        { label: "신청", value: overview.registered, detail: "취소 제외 등록", href: participantsHref },
        { label: "참가 확정", value: overview.approved, detail: "승인된 참가자", href: `${participantsHref}?status=APPROVED` },
        { label: "승인 대기", value: overview.pendingApproval, detail: "검토가 필요한 신청", href: `${participantsHref}?status=PENDING` },
        ...(overview.capacity > 0
          ? [{
              label: "대기 명단 / 정원",
              value: `${overview.waitlist} / ${overview.capacity}`,
              detail: "대기 명단 · 행사 정원",
              href: `${participantsHref}?status=WAITLIST`,
            }]
          : [{
              label: "정원",
              value: "제한 없음",
              detail: "신청 수 제한 없음",
              href: `${base}/settings`,
            }]),
      ];
    default:
      return [];
  }
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setRefreshing(true);
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
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
            recent: checks,
            registrationOpen: workspace.registrationOpen === true,
            surveyResponseCount,
            reportCount: reportRows.length,
            publishedReportCount,
            draftReportCount,
            programs: programRows,
            updatedAt: now.toISOString(),
            canManageEvent,
          },
        });
        setRefreshError(null);
        setLinkNotice(null);
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
    } catch {
      setLinkNotice("링크를 복사하지 못했습니다. 참가자 페이지를 열어 주소를 확인하세요.");
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
  const dDay = dDayLabel(overview.date, new Date());
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
          <Link className="button button-secondary" href={participantPageHref} target="_blank" rel="noreferrer">
            참가자 페이지 열기
          </Link>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void copyParticipantLink(overview.slug)}
          >
            링크 복사
          </button>
        </>
      ) : null;

  return (
    <ConsolePage pageId="overview" eventId={eventId} eventName={overview.name || "이름 없는 행사"}
      meta={eventMeta} badges={stageBadges} headerActions={headerActions}
      feedback={linkNotice ? <ConsoleFeedback kind="info">{linkNotice}</ConsoleFeedback> : undefined}>
      {overview.canManageEvent ? (
        <>
          {showApprovalAlert && (
            <ConsoleFeedback kind="warning">
              <div className={styles.approvalNotice}>
                <strong>승인 대기 {overview.pendingApproval}명</strong>
                <Link className="button button-secondary" href={`${base}/participants?status=PENDING`}>
                  승인 대기 처리
                </Link>
              </div>
            </ConsoleFeedback>
          )}
          <ConsoleSection
            headingId="event-metrics-heading"
            title={currentStage === "LIVE" ? "입장 진행" : currentStage === "ENDED" || currentStage === "ARCHIVED" ? "최종 요약" : "주요 지표"}
            description={stageKnown ? `${stageText} 단계 기준` : "확인 가능한 단계 지표가 없습니다."}
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
                ) : (
                  <Link
                    className={styles.notEntered}
                    href={`${base}/participants?status=APPROVED&attendance=NOT_ENTERED`}
                  >
                    <span>확정자 중 미입장</span>
                    <strong>{overview.confirmedNotEntered}명</strong>
                  </Link>
                )}
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
            <div className={styles.metricGrid}>
              {metrics.map((metric) => (
                <Link className={styles.metricCard} href={metric.href} key={metric.label}>
                  <span className={styles.metricLabel}>{metric.label}</span>
                  <strong className={styles.metricValue}>{metric.value}</strong>
                  <span className={styles.metricDetail}>{metric.detail}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className={styles.restrictedNote}>확인 가능한 단계 지표가 없습니다.</p>
          )}
            <div className={styles.periodBlock}>
              <div className={styles.periodHeader}>
                <h3>기간별 신청·입장</h3>
                <span>취소·정정 제외 · 입장은 참가자 기준</span>
              </div>
              <table className={styles.periodTable} aria-label="기간별 신청·입장">
                <thead>
                  <tr>
                    <th scope="col">기간</th>
                    <th scope="col">신청</th>
                    <th scope="col">입장</th>
                  </tr>
                </thead>
                <tbody>
                  {periodRows.map(([label, period]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>{period.applications}명</td>
                      <td>{period.entries}명</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </ConsoleSection>
      </>
      ) : (
        <p className={styles.restrictedNote}>행사 지표는 행사 운영자에게 표시됩니다.</p>
      )}

      {overview.canManageEvent && schedule.length > 0 ? (
        <ConsoleSection
          headingId="event-schedule-heading"
          title="현재·다음 일정"
          description="게시 여부와 관계없이 등록된 일정입니다. 실제 진행 상태가 아닌 예정 기준입니다."
          action={<Link className="button button-secondary" href={`${base}/content`}>프로그램 일정</Link>}
          surface="panel"
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

      <ConsoleSection
        headingId="event-recent-heading"
        title={overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
        description={(
          <>
            자동 갱신되지 않습니다 · <time dateTime={overview.updatedAt}>마지막 갱신 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time>
          </>
        )}
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
        surface="panel"
      >
        {refreshing ? <p className={styles.refreshStatus} role="status">최신 운영 현황을 불러오고 있습니다.</p> : null}
        {refreshError ? <p className="state-error" role="alert">{refreshError} 이전에 불러온 내용은 유지됩니다.</p> : null}
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
              ? "아직 입퇴장 기록이 없습니다."
              : "배정된 데스크에 아직 입퇴장 기록이 없습니다."}
          </p>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}
