"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeNextPath } from "../auth-redirect";

function defaultHomeForRole(role: unknown): string {
  return role === "STAFF" ? "/staff" : "/console";
}

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedNext = searchParams.get("next");
  const safeRequested = safeNextPath(requestedNext);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function restoreSession() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          user?: { role?: unknown } | null;
        } | null;
        const role = data?.user?.role;
        if (!role) return;
        // Already signed in: honor the requested destination when it fits
        // the account, otherwise fall back to the role home.
        let destination = defaultHomeForRole(role);
        if (safeRequested) {
          if (role === "STAFF" && safeRequested.startsWith("/console")) {
            destination = "/staff";
          } else {
            destination = safeRequested;
          }
        }
        router.replace(destination);
      } catch {
        // Stay on the login form; the failure belongs to the sign-in attempt.
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    }
    restoreSession();
    return () => {
      cancelled = true;
    };
  }, [router, safeRequested]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        user?: { role?: unknown } | null;
      } | null;
      if (!res.ok) {
        setFailure(
          typeof data?.error === "string"
            ? data.error
            : "로그인하지 못했습니다"
        );
        return;
      }
      const role = data?.user?.role;
      let destination = defaultHomeForRole(role);
      if (safeRequested) {
        // STAFF accounts work from the assignment hub, not the operator
        // console. Other roles keep the requested deep link; the target
        // screen still enforces its own access server-side.
        destination =
          role === "STAFF" && safeRequested.startsWith("/console")
            ? "/staff"
            : safeRequested;
      }
      router.push(destination);
      router.refresh();
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingSession) {
    return <p className="loading-state" role="status">로그인 상태를 확인하고 있습니다.</p>;
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <div className="form-field">
        <label htmlFor="login-email">이메일</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor="login-password">비밀번호</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {failure ? <p role="alert">{failure}</p> : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "로그인 중입니다" : "로그인"}
      </button>
      <p className="auth-help">비밀번호를 잊으셨나요? 조직 관리자에게 재설정을 요청하세요.</p>
    </form>
  );
}
