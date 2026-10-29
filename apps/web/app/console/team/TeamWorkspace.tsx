"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { buildStaffAssignHandoffHref, sortTeamEventsForAssign, teamEventOptionLabel } from "../console-handoff";
import { loginHrefForLocation } from "../../auth-redirect";
import ConsoleConfirm from "../console-ui/ConsoleConfirm";
import { CopyIcon } from "../console-ui/ConsoleIcons";
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
import { consoleFetch, invalidateConsoleReads } from "../../../lib/console-api";
import { getOperatorContextSnapshot, isOrganizationContextBlock, noteCommittedOperatorRoleChange, refreshOperatorContext } from "../../../lib/operator-context";
import { EVENT_WRITE_SCOPES, getEventWriteGrants } from "../../../lib/event-capabilities";

type Account = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  orgOwner: boolean;
  orgPermissions: string[];
  // Shared global identity (memberships in more than one org, however
  // flagged): boolean only, never the other orgs' names. The server
  // projection confirms the field; `active` above is the org membership
  // flag (m.active), not the global account flag.
  sharedAccount: boolean;
  // Per-membership revision for compare-and-swap writes: the server binds
  // `expectedContextVersion` to the target row's revision, so new intents
  // read it from the projected account field only — never from the actor
  // session or org headers. Absent while the directory does not project it;
  // in that case the field is omitted rather than guessed.
  membershipVersion: number | null;
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

type TeamEvent = { id: string; name: string; stage: string };

type TeamMembership = { accountId: string; eventId: string; write?: unknown };

// Current-org viewer context from the directory: the org id scopes the
// per-org membership write below, the version is its optimistic guard.
// Both stay display/transport facts; the server rechecks everything.
type TeamOrgContext = { orgId: string; orgName: string; contextVersion: number | null };

type TeamState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; accounts: Account[]; invitations: Invitation[]; events: TeamEvent[]; memberships: TeamMembership[]; canManageTeam: boolean; isOwner: boolean; userId: string; org: TeamOrgContext };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// Frozen membership-write attempt: the id plus the exact body bytes to
// send. A retry replays the same object verbatim so the server can match
// its receipt; nothing here ever mutates a stored body.
type FrozenMembershipAttempt = { fingerprint: string; commandId: string; body: Record<string, unknown> };

