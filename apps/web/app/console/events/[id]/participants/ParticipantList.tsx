"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Person = {
  id: string;
  name: string;
  status: string;
  paymentStatus: string;
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
    default:
      return "승인 대기";
  }
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

  async function load(silent = false) {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push("/staff/login");
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

  if (state.kind === "loading") return <p>참가자 목록을 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section>
        <p role="alert">{state.message}</p>
        <p>
          <Link href="/console">행사 목록으로</Link>
        </p>
      </section>
    );
  }
  return (
    <section>
      <h1>{state.eventName}</h1>
      {notice ? <p role="status">{notice}</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {state.people.length ? (
        <ul>
          {state.people.map((person) => (
            <li key={person.id}>
              <span>
                {person.name} · {statusLabel(person.status)}
              </span>
              {state.canManage ? (
                <select
                  aria-label={`${person.name} 상태 변경`}
                  value={STATUSES.includes(person.status as (typeof STATUSES)[number])
                    ? person.status
                    : "PENDING"}
                  disabled={savingId === person.id}
                  onChange={(event) => changeStatus(person, event.target.value)}
                >
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
      ) : (
        <p>등록된 참가자가 없습니다.</p>
      )}
      <p>
        <Link href={`/console/events/${encodeURIComponent(eventId)}`}>운영 현황으로</Link>
      </p>
    </section>
  );
}
