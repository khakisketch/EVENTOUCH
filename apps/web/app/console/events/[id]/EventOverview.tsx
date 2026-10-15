"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../auth-redirect";
import { eventStageClassName, eventStageLabel } from "../../../event-stage";
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

type BoothRow = {
  id: string;
  name: string;
  status: string;
  capacity: number;
  used: number;
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
  insideNow: number;
  everIn: number;
  confirmedNotEntered: number;
  entryRate: number;
  recent: CheckRow[];
  deskCount: number;
  openDeskCount: number;
  deskAssignmentCount: number;
  assignedDeskPeople: number;
  booths: BoothRow[];
  stampEnabled: boolean;
  stampMode: string;
  screenEnabled: boolean;
  displayLabel: string;
  registrationOpen: boolean;
  openModules: number;
  surveyResponseCount: number | null;
  reportCount: number;
  publishedReportCount: number;
  draftReportCount: number;
  messageAttentionCount: number;
  messageAttentionSummary: string;
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

type Problem = {
  title: string;
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

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
  const reportsHref = `${base}/reports`;

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
          : []),
      ];
    case "LIVE":
      return [
        { label: "누적 입장", value: overview.everIn, detail: "취소 제외 참가 기록", href: reportsHref },
        { label: "현재 입장", value: overview.insideNow, detail: "현재 입장 상태", href: reportsHref },
        { label: "확정자 중 미입장", value: overview.confirmedNotEntered, detail: "참가 확정 · 입장 기록 없음", href: `${participantsHref}?status=APPROVED` },
        { label: "취소 제외 등록 대비 입장률", value: `${overview.entryRate}%`, detail: "결과 보고서와 같은 정의", href: reportsHref },
      ];
    case "ENDED":
      return [
        { label: "최종 누적 입장", value: overview.everIn, detail: "everIn 기록 · 취소 제외", href: reportsHref },
        { label: "취소 제외 등록 대비 입장률", value: `${overview.entryRate}%`, detail: "결과 보고서와 같은 정의", href: reportsHref },
        ...(overview.surveyResponseCount === null
          ? []
          : [{ label: "설문 응답", value: overview.surveyResponseCount, detail: "만족도 프로그램 응답", href: reportsHref }]),
        { label: "보고서 상태", value: getReportStatus(overview), detail: overview.reportCount ? `${overview.reportCount}건` : "보고서 없음", href: reportsHref },
      ];
    case "ARCHIVED":
      return [
        { label: "취소 제외 등록", value: overview.registered, detail: "읽기 전용 요약", href: participantsHref },
        { label: "최종 누적 입장", value: overview.everIn, detail: "everIn 기록", href: reportsHref },
        { label: "취소 제외 등록 대비 입장률", value: `${overview.entryRate}%`, detail: "결과 보고서와 같은 정의", href: reportsHref },
        { label: "보고서 상태", value: getReportStatus(overview), detail: overview.reportCount ? `${overview.reportCount}건` : "보고서 없음", href: reportsHref },
      ];
    default:
      return [];
  }
}

