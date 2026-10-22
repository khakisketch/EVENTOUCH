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
  const [setupState, setSetupState] = useState<"checking" | "ready" | "required" | "unknown">("checking");
  const [setupCheck, setSetupCheck] = useState(0);
  const [administrator, setAdministrator] = useState<{ name: string; email: string } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  // A locked-out operator is told to ask the organization administrator; the
  // contact is deployment-configured (never an arbitrary account row) and is
  // only shown when the server says an administrator exists.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/help", { cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => null) as {
          administrator?: { name?: unknown; email?: unknown } | null;
        } | null;
        if (cancelled || !response.ok) return;
        const email = typeof data?.administrator?.email === "string" ? data.administrator.email : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
        const name = typeof data?.administrator?.name === "string" && data.administrator.name.trim()
          ? data.administrator.name.trim()
          : "조직 관리자";
        setAdministrator({ name, email });
      } catch {
        // The generic message stays; the login form must never depend on it.
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setSetupState("checking");
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    void (async () => {
      try {
        const response = await fetch("/api/auth/setup-state", { cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => null) as { ready?: unknown; administratorConfigured?: unknown } | null;
        if (cancelled) return;
        if (response.ok && data?.ready === false && data.administratorConfigured === false) {
          setPassword("");
          setSetupState("required");
        } else {
          setSetupState(response.ok && data?.ready === true ? "ready" : "unknown");
        }
      } catch {
        if (!cancelled) setSetupState("unknown");
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [setupCheck]);

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
        setupRequired?: unknown;
        user?: { role?: unknown } | null;
      } | null;
      if (!res.ok) {
        if (data?.setupRequired === true) {
          setPassword("");
          setSetupState("required");
          return;
        }
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

  if (checkingSession || setupState === "checking") {
    return <p className="loading-state" role="status">로그인 상태를 확인하고 있습니다.</p>;
  }

  if (setupState === "required") {
    return (
      <section className="auth-form" aria-label="초기 운영자 설정 안내">
        <p role="alert">운영자 계정이 아직 설정되지 않았습니다.</p>
        <p className="auth-help">서버 관리자에게 초기 운영자 계정 설정을 요청하세요. 설정 후 다시 확인하면 로그인할 수 있습니다.</p>
        <button type="button" onClick={() => setSetupCheck((value) => value + 1)}>설정 상태 다시 확인</button>
      </section>
    );
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
      <p className="auth-help">
        비밀번호를 잊으셨나요?{" "}
        <button
          type="button"
          className="auth-help-link"
          aria-expanded={resetOpen}
          aria-controls="login-reset-help"
          onClick={() => setResetOpen((open) => !open)}
        >
          재설정 요청
        </button>
      </p>
      {resetOpen ? (
        <div className="auth-reset-help" id="login-reset-help" role="region" aria-label="비밀번호 재설정 안내">
          <p>조직 관리자에게 재설정을 요청하세요.</p>
          {administrator ? (
            <p>
              관리자 연락처:{" "}
              <a href={`mailto:${administrator.email}`}>{administrator.email}</a>
            </p>
          ) : (
            <p>등록된 관리자 연락처가 없습니다. 조직 관리자에게 직접 문의하세요.</p>
          )}
        </div>
      ) : null}
    </form>
  );
}
