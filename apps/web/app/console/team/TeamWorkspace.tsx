"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { loginHrefForLocation } from "../../auth-redirect";
import styles from "./team.module.css";

type Account = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  orgOwner: boolean;
};

type TeamState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; accounts: Account[]; canManage: boolean; userId: string };

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
          state?: { accounts?: unknown } | null;
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
        if (!meResponse.ok || !userId) {
          setState({ kind: "failed", message: "팀 정보를 불러오지 못했습니다." });
          return;
        }
        setState({ kind: "ready", accounts, canManage, userId });
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

  if (state.kind === "loading") return <p className="loading-state" role="status">팀 정보를 불러오고 있습니다.</p>;
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
          다시 불러오기
        </button>
      </section>
    );
  }

  return (
    <div className="participants-content">
      <header>
        <p className="eyebrow">팀·권한</p>
        <h1>팀 관리</h1>
        <p className="overview-meta">비밀번호를 잊은 구성원은 조직 소유자가 재설정합니다. 재설정하면 다른 기기에서 모두 로그아웃됩니다.</p>
      </header>
      {notice ? <p className="state-success" role="status">{notice}</p> : null}
      {!state.canManage ? (
        <p className="notice" role="status">팀 관리 권한이 없습니다. 비밀번호 재설정은 조직 소유자에게 요청하세요.</p>
      ) : null}
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
      <p>
        <Link className="button button-secondary" href="/console">행사 목록으로</Link>
      </p>
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
