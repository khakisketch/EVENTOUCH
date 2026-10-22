"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { loginHrefForLocation } from "../../auth-redirect";
import ConsoleConfirm from "../console-ui/ConsoleConfirm";
import ConsolePage from "../console-ui/ConsolePage";
import ConsoleToolbar from "../console-ui/ConsoleToolbar";
import ConsoleFeedback from "../console-ui/ConsoleFeedback";
import ConsoleDialog from "../console-ui/ConsoleDialog";
import ConsoleFormActions from "../console-ui/ConsoleFormActions";
import ConsoleSection from "../console-ui/ConsoleSection";
import ConsoleStatePanel from "../console-ui/ConsoleStatePanel";
import { UNCONFIRMED_WRITE_CLOSE_MESSAGE, useConsoleDraftGuard } from "../console-draft-guard";
import consoleUiStyles from "../console-ui/console-ui.module.css";
import teamStyles from "./team.module.css";
import OperationsPanels from "./OperationsPanels";

type Account = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  orgOwner: boolean;
};

type Invitation = {
  id: string;
  name: string;
  email: string;
  role: string;
  eventId: string | null;
  status: string;
  expiresAt: string;
};

type TeamEvent = { id: string; name: string };

type TeamState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; accounts: Account[]; invitations: Invitation[]; events: TeamEvent[]; canManage: boolean; canInvite: boolean; userId: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function roleLabel(role: string): string {
  if (role === "AGENCY") return "조직 소유자";
  if (role === "MANAGER") return "운영사 구성원";
  if (role === "STAFF") return "현장 스태프";
  if (role === "CLIENT") return "고객사 담당자";
  return "상태 확인 필요";
}

