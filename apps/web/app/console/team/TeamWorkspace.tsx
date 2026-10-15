"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { loginHrefForLocation } from "../../auth-redirect";
import ConsolePageHeader from "../console-ui/ConsolePageHeader";
import ConsoleSection from "../console-ui/ConsoleSection";
import ConsoleStatePanel from "../console-ui/ConsoleStatePanel";
import OperationsPanels from "./OperationsPanels";
import styles from "./team.module.css";

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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default function TeamWorkspace() {
  const [state, setState] = useState<TeamState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issuedInvite, setIssuedInvite] = useState<{ name: string; link: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const pageHeader = (
    <ConsolePageHeader
      title="팀 관리"
      actions={<Link className="button button-secondary" href="/console">행사 목록으로</Link>}
    />
  );
  if (state.kind === "loading") {
    return (
      <div className={`${styles.workspace} participants-content`}>
        {pageHeader}
        <ConsoleStatePanel kind="loading" message="팀 정보를 불러오고 있습니다." onRetry={() => {}} />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className={`${styles.workspace} participants-content`}>
        {pageHeader}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </div>
    );
  }

  return (
    <div className={`${styles.workspace} participants-content`}>
      {pageHeader}
      <p className="overview-meta">비밀번호를 잊은 구성원은 조직 소유자가 재설정합니다. 재설정하면 다른 기기에서 모두 로그아웃됩니다.</p>
      {notice ? <p className="state-success" role="status">{notice}</p> : null}
      {!state.canManage ? (
        <p className="notice" role="status">팀 관리 권한이 없습니다. 비밀번호 재설정은 조직 소유자에게 요청하세요.</p>
      ) : null}
      {state.canInvite ? (
        <p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => { setNotice(null); setIssuedInvite(null); setInviteOpen(true); }}
          >
            구성원 초대
          </button>
        </p>
      ) : null}
      {state.canInvite && state.invitations.length ? (
        <ConsoleSection headingId="pending-invites" title="대기 중인 초대" className={styles.teamSection}>
          <ul className="participant-list" aria-label="대기 중인 초대 목록">
            {state.invitations.map((invitation) => (
              <li className="participant-row" key={invitation.id}>
                <span className="participant-summary">
                  {invitation.name} · {roleLabel(invitation.role)}
                  <br />
                  <small className={styles.accountEmail}>{invitation.email}</small>
                </span>
                <RevokeInviteButton
                  invitationId={invitation.id}
                  onDone={() => {
                    setNotice(`${invitation.name}님의 초대를 철회했습니다.`);
                    setReloadTick((tick) => tick + 1);
                  }}
                />
              </li>
            ))}
          </ul>
        </ConsoleSection>
      ) : state.canInvite ? (
        <ConsoleSection headingId="pending-invites" title="대기 중인 초대" className={styles.teamSection}>
          <p>대기 중인 초대가 없습니다.</p>
        </ConsoleSection>
      ) : null}
      <ConsoleSection headingId="team-members" title="구성원" className={styles.teamSection}>
        {state.accounts.length ? (
          <ul className="participant-list" aria-label="구성원 목록">
            {state.accounts.map((account) => (
              <li className="participant-row" key={account.id}>
                <span className="participant-summary">
                  {account.name} · {roleLabel(account.role)}
                  {account.active ? "" : " · 사용 중지"}
                  <br />
                  <small className={styles.accountEmail}>{account.email}</small>
                </span>
                {state.canManage ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => { setNotice(null); setResetTarget(account); }}
                  >
                    비밀번호 재설정
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>등록된 구성원이 없습니다.</p>
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
      {issuedInvite ? (
        <section className="state-panel" aria-label="발급된 초대 링크">
          <p role="status">초대 링크는 지금 한 번만 표시됩니다. 복사해서 전달하세요.</p>
          <p><code>{issuedInvite.link}</code></p>
          <p>
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
            </button>{" "}
            <button type="button" className="button button-secondary" onClick={() => setIssuedInvite(null)}>
              닫기
            </button>
          </p>
        </section>
      ) : null}
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
  const commandIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    passwordRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!submittingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select, textarea, a[href]"
        )
      ).filter((item) => item.tabIndex >= 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (password !== confirm) {
      setFailure("비밀번호가 일치하지 않습니다.");
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      const commandId = commandIdRef.current ?? randomCommandId();
      commandIdRef.current = commandId;
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(account.id)}/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, password }),
      });
      commandIdRef.current = null;
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        sessionsRevoked?: unknown;
      } | null;
      if (!res.ok) {
        setFailure(typeof data?.error === "string" ? data.error : "재설정하지 못했습니다.");
        return;
      }
      onDone(typeof data?.sessionsRevoked === "number" ? data.sessionsRevoked : 0);
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.backdrop} onClick={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="reset-title">
        <h2 id="reset-title">{account.name} 비밀번호 재설정</h2>
        <p>{account.email} · 다른 기기에서는 모두 로그아웃됩니다.</p>
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label htmlFor="reset-password">새 비밀번호 (8자 이상)</label>
            <input
              id="reset-password"
              ref={passwordRef}
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className="form-field">
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
          {failure ? <p role="alert">{failure}</p> : null}
          <div className={styles.actions}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={submitting}>
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? "재설정 중입니다" : "재설정"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
  const commandIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    nameRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!submittingRef.current) onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const commandId = commandIdRef.current ?? randomCommandId();
      commandIdRef.current = commandId;
      const res = await fetch("/api/auth/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          name: name.trim(),
          email: email.trim(),
          role,
          ...(role === "MANAGER" && eventId ? { eventId } : {}),
        }),
      });
      commandIdRef.current = null;
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        invitation?: { name?: unknown } | null;
        token?: unknown;
      } | null;
      if (!res.ok || typeof data?.token !== "string") {
        setFailure(typeof data?.error === "string" ? data.error : "초대하지 못했습니다.");
        return;
      }
      const inviteName = typeof data?.invitation?.name === "string" && data.invitation.name
        ? data.invitation.name
        : name.trim();
      onDone({
        name: inviteName,
        link: `${window.location.origin}/invite/${encodeURIComponent(data.token)}`,
      });
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.backdrop} onClick={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="invite-title">
        <h2 id="invite-title">구성원 초대</h2>
        <p>초대 링크는 발급 시 한 번만 표시됩니다. 현장 스태프는 수락 후 데스크·부스 배정으로 연결합니다.</p>
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label htmlFor="invite-name">이름</label>
            <input
              id="invite-name"
              ref={nameRef}
              type="text"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="form-field">
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
          <div className="form-field">
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
            <div className="form-field">
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
          {failure ? <p role="alert">{failure}</p> : null}
          <div className={styles.actions}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={submitting}>
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? "초대 중입니다" : "초대 링크 발급"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
  return (
    <span>
      <button
        type="button"
        className="button button-secondary"
        disabled={revoking}
        onClick={async () => {
          if (revoking) return;
          setRevoking(true);
          setFailure(null);
          try {
            const res = await fetch(`/api/auth/invitations/${encodeURIComponent(invitationId)}/revoke`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ commandId: randomCommandId() }),
            });
            const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
            if (!res.ok) {
              setFailure(typeof data?.error === "string" ? data.error : "철회하지 못했습니다.");
              return;
            }
            onDone();
          } catch {
            setFailure("연결하지 못했습니다. 다시 시도하세요.");
          } finally {
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
