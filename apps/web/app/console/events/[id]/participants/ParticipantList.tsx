"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePageHeader, {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import consoleUiStyles from "../../../console-ui/console-ui.module.css";

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
      eventMeta: ConsoleEventMeta;
      people: Person[];
      groups: string[];
      canManage: boolean;
      rewardFeature: boolean;
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

// Approval-time identity check: names collide, so the row carries the
// company and a masked contact next to the name. Full digits stay in the
// CSV export and the server, never on this screen.
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "연락처 확인 필요";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function identityLine(person: { company: string; group: string; phone: string }): string {
  const parts = [person.company, person.group === "일반" ? "" : person.group, maskPhone(person.phone)]
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.join(" · ");
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default function ParticipantList({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [rewardTarget, setRewardTarget] = useState<Person | null>(null);
  const [rewardDraft, setRewardDraft] = useState({ name: "", method: "ONSITE" });
  const [rewardBusy, setRewardBusy] = useState(false);
  const [rewardError, setRewardError] = useState<{ message: string; field: string | null } | null>(null);

  // The overview approval CTA lands here pre-filtered; a direct visit shows
  // everything. Read once on mount — the select owns the state afterwards.
  useEffect(() => {
    try {
      const initial = new URLSearchParams(window.location.search).get("status") ?? "";
      if ((STATUSES as readonly string[]).includes(initial)) setStatusFilter(initial);
    } catch {
      // Keep the unfiltered list.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

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
          clients?: unknown;
          workspaces?: Record<string, Record<string, unknown>>;
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
      const workspace = (bootstrap.workspaces?.[eventId] ?? {}) as Record<string, unknown>;
      const participants = workspace.participants;
      const client = Array.isArray(bootstrap.clients)
        ? bootstrap.clients.find(
            (item): item is Record<string, unknown> =>
              typeof item === "object" && item !== null && item.id === event?.clientId
          )
        : undefined;
      const venue = typeof workspace.venue === "object" && workspace.venue !== null
        ? workspace.venue as Record<string, unknown>
        : null;
      const groups = Array.isArray(workspace.groups)
        ? workspace.groups.filter((value): value is string => typeof value === "string")
        : [];
      const features = Array.isArray(event && (event as Record<string, unknown>).features)
        ? ((event as Record<string, unknown>).features as unknown[])
        : [];
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
        eventMeta: {
          clientName: stringValue(client?.name),
          date: stringValue(event?.date),
          start: stringValue(event?.start),
          end: stringValue(event?.end),
          venue: stringValue(venue?.name) || stringValue(event?.venue),
        },
        people,
        groups,
        canManage,
        rewardFeature: features.includes("reward"),
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
    // Cancellation voids the ticket: confirm it like the stage transitions
    // do. Approval stays one tap, and the row shows who is being approved.
    if (status === "CANCELLED" && !window.confirm(
      `${person.name}님의 신청을 취소할까요? 발급된 티켓은 무효화되며, 되돌리려면 다시 승인해야 합니다.`
    )) return;
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

  const pageHeader = (
    <ConsolePageHeader
      title={state.kind === "ready" ? state.eventName : "참가자 관리"}
      meta={state.kind === "ready" ? formatConsoleEventMeta(state.eventMeta) : undefined}
      back={{
        href: `/console/events/${encodeURIComponent(eventId)}`,
        label: "← 운영 현황",
      }}
    />
  );

  if (state.kind === "loading") {
    return (
      <div className={consoleUiStyles.pageFlow}>
        {pageHeader}
        <ConsoleStatePanel
          kind="loading"
          message="참가자 목록을 불러오고 있습니다."
          onRetry={() => { void load(); }}
        />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className={consoleUiStyles.pageFlow}>
        {pageHeader}
        {/* ConsoleStatePanel dispatches eventouch:shell-reload and renders 다시 불러오기. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void load(); }}
        />
      </div>
    );
  }
  const search = query.trim().toLocaleLowerCase("ko-KR");
  const visiblePeople = state.people.filter((person) => {
    const haystack = `${person.name} ${person.company} ${person.phone}`.toLocaleLowerCase("ko-KR");
    const matchesQuery = !search || haystack.includes(search);
    const matchesGroup = !groupFilter || person.group === groupFilter;
    return matchesQuery && matchesGroup && (!statusFilter || person.status === statusFilter);
  });

  // Selection is scoped to what is visible: group assignment only ever
  // touches rows the operator can see and count.
  const visibleIds = new Set(visiblePeople.map((person) => person.id));
  const effectiveSelection = selectedIds.filter((id) => visibleIds.has(id));

  function togglePerson(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }

  async function assignGroup(event: React.FormEvent) {
    event.preventDefault();
    if (groupBusy || !groupDraft || !effectiveSelection.length) return;
    setGroupBusy(true);
    setGroupError(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: randomCommandId(),
            command: "group.assign",
            payload: { group: groupDraft, ids: effectiveSelection },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setGroupError(typeof data?.error === "string" ? data.error : "그룹을 지정하지 못했습니다.");
        return;
      }
      setNotice(`${effectiveSelection.length}명을 ${groupDraft}(으)로 지정했습니다.`);
      setSelectedIds([]);
      setGroupDialogOpen(false);
      await load(true);
    } catch {
      setGroupError("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setGroupBusy(false);
    }
  }

  async function createReward(event: React.FormEvent) {
    event.preventDefault();
    if (rewardBusy || !rewardTarget || !rewardDraft.name.trim()) return;
    setRewardBusy(true);
    setRewardError(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: randomCommandId(),
            command: "reward.create",
            payload: {
              participantId: rewardTarget.id,
              name: rewardDraft.name.trim(),
              method: rewardDraft.method,
            },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } | null;
      if (!res.ok) {
        setRewardError({
          field: typeof data?.field === "string" ? data.field : null,
          message: typeof data?.error === "string" ? data.error : "경품을 등록하지 못했습니다.",
        });
        return;
      }
      setNotice(`${rewardTarget.name}님의 경품을 등록했습니다. 경품 화면에서 지급 처리하세요.`);
      setRewardTarget(null);
    } catch {
      setRewardError({ field: null, message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setRewardBusy(false);
    }
  }

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
    <div className={consoleUiStyles.pageFlow}>
      {pageHeader}
      <section className="participants-content">
      <ConsoleSection headingId="participants-list-heading" title="참가자 목록">
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
        {state.groups.length ? (
          <label>
            <span className="sr-only">그룹별 보기</span>
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">전체 그룹</option>
              {state.groups.map((group) => (
                <option key={group} value={group}>{group}</option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="button button-secondary" onClick={exportCsv}>
          목록 CSV
        </button>
        {state.canManage ? (
          <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants/import`}>
            명단 가져오기
          </Link>
        ) : null}
      </div>
      {state.canManage ? (
        <div className="participant-selection" role="group" aria-label="선택 도구">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              const ids = visiblePeople.map((person) => person.id);
              setSelectedIds((current) => [...new Set([...current, ...ids])]);
            }}
          >
            표시 {visiblePeople.length}명 선택
          </button>
          <button type="button" className="text-button" onClick={() => setSelectedIds([])}>선택 해제</button>
          <span>{effectiveSelection.length}명 선택됨</span>
          <button
            type="button"
            className="button button-secondary"
            disabled={!effectiveSelection.length}
            onClick={() => {
              setGroupError(null);
              setGroupDraft(state.groups[0] ?? "");
              setGroupDialogOpen(true);
            }}
          >
            그룹 지정
          </button>
        </div>
      ) : null}
      <p className="participant-count" role="status">
        {statusFilter || groupFilter || search
          ? `${visiblePeople.length}명 / 전체 ${state.people.length}명`
          : `전체 ${state.people.length}명`}
      </p>
      {visiblePeople.length ? (
        <ul className="participant-list">
          {visiblePeople.map((person) => (
            <li className="participant-row" key={person.id}>
              {state.canManage ? (
                <input
                  type="checkbox"
                  className="participant-select"
                  aria-label={`${person.name} 선택`}
                  checked={effectiveSelection.includes(person.id)}
                  onChange={() => togglePerson(person.id)}
                />
              ) : null}
              <span className="participant-summary">
                {person.name}
                <small className="participant-identity">{identityLine(person) || statusLabel(person.status)}</small>
                {!state.canManage ? ` · ${statusLabel(person.status)}` : ""}
              </span>
              {state.canManage ? (
                person.status === "PENDING" ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={savingId === person.id}
                    onClick={() => changeStatus(person, "APPROVED")}
                  >
                    {savingId === person.id ? "승인 중…" : "승인"}
                  </button>
                ) : person.status === "APPROVED" && state.rewardFeature ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setRewardError(null);
                      setRewardDraft({ name: "", method: "ONSITE" });
                      setRewardTarget(person);
                    }}
                  >
                    경품 등록
                  </button>
                ) : (
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
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : state.people.length ? (
        <p className="empty-state">조건에 맞는 참가자가 없습니다.</p>
      ) : (
        <p className="empty-state">등록된 참가자가 없습니다.</p>
      )}
      {groupDialogOpen ? (
        <div className="dialog-backdrop" onClick={() => { if (!groupBusy) setGroupDialogOpen(false); }}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="그룹 지정"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>그룹 지정</h2>
            <p>표시된 명단에서 선택한 {effectiveSelection.length}명의 그룹을 바꿉니다.</p>
            <form onSubmit={(event) => void assignGroup(event)}>
              <div>
                <label htmlFor="group-pick">그룹</label>
                <select
                  id="group-pick"
                  required
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                >
                  <option value="">선택하세요</option>
                  {state.groups.map((group) => (
                    <option key={group} value={group}>{group}</option>
                  ))}
                </select>
              </div>
              {groupError ? <p className="state-error" role="alert">{groupError}</p> : null}
              <div className="dialog-actions">
                <button type="submit" className="button button-primary" disabled={groupBusy || !groupDraft}>
                  {groupBusy ? "지정 중…" : "지정"}
                </button>
                <button type="button" className="button button-secondary" disabled={groupBusy} onClick={() => setGroupDialogOpen(false)}>
                  취소
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {rewardTarget ? (
        <div className="dialog-backdrop" onClick={() => { if (!rewardBusy) setRewardTarget(null); }}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="경품 등록"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>경품 등록 · {rewardTarget.name}</h2>
            <form onSubmit={(event) => void createReward(event)}>
              <div>
                <label htmlFor="reward-name">경품명 (필수)</label>
                <input
                  id="reward-name"
                  type="text"
                  maxLength={80}
                  required
                  value={rewardDraft.name}
                  aria-invalid={rewardError?.field === "name"}
                  onChange={(event) => setRewardDraft({ ...rewardDraft, name: event.target.value })}
                />
                {rewardError?.field === "name" ? <p className="state-error" role="alert">{rewardError.message}</p> : null}
              </div>
              <div>
                <label htmlFor="reward-method">지급 방식</label>
                <select
                  id="reward-method"
                  value={rewardDraft.method}
                  onChange={(event) => setRewardDraft({ ...rewardDraft, method: event.target.value })}
                >
                  <option value="ONSITE">현장 수령</option>
                  <option value="GIFT">기프티콘 (모의 코드)</option>
                </select>
                <p className="landing-note">기프티콘은 v1 제외 항목이라 모의 코드만 발급됩니다.</p>
              </div>
              {rewardError && !rewardError.field ? <p className="state-error" role="alert">{rewardError.message}</p> : null}
              <div className="dialog-actions">
                <button type="submit" className="button button-primary" disabled={rewardBusy || !rewardDraft.name.trim()}>
                  {rewardBusy ? "등록 중…" : "등록"}
                </button>
                <button type="button" className="button button-secondary" disabled={rewardBusy} onClick={() => setRewardTarget(null)}>
                  취소
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      </ConsoleSection>
      </section>
    </div>
  );
}