function roleLabel(role: string): string {
  if (role === "AGENCY") return "조직 소유자";
  if (role === "MANAGER") return "조직 구성원";
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
  // Which accepted member's org-role editor is expanded (account id, one at
  // a time). The panel below owns its draft/confirm/retry lifecycle.
  const [roleEditId, setRoleEditId] = useState<string | null>(null);

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
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch("/api/console/directory", { cache: "no-store" }),
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
        const directoryPayload = (await bootstrapResponse.json().catch(() => null)) as {
          directory?: { accounts?: unknown; invitations?: unknown; events?: unknown; memberships?: unknown; viewer?: { organizationId?: unknown; organizationName?: unknown; contextVersion?: unknown } | null } | null;
        } | null;
        const bootstrapPayload = { state: directoryPayload?.directory };
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
                sharedAccount: account.sharedAccount === true,
                membershipVersion: typeof account.membershipVersion === "number" && Number.isInteger(account.membershipVersion) && account.membershipVersion >= 0
                  ? account.membershipVersion
                  : null,
                orgPermissions: Array.isArray(account.orgPermissions)
                  ? account.orgPermissions.filter((permission): permission is string => typeof permission === "string")
                  : [],
              }];
            })
          : [];
        const mine = accounts.find((item) => item.id === userId);
        // orgPermissions normalizes to no grants when missing: the server
        // holds every team write (invitations, resets, member assignment)
        // AGENCY-only, so a missing or unknown permission value only ever
        // explains, never enables. Password reset stays owner-only below.
        // Owner-only team writes: invitations, password resets and event
        // membership grants are all AGENCY-only on the server. The UI mirrors
        // that so nobody fills a form the server will reject; the server
        // stays authoritative either way.
        const isOwner = role === "AGENCY" || mine?.orgOwner === true;
        // Only the organization owner resets passwords; the server enforces
        // the same rule, this gate only decides what to show.
        const canManageTeam = isOwner;
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
              return [{ id: event.id, name: text(event.name) || event.id, stage: text(event.stage).toUpperCase() }];
            })
          : [];
        // Stored membership grants ride through verbatim for the owner-only
        // permission editor below: omitted write reads as full access, an
        // explicit [] as read-only. Unknown entries are skipped, never
        // treated as grants.
        const rawMemberships = bootstrapPayload?.state?.memberships;        const memberships: TeamMembership[] = Array.isArray(rawMemberships)
          ? rawMemberships.flatMap((item) => {
              const membership = record(item);
              if (!membership || typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
            })
          : [];
        if (!meResponse.ok || !userId || !bootstrapResponse.ok || !bootstrapPayload?.state) {
          setState({ kind: "failed", message: "팀 정보를 불러오지 못했습니다." });
          return;
        }
        // Current-org viewer context for the per-org membership write below.
        // Missing values do not break reads: the disable action explains
        // instead of sending a request it cannot scope.
        const viewer = record((bootstrapPayload.state as Record<string, unknown>).viewer);
        const rawVersion = viewer?.contextVersion;
        const contextVersion =
          typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0
            ? rawVersion
            : typeof rawVersion === "string" && /^\d+$/.test(rawVersion.trim())
              ? Number(rawVersion.trim())
              : null;
        setState({ kind: "ready", accounts, invitations, events, memberships, canManageTeam, isOwner, userId, org: { orgId: text(viewer?.organizationId), orgName: text(viewer?.organizationName), contextVersion } });
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
        state.isOwner ? (
          <ConsoleToolbar
            filters={<p className={teamStyles.toolbarLabel}>팀 관리</p>}
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
          {!state.canManageTeam ? (
            <ConsoleFeedback kind="warning">팀 관리 권한이 없습니다. 비밀번호 재설정은 조직 소유자에게 요청하세요.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <p className="overview-meta">비밀번호 재설정은 소유자만 가능하며, 재설정 시 다른 기기에서 로그아웃됩니다.</p>
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
              <CopyIcon />
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
      {state.isOwner && state.invitations.length ? (
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
              <li className={`${consoleUiStyles.recordRow} ${teamStyles.teamRow} ${teamStyles.inviteRow}`} key={invitation.id}>
                <div className={`${consoleUiStyles.recordMain} ${teamStyles.memberMain}`}>
                  <span className={teamStyles.inviteTitle}><strong className={teamStyles.memberName}>{invitation.name}</strong><span className={teamStyles.inviteState}>대기 중</span></span>
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
      ) : state.isOwner ? (
        <ConsoleSection headingId="pending-invites" title="대기 중인 초대" surface="plain" width="full">
          <div className={`${consoleUiStyles.empty} ${teamStyles.teamEmpty}`}>
            <h3>대기 중인 초대가 없습니다.</h3>
            <p>구성원 초대 버튼으로 새 초대를 보낼 수 있습니다.</p>
          </div>
        </ConsoleSection>
      ) : null}
      <div className={state.isOwner ? teamStyles.teamWorkbench : teamStyles.teamWorkbenchSingle}>
      <div className={teamStyles.teamMain}>
      <ConsoleSection headingId="team-members" title="구성원" surface="plain" width="full">
        {state.accounts.length ? (
          <ul className={consoleUiStyles.collection} aria-label="구성원 목록">
            {state.accounts.map((account) => (
              <li className={`${consoleUiStyles.recordRow} ${teamStyles.teamRow}`} key={account.id}>
                <div className={`${consoleUiStyles.recordMain} ${teamStyles.memberMain}`}>
                  <strong className={teamStyles.memberName}>{account.name}</strong>
                  <p className={teamStyles.memberRole}>
                    조직 역할: {roleLabel(account.role)}
                    {!account.active ? <span className={teamStyles.memberStatus} data-tone="off">사용 중지</span> : null}
                  </p>
                  <p className={teamStyles.memberContact}><SafeContact value={account.email} /></p>
                  {account.sharedAccount ? (
                    <p className={teamStyles.assignLead} role="note">
                      여러 조직에서 함께 사용 중이라 이 운영사에서 비밀번호를 재설정할 수 없습니다.
                    </p>
                  ) : null}
                </div>
                {state.canManageTeam ? (
                  <div className={`${consoleUiStyles.recordActions} ${teamStyles.memberActions}`}>
                    <div className={teamStyles.actionPrimary} role="group" aria-label="조직 역할과 행사 배정">
                    <button
                      type="button"
                      id={`org-role-toggle-${account.id}`}
                      className="button button-secondary"
                      aria-expanded={roleEditId === account.id}
                      aria-controls={`org-role-panel-${account.id}`}
                      onClick={() => {
                        setNotice(null);
                        setRoleEditId((current) => (current === account.id ? null : account.id));
                      }}
                    >
                      역할 변경
                    </button>
                    {account.role === "STAFF" && account.active ? (
                      <button
                        type="button"
                        id={`staff-assign-toggle-${account.id}`}                        className="button button-quiet"
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
                    <div className={teamStyles.actionDanger} role="group" aria-label="비밀번호 재설정과 소속 변경(주의 필요)">
                    {/* Shared identities cannot reset here (see the single
                        directory note above), so the reset slot stays empty
                        instead of repeating the same sentence. Disable /
                        reactivate below are unaffected. */}
                    {account.sharedAccount ? null : (
                      <button
                        type="button"
                        className="button button-danger"
                        onClick={() => { setNotice(null); setResetTarget(account); }}
                      >
                        비밀번호 재설정
                      </button>
                    )}
                    {account.id !== state.userId && account.active ? (
                      <OrgMembershipDisableButton
                        orgId={state.org.orgId}
                        account={account}
                        onDone={(message) => {
                          setNotice(message);
                          setReloadTick((tick) => tick + 1);
                        }}
                      />
                    ) : null}
                    {account.id !== state.userId && !account.active ? (
                      <OrgMembershipReactivateButton
                        orgId={state.org.orgId}
                        account={account}
                        onDone={(message) => {
                          setNotice(message);
                          setReloadTick((tick) => tick + 1);
                        }}
                      />
                    ) : null}
                    </div>
                  </div>
                ) : null}
                {state.canManageTeam && (assignOpenId === account.id || roleEditId === account.id) ? (
                  <div className={teamStyles.memberEditor}>
                    {account.role === "STAFF" && account.active && assignOpenId === account.id ? (
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
                    {roleEditId === account.id ? (
                      <OrgRoleEditorPanel
                        orgId={state.org.orgId}
                        orgName={state.org.orgName}
                        account={account}
                        isSelf={account.id === state.userId}
                        onClose={() => {
                          setRoleEditId(null);
                          document.getElementById(`org-role-toggle-${account.id}`)?.focus();
                        }}
                        onDone={(message) => {
                          setRoleEditId(null);
                          setNotice(message);
                          setReloadTick((tick) => tick + 1);
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className={`${consoleUiStyles.empty} ${teamStyles.teamEmpty}`}>
            <h3>등록된 구성원이 없습니다.</h3>
            <p>필요하면 구성원 초대 버튼으로 첫 초대를 보내세요.</p>
          </div>
        )}
      </ConsoleSection>
      </div>
      {state.isOwner ? (
        <aside className={teamStyles.teamRail} aria-label="구성원 권한">
          <EventPermissionEditor
            events={state.events}
            accounts={state.accounts}
            memberships={state.memberships}
            onChanged={(message) => {
              setNotice(message);
              setReloadTick((tick) => tick + 1);
            }}
          />
        </aside>
      ) : null}
      </div>
      <details className={teamStyles.operationsDetails}>
        <summary>연동·활동</summary>
        <OperationsPanels />
      </details>
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
  // Options name the server stage and sort active stages before closed
  // ones; unknown stages sort last. Choosing still only reveals the
  // operations link — nothing is stored, sent, or pre-associated.
  const orderedEvents = useMemo(() => sortTeamEventsForAssign(events), [events]);
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
            {orderedEvents.map((item) => (
              <option key={item.id} value={item.id}>{teamEventOptionLabel(item)}</option>
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
            href={buildStaffAssignHandoffHref(chosen.id, accountId)}
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

// Owner-only event membership permission editor. One event at a time; each
// active MANAGER row (plus any other active member on the event) shows the
// stored grant and offers the eight server scopes, 전체, or an explicit
// empty grant. Reads are never gated here — membership alone already opens
// every event screen, and an explicit [] only removes writes. The server
// (POST /api/events/:id/members) validates the scopes and stays
// authoritative; this editor only mirrors server/event-permissions.js words.
function grantSummary(grants: string[] | null): string {
  if (grants === null) return "이 행사 권한 없음";
  if (grants.includes("all")) return "전체";
  if (grants.length === 0) return "읽기 전용";
  return grants
    .map((scope) => EVENT_WRITE_SCOPES.find((item) => item.scope === scope)?.label ?? scope)
    .join(" · ");
}

function EventPermissionEditor({
  events,
  accounts,
  memberships,
  onChanged,
}: {
  events: TeamEvent[];
  accounts: Account[];
  memberships: TeamMembership[];
  onChanged: (message: string) => void;
}) {
  const [eventId, setEventId] = useState(events.length === 1 && events[0] ? events[0].id : "");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  // The unresolved attempt keeps its full context: a retry replays the same
  // event, account and write array with the same command id, never a newly
  // minted key over unknown committed permissions.
  const pendingRef = useRef<{
    fingerprint: string;
    commandId: string;
    eventId: string;
    accountId: string;
    write: string[];
  } | null>(null);
  const submitGateRef = useRef(false);
  const chosen = events.find((item) => item.id === eventId) ?? null;
  // STAFF work through desk/booth assignments, never membership write
  // grants: only MANAGER rows get the grant UI. Active STAFF who happen to
  // hold a membership row are named below, not edited.
  const managerAccounts = accounts.filter((account) => account.active && account.role === "MANAGER");
  const staffWithMembership = chosen
    ? accounts.filter(
        (account) =>
          account.active &&
          account.role === "STAFF" &&
          memberships.some((membership) => membership.accountId === account.id && membership.eventId === chosen.id)
      )
    : [];
  // True-diff dirt for the open row: the stored grant (absent reads as full)
  // is the baseline, so an untouched open form is not dirty.
  const storedForEditing = editingId
    ? getEventWriteGrants(memberships, { userId: editingId, eventId })
    : null;
  const scopesDirty =
    editingId !== null &&
    JSON.stringify([...draft].sort()) !==
      JSON.stringify([...(storedForEditing === null ? ["all"] : storedForEditing)].sort());
  // Frozen while a save is in flight or its result is unknown: only the same
  // exact attempt may retry. Context/checkbox/member-switch/cancel all wait.
  const frozen = busy || retryable;
  // Unsaved scope edits guard navigation; an unresolved (unknown-result)
  // request guards with the stronger unconfirmed-write copy instead.
  useConsoleDraftGuard(
    scopesDirty || pendingRef.current !== null,
    pendingRef.current !== null ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE
  );

  function openEditor(accountId: string): void {
    if (submitGateRef.current || frozen) return;
    if (editingId !== null && editingId !== accountId && scopesDirty) {
      if (!window.confirm(DIRTY_CLOSE_MESSAGE)) return;
    }
    const grants = getEventWriteGrants(memberships, { userId: accountId, eventId });
    setEditingId(accountId);
    setDraft(grants === null ? ["all"] : [...grants]);
    setFailure(null);
  }

  function changeEvent(nextId: string): void {
    if (submitGateRef.current || frozen) return;
    if (editingId !== null && scopesDirty) {
      if (!window.confirm(DIRTY_CLOSE_MESSAGE)) return;
    }
    setEventId(nextId);
    setEditingId(null);
    setFailure(null);
  }

  function cancelEdit(): void {
    if (submitGateRef.current || frozen) return;
    if (scopesDirty && !window.confirm(DIRTY_CLOSE_MESSAGE)) return;
    setEditingId(null);
    setFailure(null);
  }

  function toggleScope(scope: string): void {
    // Frozen contexts never mint a new key over unknown committed
    // permissions: only the stored attempt may retry, unchanged.
    if (submitGateRef.current || frozen) return;
    setFailure(null);
    setDraft((current) => {
      if (scope === "all") return current.includes("all") ? [] : ["all"];
      const withoutAll = current.filter((item) => item !== "all");
      return withoutAll.includes(scope)
        ? withoutAll.filter((item) => item !== scope)
        : [...withoutAll, scope];
    });
  }

  async function save(account: Account): Promise<void> {
    if (submitGateRef.current || busy || !chosen) return;
    const stored = pendingRef.current;
    const resumed =
      stored !== null && stored.eventId === chosen.id && stored.accountId === account.id;
    // A retry replays the stored write array verbatim; a fresh save collapses
    // 전체 to ['all'] because sending ['all', ...] would still grant
    // everything server-side.
    const write = resumed ? stored.write : draft.includes("all") ? ["all"] : [...new Set(draft)];
    const fingerprint = JSON.stringify([chosen.id, account.id, write]);
    const attempt = resumed
      ? stored
      : { fingerprint, commandId: randomCommandId(), eventId: chosen.id, accountId: account.id, write };
    pendingRef.current = attempt;
    submitGateRef.current = true;
    setBusy(true);
    setFailure(null);
    setRetryable(false);
    try {
      const res = await consoleFetch(`/api/events/${encodeURIComponent(chosen.id)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, accountId: account.id, write: attempt.write, enabled: true }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown; membership?: unknown } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "행사 권한을 저장하지 못했습니다.";
        if (isDefinitiveClientError(res.status)) {
          pendingRef.current = null;
          setFailure(serverMessage);
        } else {
          // Ambiguous outcome keeps the stored attempt: the retry replays
          // the same request and the receipt replays the original result.
          // Everything else stays frozen until it resolves.
          setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
          setRetryable(true);
        }
        return;
      }
      pendingRef.current = null;
      setEditingId(null);
      onChanged(
        attempt.write.includes("all")
          ? `${account.name}님에게 ${chosen.name} 전체 쓰기 권한을 주었습니다.`
          : attempt.write.length === 0
            ? `${account.name}님을 ${chosen.name} 읽기 전용으로 바꾸었습니다. 보기는 그대로 되지만 바꿀 수는 없습니다.`
            : `${account.name}님에게 ${chosen.name} ${grantSummary(attempt.write)} 쓰기 권한을 주었습니다.`
      );
    } catch {
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      setRetryable(true);
    } finally {
      submitGateRef.current = false;
      setBusy(false);
    }
  }

  return (
    <ConsoleSection headingId="team-event-permissions" title="행사별 쓰기 권한" width="full">
      <p className={teamStyles.assignLead}>
        소유자만 변경할 수 있습니다. 저장하지 않으면 읽기 전용입니다.
      </p>
      {events.length ? (
        <label className={teamStyles.assignField}>
          <span>권한을 바꿀 행사</span>
          <select
            value={eventId}
            onChange={(event) => changeEvent(event.target.value)}
            aria-label="권한을 바꿀 행사 선택"
            disabled={frozen}
          >
            <option value="">선택하세요</option>
            {events.map((item) => (
              <option key={item.id} value={item.id}>{teamEventOptionLabel(item)}</option>
            ))}
          </select>
        </label>
      ) : (
        <p className={teamStyles.assignLead} role="status">권한을 바꿀 행사가 없습니다.</p>
      )}
      {retryable ? (
        <p className={teamStyles.assignLead} role="note">
          저장 결과를 확인하지 못했습니다. 이미 저장됐을 수 있으니 같은 요청으로 다시 시도하세요.
          결과가 확인될 때까지 다른 변경은 잠급니다.
        </p>
      ) : null}
      {chosen ? (
        managerAccounts.length ? (
          <ul className={consoleUiStyles.collection} aria-label={`${chosen.name} 쓰기 권한 목록`}>
            {managerAccounts.map((account) => {
              const grants = getEventWriteGrants(memberships, { userId: account.id, eventId: chosen.id });
              const editing = editingId === account.id;
              return (
                <li className={`${consoleUiStyles.recordRow} ${teamStyles.teamRow}`} key={account.id}>
                  <div className={`${consoleUiStyles.recordMain} ${teamStyles.memberMain}`}>
                    <strong className={teamStyles.memberName}>{account.name}</strong>
                    <p className={teamStyles.memberRole}>
                      {roleLabel(account.role)} · {grantSummary(grants)}
                    </p>
                    <p className={teamStyles.memberContact}><SafeContact value={account.email} /></p>
                    {editing ? (
                      <div>
                        <div role="group" aria-label={`${account.name} 쓰기 범위 선택`}>
                          <label className={teamStyles.scopeCheck}>
                            <input
                              type="checkbox"
                              checked={draft.includes("all")}
                              onChange={() => toggleScope("all")}
                              disabled={frozen}
                            />
                            전체 (모든 쓰기)
                          </label>
                          {EVENT_WRITE_SCOPES.map((item) => (
                            <label className={teamStyles.scopeCheck} key={item.scope}>
                              <input
                                type="checkbox"
                                checked={draft.includes(item.scope) && !draft.includes("all")}
                                onChange={() => toggleScope(item.scope)}
                                disabled={frozen || draft.includes("all")}
                              />
                              {item.label} — {item.description}
                            </label>
                          ))}
                        </div>
                        {!draft.includes("all") && draft.length === 0 ? (
                          <p role="note" className={teamStyles.assignLead}>
                            선택을 모두 비우면 읽기 전용이 됩니다. 화면 보기는 그대로 되지만 아무것도 바꿀 수 없습니다.
                          </p>
                        ) : null}
                        {failure && editing ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
                        <ConsoleFormActions>
                          <button
                            type="button"
                            className="button button-primary"
                            disabled={busy}
                            onClick={() => void save(account)}
                          >
                            {busy ? "저장 중입니다" : retryable ? "같은 요청으로 다시 시도" : "권한 저장"}
                          </button>
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={frozen}
                            onClick={cancelEdit}
                          >
                            취소
                          </button>
                        </ConsoleFormActions>
                      </div>
                    ) : null}
                  </div>
                  <div className={`${consoleUiStyles.recordActions} ${teamStyles.memberActions}`}>
                    {!editing ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={frozen}
                        onClick={() => openEditor(account.id)}
                      >
                        권한 편집
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={teamStyles.assignLead} role="status">권한을 바꿀 조직 구성원이 없습니다.</p>
        )
      ) : events.length ? (
        <p className={teamStyles.assignLead} role="status">행사를 선택하면 구성원별 쓰기 권한이 나타납니다.</p>
      ) : null}
      {chosen && staffWithMembership.length ? (
        <p className={teamStyles.assignLead} role="note">
          현장 스태프 {staffWithMembership.length}명은 데스크·부스 배정으로만 일하고 행사 쓰기 권한이 없으므로 편집 대상이 아닙니다.
        </p>
      ) : null}
    </ConsoleSection>
  );
}

function OrgMembershipDisableButton({
  orgId,
  account,
  onDone,
}: {
  orgId: string;
  account: Account;
  onDone: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  // The unresolved attempt keeps its full context — id plus exact body: a
  // retry replays the same request, never a newly minted key over an
  // unknown membership state.
  const pendingRef = useRef<FrozenMembershipAttempt | null>(null);
  const submitGateRef = useRef(false);
  const frozen = busy;

  function open(): void {
    if (submitGateRef.current || frozen) return;
    setFailure(null);
    setConfirming(true);
  }

  function cancel(): void {
    if (submitGateRef.current || busy) return;
    // A retryable (unknown-result) attempt survives the cancel: reopening
    // resumes the same request instead of minting a second one.
    setConfirming(false);
  }

  async function run(): Promise<void> {
    if (submitGateRef.current || busy || !orgId) return;
    const hadUncertainAttempt = retryable && pendingRef.current !== null;
    submitGateRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const fingerprint = JSON.stringify([orgId, account.id, false]);
      const stored = pendingRef.current;
      const isRetry = stored !== null && stored.fingerprint === fingerprint;
      const attempt: FrozenMembershipAttempt = isRetry
        ? stored
        : (() => {
            // Fresh intent only: take the projected target-row version when the
            // directory projects it. Never applied to an old pending body.
            const commandId = randomCommandId();
            const freshBody: Record<string, unknown> = { active: false, commandId };
            const version = typeof account.membershipVersion === "number" && Number.isInteger(account.membershipVersion) && account.membershipVersion >= 0 ? account.membershipVersion : null;
            if (version !== null) freshBody.expectedContextVersion = version;
            return { fingerprint, commandId, body: freshBody };
          })();
      pendingRef.current = attempt;
      const res = await consoleFetch(`/api/auth/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(account.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        membership?: { orgId?: unknown; accountId?: unknown; active?: unknown } | null;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "소속을 사용 중지하지 못했습니다.";
        if (data?.code === "ORGANIZATION_CONTEXT_CHANGED") {
          if (isRetry) {
            // Prior outcome uncertain: the original request may already have
            // committed, so keep its id and payload verbatim and stay
            // retryable. Point back at the original org; no auto reload and
            // no unmount — the row keeps its state for the explicit retry.
            setRetryable(true);
            setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
          } else {
            // First attempt proven stale: nothing was written, so the id is
            // dropped. The row stays actionable for an explicit fresh try.
            pendingRef.current = null;
            setRetryable(false);
            setFailure("조직 정보가 바뀌었습니다. 최신 정보를 확인한 뒤 다시 시도하세요.");
          }
          return;
        }
        if (isDefinitiveClientError(res.status)) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure(serverMessage);
          return;
        }
        // Ambiguous outcome keeps the stored attempt: the retry replays the
        // same request and freezes other changes until it resolves.
        setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        setRetryable(true);
        return;
      }
      // Proven success echoes this org and account back; anything else is
      // an unknown outcome, so the retry replays the same id.
      const membership = record(data?.membership);
      if (!membership || membership.orgId !== orgId || membership.accountId !== account.id || membership.active !== false) {
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      pendingRef.current = null;
      setRetryable(false);
      setConfirming(false);
      onDone(`${account.name}님을 이 운영사에서 사용 중지했습니다. 다른 조직의 소속과 로그인에는 영향이 없습니다.`);
    } catch (error) {
      if (isOrganizationContextBlock(error)) {
        if (!hadUncertainAttempt) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure("조직 정보가 바뀌어 요청을 보내지 않았습니다. 최신 소속을 확인한 뒤 다시 시도하세요.");
          return;
        }
        // Only an earlier unknown result needs the frozen same-key replay.
        setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      setRetryable(true);
    } finally {
      submitGateRef.current = false;
      setBusy(false);
    }
  }

  // Without a scoped org id the request cannot be addressed honestly: show
  // the reason instead of a working button.
  if (!orgId) {
    return (
      <button
        type="button"
        className="button button-secondary"
        disabled
        title="현재 조직 정보를 확인할 수 없어 소속을 바꿀 수 없습니다."
      >
        이 운영사 소속 사용 중지
      </button>
    );
  }
  return (
    <>
      {!confirming ? (
        <button type="button" className="button button-danger" disabled={frozen} onClick={open}>
          {retryable ? "같은 요청으로 다시 시도" : "이 운영사 소속 사용 중지"}
        </button>
      ) : null}
      {confirming ? (
        <ConsoleConfirm
          summary={confirmLines(`${account.name}님을 이 운영사에서 사용 중지할까요?\n\n역할은 바뀌지 않으며, 다른 조직의 소속과 로그인에는 영향이 없습니다.`)}
          confirmLabel={retryable ? "같은 요청으로 다시 시도" : "사용 중지한다"}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={cancel}
        />
      ) : null}
      {failure && confirming ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
    </>
  );
}

// Owner-only per-org membership reactivation. Role is never sent here, so
// the existing role is preserved as-is; only `active` flips back on.
// Same frozen-idempotent retry contract as deactivation: the full attempt is
// frozen on first send, an uncertain outcome keeps the same id and body, a
// fresh stale attempt mints a new one, and the panel never auto-reloads or
// unmounts on drift.
function OrgMembershipReactivateButton({
  orgId,
  account,
  onDone,
}: {
  orgId: string;
  account: Account;
  onDone: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  // The unresolved attempt keeps its full id and body: a retry replays the
  // same request, never a newly minted key over an unknown membership state.
  const pendingRef = useRef<FrozenMembershipAttempt | null>(null);
  const submitGateRef = useRef(false);
  const frozen = busy;

  function open(): void {
    if (submitGateRef.current || frozen) return;
    setFailure(null);
    setConfirming(true);
  }

  function cancel(): void {
    if (submitGateRef.current || busy) return;
    // A retryable (unknown-result) attempt survives the cancel: reopening
    // the confirm resumes the same request instead of minting a second one.
    setConfirming(false);
  }

  async function run(): Promise<void> {
    if (submitGateRef.current || busy || !orgId) return;
    const hadUncertainAttempt = retryable && pendingRef.current !== null;
    submitGateRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const fingerprint = JSON.stringify([orgId, account.id, true]);
      const stored = pendingRef.current;
      const isRetry = stored !== null && stored.fingerprint === fingerprint;
      const attempt: FrozenMembershipAttempt = isRetry
        ? stored
        : (() => {
            // Fresh intent only: take the projected target-row version when the
            // directory projects it. Never applied to an old pending body.
            const commandId = randomCommandId();
            const freshBody: Record<string, unknown> = { active: true, commandId };
            const version = typeof account.membershipVersion === "number" && Number.isInteger(account.membershipVersion) && account.membershipVersion >= 0 ? account.membershipVersion : null;
            if (version !== null) freshBody.expectedContextVersion = version;
            return { fingerprint, commandId, body: freshBody };
          })();
      pendingRef.current = attempt;
      const res = await consoleFetch(`/api/auth/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(account.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        membership?: { orgId?: unknown; accountId?: unknown; active?: unknown } | null;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "소속을 다시 활성화하지 못했습니다.";
        if (data?.code === "ORGANIZATION_CONTEXT_CHANGED") {
          if (isRetry) {
            // Prior outcome uncertain: the original request may already have
            // committed, so keep its id and payload verbatim and stay
            // retryable. Point back at the original org; no auto reload and
            // no unmount — the row keeps its state for the explicit retry.
            setRetryable(true);
            setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
          } else {
            // First attempt proven stale: nothing was written, so the id is
            // dropped. The row stays actionable for an explicit fresh try.
            pendingRef.current = null;
            setRetryable(false);
            setFailure("조직 정보가 바뀌었습니다. 최신 정보를 확인한 뒤 다시 시도하세요.");
          }
          return;
        }
        if (isDefinitiveClientError(res.status)) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure(serverMessage);
          return;
        }
        // Ambiguous outcome keeps the stored attempt: the retry replays the
        // same request and freezes other changes until it resolves.
        setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        setRetryable(true);
        return;
      }
      // Proven success echoes this org and account back as active; anything
      // else is an unknown outcome, so the retry replays the same id.
      const membership = record(data?.membership);
      if (!membership || membership.orgId !== orgId || membership.accountId !== account.id || membership.active !== true) {
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      pendingRef.current = null;
      setRetryable(false);
      setConfirming(false);
      onDone(`${account.name}님을 이 운영사에서 다시 활성화했습니다. 다른 조직의 소속과 로그인에는 영향이 없습니다.`);
    } catch (error) {
      if (isOrganizationContextBlock(error)) {
        if (!hadUncertainAttempt) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure("조직 정보가 바뀌어 요청을 보내지 않았습니다. 최신 소속을 확인한 뒤 다시 시도하세요.");
          return;
        }
        // Only an earlier unknown result needs the frozen same-key replay.
        setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      setRetryable(true);
    } finally {
      submitGateRef.current = false;
      setBusy(false);
    }
  }

  // Without a scoped org id the request cannot be addressed honestly: show
  // the reason instead of a working button.
  if (!orgId) {
    return (
      <button
        type="button"
        className="button button-secondary"
        disabled
        title="현재 조직 정보를 확인할 수 없어 소속을 바꿀 수 없습니다."
      >
        이 운영사 소속 다시 활성화
      </button>
    );
  }
  return (
    <>
      {!confirming ? (
        <button type="button" className="button button-danger" disabled={frozen} onClick={open}>
          {retryable ? "같은 요청으로 다시 시도" : "이 운영사 소속 다시 활성화"}
        </button>
      ) : null}
      {confirming ? (
        <ConsoleConfirm
          summary={confirmLines(`${account.name}님을 이 운영사에서 다시 활성화할까요?\n\n역할은 바뀌지 않으며, 이 운영사에만 적용됩니다. 다른 조직·로그인·비밀번호에는 영향이 없습니다.`)}
          confirmLabel={retryable ? "같은 요청으로 다시 시도" : "다시 활성화한다"}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={cancel}
        />
      ) : null}
      {failure && confirming ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
    </>
  );
}

// Owner-only per-org role change. Role only: the request body never carries
// `active`, so an inactive membership stays inactive (no implicit
// activation) and roles never widen event writes by themselves. A promotion
// to MANAGER grants no event access here — the separate 행사별 쓰기 권한
// editor below owns that. A move to STAFF grants no desk/booth work — the
// per-row 행사 배정 flow owns that.
function OrgRoleEditorPanel({
  orgId,
  orgName,
  account,
  isSelf,
  onClose,
  onDone,
}: {
  orgId: string;
  orgName: string;
  account: Account;
  isSelf: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [roleDraft, setRoleDraft] = useState(account.role);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  // After a self change commits, the panel waits for the central fresh-me
  // recheck instead of navigating on its own. Revalidation starts
  // immediately so the drift lock engages without waiting for focus or
  // timers; only a fresh authoritative answer moves the operator on.
  const [selfDeparted, setSelfDeparted] = useState(false);
  // The unresolved attempt keeps its exact target: a retry replays the same
  // org, account and role with the same command id, never a newly minted
  // key over an unknown membership state.
  const pendingRef = useRef<FrozenMembershipAttempt | null>(null);
  const submitGateRef = useRef(false);
  // Count captured at confirm-open for the self warning below. A confirm
  // opens with review info only; enforcement always re-reads fresh at submit.
  const confirmForeignRef = useRef(0);
  const frozen = busy || retryable;
  const roleChanged = roleDraft !== account.role;
  // Foreign pending work at this instant, from a fresh shared-transport
  // snapshot. Callers hold (run) or clear (pre-confirm) our own submit gate
  // before reading, so the count is always interpreted with our own
  // submission state known: both gates run before our fetch starts, hence
  // no shared in-flight slot can be ours. Our unresolved attempt (retry
  // path only) may occupy one shared uncertain slot, so exactly one is
  // forgiven while we hold a pending id. Either way our own completion can
  // never be cancelled by its own count.
  function foreignPendingWork(): number {
    const snap = getOperatorContextSnapshot();
    const ownUncertain = pendingRef.current !== null ? 1 : 0;
    return snap.inFlightWrites + Math.max(0, snap.uncertainWrites - ownUncertain);
  }
  // Unsaved role picks guard navigation like the permission editor's scope
  // edits; an unresolved (unknown-result) request guards with the stronger
  // unconfirmed-write copy instead.
  useConsoleDraftGuard(
    (roleChanged && !confirming) || pendingRef.current !== null,
    pendingRef.current !== null ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE
  );

  function cancel(): void {
    if (submitGateRef.current || frozen) return;
    if ((roleChanged || pendingRef.current !== null) && !window.confirm(pendingRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE)) return;
    onClose();
  }

  function requestConfirm(): void {
    if (submitGateRef.current || busy || !roleChanged) return;
    setFailure(null);
    // Fresh snapshot for the review below: the count shown in the self
    // warning is this instant's, and enforcement re-reads at submit.
    // Retry stays open here (busy-only gate) so the same key remains usable.
    confirmForeignRef.current = foreignPendingWork();
    setConfirming(true);
  }

  function cancelConfirm(): void {
    if (submitGateRef.current || busy) return;
    // A retryable (unknown-result) attempt survives the cancel: reopening
    // the confirm resumes the same request instead of minting a new key.
    setConfirming(false);
  }

  async function run(): Promise<void> {
    if (submitGateRef.current || busy || !orgId) return;
    const hadUncertainAttempt = retryable && pendingRef.current !== null;
    submitGateRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      // Self changes re-check fresh: unrelated in-flight or uncertain work
      // blocks the transmission (no id is minted), with the exact reason.
      // Other members proceed as the server permits.
      if (isSelf) {
        const foreign = foreignPendingWork();
        if (foreign > 0) {
          setConfirming(false);
          setFailure("진행 중이거나 결과 미확인인 작업을 먼저 확인한 뒤 본인 역할을 바꾸세요.");
          return;
        }
      }
      const fingerprint = JSON.stringify([orgId, account.id, roleDraft]);
      const stored = pendingRef.current;
      const isRetry = stored !== null && stored.fingerprint === fingerprint;
      const attempt: FrozenMembershipAttempt = isRetry
        ? stored
        : (() => {
            // Fresh intent only: take the projected target-row version when the
            // directory projects it. Never applied to an old pending body.
            const commandId = randomCommandId();
            const freshBody: Record<string, unknown> = { role: roleDraft, commandId };
            const version = typeof account.membershipVersion === "number" && Number.isInteger(account.membershipVersion) && account.membershipVersion >= 0 ? account.membershipVersion : null;
            if (version !== null) freshBody.expectedContextVersion = version;
            return { fingerprint, commandId, body: freshBody };
          })();
      pendingRef.current = attempt;
      // Role-only: no `active` field, so an inactive membership stays
      // inactive (no implicit activation) and roles never widen event
      // writes by themselves.
      const res = await consoleFetch(`/api/auth/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(account.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        membership?: { orgId?: unknown; accountId?: unknown; role?: unknown; active?: unknown } | null;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "역할을 바꾸지 못했습니다.";
        if (data?.code === "ORGANIZATION_CONTEXT_CHANGED") {
          if (isRetry) {
            // Prior outcome uncertain: the original request may already have
            // committed, so keep its id and payload verbatim and stay
            // retryable. Point back at the original org; no auto reload and
            // no unmount — the panel keeps its state for the explicit retry.
            setRetryable(true);
            setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
          } else {
            // First attempt proven stale: nothing was written, so the id is
            // dropped while the chosen role stays for an explicit fresh try.
            pendingRef.current = null;
            setRetryable(false);
            setFailure("조직 정보가 바뀌었습니다. 최신 정보를 확인한 뒤 다시 시도하세요.");
          }
          return;
        }
        if (isDefinitiveClientError(res.status)) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure(serverMessage);
        } else {
          // Ambiguous outcome keeps the stored attempt: the retry replays
          // the same request and freezes other changes until it resolves.
          setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
          setRetryable(true);
        }
        return;
      }
      // Proven success echoes this org, account and role back with the
      // membership active flag untouched; anything else is an unknown
      // outcome, so the retry replays the same id.
      const membership = record(data?.membership);
      if (!membership || membership.orgId !== orgId || membership.accountId !== account.id || membership.role !== roleDraft || membership.active !== account.active) {
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      pendingRef.current = null;
      setRetryable(false);
      setConfirming(false);
      if (isSelf) {
        // Own role committed, but the echoed membership must not decide the
        // next screen: races may have moved on. Lock drift immediately so the
        // old owner UI stops being usable — the revalidation below marks the
        // context changed while the pinned old view is retained (never
        // swapped for the requested role). The actual next step lives in the
        // central notice outside the locked fieldset.
        setSelfDeparted(true);
        noteCommittedOperatorRoleChange();
        invalidateConsoleReads();
        void refreshOperatorContext();
        return;
      }
      onDone(`${account.name}님의 조직 역할을 ${roleLabel(roleDraft)}(으)로 바꿨습니다. 행사별 쓰기 권한은 바뀌지 않았습니다.`);
    } catch (error) {
      if (isOrganizationContextBlock(error)) {
        if (!hadUncertainAttempt) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure("조직 정보가 바뀌어 요청을 보내지 않았습니다. 최신 소속을 확인한 뒤 다시 시도하세요.");
          return;
        }
        // Only an earlier unknown result needs the frozen same-key replay.
        setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      setRetryable(true);
    } finally {
      submitGateRef.current = false;
      setBusy(false);
    }
  }

  // Own role committed, but the next screen stays unverified until an
  // explicit fresh-me check decides it. The committed membership proves the
  // write; only the fresh read decides where to go.
  if (selfDeparted) {
    return (
      <div className={teamStyles.assignPanel} id={`org-role-panel-${account.id}`}>
        <p className={teamStyles.assignLead} role="status">
          {account.name}님의 운영사 역할을 {roleLabel(roleDraft)}(으)로 바꿨습니다. 계속하려면 위의 운영사 문맥 안내에서 현재 역할을 확인하세요.
        </p>
        {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
      </div>
    );
  }

  // Without a scoped org id the request cannot be addressed honestly: show
  // the reason instead of a working editor.
  if (!orgId) {
    return (
      <p className={teamStyles.assignLead} role="note">
        현재 조직 정보를 확인할 수 없어 역할을 바꿀 수 없습니다.
      </p>
    );
  }
  return (
    <div className={teamStyles.assignPanel} id={`org-role-panel-${account.id}`}>
      <p className={teamStyles.assignLead}>
        {account.name}님의 조직 역할을 바꿉니다. 현재: {roleLabel(account.role)}.
      </p>
      <div role="group" aria-label={`${account.name} 조직 역할 선택`}>
        {(["AGENCY", "MANAGER", "STAFF"] as const).map((scope) => (
          <label className={teamStyles.scopeCheck} key={scope}>
            <input
              type="radio"
              name={`org-role-${account.id}`}
              checked={roleDraft === scope}
              onChange={() => setRoleDraft(scope)}
              disabled={frozen}
            />
            {roleLabel(scope)}{scope === account.role ? " (현재)" : ""}
          </label>
        ))}
      </div>
      {roleDraft === "MANAGER" ? (
        <p className={teamStyles.assignLead}>
          행사별 쓰기 권한은 바뀌지 않습니다. 필요하면 아래{" "}
          <a className={teamStyles.assignLink} href="#team-event-permissions">행사별 쓰기 권한</a>에서 지정하세요.
        </p>
      ) : null}
      {roleDraft === "STAFF" ? (
        <p className={teamStyles.assignLead}>
          데스크·부스 배정은 각 행의 ‘행사 배정’에서 지정합니다. 역할 변경만으로는 배정이 생기지 않습니다.
        </p>
      ) : null}
      {isSelf && roleChanged ? (
        <p className={teamStyles.assignLead} role="note">
          본인 계정입니다. 역할을 바꾸면 이 화면의 권한도 함께 바뀌며, 소유자를 내려놓으면 팀 관리를 더 할 수 없습니다.
        </p>
      ) : null}
      {!account.active ? (
        <p className={teamStyles.assignLead} role="note">
          사용 중지 상태는 그대로 유지됩니다. 역할만 바뀌며 자동으로 활성화되지 않습니다.
        </p>
      ) : null}
      {failure && !confirming ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
      <ConsoleFormActions>
        <button
          type="button"
          className="button button-secondary"
          disabled={frozen}
          onClick={cancel}
        >
          취소
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !roleChanged}
          onClick={requestConfirm}
        >
          {retryable ? "같은 요청으로 다시 시도" : "변경 확인"}
        </button>
      </ConsoleFormActions>
      {confirming ? (
        <ConsoleConfirm
          summary={confirmLines(`${account.name}님의 조직 역할을 ${roleLabel(account.role)}에서 ${roleLabel(roleDraft)}(으)로 바꿉니다.\n\n이 운영사(${orgName || orgId})에만 적용되며, 다른 조직·로그인·비밀번호에는 영향이 없습니다.${isSelf ? `\n본인 계정입니다. 계속하면 이 화면의 권한도 함께 바뀝니다.${confirmForeignRef.current > 0 ? ` 현재 진행 중이거나 결과 미확인인 작업 ${confirmForeignRef.current}건이 있습니다.` : ""}` : ""}`)}
          confirmLabel={retryable ? "같은 요청으로 다시 시도" : "역할을 바꾼다"}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={cancelConfirm}
        />
      ) : null}
      {failure && confirming ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
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
  const [sharedEffectBlocked, setSharedEffectBlocked] = useState(false);
  // Definitive shared-account refusal (403 SHARED_ACCOUNT_GLOBAL_EFFECT):
  // the password can never change from here, so the task UI itself closes
  // off — typed values are cleared, fields and submit disappear, and only
  // 닫기 remains. This also stops impossible retries that would mint a new
  // id per attempt after the pending id was cleared.
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
    if (submitGateRef.current || submitting || sharedEffectBlocked) return;
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
      const res = await consoleFetch(`/api/auth/accounts/${encodeURIComponent(account.id)}/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        account?: unknown;
        sessionsRevoked?: unknown;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "재설정하지 못했습니다.";
        if (data?.code === "SHARED_ACCOUNT_GLOBAL_EFFECT") {
          // Fail closed with an honest boundary: an owner reset here would
          // log the account out everywhere, so no reset runs from this task.
          // The holder's own path is the verified-email self-service on the
          // login screen — never an owner reset on their behalf. Nothing
          // global is promised or stopped — only this org's membership can
          // be deactivated instead.
          // The task UI closes off with the typed values: no fields, no
          // submit, footer 닫기 only, so no further attempt can mint an id.
          pendingResetRef.current = null;
          setPassword("");
          setConfirm("");
          setSharedEffectBlocked(true);
          setFailure(
            `${serverMessage} 이 계정은 여러 조직에서 함께 사용 중이라 여기서 비밀번호를 바꿀 수 없습니다. ` +
            "사전에 이메일 인증을 마친 계정은 로그인 화면의 '이메일로 직접 재설정'으로 본인이 바꿀 수 있습니다. " +
            "인증하지 않은 채 잠긴 계정은 별도 본인확인 절차가 정해질 때까지 재설정을 약속할 수 없습니다. " +
            "접근을 막아야 한다면 팀 목록의 '이 운영사 소속 사용 중지'로 이 운영사에서만 사용 중지하세요."
          );
          return;
        }
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
      description={
        sharedEffectBlocked
          ? `${account.email} · 이 계정은 여기서 재설정할 수 없습니다.`
          : `${account.email} · 재설정이 허용되는 계정은 성공하면 다른 기기에서 로그아웃됩니다.`
      }
      onClose={onClose}
      busy={submitting}
      canClose={canCloseResetDialog}
      footer={
        <ConsoleFormActions>
          {sharedEffectBlocked ? (
            <button type="button" className="button button-secondary" onClick={onClose}>
              닫기
            </button>
          ) : (
            <>
              <button type="button" className="button button-secondary" onClick={() => { if (canCloseResetDialog()) onClose(); }} disabled={submitting}>
                취소
              </button>
              <button type="submit" form="reset-form" className="button button-primary" disabled={submitting}>
                {submitting ? "재설정 중입니다" : "재설정"}
              </button>
            </>
          )}
        </ConsoleFormActions>
      }
    >
      {sharedEffectBlocked ? (
        failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null
      ) : (
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
      )}
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
  // Org-wide AGENCY grants confirm in place before anything is sent: the
  // staged snapshot is what the confirm sends, and inputs stay frozen while
  // staged so the summary cannot go stale.
  const [agencyStaged, setAgencyStaged] = useState<{ name: string; email: string; role: string } | null>(null);
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
    inviteDirty || pendingInviteRef.current !== null || submitGateRef.current || agencyStaged !== null,
    "작성 중인 초대 내용이 사라질 수 있습니다."
  );

  // Single dismissal predicate: the shared dialog calls canClose ONCE on
  // Escape/backdrop and then the pure onClose prop below — never two
  // confirms. Cancel consults the same predicate once.
  function canCloseInviteDialog(): boolean {
    if (submitGateRef.current || submitting) return false;
    return (!inviteDirty && !pendingInviteRef.current && !agencyStaged) || window.confirm(pendingInviteRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || submitting) return;
    const payload = {
      name: name.trim(),
      email: email.trim(),
      role,
      ...(role === "MANAGER" && eventId ? { eventId } : {}),
    };
    if (role === "AGENCY") {
      // Org-wide grant with no event scope: confirm the target and the
      // whole-org scope in place before sending anything.
      setFailure(null);
      setAgencyStaged({ name: payload.name, email: payload.email, role: payload.role });
      return;
    }
    await sendInvite(payload);
  }

  async function sendInvite(payload: { name: string; email: string; role: string; eventId?: string }): Promise<void> {
    if (submitGateRef.current || submitting) return;
    submitGateRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const fingerprint = JSON.stringify(payload);
      const attempt = pendingInviteRef.current?.fingerprint === fingerprint
        ? pendingInviteRef.current
        : { fingerprint, commandId: randomCommandId() };
      pendingInviteRef.current = attempt;
      const commandId = attempt.commandId;
      const res = await consoleFetch("/api/auth/invitations", {
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
          // Server wording is never rendered: definitive denials get a
          // fixed, actionable message while the field pin stays server-set.
          const definitiveMessage =
            res.status === 409
              ? "이미 처리된 초대입니다. 대기 목록을 확인하세요."
              : res.status === 403
                ? "초대할 권한이 없습니다. 조직 소유자에게 요청하세요."
                : "입력 내용을 확인하세요.";
          setFailure(definitiveMessage);
        } else if (!res.ok) {
          setFailure("초대 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
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
      description="초대 링크는 발급 시 한 번만 표시됩니다. 역할과 적용 범위를 확인한 뒤 초대하세요."
      onClose={onClose}
      busy={submitting}
      canClose={canCloseInviteDialog}
      footer={
        <ConsoleFormActions>
          {agencyStaged ? null : (
            <>
              <button type="button" className="button button-secondary" onClick={() => { if (canCloseInviteDialog()) onClose(); }} disabled={submitting}>
                취소
              </button>
              <button type="submit" form="invite-form" className="button button-primary" disabled={submitting}>
                {submitting ? "초대 중입니다" : "초대 링크 발급"}
              </button>
            </>
          )}
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
            disabled={submitting || agencyStaged !== null}
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
            disabled={submitting || agencyStaged !== null}
          />
        </div>
        <div className={consoleUiStyles.field}>
          <label htmlFor="invite-role">역할</label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => { setRole(event.target.value); setEventId(""); }}
            disabled={submitting || agencyStaged !== null}
          >
            <option value="AGENCY">조직 소유자</option>
            <option value="MANAGER">조직 구성원</option>
            <option value="STAFF">현장 스태프</option>
          </select>
        </div>
        {role === "AGENCY" ? (
          <p className={teamStyles.assignLead} role="note">
            조직 소유자는 이 운영사의 모든 행사·팀·설정을 관리할 수 있습니다. 행사 지정 없이 조직 전체 권한으로 초대됩니다.
          </p>
        ) : null}
        {role === "MANAGER" ? (
          <div className={consoleUiStyles.field}>
            <label htmlFor="invite-event">담당 행사 (선택)</label>
            <select
              id="invite-event"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
              disabled={submitting || agencyStaged !== null}
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
      {agencyStaged ? (
        <ConsoleConfirm
          summary={confirmLines(`${agencyStaged.name}(${agencyStaged.email})님을 조직 소유자로 초대합니다.\n\n조직 소유자는 이 운영사의 모든 행사·팀·설정을 관리할 수 있으며, 이 초대에는 행사를 지정하지 않았습니다.`)}
          confirmLabel="초대한다"
          busy={submitting}
          onConfirm={() => {
            const staged = agencyStaged;
            setAgencyStaged(null);
            if (staged) void sendInvite({ name: staged.name, email: staged.email, role: staged.role });
          }}
          onCancel={() => {
            if (submitGateRef.current || submitting) return;
            setAgencyStaged(null);
            pendingInviteRef.current = null;
          }}
        />
      ) : null}
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
  const [retryable, setRetryable] = useState(false);
  // Frozen revoke attempt: the id and body are fixed on first send and
  // replayed verbatim while the outcome stays unknown, so a 502/network
  // loss never strands an unresolvable central pending entry behind a
  // freshly minted id.
  const pendingRef = useRef<FrozenMembershipAttempt | null>(null);
  const revokingRef = useRef(false);
  // An unknown revoke outcome guards navigation until it resolves.
  useConsoleDraftGuard(
    pendingRef.current !== null || revoking,
    UNCONFIRMED_WRITE_CLOSE_MESSAGE
  );

  async function run(): Promise<void> {
    if (revokingRef.current || revoking) return;
    const hadUncertainAttempt = retryable && pendingRef.current !== null;
    revokingRef.current = true;
    setRevoking(true);
    setFailure(null);
    try {
      const fingerprint = JSON.stringify(["invitation.revoke", invitationId]);
      const stored = pendingRef.current;
      const isRetry = stored !== null && stored.fingerprint === fingerprint;
      const attempt: FrozenMembershipAttempt = isRetry
        ? stored
        : (() => {
            const commandId = randomCommandId();
            return { fingerprint, commandId, body: { commandId } };
          })();
      pendingRef.current = attempt;
      const res = await consoleFetch(`/api/auth/invitations/${encodeURIComponent(invitationId)}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown; invitation?: unknown } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "철회하지 못했습니다.";
        if (data?.code === "ORGANIZATION_CONTEXT_CHANGED") {
          if (isRetry) {
            // Prior outcome uncertain: keep the frozen id and body for the
            // same-key retry and point back at the original org.
            setRetryable(true);
            setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
          } else {
            // First attempt proven stale: nothing was written, so the id is
            // dropped. The row stays actionable for an explicit fresh try.
            pendingRef.current = null;
            setRetryable(false);
            setFailure("조직 정보가 바뀌었습니다. 최신 정보를 확인한 뒤 다시 시도하세요.");
          }
          return;
        }
        if (isDefinitiveClientError(res.status)) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure(serverMessage);
          return;
        }
        setFailure(`${serverMessage} 같은 요청으로 다시 시도하세요.`);
        setRetryable(true);
        return;
      }
      // Proven success echoes the revoked invitation back; anything else is
      // an unknown outcome, so the retry replays the same id.
      const revoked = typeof data?.invitation === "object" && data?.invitation !== null
        ? data.invitation as Record<string, unknown>
        : null;
      if (!revoked || revoked.id !== invitationId) {
        setFailure("응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      pendingRef.current = null;
      setRetryable(false);
      onDone();
    } catch (error) {
      if (isOrganizationContextBlock(error)) {
        if (!hadUncertainAttempt) {
          pendingRef.current = null;
          setRetryable(false);
          setFailure("조직 정보가 바뀌어 요청을 보내지 않았습니다. 최신 소속을 확인한 뒤 다시 시도하세요.");
          return;
        }
        // Only an earlier unknown result needs the frozen same-key replay.
        setFailure("조직 정보가 바뀌었습니다. 원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요.");
        setRetryable(true);
        return;
      }
      setFailure("연결하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      setRetryable(true);
    } finally {
      revokingRef.current = false;
      setRevoking(false);
    }
  }

  return (
    <span>
      <button
        type="button"
        className="button button-danger"
        disabled={revoking}
        onClick={() => void run()}
      >
        {revoking ? "철회 중입니다" : retryable ? "같은 요청으로 다시 시도" : "초대 철회"}
      </button>
      {failure ? <small role="alert" className={teamStyles.inlineAlert}> {failure}</small> : null}
    </span>
  );
}
