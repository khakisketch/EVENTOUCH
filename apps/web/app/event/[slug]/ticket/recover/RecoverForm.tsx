"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Failure = { message: string; field?: string };

export default function RecoverForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [working, setWorking] = useState(false);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/verification/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, purpose: "RECOVER" }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown; field?: unknown } | null;
      if (!res.ok) {
        setFailure({
          message: typeof data?.error === "string" ? data.error : "인증번호를 보내지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return;
      }
      setSent(true);
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setWorking(false);
    }
  }

  async function confirmCode(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/verification/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown; field?: unknown } | null;
      if (!res.ok) {
        setFailure({
          message: typeof data?.error === "string" ? data.error : "인증번호를 확인하세요.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return;
      }
      // The server set the browser session cookie; the ticket screen reads
      // through it from here on.
      router.push(`/event/${encodeURIComponent(slug)}/ticket`);
      router.refresh();
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="recover-flow">
      {!sent ? (
        <form className="registration-form" onSubmit={requestCode}>
          <div className="form-field">
            <label htmlFor="recover-phone">신청할 때 입력한 연락처</label>
            <input
              id="recover-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="01012345678"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              aria-invalid={failure?.field === "phone" || undefined}
              required
            />
          </div>
          {failure ? <p role="alert">{failure.message}</p> : null}
          <button type="submit" className="button button-primary" disabled={working}>
            {working ? "보내는 중입니다" : "인증번호 받기"}
          </button>
        </form>
      ) : (
        <form className="registration-form" onSubmit={confirmCode}>
          <p className="notice" role="status">
            {phone} 번호로 인증번호를 보냈습니다. 새 번호로 다시 받으려면 처음부터 입력하세요.
          </p>
          <div className="form-field">
            <label htmlFor="recover-code">인증번호 6자리</label>
            <input
              id="recover-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6자리 숫자"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={failure?.field === "code" || undefined}
              required
            />
          </div>
          {failure ? <p role="alert">{failure.message}</p> : null}
          <button type="submit" className="button button-primary" disabled={working}>
            {working ? "확인 중입니다" : "내 티켓 열기"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={working}
            onClick={() => {
              setSent(false);
              setCode("");
              setFailure(null);
            }}
          >
            연락처 다시 입력
          </button>
        </form>
      )}
      <p>
        <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
      </p>
    </div>
  );
}
