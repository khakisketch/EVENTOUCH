"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function StaffLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      } | null;
      if (!res.ok) {
        setFailure(
          typeof data?.error === "string"
            ? data.error
            : "로그인하지 못했습니다"
        );
        return;
      }
      router.push("/staff");
    } catch {
      setFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <div>
        <label htmlFor="staff-email">이메일</label>
        <input
          id="staff-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <label htmlFor="staff-password">비밀번호</label>
        <input
          id="staff-password"
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
    </form>
  );
}