function formatInviteExpiry(value: string): string {
  // Existing invitation data only: show the expiry when present, never
  // invent one. Falls back to the raw value when it is not a date.
  if (!value) return "";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  try {
    return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

// Warn copy shared by the invite-open replace and the issued-link close:
// the bearer is once-shown, so dropping it is unrecoverable.
const ISSUED_LINK_LOSS_MESSAGE = "발급된 초대 링크는 한 번만 표시됩니다. 지금 닫으면 링크를 다시 확인할 수 없습니다. 계속할까요?";

function confirmLines(message: string): ReactNode {
  const parts = message.split("\n");
  return parts.flatMap((line, index) => (index === 0 ? [line] : [<br key={index} />, line]));
}

// Long audit-style addresses (audit-owner-…@example.test) must not snap
// mid-token: the local part breaks only after -/_ runs, and the @domain
// reads as one atomic group (inline-block, full contact width available).
// Only a domain wider than the row itself wraps inside (anywhere fallback
// that still never overflows). Non-addresses render untouched.
function SafeContact({ value }: { value: string }) {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return <>{value}</>;
  const parts = value.slice(0, at).split(/([-_]+)/);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index}>{part}<wbr /></span>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
      <wbr />
      <span className={teamStyles.contactDomain}>@{value.slice(at + 1)}</span>
    </>
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDefinitiveClientError(status: number): boolean {
  // 4xx (except 408) proves the server saw and rejected this exact request;
  // 5xx, 408 and network loss stay ambiguous, so the retry replays the SAME
  // command id and the receipt replays the original result.
  return status >= 400 && status < 500 && status !== 408;
}

const DIRTY_CLOSE_MESSAGE = "작성 중인 내용이 사라집니다. 닫을까요?";

export default function TeamWorkspace() {
  const [state, setState] = useState<TeamState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issuedInvite, setIssuedInvite] = useState<{ name: string; link: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One in-place confirm for dropping the once-shown bearer link: opening a
  // new invite ("replace") or closing the issued block ("close") while it is
  // unresolved first states the loss where the link lives. The dialog
  // dismissal gates (ResetDialog/InviteDialog canClose) keep their own
  // contract and are untouched.
  const [inviteLossPending, setInviteLossPending] = useState<"replace" | "close" | null>(null);
  // Which accepted member's assignment picker is expanded (account id, one at
  // a time). Navigation-only: choosing an event never writes, so the member
  // list stays non-dirty and no draft guard is registered for it.
  const [assignOpenId, setAssignOpenId] = useState<string | null>(null);

  // Only the issued once-shown bearer link guards navigation at the parent
  // level: losing it loses the link. Open reset/invite forms register their
  // own field-diff guards inside ResetDialog/InviteDialog (pristine opens
  // are not dirty). The member list itself is never dirty.
  useConsoleDraftGuard(
    issuedInvite !== null,
    "발급된 초대 링크는 한 번만 표시됩니다. 떠나면 링크를 다시 확인할 수 없습니다."
  );

  // The issued link is once-shown and never re-fetched: opening a new invite
  // or closing the block while it is unresolved asks first. The toolbar and
  // the block close below both consult these predicates.
  function requestInviteOpen(): void {
    setNotice(null);
    if (issuedInvite !== null) {
      setInviteLossPending("replace");
      return;
    }
    setInviteOpen(true);
  }

  function requestCloseIssued(): void {
    if (issuedInvite === null) return;
    setInviteLossPending("close");
  }

  function confirmInviteLoss(): void {
    // The pending slot only renders while the issued link exists, so the
    // bearer being confirmed away is always the current one.
    const pending = inviteLossPending;
    setInviteLossPending(null);
    setIssuedInvite(null);
    if (pending === "replace") setInviteOpen(true);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meResponse, bootstrapResponse] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/bootstrap", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (meResponse.status === 401 || bootstrapResponse.status === 401) {
          window.location.href = loginHrefForLocation(
            window.location.pathname,
            window.location.search
          );
          return;
        }
        const mePayload = (await meResponse.json().catch(() => null)) as {
          user?: { id?: unknown; role?: unknown } | null;
        } | null;
        const bootstrapPayload = (await bootstrapResponse.json().catch(() => null)) as {
          state?: { accounts?: unknown; invitations?: unknown; events?: unknown } | null;
        } | null;
        const user = record(mePayload?.user);
        const userId = text(user?.id);
        const role = text(user?.role);
        const rawAccounts = bootstrapPayload?.state?.accounts;
        const accounts: Account[] = Array.isArray(rawAccounts)
          ? rawAccounts.flatMap((item) => {
              const account = record(item);
              if (!account || typeof account.id !== "string" || !account.id) return [];
              return [{
                id: account.id,
                name: text(account.name) || account.id,
                email: text(account.email),
                role: text(account.role),
                active: account.active !== false,
                orgOwner: account.orgOwner === true,
              }];
            })
          : [];
        const mine = accounts.find((item) => item.id === userId);
        const permissions = mine && Array.isArray((mine as unknown as Record<string, unknown>).orgPermissions)
          ? ((mine as unknown as Record<string, unknown>).orgPermissions as unknown[]).filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        // Only the organization owner resets passwords; the server enforces
        // the same rule, this gate only decides what to show.
        const canManage = role === "AGENCY" || mine?.orgOwner === true || permissions.includes("team.manage");
        // Invitations are AGENCY-only on the server; the UI mirrors it so a
        // manager never fills a form the server will reject.
        const canInvite = role === "AGENCY" || mine?.orgOwner === true;
        const rawInvitations = bootstrapPayload?.state?.invitations;
        const invitations: Invitation[] = Array.isArray(rawInvitations)
          ? rawInvitations.flatMap((item) => {
              const invitation = record(item);
              if (!invitation || typeof invitation.id !== "string" || !invitation.id) return [];
              if (text(invitation.status) !== "PENDING") return [];
              return [{
                id: invitation.id,
                name: text(invitation.name) || text(invitation.email),
                email: text(invitation.email),
                role: text(invitation.role),
                eventId: typeof invitation.eventId === "string" ? invitation.eventId : null,
                status: "PENDING",
                expiresAt: text(invitation.expiresAt),
              }];
            })
          : [];
        const rawEvents = bootstrapPayload?.state?.events;
        const events: TeamEvent[] = Array.isArray(rawEvents)
          ? rawEvents.flatMap((item) => {
              const event = record(item);
              if (!event || typeof event.id !== "string" || !event.id) return [];
              return [{ id: event.id, name: text(event.name) || event.id }];
            })
          : [];
        if (!meResponse.ok || !userId || !bootstrapResponse.ok || !bootstrapPayload?.state) {
          setState({ kind: "failed", message: "팀 정보를 불러오지 못했습니다." });
          return;
        }
        setState({ kind: "ready", accounts, invitations, events, canManage, canInvite, userId });
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
  }, [reloadTick]);

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="team">
        <ConsoleStatePanel kind="loading" message="팀 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="team">
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage
      pageId="team"
      toolbar={
        state.canInvite ? (
          <ConsoleToolbar
            actions={
              <button
                type="button"
                className="button button-primary"
                onClick={requestInviteOpen}
              >
                구성원 초대
              </button>
            }
          />
        ) : undefined
      }
      feedback={
        <>
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {!state.canManage ? (
            <ConsoleFeedback kind="warning">팀 관리 권한이 없습니다. 비밀번호 재설정은 조직 소유자에게 요청하세요.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <p className="overview-meta">비밀번호를 잊은 구성원은 조직 소유자가 재설정합니다. 재설정하면 다른 기기에서 모두 로그아웃됩니다.</p>
      {/* Issued once-shown bearer lives next to the invite action and the
          pending queue — not after the long activity panel — so the operator
          sees it without scrolling. Still once-shown: never re-fetched or
          re-shown from the server; reloads only refresh the queue below.
          Closing/replacing while unresolved asks first (see
          requestInviteOpen/requestCloseIssued). */}
      {issuedInvite ? (
        <ConsoleSection headingId="issued-invite" title="발급된 초대 링크" surface="panel" width="full">
          <p role="status">초대 링크는 지금 한 번만 표시됩니다. 복사해서 전달하세요.</p>
          <p><code>{issuedInvite.link}</code></p>
          <ConsoleFormActions>
            <button
              type="button"
              className="button button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issuedInvite.link);
                  setNotice("초대 링크를 복사했습니다.");
                } catch {
                  setNotice("복사에 실패했습니다. 링크를 직접 선택해 복사하세요.");
                }
              }}
            >
              링크 복사
            </button>
            <button type="button" className="button button-secondary" onClick={requestCloseIssued}>
              닫기
            </button>
          </ConsoleFormActions>
          {inviteLossPending ? (
            <ConsoleConfirm
              summary={confirmLines(ISSUED_LINK_LOSS_MESSAGE)}
              confirmLabel={inviteLossPending === "replace" ? "새 초대 열기" : "닫는다"}
              onConfirm={confirmInviteLoss}
              onCancel={() => setInviteLossPending(null)}
            />
          ) : null}
        </ConsoleSection>
      ) : null}
      {state.canInvite && state.invitations.length ? (
        <ConsoleSection headingId="pending-invites" title="대기 중인 초대" surface="plain" width="full">
          <ul className={consoleUiStyles.collection} aria-label="대기 중인 초대 목록">
            {state.invitations.map((invitation) => {
              // Event scope and expiry come from the existing invitation
              // record only: event-scoped invites name their 행사, others
              // read 미지정, and missing expiry renders nothing.
              const eventName = invitation.eventId
                ? state.events.find((item) => item.id === invitation.eventId)?.name ?? ""
                : "";
              const expiry = invitation.expiresAt ? formatInviteExpiry(invitation.expiresAt) : "";
              return (
              <li className={`${consoleUiStyles.recordRow} ${teamStyles.teamRow}`} key={invitation.id}>
                <div className={`${consoleUiStyles.recordMain} ${teamStyles.memberMain}`}>
                  <strong className={teamStyles.memberName}>{invitation.name}</strong>
                  <p className={teamStyles.memberRole}>{roleLabel(invitation.role)}</p>
                  <p className={teamStyles.memberContact}><SafeContact value={invitation.email} /></p>
                  <p className={teamStyles.inviteDetail}>
                    <span>{eventName ? `담당 행사: ${eventName}` : "담당 행사 미지정"}</span>
                    {expiry ? <span>만료: {expiry}</span> : null}
                  </p>
                </div>
                <div className={`${consoleUiStyles.recordActions} ${teamStyles.memberActions}`}>
                  <RevokeInviteButton
                    invitationId={invitation.id}
                    onDone={() => {
                      setNotice(`${invitation.name}님의 초대를 철회했습니다.`);
                      setReloadTick((tick) => tick + 1);
                    }}
                  />
                </div>
              </li>
              );
            })}
          </ul>
        </ConsoleSection>
      ) : state.canInvite ? (
        <ConsoleSection headingId="pending-invites" title="대기 중인 초대" surface="plain" width="full">
          <div className={consoleUiStyles.empty}>
            <h3>대기 중인 초대가 없습니다.</h3>
          </div>
        </ConsoleSection>
      ) : null}
      <ConsoleSection headingId="team-members" title="구성원" surface="plain" width="full">
        {state.accounts.length ? (
          <ul className={consoleUiStyles.collection} aria-label="구성원 목록">
            {state.accounts.map((account) => (
              <li className={`${consoleUiStyles.recordRow} ${teamStyles.teamRow}`} key={account.id}>
                <div className={`${consoleUiStyles.recordMain} ${teamStyles.memberMain}`}>
                  <strong className={teamStyles.memberName}>{account.name}</strong>
                  <p className={teamStyles.memberRole}>
                    {roleLabel(account.role)}
                    {account.active ? "" : " · 사용 중지"}
                  </p>
                  <p className={teamStyles.memberContact}><SafeContact value={account.email} /></p>
                  {state.canManage && account.role === "STAFF" && account.active && assignOpenId === account.id ? (
                    <StaffAssignmentPanel
                      events={state.events}
                      accountId={account.id}
                      accountName={account.name}
                      onClose={() => {
                        setAssignOpenId(null);
                        document.getElementById(`staff-assign-toggle-${account.id}`)?.focus();
                      }}
                    />
                  ) : null}
                </div>
                {state.canManage ? (
                  <div className={`${consoleUiStyles.recordActions} ${teamStyles.memberActions}`}>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => { setNotice(null); setResetTarget(account); }}
                    >
                      비밀번호 재설정
                    </button>
                    {account.role === "STAFF" && account.active ? (
                      <button
                        type="button"
                        id={`staff-assign-toggle-${account.id}`}
                        className="button button-secondary"
                        aria-expanded={assignOpenId === account.id}
                        aria-controls={`staff-assign-panel-${account.id}`}
                        onClick={() => {
                          setNotice(null);
                          setAssignOpenId((current) => (current === account.id ? null : account.id));
                        }}
                      >
                        행사 배정
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className={consoleUiStyles.empty}>
            <h3>등록된 구성원이 없습니다.</h3>
          </div>
        )}
      </ConsoleSection>
      <OperationsPanels />
      {resetTarget ? (
        <ResetDialog
          account={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={(revoked) => {
            setResetTarget(null);
            setNotice(
              `${resetTarget.name} 비밀번호를 재설정했습니다.` +
              (revoked > 0 ? ` 다른 기기 ${revoked}곳에서 로그아웃됩니다.` : "")
            );
          }}
        />
      ) : null}
      {inviteOpen && state.kind === "ready" ? (
        <InviteDialog
          events={state.events}
          onClose={() => setInviteOpen(false)}
          onDone={(issued) => {
            setInviteOpen(false);
            setIssuedInvite(issued);
            setNotice(`${issued.name}님을 초대했습니다. 아래 링크를 전달하세요.`);
            setReloadTick((tick) => tick + 1);
          }}
        />
      ) : null}
    </ConsolePage>
  );
}

function StaffAssignmentPanel({
  events,
  accountId,
  accountName,
  onClose,
}: {
  events: TeamEvent[];
  accountId: string;
  accountName: string;
  onClose: () => void;
}) {
  // Preselect only when there is exactly one event to choose from; with
  // several events the operator must choose, and with none there is nothing
  // to link. No association is stored or sent anywhere here — the actual
  // assignment stays an explicit operations command on the target event.
  const [eventId, setEventId] = useState(
    events.length === 1 && events[0] ? events[0].id : ""
  );
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    selectRef.current?.focus();
  }, []);
  const chosen = events.find((item) => item.id === eventId) ?? null;
  return (
    <div className={teamStyles.assignPanel} id={`staff-assign-panel-${accountId}`}>
      <p className={teamStyles.assignLead}>
        {accountName}님의 데스크·부스 배정은 행사별 현장 운영에서 지정합니다.
        {events.length === 1
          ? " 배정할 행사가 하나뿐이라 미리 선택했습니다."
          : " 배정할 행사를 선택하세요."}
      </p>
      {events.length ? (
        <label className={teamStyles.assignField}>
          <span>배정할 행사</span>
          <select
            ref={selectRef}
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
            aria-label={`${accountName} 배정 행사 선택`}
          >
            <option value="">선택하세요</option>
            {events.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
      ) : (
        <p className={teamStyles.assignLead} role="status">배정할 수 있는 행사가 없습니다.</p>
      )}
      {chosen ? (
        <p className={teamStyles.assignLead}>
          <Link
            className={teamStyles.assignLink}
            href={`/console/events/${encodeURIComponent(chosen.id)}/operations#ops-staff`}
          >
            {chosen.name} 현장 운영 · 스태프 배정으로 이동
          </Link>
        </p>
      ) : events.length ? (
        <p className={teamStyles.assignLead} role="status">배정할 행사를 선택하면 이동 링크가 나타납니다.</p>
      ) : null}
      <p className={teamStyles.assignLead}>
        <button type="button" className="button button-secondary" onClick={onClose}>
          닫기
        </button>
      </p>
    </div>
  );
}

function ResetDialog({
  account,
  onClose,
  onDone,
}: {
  account: Account;
  onClose: () => void;
  onDone: (sessionsRevoked: number) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One command id per distinct password: the server only replays a
  // byte-identical retry, so the fingerprint includes the password and any
  // edit after a failure mints a new id. An ambiguous failure keeps the id.
  const pendingResetRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const submitGateRef = useRef(false);

  // True field diff versus empty defaults, plus unsettled/pending work.
  // Registered here (unconditionally, before any early return — this
  // component has none) so a pristine open form is not dirty.
  const resetDirty = password !== "" || confirm !== "";
  useConsoleDraftGuard(
    resetDirty || pendingResetRef.current !== null || submitGateRef.current,
    "작성 중인 비밀번호가 사라질 수 있습니다."
  );

  // Single dismissal predicate: the shared dialog calls canClose ONCE on
  // Escape/backdrop and then the pure onClose prop below — never two
  // confirms. Cancel consults the same predicate once.
  function canCloseResetDialog(): boolean {
    if (submitGateRef.current || submitting) return false;
    return (!resetDirty && !pendingResetRef.current) || window.confirm(pendingResetRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || submitting) return;
    if (password !== confirm) {
      setFailure("비밀번호가 일치하지 않습니다.");
      return;
    }
    submitGateRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const fingerprint = JSON.stringify([account.id, password]);
      const attempt = pendingResetRef.current?.fingerprint === fingerprint
        ? pendingResetRef.current
        : { fingerprint, commandId: randomCommandId() };
      pendingResetRef.current = attempt;
      const commandId = attempt.commandId;
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(account.id)}/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        account?: unknown;
        sessionsRevoked?: unknown;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "재설정하지 못했습니다.";
        if (isDefinitiveClientError(res.status)) {
          pendingResetRef.current = null;
          setFailure(serverMessage);
        } else {
          setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        }
        return;
      }
      // Proven success echoes this account back; a bare 2xx without it may
      // mean the write landed unseen, so the retry replays the same id.
      const resetAccount = typeof data?.account === "object" && data?.account !== null
        ? data.account as Record<string, unknown>
        : null;
      if (!resetAccount || resetAccount.id !== account.id) {
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        return;
      }
      pendingResetRef.current = null;
      onDone(typeof data?.sessionsRevoked === "number" ? data.sessionsRevoked : 0);
    } catch {
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
    } finally {
      submitGateRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ConsoleDialog
      title={`${account.name} 비밀번호 재설정`}
      titleId="reset-title"
      description={`${account.email} · 다른 기기에서는 모두 로그아웃됩니다.`}
      onClose={onClose}
      busy={submitting}
      canClose={canCloseResetDialog}
      footer={
        <ConsoleFormActions>
          <button type="button" className="button button-secondary" onClick={() => { if (canCloseResetDialog()) onClose(); }} disabled={submitting}>
            취소
          </button>
          <button type="submit" form="reset-form" className="button button-primary" disabled={submitting}>
            {submitting ? "재설정 중입니다" : "재설정"}
          </button>
        </ConsoleFormActions>
      }
    >
      <form id="reset-form" className={consoleUiStyles.formStack} onSubmit={onSubmit}>
        <div className={consoleUiStyles.field}>
          <label htmlFor="reset-password">새 비밀번호 (8자 이상)</label>
          <input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <div className={consoleUiStyles.field}>
          <label htmlFor="reset-confirm">새 비밀번호 확인</label>
          <input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>
        {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
      </form>
    </ConsoleDialog>
  );
}
function InviteDialog({
  events,
  onClose,
  onDone,
}: {
  events: TeamEvent[];
  onClose: () => void;
  onDone: (issued: { name: string; link: string }) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MANAGER");
  const [eventId, setEventId] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One command id per distinct invitation: a lost response must replay the
  // same request (the server dedupes by id and never double-invites).
  // Replays return 409 INVITATION_LINK_UNAVAILABLE without reissuing the
  // once-shown bearer — that definitive 4xx clears the id. Edits mint a new
  // one via the fingerprint.
  const pendingInviteRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const submitGateRef = useRef(false);

  // True field diff versus opening defaults (role/eventId count, not just
  // name/email), plus unsettled/pending work. Pristine opens are not dirty.
  const inviteDirty =
    name.trim() !== "" || email.trim() !== "" || role !== "MANAGER" || eventId !== "";
  useConsoleDraftGuard(
    inviteDirty || pendingInviteRef.current !== null || submitGateRef.current,
    "작성 중인 초대 내용이 사라질 수 있습니다."
  );

  // Single dismissal predicate: the shared dialog calls canClose ONCE on
  // Escape/backdrop and then the pure onClose prop below — never two
  // confirms. Cancel consults the same predicate once.
  function canCloseInviteDialog(): boolean {
    if (submitGateRef.current || submitting) return false;
    return (!inviteDirty && !pendingInviteRef.current) || window.confirm(pendingInviteRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || submitting) return;
    submitGateRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const payload = {
        name: name.trim(),
        email: email.trim(),
        role,
        ...(role === "MANAGER" && eventId ? { eventId } : {}),
      };
      const fingerprint = JSON.stringify(payload);
      const attempt = pendingInviteRef.current?.fingerprint === fingerprint
        ? pendingInviteRef.current
        : { fingerprint, commandId: randomCommandId() };
      pendingInviteRef.current = attempt;
      const commandId = attempt.commandId;
      const res = await fetch("/api/auth/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, ...payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        invitation?: { name?: unknown } | null;
        token?: unknown;
      } | null;
      if (!res.ok || typeof data?.token !== "string") {
        if (!res.ok && isDefinitiveClientError(res.status)) {
          pendingInviteRef.current = null;
          setFailure(typeof data?.error === "string" ? data.error : "초대하지 못했습니다.");
        } else if (!res.ok) {
          setFailure(`${typeof data?.error === "string" ? data.error : "초대하지 못했습니다."} 같은 요청으로 다시 시도하세요.`);
        } else {
          // 2xx without the once-shown bearer: the invite may exist unseen.
          // Keep the id so the retry replays instead of double-inviting.
          setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        }
        return;
      }
      pendingInviteRef.current = null;
      const inviteName = typeof data?.invitation?.name === "string" && data.invitation.name
        ? data.invitation.name
        : name.trim();
      onDone({
        name: inviteName,
        link: `${window.location.origin}/invite/${encodeURIComponent(data.token)}`,
      });
    } catch {
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
    } finally {
      submitGateRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ConsoleDialog
      title="구성원 초대"
      titleId="invite-title"
      description="초대 링크는 발급 시 한 번만 표시됩니다. 현장 스태프는 수락 후 데스크·부스 배정으로 연결합니다."
      onClose={onClose}
      busy={submitting}
      canClose={canCloseInviteDialog}
      footer={
        <ConsoleFormActions>
          <button type="button" className="button button-secondary" onClick={() => { if (canCloseInviteDialog()) onClose(); }} disabled={submitting}>
            취소
          </button>
          <button type="submit" form="invite-form" className="button button-primary" disabled={submitting}>
            {submitting ? "초대 중입니다" : "초대 링크 발급"}
          </button>
        </ConsoleFormActions>
      }
    >
      <form id="invite-form" className={consoleUiStyles.formStack} onSubmit={onSubmit}>
        <div className={consoleUiStyles.field}>
          <label htmlFor="invite-name">이름</label>
          <input
            id="invite-name"
            type="text"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className={consoleUiStyles.field}>
          <label htmlFor="invite-email">이메일</label>
          <input
            id="invite-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className={consoleUiStyles.field}>
          <label htmlFor="invite-role">역할</label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => { setRole(event.target.value); setEventId(""); }}
          >
            <option value="MANAGER">운영사 구성원</option>
            <option value="STAFF">현장 스태프</option>
          </select>
        </div>
        {role === "MANAGER" ? (
          <div className={consoleUiStyles.field}>
            <label htmlFor="invite-event">담당 행사 (선택)</label>
            <select
              id="invite-event"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
            >
              <option value="">지정하지 않음</option>
              {events.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
      </form>
    </ConsoleDialog>
  );
}

function RevokeInviteButton({
  invitationId,
  onDone,
}: {
  invitationId: string;
  onDone: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const revokingRef = useRef(false);
  return (
    <span>
      <button
        type="button"
        className="button button-secondary"
        disabled={revoking}
        onClick={async () => {
          if (revokingRef.current || revoking) return;
          revokingRef.current = true;
          setRevoking(true);
          setFailure(null);
          try {
            const res = await fetch(`/api/auth/invitations/${encodeURIComponent(invitationId)}/revoke`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ commandId: randomCommandId() }),
            });
            const data = (await res.json().catch(() => null)) as { error?: unknown; invitation?: unknown } | null;
            if (!res.ok) {
              setFailure(typeof data?.error === "string" ? data.error : "철회하지 못했습니다.");
              return;
            }
            // Proven success echoes the revoked invitation back.
            const revoked = typeof data?.invitation === "object" && data?.invitation !== null
              ? data.invitation as Record<string, unknown>
              : null;
            if (!revoked || revoked.id !== invitationId) {
              setFailure("응답을 확인하지 못했습니다. 다시 시도하세요.");
              return;
            }
            onDone();
          } catch {
            setFailure("연결하지 못했습니다. 다시 시도하세요.");
          } finally {
            revokingRef.current = false;
            setRevoking(false);
          }
        }}
      >
        {revoking ? "철회 중입니다" : "초대 철회"}
      </button>
      {failure ? <small role="alert"> {failure}</small> : null}
    </span>
  );
}
