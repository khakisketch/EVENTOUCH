"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleToolbar from "../../../console-ui/ConsoleToolbar";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import consoleUiStyles from "../../../console-ui/console-ui.module.css";

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
  company: string;
  programTitle: string;
  drawProgramId: string;
  pendingAssignee: boolean;
};

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; eventName: string; eventMeta?: string; eventStage: string; featureOn: boolean; canManage: boolean; rewards: Reward[] };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isDefinitiveClientError(status: number): boolean {
  // 4xx (except 408) proves the server saw and rejected this exact request;
  // 5xx, 408 and network loss stay ambiguous, so the retry replays the SAME
  // command id and the receipt replays the original result.
  return status >= 400 && status < 500 && status !== 408;
}

function rewardRecordMatches(value: unknown, id: string, statuses: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.id === id && typeof record.status === "string" && statuses.includes(record.status);
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
    case "PENDING":
      return "수령자 지정 대기";
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

// Irreversible-step summaries, moved verbatim from the previous native
// confirms (target naming + no-undo notice). Newlines render as breaks so
// no information is dropped inside the single-paragraph confirm region.
function confirmLines(message: string): ReactNode {
  const parts = message.split("\n");
  return parts.flatMap((line, index) => (index === 0 ? [line] : [<br key={index} />, line]));
}

function rewardTargetName(reward: Reward): string {
  return reward.company && reward.pendingAssignee
    ? `${reward.company} 업체 당첨 경품`
    : `${reward.participantName}님의 경품`;
}

function fulfillSummary(reward: Reward): string {
  return `${rewardTargetName(reward)}을 처리할까요? 처리한 뒤에는 취소할 수 없습니다.`;
}

function cancelSummary(reward: Reward): string {
  return `${rewardTargetName(reward)}을 취소할까요?`;
}

export default function RewardsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One in-place confirm at a time: the trigger stays, and the confirm
  // renders inside the same row. Confirming runs the existing command and
  // clears the pending slot; cancelling only clears it.
  const [rewardPending, setRewardPending] = useState<{
    id: string;
    command: "reward.fulfill" | "reward.cancel";
  } | null>(null);
  // Local-only desk filters over the loaded list: free-text search across
  // participant/company/경품명/추첨명 plus a status bucket. Never a new fetch.
  const [rewardQuery, setRewardQuery] = useState("");
  const [rewardStatusFilter, setRewardStatusFilter] = useState("");
  // Same-turn in-flight gate: `busy` state flips only on re-render.
  const busyGateRef = useRef(false);
  const pendingRewardActionRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  // No dirty forms on this desk (reads + one-tap writes only): no draft guard.

  // Event switch resets explicit local banners (never a key remount).
  useEffect(() => {
    setBusy(null);
    setFailure(null);
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, bootRes] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/bootstrap", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (meRes.status === 401 || bootRes.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const me = (await meRes.json().catch(() => null)) as {
          user?: { id?: unknown; role?: unknown } | null;
        } | null;
        const data = (await bootRes.json().catch(() => null)) as {
          state?: { events?: unknown; clients?: unknown; workspaces?: unknown; memberships?: unknown } | null;
        } | null;
        const bootstrap = data?.state;
        if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
          setState({ kind: "failed", message: "경품 정보를 불러오지 못했습니다." });
          return;
        }
        const role = typeof me.user.role === "string" ? me.user.role : "";
        const myId = typeof me.user.id === "string" ? me.user.id : "";
        const memberships: Array<{ accountId: string; eventId: string }> = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const membership = item as Record<string, unknown>;
              if (typeof membership.accountId !== "string") return [];
              if (typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId }];
            })
          : [];
        // Display gate mirroring the current server enforcement (role +
        // event membership — the same rule participant screens use). The
        // server re-checks every write; this only decides what to show.
        // No granular write-permission policy is invented here.
        const canManage =
          role === "AGENCY" ||
          (role === "MANAGER" &&
            memberships.some(
              (membership) =>
                membership.accountId === myId && membership.eventId === eventId
            ));
        const event = (Array.isArray(bootstrap.events) ? bootstrap.events : [])
          .map(record)
          .find((item) => item?.id === eventId);
        const workspace = record((bootstrap.workspaces ?? {})[eventId as keyof object]);
        if (!event || !workspace) {
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        const clients = Array.isArray(bootstrap.clients) ? bootstrap.clients.map(record) : [];
        const clientName = clients.find((client) => client?.id === event.clientId)?.name;
        const venue = record(workspace.venue);
        const names = new Map<string, string>();
        if (Array.isArray(workspace.participants)) {
          for (const item of workspace.participants) {
            const person = record(item);
            if (person && typeof person.id === "string") names.set(person.id, text(person.name, "이름 미등록"));
          }
        }
        // A draw reward points at a draw program (source.programId), not at a
        // participation module: looking the name up in the module list made
        // every draw prize read as "연결 추첨 확인 필요".
        const drawTitles = new Map<string, string>();
        if (Array.isArray(workspace.drawPrograms)) {
          for (const item of workspace.drawPrograms) {
            const program = record(item);
            if (program && typeof program.id === "string") {
              drawTitles.set(program.id, text(program.name, "제목 없는 추첨"));
            }
          }
        }
        const rewards: Reward[] = Array.isArray(workspace.rewards)
          ? workspace.rewards.flatMap((item) => {
              const reward = record(item);
              if (!reward || typeof reward.id !== "string") return [];
              const source = record(reward.source);
              const programId = text(source?.programId);
              const company = text(reward.company);
              return [{
                id: reward.id,
                participantId: text(reward.participantId),
                name: text(reward.name, "경품명 미등록"),
                method: text(reward.method, "ONSITE"),
                status: text(reward.status),
                at: text(reward.at),
                code: text(reward.code),
                participantName: names.get(text(reward.participantId)) ?? (company || "참가자 확인 필요"),
                company,
                programTitle: programId ? drawTitles.get(programId) ?? "연결 추첨 확인 필요" : "",
                drawProgramId: programId,
                pendingAssignee: reward.status === "PENDING"
                  && text(reward.participantId) === ""
                  && source?.kind === "draw",
              }];
            })
          : [];
        setState({
          kind: "ready",
          eventName: text(event.name, eventId),
          eventMeta: formatConsoleEventMeta({
            clientName: text(clientName),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue: text(venue?.name),
          }),
          // Domain writes stop at ARCHIVED on the server; the desk mirrors
          // that below while the list itself stays readable on every stage.
          eventStage: text(event.stage),
          featureOn: Array.isArray(event.features) && event.features.includes("reward"),
          canManage,
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
    if (busyGateRef.current || busy) return;
    busyGateRef.current = true;
    setBusy(id);
    setFailure(null);
    setNotice(null);
    // One command id per distinct action: an ambiguous failure keeps the id
    // so repeating the same tap replays the original write instead of
    // applying twice. A definitive 4xx clears it.
    const fingerprint = JSON.stringify([command, eventId, id]);
    const attempt = pendingRewardActionRef.current?.fingerprint === fingerprint
      ? pendingRewardActionRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingRewardActionRef.current = attempt;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: attempt.commandId, command, payload: { id } }),
        }
      );
      const data = (await res.json().catch(() => null)) as { error?: unknown; reward?: unknown } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "처리하지 못했습니다.";
        if (isDefinitiveClientError(res.status)) {
          pendingRewardActionRef.current = null;
          setFailure(serverMessage);
        } else {
          setFailure(`${serverMessage} 같은 동작으로 다시 시도하세요.`);
        }
        return;
      }
      // Proven success echoes this reward in its new state, not just any
      // reward object: fulfill lands RECEIVED (ONSITE) or NEEDS_CONNECTION
      // (GIFT 모의), cancel lands CANCELLED.
      const expected = command === "reward.fulfill" ? ["RECEIVED", "NEEDS_CONNECTION"] : ["CANCELLED"];
      if (!rewardRecordMatches(data?.reward, id, expected)) {
        setFailure("응답을 확인하지 못했습니다. 같은 동작으로 다시 시도하세요.");
        return;
      }
      pendingRewardActionRef.current = null;
      setNotice(command === "reward.fulfill" ? "지급 처리했습니다." : "경품을 취소했습니다.");
      setReloadTick((tick) => tick + 1);
    } catch {
      setFailure("연결하지 못했습니다. 같은 동작으로 다시 시도하세요.");
    } finally {
      busyGateRef.current = false;
      setBusy(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="rewards" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="경품 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="rewards" eventId={eventId}>
        {/* ConsoleStatePanel dispatches eventouch:shell-reload before its "다시 불러오기" callback. */}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }

  const archived = state.eventStage.toUpperCase() === "ARCHIVED";
  const canAct = state.canManage && !archived;
  const rewardSearch = rewardQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleRewards = state.rewards.filter((reward) => {
    if (rewardStatusFilter === "action") {
      if (reward.status !== "READY" && reward.status !== "FAILED") return false;
    } else if (rewardStatusFilter === "assignee") {
      if (reward.status !== "PENDING") return false;
    } else if (rewardStatusFilter === "connection") {
      if (reward.status !== "NEEDS_CONNECTION") return false;
    } else if (rewardStatusFilter === "received") {
      if (reward.status !== "RECEIVED") return false;
    }
    if (!rewardSearch) return true;
    return `${reward.participantName} ${reward.company} ${reward.name} ${reward.programTitle}`
      .toLocaleLowerCase("ko-KR")
      .includes(rewardSearch);
  });
  const hasRewardFilter = rewardSearch !== "" || rewardStatusFilter !== "";
  function clearRewardFilters(): void {
    setRewardQuery("");
    setRewardStatusFilter("");
  }

  return (
    <ConsolePage
      pageId="rewards"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      headerActions={(
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자로</Link>
      )}
      toolbar={
        <ConsoleToolbar
          filters={
            <>
              <label>
                <span className="sr-only" id="reward-search-label">경품 검색</span>
                <input
                  aria-labelledby="reward-search-label"
                  type="search"
                  placeholder="참가자·소속·경품명·추첨명 검색"
                  value={rewardQuery}
                  onChange={(event) => setRewardQuery(event.target.value)}
                />
              </label>
              <label>
                <span className="sr-only" id="reward-status-label">상태별 보기</span>
                <select aria-labelledby="reward-status-label" value={rewardStatusFilter} onChange={(event) => setRewardStatusFilter(event.target.value)}>
                  <option value="">전체</option>
                  <option value="action">지급 대기·실패</option>
                  <option value="assignee">수령자 지정 대기</option>
                  <option value="connection">연결 필요</option>
                  <option value="received">수령 완료</option>
                </select>
              </label>
            </>
          }
        />
      }
      feedback={
        <>
          {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {!state.canManage ? (
            <ConsoleFeedback kind="warning">지급 처리 권한이 없습니다. 처리가 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {state.canManage && archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 변경할 수 없습니다. 경품 목록 확인은 계속할 수 있습니다.</ConsoleFeedback>
          ) : null}
          {!state.featureOn ? (
            <ConsoleFeedback kind="warning">
              경품 기능이 꺼져 있습니다.{" "}
              <Link href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</Link>에서 먼저 켜세요.
            </ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <ConsoleSection
        headingId="rewards-list"
        title="경품 목록"
        description="경품 등록은 참가자 화면에서, 지급 처리는 여기서 합니다. 참가 확정자에게만 등록할 수 있습니다."
        surface="plain"
        width="full"
      >
        <p className="participant-count" role="status">
          {hasRewardFilter
            ? `${visibleRewards.length}개 / 전체 ${state.rewards.length}개`
            : `전체 ${state.rewards.length}개`}
          {hasRewardFilter ? (
            <>
              {" "}
              <button type="button" className="button button-secondary" onClick={clearRewardFilters}>
                검색·필터 지우기
              </button>
            </>
          ) : null}
        </p>
        {!state.rewards.length ? (
          <div className={consoleUiStyles.empty}>
            <h3>등록된 경품이 없습니다.</h3>
            <p>참가자 화면에서 참가 확정자에게 경품을 등록하세요.</p>
          </div>
        ) : !visibleRewards.length ? (
          <div className={consoleUiStyles.empty}>
            <h3>조건에 맞는 경품이 없습니다.</h3>
            <p>검색어·상태 조건을 바꾸거나 지우고 다시 찾아보세요.</p>
            <p>
              <button type="button" className="button button-secondary" onClick={clearRewardFilters}>
                검색·필터 지우기
              </button>
            </p>
          </div>
        ) : (
          <ul className={consoleUiStyles.collection} aria-label="경품 목록">
            {visibleRewards.map((reward) => (
              <li className={consoleUiStyles.recordRow} key={reward.id}>
                <div className={consoleUiStyles.recordMain}>
                  <strong>{reward.name}</strong>
                  <p className={consoleUiStyles.recordMeta}>
                    {reward.participantName} · {methodLabel(reward.method)} · {statusLabel(reward.status)}
                  </p>
                  {reward.pendingAssignee ? (
                    <p className={consoleUiStyles.recordMeta}>
                      {reward.company ? `${reward.company} 업체 당첨` : "업체 당첨"}
                      {reward.programTitle ? ` · ${reward.programTitle}` : ""} · 수령자를 지정한 뒤 지급할 수 있습니다.
                      {canAct && state.featureOn ? (
                        <>
                          {" "}
                          <Link
                            href={reward.drawProgramId
                              ? `/console/events/${encodeURIComponent(eventId)}/draws#draw-program-${encodeURIComponent(reward.drawProgramId)}`
                              : `/console/events/${encodeURIComponent(eventId)}/draws#draws-programs`}
                          >
                            추첨에서 수령자 지정
                          </Link>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  <p className={consoleUiStyles.recordMeta}>
                    등록 {formatTime(reward.at)}
                    {reward.code ? ` · 코드 ${reward.code}` : ""}
                  </p>
                </div>
                <div className={consoleUiStyles.recordActions}>
                  {state.featureOn && canAct && (reward.status === "READY" || reward.status === "FAILED") ? (
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy !== null}
                      onClick={() => {
                        // The server refuses a cancel once the prize is
                        // received, so the one irreversible step asks first —
                        // in place, with the same summary as before.
                        setRewardPending({ id: reward.id, command: "reward.fulfill" });
                      }}
                    >
                      {busy === reward.id ? "처리 중…" : reward.method === "GIFT" ? "기프티콘 지급(모의)" : "수령 처리"}
                    </button>
                  ) : null}
                  {state.featureOn && canAct && reward.status !== "RECEIVED" && reward.status !== "CANCELLED" ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy !== null}
                      onClick={() => {
                        setRewardPending({ id: reward.id, command: "reward.cancel" });
                      }}
                    >
                      취소
                    </button>
                  ) : null}
                </div>
                {rewardPending?.id === reward.id ? (
                  <ConsoleConfirm
                    summary={confirmLines(
                      rewardPending.command === "reward.fulfill" ? fulfillSummary(reward) : cancelSummary(reward)
                    )}
                    confirmLabel={rewardPending.command === "reward.fulfill" ? "처리한다" : "취소한다"}
                    busy={busy === reward.id}
                    onConfirm={() => {
                      const pending = rewardPending;
                      setRewardPending(null);
                      void runCommand(pending.id, pending.command);
                    }}
                    onCancel={() => setRewardPending(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}
