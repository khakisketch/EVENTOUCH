"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import OrganizationSwitcher from "../../OrganizationSwitcher";
import { loginHref } from "../../auth-redirect";

type Invitation = {
  name: string;
  email: string;
  role: string;
  eventId: string | null;
  status: string;
  expiresAt: string;
  requiresSignIn: boolean;
};

function roleLabel(role: string): string {
  if (role === "MANAGER") return "조직 구성원";
  if (role === "STAFF") return "현장 스태프";
  return "상태 확인 필요";
}

// Where the login form should send the new account next. STAFF accounts work
// from the assignment hub, never the operator console; a MANAGER invited to
// a specific event returns there, otherwise to the console. The destination
// itself rechecks role and assignment server-side. STAFF invitations never
// carry an event (the server rejects them), so no assignment is fabricated
// here — desk/booth placement stays with the operator.
function loginNextForRole(role: string, eventId: string | null): string {
  if (role === "STAFF") return "/staff";
  if (role === "MANAGER" && eventId && /^[A-Za-z0-9_-]{1,120}$/.test(eventId)) {
    return `/console/events/${eventId}`;
  }
  return "/console";
}

function nextStepHint(role: string, eventId: string | null): string {
  if (role === "STAFF") return "수락 후 로그인하면 운영자가 배정한 업무 목록으로 이동합니다. 아직 배정되지 않았다면 대기 상태로 표시됩니다.";
  if (role === "MANAGER" && eventId) return "수락 후 로그인하면 담당 행사로 이동합니다.";
  if (role === "MANAGER") return "수락 후 로그인하면 운영 콘솔로 이동합니다.";
  return "수락 후 로그인하세요.";
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export default function InviteAccept({ token, invitation }: { token: string; invitation: Invitation }) {
  // New-account flow (requiresSignIn === false): the password form below is
  // the only writer, byte-identical to the existing contract.
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // Existing-account flow (requiresSignIn === true): no password is ever
  // asked for or overwritten. undefined = session still checking,
  // null = not signed in, string = signed-in email. noMembership marks the
  // 403 NO_ORGANIZATION_MEMBERSHIP case: a valid session with zero orgs,
  // where only the server-side accept can validate the invited email.
  const [sessionEmail, setSessionEmail] = useState<string | null | undefined>(
    invitation.requiresSignIn ? undefined : null
  );
  const [noMembership, setNoMembership] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptFailure, setAcceptFailure] = useState<string | null>(null);
  const [loginRequired, setLoginRequired] = useState(false);
  const [acceptedOrg, setAcceptedOrg] = useState<{ organizationId: string; organizationName: string } | null>(null);

  useEffect(() => {
    if (!invitation.requiresSignIn) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          setNoMembership(false);
          setSessionEmail(null);
          return;
        }
        if (res.status === 403) {
          // Logged in but org-less: the session is valid, only the org
          // context is missing. The server answers 403 +
          // NO_ORGANIZATION_MEMBERSHIP with the identity, so the accept
          // below can still be validated server-side. Never bounce to
          // login here: signing in again cannot create what login never
          // mints, so that link would only loop.
          const denied = (await res.json().catch(() => null)) as {
            code?: unknown;
            user?: { email?: unknown } | null;
          } | null;
          if (cancelled) return;
          if (denied?.code === "NO_ORGANIZATION_MEMBERSHIP") {
            const email = typeof denied?.user?.email === "string" ? denied.user.email : "";
            setNoMembership(true);
            setSessionEmail(email || null);
            return;
          }
          setNoMembership(false);
          setSessionEmail(null);
          return;
        }
        if (!res.ok) {
          setNoMembership(false);
          setSessionEmail(null);
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          user?: { email?: unknown } | null;
        } | null;
        if (cancelled) return;
        const email = typeof data?.user?.email === "string" ? data.user.email : "";
        setNoMembership(false);
        setSessionEmail(email || null);
      } catch {
        if (!cancelled) {
          setNoMembership(false);
          setSessionEmail(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invitation.requiresSignIn, invitation.email]);

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
      const res = await fetch(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        // Server wording is never rendered: the status decides a fixed,
        // actionable message instead of leaking internal reasons.
        setFailure(
          res.status === 410
            ? "이 초대 링크가 만료되었습니다. 운영자에게 새 초대를 요청하세요."
            : res.status === 404
              ? "초대 링크를 확인할 수 없습니다. 링크를 다시 확인하거나 운영자에게 문의하세요."
              : res.status === 409
                ? "이미 처리된 초대입니다. 로그인 후 소속을 확인하세요."
                : "초대를 수락하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        );
        return;
      }
      setAccepted(true);
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  async function acceptExistingAccount() {
    if (accepting) return;
    setAccepting(true);
    setAcceptFailure(null);
    setLoginRequired(false);
    try {
      // Existing global accounts join with their own login: the stored
      // password is never overwritten, so no password travels here.
      const res = await fetch(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => null)) as {
        code?: unknown;
        account?: { organizationId?: unknown; organizationName?: unknown } | null;
      } | null;
      if (!res.ok) {
        // Server wording is never rendered: the machine code and the
        // status decide a fixed message instead of leaking internals.
        if (res.status === 409 && data?.code === "INVITATION_LOGIN_REQUIRED") {
          // Same recovery as the fresh link: sign in with the invited
          // email, then return to this exact token.
          setLoginRequired(true);
          setAcceptFailure("로그인이 필요합니다. 초대받은 이메일로 로그인한 뒤 같은 링크에서 다시 수락하세요.");
          return;
        }
        setAcceptFailure(
          res.status === 410
            ? "이 초대 링크가 만료되었습니다. 운영자에게 새 초대를 요청하세요."
            : res.status === 404
              ? "초대 링크를 확인할 수 없습니다. 링크를 다시 확인하거나 운영자에게 문의하세요."
              : res.status === 409
                ? "이미 처리된 초대입니다. 로그인 후 소속을 확인하세요."
                : "초대를 수락하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        );
        return;
      }
      const account = data?.account;
      setAcceptedOrg({
        organizationId: typeof account?.organizationId === "string" ? account.organizationId : "",
        organizationName: typeof account?.organizationName === "string" ? account.organizationName : "",
      });
    } catch {
      setAcceptFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setAccepting(false);
    }
  }

  if (accepted) {
    const loginHrefValue = loginHref(loginNextForRole(invitation.role, invitation.eventId));
    return (
      <section className="auth-card invite-card" aria-label="팀 초대 수락">
        <h1>초대를 수락했습니다</h1>
        <p>{invitation.name}님, 이 계정으로 로그인하세요.</p>
        <p>{nextStepHint(invitation.role, invitation.eventId)}</p>
        <p>
          <Link className="button button-primary" href={loginHrefValue}>로그인으로</Link>
        </p>
      </section>
    );
  }

  if (invitation.requiresSignIn) {
    if (acceptedOrg) {
      return (
        <section className="auth-card invite-card" aria-label="팀 초대 수락">
          <h1>초대를 수락했습니다</h1>
          <p>
            {acceptedOrg.organizationName
              ? `${invitation.name}님을 ${acceptedOrg.organizationName} 소속으로 추가했습니다.`
              : `${invitation.name}님을 초대 조직의 소속으로 추가했습니다.`}
          </p>
          <p>계속할 조직을 직접 선택하세요. 자동으로 이동하지 않습니다.</p>
          {acceptedOrg.organizationId ? (
            <OrganizationSwitcher suggestedOrganizationId={acceptedOrg.organizationId} />
          ) : (
            <p>
              <Link className="button button-primary" href="/console?chooseOrganization=1">조직 선택으로 이동</Link>
            </p>
          )}
        </section>
      );
    }
    const matched =
      typeof sessionEmail === "string" && sessionEmail !== "" && sameEmail(sessionEmail, invitation.email);
    // 403 without a usable email is near-impossible (the server always
    // sends the identity), but the accept itself is server-validated, so
    // attempt it rather than stranding the operator or looping to login.
    const unknownIdentity = noMembership && sessionEmail === null;
    const acceptControls = (
      <>
        {acceptFailure ? <p role="alert">{acceptFailure}</p> : null}
        {loginRequired ? (
          <p>
            <Link className="button button-primary" href={loginHref(`/invite/${token}`)}>로그인으로</Link>
          </p>
        ) : (
          <button type="button" className="button button-primary" disabled={accepting} onClick={() => void acceptExistingAccount()}>
            {accepting ? "수락 중입니다" : "초대 수락"}
          </button>
        )}
      </>
    );
    return (
      <section className="auth-card invite-card" aria-label="팀 초대 수락">
        <h1>{invitation.name}님을 초대했습니다</h1>
        <p>
          {invitation.email} · {roleLabel(invitation.role)}
        </p>
        {sessionEmail === undefined ? (
          <p role="status">로그인 상태를 확인하고 있습니다.</p>
        ) : unknownIdentity ? (
          <>
            <p>
              로그인 상태는 확인됐지만 계정 정보를 읽지 못했습니다. 초대 이메일({invitation.email})과
              같은 계정으로 수락을 시도하며, 다르면 서버에서 거부됩니다.
            </p>
            {acceptControls}
          </>
        ) : sessionEmail === null || sessionEmail === "" ? (
          <>
            <p>
              이 초대는 이미 등록된 이메일({invitation.email})의 것입니다. 새 비밀번호를 만들지 않고,
              해당 계정으로 로그인한 뒤 이 자리에서 수락하세요. 기존 비밀번호는 그대로 유지됩니다.
            </p>
            <p>
              <Link className="button button-primary" href={loginHref(`/invite/${token}`)}>로그인으로</Link>
            </p>
          </>
        ) : !matched ? (
          <>
            <p>
              현재 {sessionEmail} 계정으로 로그인되어 있습니다. 초대받은 이메일({invitation.email})과
              같은 계정으로 로그인한 뒤 수락하세요.
            </p>
            <p>
              <Link className="button button-primary" href={loginHref(`/invite/${token}`)}>다른 계정으로 로그인</Link>
            </p>
          </>
        ) : (
          <>
            <p>{nextStepHint(invitation.role, invitation.eventId)} 수락 후 계속할 조직을 직접 선택합니다.</p>
            {noMembership ? (
              <p>
                현재 계정에 소속된 조직이 없습니다. 초대 이메일과 로그인 계정의 일치는
                서버에서 확인하므로, 수락하면 이 초대 조직에 소속됩니다.
              </p>
            ) : null}
            {acceptControls}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="auth-card invite-card" aria-label="팀 초대 수락">
      <h1>{invitation.name}님을 초대했습니다</h1>
      <p>
        {invitation.email} · {roleLabel(invitation.role)}
      </p>
      <p>{nextStepHint(invitation.role, invitation.eventId)}</p>
      <form className="registration-form" onSubmit={onSubmit}>
        <div className="form-field">
          <label htmlFor="invite-password">비밀번호 (8자 이상)</label>
          <input
            id="invite-password"
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
          <label htmlFor="invite-confirm">비밀번호 확인</label>
          <input
            id="invite-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>
        {failure ? <p role="alert">{failure}</p> : null}
        <button type="submit" className="button button-primary" disabled={submitting}>
          {submitting ? "수락 중입니다" : "초대 수락"}
        </button>
      </form>
    </section>
  );
}
