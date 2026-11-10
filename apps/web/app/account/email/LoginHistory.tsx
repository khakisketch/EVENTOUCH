"use client";

import { useRef, useState } from "react";
import Link from "next/link";

type History = { enabled: boolean; retentionDays: number | null; entries: Array<{ at: string }> };
export default function LoginHistory() {
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [signin, setSignin] = useState(false);
  const gate = useRef(false);
  async function load() {
    if (gate.current) return;
    gate.current = true; setBusy(true); setFailure(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api/auth/login-history", { cache: "no-store", signal: controller.signal });
      if (response.status === 401) { setSignin(true); return; }
      const data = await response.json();
      if (!response.ok || typeof data.enabled !== "boolean" || !Array.isArray(data.entries) || !data.entries.every((entry: { at?: unknown } | null) => entry && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)))) throw new Error();
      setHistory(data as History);
    } catch { setFailure("로그인 기록을 불러오지 못했습니다. 다시 시도하세요."); }
    finally { window.clearTimeout(timer); gate.current = false; setBusy(false); }
  }
  return (
    <details className="account-history" onToggle={(event) => { if (event.currentTarget.open && !history && !signin) void load(); }}>
      <summary data-disclosure-indicator="">최근 로그인</summary>
      <div className="auth-form">
        <p className="auth-help">본인 계정의 비밀번호 로그인 시각만 표시합니다. 시각은 한국 표준시입니다.</p>
        <p role="status" className={busy ? undefined : "sr-only"}>{busy ? "기록을 불러오고 있습니다." : ""}</p>
        {failure ? <><p role="alert">{failure}</p><button type="button" className="button button-secondary" onClick={() => void load()} disabled={busy}>다시 불러오기</button></> : null}
        {signin ? <Link href="/login">로그인 후 확인</Link> : null}
        {history?.enabled === false ? <p className="auth-help">이 환경에서는 로그인 기록 수집이 꺼져 있습니다.</p> : null}
        {history?.enabled ? <>
          <p className="auth-help">최근 {history.retentionDays}일 이내의 로그인 중 최신 20건입니다.</p>
          {history.entries.length ? <ol>{history.entries.map((entry, index) => <li key={`${entry.at}-${index}`}><time dateTime={entry.at}>{new Date(entry.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</time></li>)}</ol> : <p>보관 중인 로그인 기록이 없습니다.</p>}
        </> : null}
      </div>
    </details>
  );
}
