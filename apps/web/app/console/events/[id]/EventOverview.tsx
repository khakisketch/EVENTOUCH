"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { eventStageLabel } from "../../../event-stage";

type Participant = {
  status: string;
  inside: boolean;
  everIn: boolean;
};
type CheckRow = {
  id: string;
  participantId: string;
  name: string;
  action: string;
  at: string;
  corrected: boolean;
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
};

type OverviewState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; overview: Overview };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push("/staff/login");
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: unknown;
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
        const participants: Participant[] = Array.isArray(workspace.participants)
          ? workspace.participants.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const person = item as Record<string, unknown>;
              return [{
                status: text(person.status),
                inside: person.inside === true,
                everIn: person.everIn === true,
              }];
            })
          : [];
        const live = participants.filter((person) => person.status !== "CANCELLED");
        const approved = live.filter((person) => person.status === "APPROVED");
        const venue =
          typeof workspace.venue === "object" && workspace.venue !== null
            ? text((workspace.venue as Record<string, unknown>).name)
            : "";
        const checks: CheckRow[] = Array.isArray(workspace.checks)
          ? workspace.checks.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const check = item as Record<string, unknown>;
              if (typeof check.id !== "string") return [];
              return [{
                id: check.id,
                participantId: text(check.participantId),
                name: text(check.name),
                action: text(check.action),
                at: text(check.at),
                corrected: check.corrected === true,
              }];
            })
          : [];
        const recent = checks
          .filter((check) => !check.corrected)
          .slice(0, 5);
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        setState({
          kind: "ready",
          overview: {
            name: text(event.name),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue,
            stage: text(event.stage),
            registered: live.length,
            pendingApproval: live.filter((person) => person.status === "PENDING").length,
            insideNow: live.filter((person) => person.inside).length,
            entryRate: approved.length
              ? Math.round(
                  (approved.filter((person) => person.everIn).length / approved.length) * 100
                )
              : 0,
            recent,
            deskCount: desks.length,
            assignedDeskStaff: (() => {
              const assignments = workspace.assignments;
              return Array.isArray(assignments)
                ? assignments.filter((item) => {
                    if (typeof item !== "object" || item === null) return false;
                    return (item as Record<string, unknown>).type === "DESK";
                  }).length
                : 0;
            })(),
            registrationOpen: workspace.registrationOpen === true,
            openModules: Array.isArray(workspace.modules)
              ? workspace.modules.filter((item) => {
                  if (typeof item !== "object" || item === null) return false;
                  return (item as Record<string, unknown>).status === "OPEN";
                }).length
              : 0,
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

  const STAGE_ORDER = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];
  const currentStage = state.kind === "ready" ? state.overview.stage.toUpperCase() : "";
  const stageIndex = STAGE_ORDER.indexOf(currentStage);
  const nextStage = stageIndex >= 0 && stageIndex < STAGE_ORDER.length - 1
    ? STAGE_ORDER[stageIndex + 1]
    : null;

  async function advanceStage() {
    if (state.kind !== "ready" || !nextStage || stageBusy) return;
    const overview = state.overview;
    const label = eventStageLabel(nextStage);
    const extra =
      nextStage === "LIVE"
        ? "\n\n현장 운영이 시작됩니다. 등록 데스크와 활성 스태프 배정이 필요합니다."
        : nextStage === "ARCHIVED"
          ? "\n\n보관하면 이 행사를 변경할 수 없습니다. 접수와 참여 프로그램을 먼저 닫아야 합니다."
          : "";
    if (!window.confirm(`행사를 ${label}(으)로 전환할까요?${extra}`)) return;
    setStageBusy(true);
    setStageError(null);
    setStageNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          command: "event.stage",
          payload: { stage: nextStage },
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setStageError(
          typeof data?.error === "string" ? data.error : "단계를 전환하지 못했습니다."
        );
        return;
      }
      setStageNotice(`행사를 ${label}(으)로 전환했습니다.`);
      setReloadTick((tick) => tick + 1);
    } catch {
      setStageError("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setStageBusy(false);
    }
  }

  if (state.kind === "loading") return <p className="loading-state" role="status">운영 현황을 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <p>
          <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
            다시 불러오기
          </button>
        </p>
        <p>
          <Link href="/console">행사 목록으로</Link>
        </p>
      </section>
    );
  }
  const overview = state.overview;
  const stageText = STAGE_ORDER.includes(overview.stage.toUpperCase())
    ? eventStageLabel(overview.stage)
    : "단계 미정";
  return (
    <section className="overview-content">
      <header className="overview-header">
      <h1>{overview.name}</h1>
      <p className="overview-meta">
        {[overview.date, overview.start && overview.end
          ? `${overview.start} ~ ${overview.end}`
          : overview.start, overview.venue, stageText]
          .filter(Boolean)
          .join(" · ")}
      </p>
      </header>
      <h2 className="section-heading">핵심 지표</h2>
      <ul className="overview-metrics">
        <li><span>등록</span><strong>{overview.registered}</strong></li>
        <li><span>승인 대기</span><strong>{overview.pendingApproval}</strong></li>
        <li><span>현재 입장</span><strong>{overview.insideNow}</strong></li>
        <li><span>입장률</span><strong>{overview.entryRate}<small>%</small></strong></li>
      </ul>
      <section className="overview-stage">
        <h2 className="section-heading">진행 단계</h2>
        <p>
          현재 <strong>{stageText}</strong>
          {nextStage
            ? ` · 다음 ${eventStageLabel(nextStage)}`
            : stageText === "단계 미정"
              ? ""
              : " · 마지막 단계입니다"}
        </p>
        {nextStage === "LIVE" && (overview.deskCount === 0 || overview.assignedDeskStaff === 0) ? (
          <p className="notice" role="status">
            진행 중으로 전환하려면 등록 데스크와 활성 스태프 배정이 필요합니다.
          </p>
        ) : null}
        {nextStage === "ARCHIVED" && (overview.registrationOpen || overview.openModules > 0) ? (
          <p className="notice" role="status">
            보관하려면 접수를 닫고 진행 중인 참여 프로그램을 모두 닫아야 합니다.
          </p>
        ) : null}
        {nextStage ? (
          <p className="overview-action">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void advanceStage()}
              disabled={stageBusy}
            >
              {stageBusy ? "전환 중입니다" : `${eventStageLabel(nextStage)}(으)로 전환`}
            </button>
          </p>
        ) : null}
        {stageNotice ? <p role="status">{stageNotice}</p> : null}
        {stageError ? <p role="alert">{stageError}</p> : null}
      </section>
      <section className="overview-task">
      <h2 className="section-heading">지금 할 일</h2>
      {overview.pendingApproval > 0 ? (
        <p>승인 대기 {overview.pendingApproval}건을 확인하세요.</p>
      ) : (
        <p>대기 중인 승인이 없습니다.</p>
      )}
      <div className="overview-action-group">
        <Link className="button button-primary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>
          참가자 관리로
        </Link>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/messages`}>
          메시지 관리로
        </Link>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/operations`}>
          현장 운영 준비
        </Link>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/settings`}>
          행사 설정
        </Link>
      </div>
      </section>
      <section className="overview-recent">
      <h2 className="section-heading">최근 입퇴장</h2>
      {overview.recent.length ? (
        <ul className="recent-checks">
          {overview.recent.map((check) => (
            <li key={check.id}>
              {check.name} · {check.action === "IN" ? "입장" : "퇴장"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">아직 입퇴장 기록이 없습니다.</p>
      )}
      </section>
    </section>
  );
}
