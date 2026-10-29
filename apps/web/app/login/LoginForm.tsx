"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeNextPath, chooseOrganizationHref } from "../auth-redirect";
import { resetOperatorContext } from "../../lib/operator-context";
import styles from "../auth-entry.module.css";

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
  const failureRef = useRef<HTMLParagraphElement>(null);
  const [submitting, setSubmitting] = useState(false);  const [checkingSession, setCheckingSession] = useState(true);
  // A slow or hung /auth/me must never trap the operator on a spinner: the
  // form stays usable and only this flag offers a same-context recheck.
  const [sessionStale, setSessionStale] = useState(false);
  const [sessionCheck, setSessionCheck] = useState(0);
  // Monotonic epoch for the sign-in race: a session read that started before
  // the operator's own submit must not override that submit's navigation.
  const loginEpochRef = useRef(0);
  // Synchronous double-click guard: `submitting` state lands a render late,
  // so two rapid submits would otherwise both pass the `if (submitting)`
  // check in the same tick.
  const submitGateRef = useRef(false);
  const [setupState, setSetupState] = useState<"checking" | "ready" | "required" | "unknown">("checking");
  const [setupCheck, setSetupCheck] = useState(0);
  const [administrator, setAdministrator] = useState<{ name: string; email: string } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  // A failed sign-in moves keyboard focus to the error summary so screen
  // reader and keyboard operators land on the recovery message at once.
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

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
    const controller = new AbortController();
    let cancelled = false;
    // The session read that this effect started with: if the operator
    // submits while it is still pending, the epoch moves on and this stale
    // read must not redirect over the fresh sign-in.
    const epochAtStart = loginEpochRef.current;
    setCheckingSession(true);
    setSessionStale(false);
    // 10s ceiling: a hung /auth/me (mock or network) resolves into a stale
    // flag with a retry, never into an endless spinner that blocks the form.
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    async function restoreSession() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store", signal: controller.signal });
        if (cancelled) return;
        if (loginEpochRef.current !== epochAtStart) return;
        if (!res.ok) {
          // Authenticated but org-less (403 NO_ORGANIZATION_MEMBERSHIP):
          // the session is valid, only org context is missing. Route once
          // to the explicit picker like the null-role case instead of
          // idling on the login form, where another sign-in cannot help.
          if (!cancelled && loginEpochRef.current === epochAtStart && res.status === 403) {
            const denied = (await res.json().catch(() => null)) as { code?: unknown } | null;
            if (denied?.code === "NO_ORGANIZATION_MEMBERSHIP") {
              // Epoch guard above already ran: a late stale read cannot
              // reach here to clear a fresh sign-in. Drop the pinned
              // tab context first — it survives AppRouter navigation, and
              // the previous org/role/user must not seed the picker route.
              // The reset broadcasts; other tabs revalidate with forms intact.
              resetOperatorContext();
              router.replace(chooseOrganizationHref(safeRequested));
            }
          }
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          user?: { role?: unknown } | null;
        } | null;
        if (cancelled || loginEpochRef.current !== epochAtStart) return;
        const user = data?.user ?? null;
        const role = typeof user?.role === "string" ? user.role : "";
        if (!user || !role) {
          // Authenticated but org-unselected (multi-membership): never loop
          // back to the login form — hand off once to the explicit org
          // picker, keeping a safe requested invite so join can resume.
          if (!cancelled && loginEpochRef.current === epochAtStart && user && !role) {
            resetOperatorContext();
            router.replace(chooseOrganizationHref(safeRequested));
          }
          return;
        }
        // Already signed in: honor the requested destination when it fits
        // the account, otherwise fall back to the role home. The pinned
        // tab context is dropped first for the same reason as above.
        let destination = defaultHomeForRole(role);
        if (safeRequested) {
          if (role === "STAFF" && safeRequested.startsWith("/console")) {
            destination = "/staff";
          } else {
            destination = safeRequested;
          }
        }
        resetOperatorContext();
        router.replace(destination);
      } catch {
        // Stay on the login form; the failure belongs to the sign-in attempt.
        // Only a transport-level failure (abort/timeout included) offers a
        // recheck: a clean non-OK response simply means "not signed in".
        if (!cancelled && loginEpochRef.current === epochAtStart) setSessionStale(true);
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setCheckingSession(false);
      }
    }
    restoreSession();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [router, safeRequested, sessionCheck]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || submitting) return;
    submitGateRef.current = true;
    // Move the epoch so a still-pending /auth/me read can no longer
    // redirect over this submit's navigation.
    loginEpochRef.current += 1;
    setSubmitting(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        setupRequired?: unknown;
        user?: { role?: unknown } | null;
      } | null;
      if (!res.ok) {
        if (data?.setupRequired === true) {
          setPassword("");
          setSetupState("required");
          return;
        }
        // Server wording is never rendered: the status decides a fixed,
        // actionable message instead of leaking internal reasons.
        setFailure(
          res.status === 401
            ? "이메일 또는 비밀번호가 일치하지 않습니다. 다시 확인하세요."
            : res.status === 429
              ? "로그인 시도를 너무 많이 했습니다. 잠시 후 다시 시도하세요."
              : "로그인하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        );
        return;
      }
      const user = data?.user ?? null;
      const role = typeof user?.role === "string" ? user.role : "";
      // Authenticated without a selected org (multi-membership): the
      // explicit org picker owns the next step, never another login. A
      // safe requested invite survives so the join flow can resume.
      let destination = defaultHomeForRole(role);
      if (user && !role) {
        destination = chooseOrganizationHref(safeRequested);
      } else if (safeRequested) {
        // STAFF accounts work from the assignment hub, not the operator
        // console. Other roles keep the requested deep link; the target
        // screen still enforces its own access server-side.
        destination =
          role === "STAFF" && safeRequested.startsWith("/console")
            ? "/staff"
            : safeRequested;
      }
      // Epoch already moved at submit start, so a still-pending /auth/me
      // read cannot land after this and clear the fresh context. Drop the
      // pinned tab context first: it survives AppRouter navigation, and
      // the previous org/global role must not seed the new login route.
      resetOperatorContext();
      router.push(destination);
      router.refresh();
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      submitGateRef.current = false;
      setSubmitting(false);
    }
  }

  if (setupState === "checking") {
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
    <>
      {checkingSession ? (
        <p className="auth-help" role="status">로그인 상태를 확인하고 있습니다. 입력은 바로 시작할 수 있습니다.</p>
      ) : null}
      {sessionStale && !checkingSession ? (
        <p className="auth-session-stale" role="status">
          세션 확인이 끝나지 않았습니다. 로그인은 계속할 수 있습니다.{" "}
          <button
            type="button"
            className="auth-help-link"
            onClick={() => setSessionCheck((value) => value + 1)}
          >
            세션 다시 확인
          </button>
        </p>
      ) : null}
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
      {failure ? <p role="alert" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
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
        <div className={`auth-reset-help ${styles.loginReset}`} id="login-reset-help" role="region" aria-label="비밀번호 재설정 안내">
          <p>
            이메일을 미리 인증했다면 발송 연결 후{" "}
            <a href="/recover">이메일로 직접 재설정</a>할 수 있습니다.
          </p>
          <p>
            한 조직에만 속한 계정은 조직 관리자에게 재설정을 요청할 수 있습니다.
            여러 조직에 속한 계정은 한 조직의 관리자가 재설정할 수 없습니다.
          </p>
          {administrator ? (
            <p>
              설정된 관리자 연락처:{" "}
              <a href={`mailto:${administrator.email}`}>{administrator.email}</a>
            </p>
          ) : (
            <p>등록된 관리자 연락처가 없습니다. 조직 관리자에게 직접 문의하세요.</p>
          )}
          <p>
            인증하지 않은 채 잠긴 계정은 별도 본인확인 절차가 정해질 때까지
            조직 관리자에게 문의하세요.
          </p>
        </div>
      ) : null}
    </form>
    </>
  );
}
