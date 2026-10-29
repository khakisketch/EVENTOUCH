"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

// Logged-out password reset by verified email ("이메일+수동 예외").
//
// Two modes in one page. Without a token the page takes an address and always
// answers the same generic guidance — the anonymous endpoint never says which
// addresses qualify. Its `delivery` flag describes GLOBAL send capability
// only (unconfigured provider, missing public base): when sending is
// impossible the page says so honestly instead of promising a mail that
// cannot go out. With a `#t=` fragment link the page takes a new password;
// the token moves into tab memory and the fragment is stripped at once (a
// fragment never reaches the server, proxy logs, or Referer in the first
// place), then travels in the confirm POST body only.
//
// Every non-success from confirm shares one message: invalid, expired, used,
// and deactivated links are indistinguishable by design. A used link after a
// lost response is therefore also generic — the ground truth is trying the
// new password on the login screen, which the success and failure panels both
// point at. No storage, no enumeration, no server wording rendered verbatim.
export default function RecoverForm() {
  const [token, setToken] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const [email, setEmail] = useState("");
  const [requested, setRequested] = useState(false);
  const [deliveryDown, setDeliveryDown] = useState(false);
  const [deliveryMock, setDeliveryMock] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [offerLogin, setOfferLogin] = useState(false);
  const [working, setWorking] = useState(false);
  const gateRef = useRef(false);
  const failureRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  // Read the link fragment once, keep it in tab memory, and strip it from
  // the address bar at once so history, screenshots, and shoulder-surfed
  // URLs stop carrying the bearer. Fragments never leave the client, so the
  // server, the Next/proxy access line, and the Referer never see the token.
  // A hashchange listener covers same-tab mailed-link clicks, which do not
  // remount the page (the strip below fires no hashchange of its own).
  useEffect(() => {
    const read = () => {
      const match = /^#t=([A-Za-z0-9_-]{32,128})$/.exec(window.location.hash);
      if (match) {
        // A fresh token always returns to confirm mode: after a success, a
        // reused link must face the server verdict (generic denial for a
        // consumed link), not replay the old success panel.
        setToken(match[1]);
        setDone(false);
        setRequested(false);
        setPassword("");
        setConfirm("");
        setFailure(null);
        setOfferLogin(false);
        window.history.replaceState(null, "", "/recover");
      } else if (window.location.hash) {
        window.history.replaceState(null, "", "/recover");
      }
    };
    read();
    setTokenReady(true);
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  async function onRequest(event: React.FormEvent) {
    event.preventDefault();
    await postRequest();
  }

  async function postRequest() {
    if (gateRef.current || working) return;
    gateRef.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/recovery/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.status === 429) {
        setFailure("요청이 많습니다. 잠시 후 다시 시도하세요.");
        return;
      }
      // Any other non-200 (500, gateway failure, malformed body) is a
      // retryable transport failure — never a success panel.
      if (!res.ok) {
        setFailure("요청을 접수하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        ok?: unknown;
        delivery?: { connected?: unknown; mode?: unknown };
      } | null;
      if (!data || data.ok !== true || typeof data.delivery?.connected !== "boolean") {
        setFailure("요청을 접수하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
        return;
      }
      // The delivery flag is global capability only — it never reveals this
      // address — so an unconfigured provider gets an honest panel, not a
      // fake promise. A connected flag is NOT proof of arrival (the send can
      // still fail or be rate-capped server-side), so the copy promises a
      // received request, never a delivered mail, and always offers a retry.
      const delivery = data?.delivery;
      setDeliveryDown(delivery?.connected !== true);
      setDeliveryMock(delivery?.mode === "mock");
      setRequested(true);
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      gateRef.current = false;
      setWorking(false);
    }
  }

  async function onConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (gateRef.current || working || !token) return;
    if (password !== confirm) {
      setFailure("비밀번호가 일치하지 않습니다.");
      return;
    }
    gateRef.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/recovery/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.status === 429) {
        setFailure("요청이 많습니다. 잠시 후 다시 시도하세요.");
        return;
      }
      if (!res.ok) {
        setFailure(res.status >= 500
          ? "비밀번호 변경 결과를 확인하지 못했습니다. 새 비밀번호가 적용됐는지 로그인해 확인해 보세요."
          : "복구 링크를 확인하세요. 만료되었거나 이미 사용된 링크는 다시 요청해야 합니다. 새 비밀번호가 맞는지 로그인을 직접 확인해 보세요.");
        setOfferLogin(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (data?.ok !== true) {
        setFailure("비밀번호 변경 결과를 확인하지 못했습니다. 새 비밀번호가 적용됐는지 로그인해 확인해 보세요.");
        setOfferLogin(true);
        return;
      }
      setPassword("");
      setConfirm("");
      setToken(null);
      setDone(true);
    } catch {
      setFailure("연결하지 못했습니다. 새 비밀번호가 적용됐는지 로그인을 직접 확인해 보세요.");
      setOfferLogin(true);
    } finally {
      gateRef.current = false;
      setWorking(false);
    }
  }

  function requestAgain() {
    setToken(null);
    setPassword("");
    setConfirm("");
    setFailure(null);
    setOfferLogin(false);
    setRequested(false);
  }

  if (!tokenReady) {
    return <p className="loading-state" role="status">재설정 화면을 불러오고 있습니다.</p>;
  }

  if (done) {
    return (
      <div className="auth-form">
        <p role="status">비밀번호를 바꿨습니다. 모든 기기에서 로그아웃되었으니 새 비밀번호로 로그인하세요.</p>
        <p className="auth-help">
          <Link href="/login">로그인으로 이동</Link>
        </p>
      </div>
    );
  }

  if (token) {
    return (
      <form className="auth-form" onSubmit={onConfirm}>
        <p className="auth-help" role="status">
          메일의 링크를 확인했습니다. 새 비밀번호를 입력하면 모든 기기에서 로그아웃됩니다.
        </p>
        <div className="form-field">
          <label htmlFor="recover-password">새 비밀번호 (8자 이상)</label>
          <input
            id="recover-password"
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
          <label htmlFor="recover-password-confirm">새 비밀번호 확인</label>
          <input
            id="recover-password-confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-describedby={failure ? "recover-confirm-error" : undefined}
            required
          />
        </div>
        {failure ? <p role="alert" id="recover-confirm-error" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
        <button type="submit" disabled={working}>
          {working ? "바꾸는 중입니다" : "비밀번호 바꾸기"}
        </button>
        <p className="auth-help">
          링크가 동작하지 않나요?{" "}
          <button type="button" className="auth-help-link" onClick={requestAgain}>
            새 복구 메일 요청
          </button>
        </p>
        {offerLogin && failure ? (
          <p className="auth-help">
            <Link href="/login" target="_blank" rel="noopener noreferrer">
              새 비밀번호로 로그인 확인 (새 탭)
            </Link>
          </p>
        ) : null}
      </form>
    );
  }

  if (requested) {
    if (deliveryDown) {
      return (
        <div className="auth-form">
          <p role="alert" ref={failureRef} tabIndex={-1}>
            현재 이메일 발송이 설정되지 않아 복구 메일을 보낼 수 없습니다. 조직 관리자에게 문의하세요.
          </p>
          <p className="auth-help">
            사전에 인증하지 않은 채 잠긴 계정은 별도 본인확인 절차가 정해질 때까지
            조직 관리자에게 문의하세요.
          </p>
          <p className="auth-help">
            <Link href="/login">로그인으로 돌아가기</Link>
          </p>
        </div>
      );
    }
    return (
      <div className="auth-form">
        <p role="status">
          복구 메일 요청을 접수했습니다. 사전에 인증된 이메일이고 발송이 가능한 경우 링크를 보내드립니다. 링크는 30분 동안 한 번만 쓸 수 있습니다.
        </p>
        {deliveryMock ? (
          <p className="auth-help" role="note">
            모의 발송 모드: 실제 메일이 발송되지 않습니다. 개발·검증용 화면입니다.
          </p>
        ) : null}
        {failure ? <p role="alert" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
        <p className="auth-help">
          메일이 오지 않으면 스팸함을 확인한 뒤 아래에서 다시 요청하세요. 이메일을
          인증하지 않은 채 잠긴 계정은 별도 본인확인 절차가 정해질 때까지 조직
          관리자에게 문의하세요.
        </p>
        <p className="auth-help">
          <button
            type="button"
            className="auth-help-link"
            disabled={working}
            onClick={() => { void postRequest(); }}
          >
            {working ? "요청 중입니다" : "복구 메일 다시 요청"}
          </button>
        </p>
        <p className="auth-help">
          <Link href="/login">로그인으로 돌아가기</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={onRequest}>
      <p className="auth-help" role="status">
        사전에 이메일 인증을 마친 계정만 직접 재설정할 수 있습니다. 인증하지 않은
        계정은 복구 메일이 가지 않습니다.
      </p>
      <div className="form-field">
        <label htmlFor="recover-email">계정 이메일</label>
        <input
          id="recover-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={failure ? "recover-request-error" : undefined}
          required
        />
      </div>
      {failure ? <p role="alert" id="recover-request-error" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
      <button type="submit" disabled={working}>
        {working ? "요청 중입니다" : "복구 메일 요청"}
      </button>
      <p className="auth-help">
        <Link href="/login">로그인으로 돌아가기</Link>
      </p>
    </form>
  );
}
