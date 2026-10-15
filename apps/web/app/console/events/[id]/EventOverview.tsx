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
};

type Overview = {
  name: string;
  date: string;
  start: string;
  end: string;
  venue: string;
  stage: string;
  registered: number;
  pendingApproval: number;
  insideNow: number;
  entryRate: number;
  recent: CheckRow[];
  deskCount: number;
  assignedDeskStaff: number;
  registrationOpen: boolean;
  openModules: number;
  canManageEvent: boolean;
};

type OverviewState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; overview: Overview };

type TaskAction = {
  href: string;
  label: string;
};

const STAGE_ORDER = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];
const CHECK_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function taskActionFor(overview: Overview, eventId: string): TaskAction | null {
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  if (overview.pendingApproval > 0) {
    return { href: `${base}/participants?status=PENDING`, label: "승인 처리하기" };
  }
  switch (overview.stage.toUpperCase()) {
    case "DRAFT":
      return { href: `${base}/settings`, label: "이어서 만들기" };
    case "READY":
      return { href: `${base}/operations`, label: "현장 준비하기" };
    case "LIVE":
      return { href: `${base}/operations`, label: "현장 보기" };
    default:
      return null;
  }
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageConfirm, setStageConfirm] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const stageCommandIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
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
            accounts?: unknown;
            workspaces?: Record<string, {
              participants?: unknown;
              checks?: unknown;
              venue?: { name?: unknown } | null;
              desks?: unknown;
              assignments?: unknown;
              modules?: unknown;
              registrationOpen?: unknown;
            }>;
          } | null;
        } | null;
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
          setState({ kind: "failed", message: "운영 현황을 불러오지 못했습니다." });
          return;
        }
        const event = Array.isArray(bootstrap.events)
          ? bootstrap.events.find(
              (item): item is Record<string, unknown> =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>).id === eventId
            )
          : undefined;
        const workspace = bootstrap.workspaces?.[eventId];
        if (!event || !workspace) {
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        const accounts = Array.isArray(bootstrap.accounts)
          ? bootstrap.accounts.flatMap((item) =>
              typeof item === "object" && item !== null
                ? [item as Record<string, unknown>]
                : []
            )
          : [];
        // Bootstrap returns only the staff account to STAFF users; managers
        // and agency owners receive their operator account in this projection.
        // This display gate never replaces the server's command authorization.
        const canManageEvent = accounts.some((account) =>
          ["AGENCY", "MANAGER"].includes(text(account.role))
        );
        const participants = Array.isArray(workspace.participants)
          ? workspace.participants.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const person = item as Record<string, unknown>;
              if (person.status === "CANCELLED") return [];
              return [{
                status: text(person.status),
                inside: person.inside === true,
                everIn: person.everIn === true,
              }];
            })
          : [];
        const approved = participants.filter((person) => person.status === "APPROVED");
        const venue =
          typeof workspace.venue === "object" && workspace.venue !== null
            ? text((workspace.venue as Record<string, unknown>).name)
            : "";
        const checks: CheckRow[] = Array.isArray(workspace.checks)
          ? workspace.checks.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const check = item as Record<string, unknown>;
              if (typeof check.id !== "string") return [];
              if (check.corrected === true) return [];
              return [{
                id: check.id,
                name: text(check.name),
                action: text(check.action),
                at: text(check.at),
              }];
            })
          : [];
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        const assignments = Array.isArray(workspace.assignments) ? workspace.assignments : [];
        setState({
          kind: "ready",
          overview: {
            name: text(event.name),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue,
            stage: text(event.stage),
            registered: participants.length,
            pendingApproval: participants.filter((person) => person.status === "PENDING").length,
            insideNow: participants.filter((person) => person.inside).length,
            entryRate: approved.length
              ? Math.round(
                  (approved.filter((person) => person.everIn).length / approved.length) * 100
                )
              : 0,
            recent: checks.slice(0, 5),
            deskCount: desks.length,
            assignedDeskStaff: assignments.filter((item) =>
              typeof item === "object" && item !== null &&
              (item as Record<string, unknown>).type === "DESK"
            ).length,
            registrationOpen: workspace.registrationOpen === true,
            openModules: Array.isArray(workspace.modules)
              ? workspace.modules.filter((item) =>
                  typeof item === "object" && item !== null &&
                  (item as Record<string, unknown>).status === "OPEN"
                ).length
              : 0,
            canManageEvent,
          },
        });
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [eventId, router, reloadTick]);

  function reloadOverview() {
    setStageError(null);
    setState({ kind: "loading" });
    setReloadTick((tick) => tick + 1);
    window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
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
  const task = overview.canManageEvent && !archived ? taskActionFor(overview, eventId) : null;
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const destinations = overview.canManageEvent && !archived
    ? [
        { href: `${base}/participants`, label: "참가자 관리" },
        { href: `${base}/messages`, label: "메시지 관리" },
        { href: `${base}/operations`, label: "현장 운영" },
        { href: `${base}/settings`, label: "행사 설정" },
      ].filter((destination) => destination.href !== task?.href)
    : [];
  const stagePrompt = nextStage
    ? `현재 ${stageText} · 다음 ${eventStageLabel(nextStage)}`
    : archived
      ? "보관된 행사는 읽기 전용입니다."
      : stageKnown
        ? "마지막 진행 단계입니다."
        : "단계 정보가 확인되지 않아 전환할 수 없습니다.";

  return (
    <div className={styles.overview}>
      <p className="sr-only" role="status">{stageNotice ?? ""}</p>
      <header className={styles.pageHeader}>
        <div className={styles.eventTitleBlock}>
          <h1>{overview.name || "이름 없는 행사"}</h1>
          <p className={styles.scheduleLine}>
            <span>{formatEventDate(overview.date)}</span>
            {overview.start || overview.end ? (
              <span>
                {overview.start && overview.end
                  ? `${overview.start}–${overview.end}`
                  : overview.start || overview.end}
              </span>
            ) : null}
            <span>{overview.venue || "장소 미정"}</span>
          </p>
        </div>
        <div className={styles.statusBadges}>
          <span className={`${eventStageClassName(currentStage)} ${styles.stagePill}`}>{stageText}</span>
          <span className={`${styles.intakeBadge} ${overview.registrationOpen ? styles.intakeOpen : styles.intakeClosed}`}>
            {overview.registrationOpen ? "접수 중" : "접수 마감"}
          </span>
          {overview.pendingApproval > 0 && overview.canManageEvent ? (
            <span className={styles.pendingBadge}>승인 대기 {overview.pendingApproval}</span>
          ) : null}
        </div>
      </header>

      {overview.canManageEvent ? (
        <section className={styles.metricsSection} aria-labelledby="event-metrics-heading">
          <h2 id="event-metrics-heading" className={styles.sectionTitle}>주요 지표</h2>
          <dl className={styles.metricGrid}>
            <div className={styles.metricCard}>
              <dt>등록</dt>
              <dd>{overview.registered}</dd>
            </div>
            <div className={styles.metricCard}>
              <dt>승인 대기</dt>
              <dd>{overview.pendingApproval}</dd>
            </div>
            <div className={styles.metricCard}>
              <dt>현재 입장</dt>
              <dd>{overview.insideNow}</dd>
            </div>
            <div className={styles.metricCard}>
              <dt>입장률</dt>
              <dd>{overview.entryRate}<span>%</span></dd>
            </div>
          </dl>
        </section>
      ) : (
        <p className={styles.restrictedNote}>행사 전체 지표는 행사 운영자에게 표시됩니다.</p>
      )}

      <div className={styles.workGrid}>
        <section className={styles.taskCard} aria-labelledby="event-task-heading">
          <div>
            <h2 id="event-task-heading" className={styles.sectionTitle}>지금 할 일</h2>
            {overview.canManageEvent ? (
              archived ? (
                <p className={styles.taskSummary}>이 행사는 보관되어 읽기 전용입니다.</p>
              ) : overview.pendingApproval > 0 ? (
                <p className={styles.taskSummary}>
                  <strong className={styles.tabular}>{overview.pendingApproval}명</strong>의 승인 요청을 먼저 확인하세요.
                </p>
              ) : task ? (
                <p className={styles.taskSummary}>
                  {currentStage === "DRAFT"
                    ? "행사 정보와 접수 내용을 마무리하세요."
                    : currentStage === "READY"
                      ? "현장 운영을 시작하기 전에 준비 상태를 확인하세요."
                      : "진행 중인 현장 운영을 확인하세요."}
                </p>
              ) : (
                <p className={styles.taskSummary}>
                  {currentStage === "ENDED"
                    ? "진행 중인 현장 업무가 없습니다."
                    : "다음 작업을 안내할 수 있는 진행 단계가 없습니다."}
                </p>
              )
            ) : (
              <p className={styles.taskSummary}>전체 행사 관리는 행사 운영자 권한이 필요합니다.</p>
            )}
          </div>

          {task ? (
            <Link className={`button button-primary ${styles.taskPrimary}`} href={task.href}>
              {task.label}
            </Link>
          ) : null}

          {destinations.length ? (
            <nav className={styles.quickLinks} aria-label="행사 관리 화면">
              {destinations.map((destination) => (
                <Link key={destination.href} className="button button-secondary" href={destination.href}>
                  {destination.label}
                </Link>
              ))}
            </nav>
          ) : null}
        </section>

        <section className={styles.stageCard} aria-labelledby="event-stage-heading">
          <div>
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

          {nextStage === "LIVE" && (overview.deskCount === 0 || overview.assignedDeskStaff === 0) ? (
            <p className={styles.precondition}>
              진행 중으로 전환하려면 등록 데스크와 활성 스태프 배정이 필요합니다.
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
      </div>

      <section className={styles.recentCard} aria-labelledby="event-recent-heading">
        <div className={styles.recentHeading}>
          <h2 id="event-recent-heading" className={styles.sectionTitle}>
            {overview.canManageEvent ? "최근 입퇴장" : "배정 데스크 최근 입퇴장"}
          </h2>
          <span className={styles.recentCount}>{overview.recent.length}건</span>
        </div>
        {overview.recent.length ? (
          <ul className={styles.activityList}>
            {overview.recent.map((check) => (
              <li key={check.id}>
                <div className={styles.checkDetails}>
                  <strong>{check.name || "이름 없음"}</strong>
                  <span className={check.action === "IN" ? styles.checkIn : styles.checkOut}>
                    {check.action === "IN" ? "입장" : "퇴장"}
                  </span>
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
