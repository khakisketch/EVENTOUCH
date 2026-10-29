"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

// The holder's own mailbox proof ("이메일+수동 예외"의 자동 복구 절반).
//
// A signed-in holder requests a link to their OWN stored address (the server
// re-checks the current password first and never redirects mail elsewhere),
// then confirms the mailed token here while still signed in as the same
// account. Only then may the address receive future recovery mail. Invitation
// acceptance never counts: invitation links are bearer-delivered without
// mailbox proof, so every account starts unverified.
//
// Honest states, never a dead end without a reason: delivery-off shows the
// 503 EMAIL_NOT_CONFIGURED as a disabled panel (not a spinner, not a fake
// send); locked holders with no proven channel read the manual-process
// limitation instead of a promise. No storage, no org headers — this is
// global identity traffic on the holder's own account.
type Status =
  | { kind: "checking" }
  | { kind: "signin" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      verified: boolean;
      verifiedAt: string | null;
      emailMasked: string;
      deliveryConnected: boolean;
      deliveryMock: boolean;
    };

export default function EmailVerification() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [mailed, setMailed] = useState(false);
  const [confirmToken, setConfirmToken] = useState("");
  const [hasConfirmLink, setHasConfirmLink] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const gateRef = useRef(false);
  const failureRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  const refresh = useCallback(async () => {
    setStatus({ kind: "checking" });
    setFailure(null);
    try {
      const me = await fetch("/api/auth/me", { cache: "no-store" });
      if (me.status === 401) {
        setStatus({ kind: "signin" });
        return;
      }
      // Only a definitive auth denial signs out: a 500, gateway failure, or
      // any other transport problem is a retryable failure, never proof that
      // a healthy session is unauthenticated.
      if (!me.ok) {
        setStatus({ kind: "failed", message: "인증 상태를 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요." });
        return;
      }
      const res = await fetch("/api/auth/email/status", { cache: "no-store" });
      if (res.status === 401) {
        setStatus({ kind: "signin" });
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        verified?: unknown;
        verifiedAt?: unknown;
        emailMasked?: unknown;
        delivery?: { connected?: unknown; mode?: unknown };
      } | null;
      if (!res.ok || !data) {
        // Transport/server failure is a retryable failure, not a signed-out
        // session: never present a healthy session as unauthenticated.
        setStatus({ kind: "failed", message: "인증 상태를 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요." });
        return;
      }
      setStatus({
        kind: "ready",
        verified: data.verified === true,
        verifiedAt: typeof data.verifiedAt === "string" ? data.verifiedAt : null,
        emailMasked: typeof data.emailMasked === "string" ? data.emailMasked : "",
        deliveryConnected: data.delivery?.connected === true,
        deliveryMock: data.delivery?.mode === "mock",
      });
    } catch {
      setStatus({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A mailed link lands here with a fragment bearer (#t=): move it into tab
  // memory and strip the fragment at once. Fragments never leave the client,
  // so the server, proxy logs, and Referer never see the token. A hashchange
  // listener covers same-tab mailed-link clicks, which do not remount the
  // page. Signed-out visitors are asked to sign in and reopen the original
  // link from their mailbox; the fragment is stripped from this tab too.
  useEffect(() => {
    const read = () => {
      const match = /^#t=([A-Za-z0-9_-]{32,128})$/.exec(window.location.hash);
      if (!match) {
        if (window.location.hash) {
          window.history.replaceState(null, "", "/account/email");
        }
        return;
      }
      setConfirmToken(match[1]);
      setHasConfirmLink(true);
      window.history.replaceState(null, "", "/account/email");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  async function onRequest(event: React.FormEvent) {
    event.preventDefault();
    if (gateRef.current || working) return;
    gateRef.current = true;
    setWorking(true);
    setFailure(null);
    setOutcome(null);
    try {
      const res = await fetch("/api/auth/email/verify/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: unknown; already?: unknown; error?: unknown; code?: unknown } | null;
      if (!res.ok) {
        setFailure(
          typeof data?.error === "string" ? data.error : "인증 메일을 보내지 못했습니다."
        );
        return;
      }
      if (data?.ok !== true) {
        setFailure("인증 메일 요청 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요.");
        return;
      }
      setCurrentPassword("");
      if (data.already === true) {
        setOutcome("이미 인증된 이메일입니다.");
        await refresh();
        return;
      }
      setMailed(true);
      setOutcome(status.kind === "ready" && status.deliveryMock
        ? "모의 인증 요청을 기록했습니다. 실제 메일은 발송되지 않습니다."
        : "인증 메일을 보냈습니다. 메일의 링크는 60분 안에 이 로그인 상태에서 열어주세요.");
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      gateRef.current = false;
      setWorking(false);
    }
  }

  async function onConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (gateRef.current || working || !confirmToken.trim()) return;
    gateRef.current = true;
    setWorking(true);
    setFailure(null);
    setOutcome(null);
    try {
      const res = await fetch("/api/auth/email/verify/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: confirmToken.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: unknown; verified?: unknown; error?: unknown } | null;
      if (!res.ok) {
        setFailure(
          typeof data?.error === "string" ? data.error : "인증 링크를 확인하세요."
        );
        return;
      }
      if (data?.ok !== true || data.verified !== true) {
        setFailure("이메일 인증 결과를 확인하지 못했습니다. 이 페이지를 다시 열어 인증 상태를 확인하세요.");
        return;
      }
      setConfirmToken("");
      setHasConfirmLink(false);
      setMailed(false);
      setOutcome("이메일 인증을 마쳤습니다.");
      await refresh();
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      gateRef.current = false;
      setWorking(false);
    }
  }

  if (status.kind === "checking") {
    return <p className="loading-state" role="status">인증 상태를 확인하고 있습니다.</p>;
  }

  if (status.kind === "signin") {
    return (
      <div className="auth-form">
        {failure ? <p role="alert" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
        <p className="auth-help" role="status">
          이메일 인증은 로그인한 본인만 할 수 있습니다. 먼저 로그인한 뒤 메일의
          링크를 다시 열어주세요.
        </p>
        <p className="auth-help">
          <Link href="/login">로그인으로 이동</Link>
        </p>
      </div>
    );
  }

  if (status.kind === "failed") {
    return (
      <div className="auth-form">
        <p role="alert" ref={failureRef} tabIndex={-1}>{status.message}</p>
        <p className="auth-help">
          로그인 상태는 그대로입니다. 네트워크 문제일 수 있으니 다시 확인하세요.
        </p>
        <button type="button" className="button button-secondary" onClick={() => { void refresh(); }}>
          인증 상태 다시 확인
        </button>
      </div>
    );
  }

  if (status.verified) {
    return (
      <div className="auth-form">
        {outcome ? <p role="status">{outcome}</p> : null}
        <p role="status">인증됨 · {status.emailMasked}</p>
        {status.verifiedAt ? (
          <p className="auth-help">인증 시각: {new Date(status.verifiedAt).toLocaleString("ko-KR")}</p>
        ) : null}
        <p className="auth-help">
          {!status.deliveryConnected
            ? "이 주소는 인증되었지만 이메일 발송이 설정되지 않아 지금은 복구 메일을 보낼 수 없습니다."
            : status.deliveryMock
              ? "모의 발송 모드입니다. 실제 복구 메일은 발송되지 않습니다."
              : "비밀번호를 잊으면 로그인 화면에서 이 주소로 복구 메일을 요청할 수 있습니다."}
        </p>
      </div>
    );
  }

  // Delivery is required to request a NEW mail, not to confirm one already
  // issued. Keep link mode even if the user edits the token field to empty.
  const showConfirm = mailed || hasConfirmLink || confirmToken !== "";

  if (!status.deliveryConnected && !showConfirm) {
    return (
      <div className="auth-form">
        <p role="alert" ref={failureRef} tabIndex={-1}>
          현재 이메일 발송이 설정되지 않아 인증 메일을 보낼 수 없습니다. 관리자에게 문의하세요.
        </p>
        <p className="auth-help">
          사전에 인증하지 않은 채 잠긴 계정은 별도 본인확인 절차가 정해질 때까지
          조직 관리자에게 문의하세요.
        </p>
      </div>
    );
  }

  return (
    <>
      {outcome ? <p role="status">{outcome}</p> : null}
      {!showConfirm ? (
        <form className="auth-form" onSubmit={onRequest}>
          <p className="auth-help" role="status">
            {status.emailMasked} 주소가 본인의 것인지 확인합니다. 현재 비밀번호를
            입력하면 이 주소로만 인증 메일이 갑니다. 초대를 수락한 것만으로는
            인증되지 않습니다.
          </p>
          <div className="form-field">
            <label htmlFor="verify-current-password">현재 비밀번호</label>
            <input
              id="verify-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              aria-describedby={failure ? "verify-request-error" : undefined}
              required
            />
          </div>
          {failure ? <p role="alert" id="verify-request-error" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
          <button type="submit" disabled={working}>
            {working ? "보내는 중입니다" : "인증 메일 보내기"}
          </button>
          {status.deliveryMock ? (
            <p className="auth-help" role="note">
              모의 발송 모드: 실제 메일이 발송되지 않습니다. 개발·검증용 화면입니다.
            </p>
          ) : null}
          <p className="auth-help">
            사전에 인증하지 않은 채 잠긴 계정은 별도 본인확인 절차가 정해질 때까지
            조직 관리자에게 문의하세요.
          </p>
        </form>
      ) : (
        <form className="auth-form" onSubmit={onConfirm}>
          <p className="auth-help" role="status">
            메일의 링크로 이 화면이 열렸다면 아래 버튼을 눌러 인증을 마치세요.
            토큰만 복사했다면 아래에 직접 입력해도 됩니다. 링크는 60분 동안
            한 번만 쓸 수 있습니다.
          </p>
          <div className="form-field">
            <label htmlFor="verify-token">인증 토큰</label>
            <input
              id="verify-token"
              type="text"
              autoComplete="off"
              inputMode="text"
              value={confirmToken}
              onChange={(event) => setConfirmToken(event.target.value)}
              aria-describedby={failure ? "verify-confirm-error" : undefined}
              required
            />
          </div>
          {failure ? <p role="alert" id="verify-confirm-error" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
          <button type="submit" disabled={working}>
            {working ? "확인 중입니다" : "이메일 인증하기"}
          </button>
          {status.deliveryConnected ? (
            <p className="auth-help">
              메일이 오지 않으면 스팸함을 확인한 뒤 잠시 후 다시 요청하세요.{" "}
              <button
                type="button"
                className="auth-help-link"
                onClick={() => {
                  setMailed(false);
                  setConfirmToken("");
                  setHasConfirmLink(false);
                  setFailure(null);
                  setOutcome(null);
                }}
              >
                다시 보내기
              </button>
            </p>
          ) : (
            <p className="auth-help">현재 이메일 발송을 사용할 수 없어 새 메일을 요청할 수 없습니다.</p>
          )}
        </form>
      )}
    </>
  );
}
