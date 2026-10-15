"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../../auth-redirect";

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
      eventName: string;
      people: Person[];
      canManage: boolean;
    };

const STATUSES = ["PENDING", "APPROVED", "WAITLIST", "CANCELLED"] as const;

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

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function ParticipantList({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

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
          workspaces?: Record<string, { participants?: unknown }>;
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
      const participants = bootstrap.workspaces?.[eventId]?.participants;
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
        eventName:
          event && typeof event.name === "string" ? event.name : eventId,
        people,
        canManage,
      });
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function changeStatus(person: Person, status: string) {
    if (savingId || status === person.status) return;
    setSavingId(person.id);
    setNotice(null);
    setFailure(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: randomCommandId(),
            command: "participant.status",
            payload: { id: person.id, status },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      if (!res.ok) {
        setFailure(
          typeof data?.error === "string" ? data.error : "변경하지 못했습니다."
        );
        return;
      }
      setNotice(`${person.name} 상태를 ${statusLabel(status)}(으)로 바꿨습니다.`);
      await load(true);
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSavingId(null);
    }
  }

  if (state.kind === "loading") return <p className="loading-state" role="status">참가자 목록을 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <p>
          <button type="button" className="button button-secondary" onClick={() => {
            window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
            void load();
          }}>
            다시 불러오기
          </button>
        </p>
        <p>
          <Link href="/console">행사 목록으로</Link>
        </p>
      </section>
    );
  }
  const search = query.trim().toLocaleLowerCase("ko-KR");
  const visiblePeople = state.people.filter((person) => {
    const haystack = `${person.name} ${person.company} ${person.phone}`.toLocaleLowerCase("ko-KR");
    const matchesQuery = !search || haystack.includes(search);
    return matchesQuery && (!statusFilter || person.status === statusFilter);
  });

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
      .map((row) =>
        row
          .map((cell) =>
            /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
          )
          .join(",")
      )
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
  return (
    <section className="participants-content">
      <header className="participants-heading">
      <h1>{state.eventName}</h1>
      </header>
      {notice ? <p className="state-success" role="status">{notice}</p> : null}
      {failure ? <p className="state-error" role="alert">{failure}</p> : null}
      {!state.canManage ? (
        <p className="notice" role="status">상태 변경 권한이 없습니다. 변경이 필요하면 담당 행사 운영자에게 요청하세요.</p>
      ) : null}
      <div className="participant-toolbar">
        <label>
          <span className="sr-only">참가자 이름 검색</span>
          <input
            type="search"
            placeholder="이름·소속·연락처 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">상태별 보기</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">전체 상태</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>{statusLabel(status)}</option>
            ))}
          </select>
        </label>
        <button type="button" className="button button-secondary" onClick={exportCsv}>
          목록 CSV
        </button>
        {state.canManage ? (
          <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants/import`}>
            명단 가져오기
          </Link>
        ) : null}
      </div>
      <p className="participant-count" role="status">
        {statusFilter || search
          ? `${visiblePeople.length}명 / 전체 ${state.people.length}명`
          : `전체 ${state.people.length}명`}
      </p>
      {visiblePeople.length ? (
        <ul className="participant-list">
          {visiblePeople.map((person) => (
            <li className="participant-row" key={person.id}>
              <span className="participant-summary">
                {state.canManage ? person.name : `${person.name} · ${statusLabel(person.status)}`}
              </span>
              {state.canManage ? (
                <select
                  aria-label={`${person.name} 상태 변경`}
                  value={isKnownStatus(person.status) ? person.status : ""}
                  disabled={savingId === person.id}
                  onChange={(event) => changeStatus(person, event.target.value)}
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
            </li>
          ))}
        </ul>
      ) : state.people.length ? (
        <p className="empty-state">조건에 맞는 참가자가 없습니다.</p>
      ) : (
        <p className="empty-state">등록된 참가자가 없습니다.</p>
      )}
      <p>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}`}>운영 현황으로</Link>
      </p>
    </section>
  );
}
