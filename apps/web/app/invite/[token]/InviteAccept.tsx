"use client";

import { useState } from "react";
import Link from "next/link";
import { loginHref } from "../../auth-redirect";

type Invitation = {
  name: string;
  email: string;
  role: string;
  eventId: string | null;
  status: string;
  expiresAt: string;
};

function roleLabel(role: string): string {
  if (role === "MANAGER") return "운영사 구성원";
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

export default function InviteAccept({ token, invitation }: { token: string; invitation: Invitation }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

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
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setFailure(typeof data?.error === "string" ? data.error : "초대를 수락하지 못했습니다.");
        return;
      }
      setAccepted(true);
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  if (accepted) {
    const loginHrefValue = loginHref(loginNextForRole(invitation.role, invitation.eventId));
    return (
      <section className="ticket-card ticket-message">
        <h1>초대를 수락했습니다</h1>
        <p>{invitation.name}님, 이 계정으로 로그인하세요.</p>
        <p>{nextStepHint(invitation.role, invitation.eventId)}</p>
        <p>
          <Link className="button button-primary" href={loginHrefValue}>로그인으로</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="ticket-card">
      <p className="eyebrow">팀 초대 수락</p>
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