function problemsForStage(overview: Overview, stage: string, base: string): Problem[] {
  const problems: Problem[] = [];
  const pendingCanBeApproved = stage !== "ENDED" && stage !== "ARCHIVED";
  const isLiveOrReady = stage === "READY" || stage === "LIVE";
  const soldOutBooths = overview.booths.filter(
    (booth) => booth.capacity > 0 && booth.used >= booth.capacity
  );
  const reportIsIncomplete =
    (stage === "ENDED" || stage === "ARCHIVED") &&
    (overview.reportCount === 0 || overview.draftReportCount === overview.reportCount);

  if (isLiveOrReady && (overview.deskCount === 0 || overview.deskAssignmentCount === 0)) {
    const gaps = [
      overview.deskCount === 0 ? "등록 데스크 없음" : "",
      overview.deskAssignmentCount === 0 ? "데스크 배정 없음" : "",
    ].filter(Boolean);
    problems.push({
      title: "현장 데스크 준비 필요",
      detail: gaps.join(" · "),
      href: `${base}/operations`,
    });
  }

  if (overview.messageAttentionCount > 0) {
    problems.push({
      title: "발송 확인 필요",
      detail: `${overview.messageAttentionCount}개 캠페인 · ${overview.messageAttentionSummary}`,
      href: `${base}/messages`,
    });
  }

  if (soldOutBooths.length > 0) {
    const names = soldOutBooths.map((booth) => booth.name).filter(Boolean).slice(0, 3);
    const suffix = soldOutBooths.length > names.length ? ` 외 ${soldOutBooths.length - names.length}곳` : "";
    problems.push({
      title: "부스 수량 소진",
      detail: `${soldOutBooths.length}개 부스 · ${names.join(" · ")}${suffix}`,
      href: `${base}/operations`,
    });
  }

  if (pendingCanBeApproved && overview.pendingApproval > 0) {
    problems.push({
      title: `승인 대기 ${overview.pendingApproval}명`,
      detail: "참가 신청을 검토하고 승인 여부를 정하세요.",
      href: `${base}/participants?status=PENDING`,
    });
  }

  if (reportIsIncomplete) {
    problems.push({
      title: "결과 보고서 작성 필요",
      detail: overview.reportCount === 0 ? "아직 작성된 보고서가 없습니다." : "보고서가 모두 초안 상태입니다.",
      href: `${base}/reports`,
    });
  }

  return problems.slice(0, 5);
}

