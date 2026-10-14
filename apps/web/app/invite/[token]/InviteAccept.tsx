"use client";

import { useState } from "react";
import Link from "next/link";

type Invitation = {
  name: string;
  email: string;
  role: string;
  expiresAt: string;
};

function roleLabel(role: string): string {
  if (role === "MANAGER") return "운영사 구성원";
  if (role === "STAFF") return "현장 스태프";
  return "상태 확인 필요";
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
    return (
      <section className="ticket-card ticket-message">
        <h1>초대를 수락했습니다</h1>
        <p>{invitation.name}님, 이 계정으로 로그인하세요.</p>
        <p>
          <Link className="button button-primary" href="/staff/login">로그인으로</Link>
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
