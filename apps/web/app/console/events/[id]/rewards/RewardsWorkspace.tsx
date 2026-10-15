"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import styles from "./rewards.module.css";

// Reward handout desk: registration happens on the participant row
// (경품 등록), and this screen is where staff/operators mark handout or
// cancel. GIFT fulfilment is honest about v1: the code is a DEMO- placeholder
// and the status records NEEDS_CONNECTION instead of pretending a coupon
// was issued.

type Reward = {
  id: string;
  participantId: string;
  name: string;
  method: string;
  status: string;
  at: string;
  code: string;
  participantName: string;
};

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; eventName: string; featureOn: boolean; canManage: boolean; rewards: Reward[] };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function methodLabel(method: string): string {
  return method === "GIFT" ? "기프티콘 (모의)" : "현장 수령";
}

function statusLabel(status: string): string {
  switch (status) {
    case "READY":
      return "지급 대기";
    case "RECEIVED":
      return "수령 완료";
    case "NEEDS_CONNECTION":
      return "연결 필요 (기프티콘 미연동)";
    case "CANCELLED":
      return "취소";
    case "FAILED":
      return "지급 실패";
    default:
      return "상태 확인 필요";
  }
}

function formatTime(value: string): string {
  if (!value) return "시각 확인 중";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function RewardsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
          state?: { events?: unknown; workspaces?: unknown } | null;
        } | null;
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
          setState({ kind: "failed", message: "경품 정보를 불러오지 못했습니다." });
          return;
        }
        const event = (Array.isArray(bootstrap.events) ? bootstrap.events : [])
          .map(record)
          .find((item) => item?.id === eventId);
        const workspace = record((bootstrap.workspaces ?? {})[eventId as keyof object]);
        if (!event || !workspace) {
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        const names = new Map<string, string>();
        if (Array.isArray(workspace.participants)) {
          for (const item of workspace.participants) {
            const person = record(item);
            if (person && typeof person.id === "string") names.set(person.id, text(person.name, "이름 미등록"));
          }
        }
        const rewards: Reward[] = Array.isArray(workspace.rewards)
          ? workspace.rewards.flatMap((item) => {
              const reward = record(item);
              if (!reward || typeof reward.id !== "string") return [];
              return [{
                id: reward.id,
                participantId: text(reward.participantId),
                name: text(reward.name, "경품명 미등록"),
                method: text(reward.method, "ONSITE"),
                status: text(reward.status),
                at: text(reward.at),
                code: text(reward.code),
                participantName: names.get(text(reward.participantId)) ?? "참가자 확인 필요",
              }];
            })
          : [];
        setState({
          kind: "ready",
          eventName: text(event.name, eventId),
          featureOn: Array.isArray(event.features) && event.features.includes("reward"),
          canManage: (event as Record<string, unknown>).canManage !== false,
          rewards,
        });
      } catch {
        if (!cancelled) setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [eventId, reloadTick, router]);

  async function runCommand(id: string, command: "reward.fulfill" | "reward.cancel") {
    if (busy) return;
    setBusy(id);
    setFailure(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: randomCommandId(), command, payload: { id } }),
        }
      );
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setFailure(typeof data?.error === "string" ? data.error : "처리하지 못했습니다.");
        return;
      }
      setNotice(command === "reward.fulfill" ? "지급 처리했습니다." : "경품을 취소했습니다.");
      setReloadTick((tick) => tick + 1);
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading") return <p className="loading-state" role="status">경품 정보를 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setReloadTick((tick) => tick + 1);
            window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
          }}
        >
          다시 불러오기
        </button>
      </section>
    );
  }

  return (
    <div className={styles.wrapper}>
      <header>
        <p className="eyebrow">경품</p>
        <h1>{state.eventName}</h1>
        <p className={styles.help}>
          경품 등록은 참가자 화면에서, 지급 처리는 여기서 합니다. 참가 확정자에게만 등록할 수 있습니다.
        </p>
      </header>
      {!state.featureOn ? (
        <p className="notice" role="status">
          경품 기능이 꺼져 있습니다.{" "}
          <Link href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</Link>에서 먼저 켜세요.
        </p>
      ) : null}
      {failure ? <p className="state-error" role="alert">{failure}</p> : null}
      {notice ? <p className="state-success" role="status">{notice}</p> : null}
      {state.rewards.length ? (
        <ul className={styles.list} aria-label="경품 목록">
          {state.rewards.map((reward) => (
            <li className={styles.row} key={reward.id}>
              <div className={styles.summary}>
                <strong>{reward.name}</strong>
                <span className={styles.meta}>
                  {reward.participantName} · {methodLabel(reward.method)} · {statusLabel(reward.status)}
                </span>
                <span className={styles.meta}>
                  등록 {formatTime(reward.at)}
                  {reward.code ? ` · 코드 ${reward.code}` : ""}
                </span>
              </div>
              {state.featureOn && (reward.status === "READY" || reward.status === "FAILED") ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy !== null}
                  onClick={() => void runCommand(reward.id, "reward.fulfill")}
                >
                  {busy === reward.id ? "처리 중…" : reward.method === "GIFT" ? "기프티콘 지급(모의)" : "수령 처리"}
                </button>
              ) : null}
              {state.featureOn && reward.status !== "RECEIVED" && reward.status !== "CANCELLED" ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`${reward.participantName}님의 경품을 취소할까요?`)) {
                      void runCommand(reward.id, "reward.cancel");
                    }
                  }}
                >
                  취소
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">등록된 경품이 없습니다. 참가자 화면에서 참가 확정자에게 경품을 등록하세요.</p>
      )}
      <p>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자로</Link>
      </p>
    </div>
  );
}