function displayName(
  display: Record<string, unknown> | null,
  modules: Record<string, unknown>[],
  notices: Record<string, unknown>[]
): string {
  const type = text(display?.type);
  if (type === "idle") return "유휴 화면";
  if (type === "photo") return "사진 출력";
  if (type === "notice") {
    const notice = notices.find((item) => item.id === display?.noticeId);
    return notice ? `공지 · ${text(notice.title) || "제목 없음"}` : "공지 출력 · 내용 확인 필요";
  }
  const module = modules.find((item) => item.id === display?.moduleId);
  const title = text(module?.title);
  const typeLabel: Record<string, string> = {
    poll: "투표",
    quiz: "퀴즈 정답",
    draw: "추첨 결과",
    qa: "Q&A",
  };
  return typeLabel[type] && module
    ? `${typeLabel[type]}${title ? ` · ${title}` : ""}`
    : "출력 설정 확인 필요";
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageConfirm, setStageConfirm] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const stageCommandIdRef = useRef<string | null>(null);

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
        const desks = records(workspace.desks);
        const deskMap = new Map<string, string>();
        desks.forEach((desk) => {
          if (typeof desk.id === "string") deskMap.set(desk.id, text(desk.name));
        });
        const assignments = records(workspace.assignments);
        const deskAssignments = assignments.filter((assignment) => assignment.type === "DESK");
        const assignedDeskPeople = new Set(
          deskAssignments.map((assignment) => text(assignment.accountId)).filter(Boolean)
        ).size;
        const boothRows: BoothRow[] = records(workspace.booths).flatMap((booth) => {
          if (typeof booth.id !== "string" || !booth.id) return [];
          return [{
            id: booth.id,
            name: text(booth.name),
            status: text(booth.status),
            capacity: number(booth.capacity),
            used: number(booth.used),
          }];
        });
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
        const attentionStatusCounts = new Map<string, number>();
        records(workspace.messages).forEach((campaign) => {
          const status = text(campaign.status);
          if (["FAILED", "PARTIAL", "NEEDS_CONNECTION"].includes(status)) {
            attentionStatusCounts.set(status, (attentionStatusCounts.get(status) ?? 0) + 1);
          }
        });
        const attentionLabels = [
          ["FAILED", "실패"],
          ["PARTIAL", "일부 실패"],
          ["NEEDS_CONNECTION", "연결 필요"],
        ] as const;
        const messageAttentionSummary = attentionLabels
          .flatMap(([status, label]) => {
            const count = attentionStatusCounts.get(status) ?? 0;
            return count ? [`${label} ${count}건`] : [];
          })
          .join(" · ");
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
        const notices = records(workspace.notices);
        const display = asRecord(workspace.display);
        const checks: CheckRow[] = records(workspace.checks)
          .filter((check) => typeof check.id === "string" && check.id && check.corrected !== true)
          .map((check) => ({
            id: String(check.id),
            name: text(check.name),
            action: text(check.action),
            at: text(check.at),
            deskName: deskMap.get(text(check.deskId)) ?? "",
          }))
          .sort((left, right) => {
            const leftTime = Date.parse(left.at);
            const rightTime = Date.parse(right.at);
            return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
          })
          .slice(0, 8);
        const features = Array.isArray(event.features)
          ? event.features.filter((feature): feature is string => typeof feature === "string")
          : [];
        const workspaceVenue = asRecord(workspace.venue);
        const now = new Date();

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
            insideNow: participantRows.filter((person) => person.inside === true).length,
            everIn,
            confirmedNotEntered: approved.filter((person) => person.everIn !== true).length,
            entryRate: registered ? Math.round((everIn / registered) * 100) : 0,
            recent: checks,
            deskCount: desks.length,
            openDeskCount: desks.filter((desk) => desk.open === true).length,
            deskAssignmentCount: deskAssignments.length,
            assignedDeskPeople,
            booths: boothRows,
            stampEnabled: features.includes("stamp"),
            stampMode: text(workspace.stampMode),
            screenEnabled: features.includes("screen"),
            displayLabel: displayName(display, modules, notices),
            registrationOpen: workspace.registrationOpen === true,
            openModules: modules.filter((module) => module.status === "OPEN").length,
            surveyResponseCount,
            reportCount: reportRows.length,
            publishedReportCount,
            draftReportCount,
            messageAttentionCount: [...attentionStatusCounts.values()].reduce((sum, count) => sum + count, 0),
            messageAttentionSummary,
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
    setStageError(null);
    setRefreshError(null);
    setReloadTick((tick) => tick + 1);
    window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
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
  const stageIndex = STAGE_ORDER.indexOf(currentStage);
  const nextStage = stageIndex >= 0 && stageIndex < STAGE_ORDER.length - 1
    ? STAGE_ORDER[stageIndex + 1]
    : null;

  async function submitStageTransition() {
    if (
      state.kind !== "ready" ||
      !state.overview.canManageEvent ||
      !nextStage ||
      stageBusy ||
      !stageConfirm
    ) return;
    const label = eventStageLabel(nextStage);
    if (!stageCommandIdRef.current) stageCommandIdRef.current = randomCommandId();
    setStageBusy(true);
    setStageError(null);
    setStageNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: stageCommandIdRef.current,
          command: "event.stage",
          payload: { stage: nextStage },
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setStageError(
          typeof data?.error === "string" ? data.error : "단계를 전환하지 못했습니다."
        );
        setStageConfirm(false);
        stageCommandIdRef.current = null;
        return;
      }
      stageCommandIdRef.current = null;
      setStageNotice(`행사를 ${label}(으)로 전환했습니다.`);
      setStageConfirm(false);
      setReloadTick((tick) => tick + 1);
    } catch {
      // Keep the same id when the response is lost so a retry can replay its
      // receipt instead of creating a second stage command.
      setStageError("연결하지 못했습니다. 같은 요청을 다시 시도하세요.");
    } finally {
      setStageBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className={styles.overview}>
        <header className={styles.pageHeader}>
          <h1>행사 운영 현황</h1>
        </header>
        <p className="loading-state" role="status">운영 현황을 불러오고 있습니다.</p>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className={styles.overview}>
        <header className={styles.pageHeader}>
          <h1>행사 운영 현황</h1>
        </header>
        <section className="state-panel" aria-label="운영 현황을 불러오지 못함">
          <p role="alert">{state.message}</p>
          <button type="button" className="button button-secondary" onClick={reloadOverview}>
            다시 불러오기
          </button>
        </section>
      </div>
    );
  }

  const overview = state.overview;
  const stageKnown = STAGE_ORDER.includes(currentStage);
  const stageText = stageKnown ? eventStageLabel(currentStage) : "단계 미정";
  const archived = currentStage === "ARCHIVED";
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const metrics = metricsForStage(overview, currentStage, base);
  const problems = overview.canManageEvent ? problemsForStage(overview, currentStage, base) : [];
  const schedule = overview.canManageEvent
    ? upcomingPrograms(overview.programs, new Date())
    : [];
  const dDay = dDayLabel(overview.date, new Date());
  const stagePrompt = nextStage
    ? `현재 ${stageText} · 다음 ${eventStageLabel(nextStage)}`
    : archived
      ? "보관된 행사는 읽기 전용입니다."
      : stageKnown
        ? "마지막 진행 단계입니다."
        : "단계 정보가 확인되지 않아 전환할 수 없습니다.";
  const boothCounts = {
    before: overview.booths.filter((booth) => booth.status === "WAITING").length,
    live: overview.booths.filter((booth) => booth.status === "OPEN").length,
    ended: overview.booths.filter((booth) => booth.status === "CLOSED").length,
    unknown: overview.booths.filter((booth) => !["WAITING", "OPEN", "CLOSED"].includes(booth.status)).length,
  };
  const participantPageHref = overview.slug
    ? `/event/${encodeURIComponent(overview.slug)}`
    : "";

  return (
    <div className={styles.overview}>
      <p className="sr-only" role="status">{stageNotice ?? ""}</p>
      <header className={styles.pageHeader}>
        <div className={styles.titleBlock}>
          <h1>{overview.name || "이름 없는 행사"}</h1>
          {overview.clientName ? <p className={styles.clientName}>{overview.clientName}</p> : null}
          <div className={styles.scheduleLine}>
            <span>{formatEventDate(overview.date)}</span>
            {overview.start || overview.end ? (
              <span>
                {overview.start && overview.end
                  ? `${overview.start}–${overview.end}`
                  : overview.start || overview.end}
              </span>
            ) : null}
            <span>{overview.venue || "장소 미정"}</span>
          </div>
          <div className={styles.statusBadges}>
            <span className={`${eventStageClassName(currentStage)} ${styles.stagePill}`}>{stageText}</span>
            <span className={`${styles.intakeBadge} ${overview.registrationOpen ? styles.intakeOpen : styles.intakeClosed}`}>
              {overview.registrationOpen ? "접수 중" : "접수 마감"}
            </span>
            {dDay ? (
              <span className={styles.dDay} title="일정 표시이며 단계는 자동 변경되지 않습니다.">
                {dDay}
              </span>
            ) : null}
            {overview.pendingApproval > 0 && overview.canManageEvent && currentStage !== "ENDED" && !archived ? (
              <span className={styles.pendingBadge}>승인 대기 {overview.pendingApproval}</span>
            ) : null}
          </div>
        </div>
        {overview.canManageEvent && participantPageHref ? (
          <div className={styles.headerActions}>
            <Link className="button button-primary" href={participantPageHref} target="_blank" rel="noreferrer">
              참가자 페이지 열기
            </Link>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void copyParticipantLink(overview.slug)}
            >
              링크 복사
            </button>
          </div>
        ) : null}
        {linkNotice ? <p className={styles.linkNotice} role="status">{linkNotice}</p> : null}
      </header>

      {overview.canManageEvent ? (
        <>
          {problems.length > 0 ? (
            <section className={styles.problemSection} aria-labelledby="event-problems-heading">
              <div className={styles.sectionHeading}>
                <div>
                  <h2 id="event-problems-heading" className={styles.sectionTitle}>조치할 문제</h2>
                  <p className={styles.sectionDescription}>현재 행사 데이터에서 확인된 항목입니다.</p>
                </div>
                <span className={styles.problemCount}>{problems.length}건</span>
              </div>
              <ul className={styles.problemList}>
                {problems.map((problem, index) => (
                  <li key={`${problem.href}-${problem.title}-${index}`}>
                    <Link className={styles.problemLink} href={problem.href}>
                      <span className={styles.problemCopy}>
                        <strong>{problem.title}</strong>
                        <span>{problem.detail}</span>
                      </span>
                      <span className={styles.problemAction}>화면에서 확인</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className={styles.metricsSection} aria-labelledby="event-metrics-heading">
            <div className={styles.sectionHeading}>
              <div>
                <h2 id="event-metrics-heading" className={styles.sectionTitle}>주요 지표</h2>
                <p className={styles.sectionDescription}>{stageKnown ? `${stageText} 단계 기준` : "확인 가능한 단계 지표가 없습니다."}</p>
              </div>
            </div>
            {metrics.length ? (
              <div className={styles.metricGrid}>
                {metrics.map((metric) => (
                  <Link className={styles.metricCard} href={metric.href} key={metric.label}>
                    <span className={styles.metricLabel}>{metric.label}</span>
                    <strong className={styles.metricValue}>{metric.value}</strong>
                    <span className={styles.metricDetail}>{metric.detail}</span>
                  </Link>
                ))}
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <p className={styles.restrictedNote}>행사 전체 지표와 운영 준비 정보는 행사 운영자에게 표시됩니다.</p>
      )}

      {overview.canManageEvent ? (
        <section className={styles.operationsCard} aria-labelledby="event-operations-heading">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="event-operations-heading" className={styles.sectionTitle}>운영 준비·가동</h2>
              <p className={styles.sectionDescription}>설정과 배정 상태를 보여줍니다. 현장 출근이나 기기 정상 여부를 확인하는 값은 아닙니다.</p>
            </div>
            <Link className="button button-secondary" href={`${base}/operations`}>현장 운영</Link>
          </div>
          <dl className={styles.operationsGrid}>
            <div className={styles.operationItem}>
              <dt>열린 데스크</dt>
              <dd>{overview.openDeskCount} / {overview.deskCount}개</dd>
            </div>
            <div className={styles.operationItem}>
              <dt>데스크 배정 계정</dt>
              <dd>{overview.assignedDeskPeople}명</dd>
            </div>
            <div className={styles.operationItem}>
              <dt>부스 상태</dt>
              <dd>
                {overview.booths.length
                  ? `운영 전 ${boothCounts.before} · 운영 중 ${boothCounts.live} · 종료 ${boothCounts.ended}${boothCounts.unknown ? ` · 상태 미정 ${boothCounts.unknown}` : ""}`
                  : "등록 부스 없음"}
              </dd>
            </div>
            <div className={styles.operationItem}>
              <dt>부스 인증 방식</dt>
              <dd>
                {!overview.stampEnabled
                  ? "사용 안 함"
                  : overview.stampMode === "SELF"
                    ? "참가자 직접 인증"
                    : overview.stampMode === "STAFF"
                      ? "스태프 확인"
                      : "인증 방식 확인 필요"}
              </dd>
            </div>
            <div className={styles.operationItem}>
              <dt>전광판 출력</dt>
              <dd>{overview.screenEnabled ? overview.displayLabel : "사용 안 함"}</dd>
            </div>
          </dl>
          <p className={styles.operationNote}>데스크 열림은 설정 상태이고, 배정 인원은 출근 확인이 아닙니다. 부스·전광판 기기 상태도 별도 확인이 필요합니다.</p>
        </section>
      ) : null}

      {overview.canManageEvent && schedule.length > 0 ? (
        <section className={styles.scheduleCard} aria-labelledby="event-schedule-heading">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="event-schedule-heading" className={styles.sectionTitle}>현재·다음 일정</h2>
              <p className={styles.sectionDescription}>게시 여부와 관계없이 등록된 일정입니다. 실제 진행 상태가 아닌 예정 기준입니다.</p>
            </div>
            <Link className="button button-secondary" href={`${base}/content`}>프로그램 일정</Link>
          </div>
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
        </section>
      ) : null}

      <section className={styles.stageControl} aria-labelledby="event-stage-heading">
        <div className={styles.stageCopy}>
          <h2 id="event-stage-heading" className={styles.sectionTitle}>진행 단계</h2>
          <p className={styles.stagePrompt}>{stagePrompt}</p>
        </div>
        {nextStage && overview.canManageEvent ? (
          <div className={styles.stageControls}>
            {!stageConfirm ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setStageError(null);
                  setStageNotice(null);
                  setStageConfirm(true);
                }}
                disabled={stageBusy}
              >
                {eventStageLabel(nextStage)}(으)로 전환
              </button>
            ) : (
              <div className={styles.confirmation} role="group" aria-label="단계 전환 확인">
                <p>정말 {eventStageLabel(nextStage)} 단계로 전환합니다?</p>
                <div className={styles.confirmationActions}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void submitStageTransition()}
                    disabled={stageBusy}
                    aria-label={`정말 ${eventStageLabel(nextStage)} 단계로 전환합니다`}
                  >
                    {stageBusy
                      ? "전환 중입니다"
                      : stageCommandIdRef.current && stageError
                        ? "같은 요청 다시 시도"
                        : "정말 전환합니다"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setStageConfirm(false);
                      setStageError(null);
                    }}
                    disabled={stageBusy}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : !overview.canManageEvent ? (
          <p className={styles.readOnlyNote}>행사 단계 변경 권한이 없습니다.</p>
        ) : !archived && !stageKnown ? (
          <p className={styles.readOnlyNote}>단계 정보가 확인되지 않아 전환할 수 없습니다.</p>
        ) : null}

        {nextStage === "LIVE" && (overview.deskCount === 0 || overview.deskAssignmentCount === 0) ? (
          <p className={styles.precondition}>
            진행 중 전환에는 등록 데스크와 데스크 배정이 필요합니다. 배정은 출근 확인이 아닙니다.
          </p>
        ) : null}
        {nextStage === "ARCHIVED" && (overview.registrationOpen || overview.openModules > 0) ? (
          <p className={styles.precondition}>
            보관하려면 접수를 닫고 진행 중인 참여 프로그램을 모두 닫아야 합니다.
          </p>
        ) : null}
        {stageError ? (
          <div className={styles.stageFeedback}>
            <p className="state-error" role="alert">{stageError}</p>
            {!stageConfirm ? (
              <button type="button" className="button button-secondary" onClick={reloadOverview}>
                현황 다시 불러오기
              </button>
            ) : null}
          </div>
        ) : null}
        {stageNotice ? <p className="state-success">{stageNotice}</p> : null}
      </section>

      <section className={styles.recentCard} aria-labelledby="event-recent-heading">
        <div className={styles.recentHeading}>
          <div>
            <h2 id="event-recent-heading" className={styles.sectionTitle}>
              {overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
            </h2>
            <p className={styles.updateNote}>
              자동 갱신되지 않습니다 · <time dateTime={overview.updatedAt}>마지막 갱신 {UPDATED_TIME_FORMAT.format(new Date(overview.updatedAt))}</time>
            </p>
          </div>
          <div className={styles.recentActions}>
            <span className={styles.recentCount}>{overview.recent.length}건</span>
            <button
              type="button"
              className="button button-secondary"
              onClick={reloadOverview}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              다시 불러오기
            </button>
          </div>
        </div>
        {refreshing ? <p className={styles.refreshStatus} role="status">최신 운영 현황을 불러오고 있습니다.</p> : null}
        {refreshError ? <p className="state-error" role="alert">{refreshError} 이전에 불러온 내용은 유지됩니다.</p> : null}
        {overview.recent.length ? (
          <ul className={styles.activityList}>
            {overview.recent.map((check) => (
              <li key={check.id}>
                <div className={styles.checkDetails}>
                  <strong>{check.name || "이름 없음"}</strong>
                  <span className={check.action === "IN" ? styles.checkIn : styles.checkOut}>
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
      </section>
    </div>
  );
}
