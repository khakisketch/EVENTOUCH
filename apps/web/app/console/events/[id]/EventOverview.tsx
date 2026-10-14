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
};

type OverviewState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; overview: Overview };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default function EventOverview({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<OverviewState>({ kind: "loading" });

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
  }, [eventId, router]);

  if (state.kind === "loading") return <p className="loading-state" role="status">운영 현황을 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <p>
          <Link href="/console">행사 목록으로</Link>
        </p>
      </section>
    );
  }
  const overview = state.overview;
  return (
    <section className="overview-content">
      <header className="overview-header">
      <h1>{overview.name}</h1>
      <p className="overview-meta">
        {[overview.date, overview.start && overview.end
          ? `${overview.start} ~ ${overview.end}`
          : overview.start, overview.venue, eventStageLabel(overview.stage)]
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
      <section className="overview-task">
      <h2 className="section-heading">지금 할 일</h2>
      {overview.pendingApproval > 0 ? (
        <p>승인 대기 {overview.pendingApproval}건을 확인하세요.</p>
      ) : (
        <p>대기 중인 승인이 없습니다.</p>
      )}
      <p className="overview-action">
        <Link className="button button-primary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>
          참가자 관리로
        </Link>
      </p>
      <p className="overview-action">
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/messages`}>
          메시지 관리로
        </Link>
      </p>
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
