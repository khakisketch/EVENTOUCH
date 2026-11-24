"use client";

import { useEffect, useRef, useState } from "react";
import ValidatedForm from "../../ui/ValidatedForm";
import ProductButton from "../../ui/ProductButton";
import ProductLink from "../../ui/ProductLink";
import { useUnsavedNavigationGuard } from "../../../lib/use-unsaved-navigation-guard";

// 내 비밀번호 직접 변경. 현재 비밀번호를 다시 확인하고, 성공하면 지금 쓰는 이
// 기기를 뺀 같은 계정의 다른 로그인을 모두 끊는다(서버가 처리). 결과를 받지
// 못한 요청은 같은 commandId로만 다시 보내 중복 처리 없이 결과를 확인한다.
// 비밀번호 값은 상태에만 두고 저장소·주소·로그에 남기지 않는다.
const MIN = 8;
const MAX = 200;

type Phase = "checking" | "signin" | "ready" | "done";

function newCommandId() {
  return `pw-${crypto.randomUUID().replace(/-/g, "")}`;
}

export default function PasswordChange() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [working, setWorking] = useState(false);
  const [revoked, setRevoked] = useState(0);
  const gateRef = useRef(false);
  const failureRef = useRef<HTMLParagraphElement>(null);
  // One id per intended change: kept while the result is unknown so a retry
  // is the same command, replaced when the input changes or the server said no.
  const commandRef = useRef<string>("");

  useUnsavedNavigationGuard(
    phase === "ready" && Boolean(currentPassword || newPassword || confirmPassword || working),
    "입력한 비밀번호는 저장되지 않습니다."
  );

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await fetch("/api/auth/me", { cache: "no-store" });
        if (!live) return;
        if (me.status === 401) setPhase("signin");
        else if (me.ok) setPhase("ready");
        else {
          setPhase("ready");
          setFailure("로그인 상태를 확인하지 못했습니다. 입력 후 변경할 때 다시 확인합니다.");
        }
      } catch {
        if (live) {
          setPhase("ready");
          setFailure("로그인 상태를 확인하지 못했습니다. 입력 후 변경할 때 다시 확인합니다.");
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  function edit(setter: (value: string) => void, value: string) {
    setter(value);
    // A different input is a different command.
    commandRef.current = "";
    setUncertain(false);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (gateRef.current || working) return;
    if (newPassword !== confirmPassword) {
      setFailure("새 비밀번호와 확인 입력이 다릅니다. 같은 비밀번호를 두 번 입력하세요.");
      return;
    }
    if (newPassword === currentPassword) {
      setFailure("새 비밀번호가 현재 비밀번호와 같습니다. 다른 비밀번호를 입력하세요.");
      return;
    }
    gateRef.current = true;
    setWorking(true);
    setFailure(null);
    if (!commandRef.current) commandRef.current = newCommandId();
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, commandId: commandRef.current }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: unknown; sessionsRevoked?: unknown; error?: unknown }
        | null;
      if (res.ok && data?.ok === true) {
        setRevoked(typeof data.sessionsRevoked === "number" ? data.sessionsRevoked : 0);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        commandRef.current = "";
        setUncertain(false);
        setPhase("done");
        return;
      }
      if (res.status === 401 && data?.error === "로그인이 필요합니다") {
        setPhase("signin");
        return;
      }
      if (!res.ok && res.status < 500 && res.status !== 408 && res.status !== 425) {
        // The server said no: nothing changed, the next attempt is a new command.
        commandRef.current = "";
        setUncertain(false);
        setFailure(typeof data?.error === "string" ? data.error : "비밀번호를 바꾸지 못했습니다.");
        return;
      }
      setUncertain(true);
      setFailure("변경 결과를 확인하지 못했습니다. 이미 바뀌었을 수 있습니다. 같은 입력으로 다시 시도하면 중복 없이 처리됩니다.");
    } catch {
      setUncertain(true);
      setFailure("변경 결과를 확인하지 못했습니다. 이미 바뀌었을 수 있습니다. 같은 입력으로 다시 시도하면 중복 없이 처리됩니다.");
    } finally {
      gateRef.current = false;
      setWorking(false);
    }
  }

  if (phase === "checking") {
    return <p className="loading-state" role="status">로그인 상태를 확인하고 있습니다.</p>;
  }

  if (phase === "signin") {
    return (
      <div className="auth-form">
        <p className="auth-help" role="status">
          비밀번호 변경은 로그인한 본인만 할 수 있습니다. 먼저 로그인하세요. 비밀번호를 잊었다면
          로그인 화면의 안내를 따르세요.
        </p>
        <p className="auth-help">
          <ProductLink href="/login">로그인으로 이동</ProductLink>
        </p>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="auth-form">
        <p role="status">비밀번호를 바꿨습니다.</p>
        <p className="auth-help">
          {revoked > 0
            ? `지금 쓰는 기기를 뺀 다른 로그인 ${revoked}곳은 로그아웃되었습니다. 다음 로그인부터 새 비밀번호를 입력하세요.`
            : "다른 기기에 열려 있던 로그인은 없었습니다. 다음 로그인부터 새 비밀번호를 입력하세요."}
        </p>
        <p className="auth-help">
          <ProductLink href="/console">콘솔로 돌아가기</ProductLink>
        </p>
      </div>
    );
  }

  return (
    <ValidatedForm className="auth-form" onSubmit={onSubmit}>
      <p className="auth-help">
        비밀번호를 바꾸면 지금 쓰는 기기를 뺀 같은 계정의 다른 로그인은 모두 로그아웃됩니다.
        비밀번호는 {MIN}자 이상 {MAX}자 이하로 입력하세요.
      </p>
      <div className="form-field">
        <label htmlFor="pw-current">현재 비밀번호</label>
        <input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => edit(setCurrentPassword, event.target.value)}
          readOnly={working}
          required
          maxLength={MAX}
        />
      </div>
      <div className="form-field">
        <label htmlFor="pw-new">새 비밀번호</label>
        <input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => edit(setNewPassword, event.target.value)}
          readOnly={working}
          required
          minLength={MIN}
          maxLength={MAX}
        />
      </div>
      <div className="form-field">
        <label htmlFor="pw-confirm">새 비밀번호 확인</label>
        <input
          id="pw-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => edit(setConfirmPassword, event.target.value)}
          readOnly={working}
          required
          minLength={MIN}
          maxLength={MAX}
          aria-describedby={failure ? "pw-error" : undefined}
        />
      </div>
      {failure ? <p role="alert" id="pw-error" ref={failureRef} tabIndex={-1}>{failure}</p> : null}
      <ProductButton type="submit" className="button button-primary" disabled={working}>
        {working ? "바꾸는 중입니다" : uncertain ? "같은 입력으로 다시 시도" : "비밀번호 바꾸기"}
      </ProductButton>
    </ValidatedForm>
  );
}
