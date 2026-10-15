"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublishedField } from "./page";

type Props = {
  slug: string;
  fields: PublishedField[];
  consentText: string;
  formVersion: number;
  verificationRequired: boolean;
};

type Failure = { message: string; field?: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function RegisterForm({ slug, fields, consentText, formVersion, verificationRequired }: Props) {
  const router = useRouter();
  // One command id per filled form, not per click: if the response is lost
  // on its way back, the retry replays the SAME request and the server
  // returns the original participant and ticket instead of creating a
  // second registration. Cleared only after a response is received.
  const commandIdRef = useRef<string | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [consent, setConsent] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Phone-ownership proof for verified-only events. The grant is bound to
  // the exact digits shown; editing the number afterwards voids it.
  const [grant, setGrant] = useState("");
  const [grantPhone, setGrantPhone] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verifyFailure, setVerifyFailure] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  function setValue(id: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [id]: value }));
    if (id === "phone" && typeof value === "string" && value !== grantPhone) {
      setGrant("");
      setGrantPhone("");
      setCodeSent(false);
      setCode("");
    }
  }

  async function requestCode() {
    if (verifying) return;
    const phone = typeof values.phone === "string" ? values.phone : "";
    if (!phone.trim()) {
      setVerifyFailure("연락처를 먼저 입력하세요.");
      return;
    }
    setVerifying(true);
    setVerifyFailure(null);
    try {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/verification/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, purpose: "ENROLL" }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setVerifyFailure(
          typeof data?.error === "string" ? data.error : "인증번호를 보내지 못했습니다."
        );
        return;
      }
      setCodeSent(true);
    } catch {
      setVerifyFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setVerifying(false);
    }
  }

  async function confirmCode() {
    if (verifying) return;
    const phone = typeof values.phone === "string" ? values.phone : "";
    setVerifying(true);
    setVerifyFailure(null);
    try {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/verification/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        grant?: unknown;
      } | null;
      if (!res.ok || typeof data?.grant !== "string") {
        setVerifyFailure(
          typeof data?.error === "string" ? data.error : "인증번호를 확인하세요."
        );
        return;
      }
      setGrant(data.grant);
      setGrantPhone(phone);
    } catch {
      setVerifyFailure("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setVerifying(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (verificationRequired && !grant) {
      setFailure({ message: "연락처 인증을 먼저 완료하세요.", field: "phone" });
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      const commandId = commandIdRef.current ?? randomCommandId();
      commandIdRef.current = commandId;
      const body: Record<string, unknown> = {
        commandId,
        formVersion,
        consent: consentText ? consent : undefined,
      };
      if (verificationRequired) body.verificationGrant = grant;
      for (const field of fields) {
        const value = values[field.id];
        if (field.type === "checkbox") {
          body[field.id] = value === true;
        } else if (typeof value === "string" && value !== "") {
          body[field.id] = value;
        }
      }
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // A received response settles the attempt: the next submit is a new
      // request. Only a transport failure (catch below) keeps the id.
      commandIdRef.current = null;
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        participant?: { ticket?: unknown } | null;
      } | null;
      if (!res.ok) {
        setFailure({
          message:
            typeof data?.error === "string"
              ? data.error
              : "신청을 저장하지 못했습니다",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return;
      }
      const ticket = data?.participant?.ticket;
      if (typeof ticket !== "string" || !ticket) {
        setFailure({ message: "티켓을 받지 못했습니다. 운영자에게 문의하세요." });
        return;
      }
      // The bearer travels in memory and in this one navigation only. The
      // ticket page consumes it once and cleans the address right away.
      router.push(`/event/${encodeURIComponent(slug)}/ticket?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="registration-form" onSubmit={onSubmit}>
      {fields.map((field) => {
        const invalid = failure?.field === field.id;
        if (field.type === "select") {
          return (
            <div className="form-field" key={field.id}>
              <label htmlFor={`field-${field.id}`}>
                {field.label}
                {field.required ? " (필수)" : ""}
              </label>
              <select
                id={`field-${field.id}`}
                value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
                onChange={(event) => setValue(field.id, event.target.value)}
                aria-invalid={invalid || undefined}
                required={field.required}
              >
                <option value="">선택하세요</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {invalid ? <p role="alert">{failure?.message}</p> : null}
            </div>
          );
        }
        if (field.type === "checkbox") {
          return (
            <div className="form-field checkbox-field" key={field.id}>
              <label htmlFor={`field-${field.id}`}>
                <input
                  id={`field-${field.id}`}
                  type="checkbox"
                  checked={values[field.id] === true}
                  onChange={(event) => setValue(field.id, event.target.checked)}
                  aria-invalid={invalid || undefined}
                  required={field.required}
                />
                {field.label}
                {field.required ? " (필수)" : ""}
              </label>
              {invalid ? <p role="alert">{failure?.message}</p> : null}
            </div>
          );
        }
        return (
          <div className="form-field" key={field.id}>
            <label htmlFor={`field-${field.id}`}>
              {field.label}
              {field.required ? " (필수)" : ""}
            </label>
            <input
              id={`field-${field.id}`}
              type={field.type === "email" ? "email" : "text"}
              autoComplete={field.id === "phone" ? "tel" : undefined}
              inputMode={field.id === "phone" ? "tel" : undefined}
              value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
              onChange={(event) => setValue(field.id, event.target.value)}
              aria-invalid={invalid || undefined}
              required={field.required}
            />
            {invalid ? <p role="alert">{failure?.message}</p> : null}
          </div>
        );
      })}
      {consentText ? (
        <div className="consent-field">
          <label htmlFor="consent">
            <input
              id="consent"
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
            />
            필수 정보 수집 안내에 동의합니다
          </label>
          <p>{consentText}</p>
          {failure?.field === "consent" ? <p role="alert">{failure.message}</p> : null}
        </div>
      ) : null}
      {verificationRequired ? (
        <section className="verification-panel" aria-label="연락처 인증">
          <h2>연락처 인증</h2>
          {grant ? (
            <p className="state-success" role="status">연락처 인증됨. 번호를 바꾸면 다시 인증하세요.</p>
          ) : (
            <>
              <p>신청 연락처가 본인 것인지 문자 인증번호로 확인합니다. 인증을 마쳐야 신청할 수 있습니다.</p>
              {!codeSent ? (
                <button type="button" className="button button-secondary" onClick={requestCode} disabled={verifying}>
                  {verifying ? "보내는 중입니다" : "인증번호 받기"}
                </button>
              ) : (
                <>
                  <p className="state-success" role="status">입력한 연락처로 인증번호를 보냈습니다. 10분 안에 입력하세요. 오지 않으면 다시 받기를 누르세요.</p>
                  <div className="form-field">
                    <label htmlFor="verify-code">인증번호 6자리</label>
                    <input
                      id="verify-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6자리 숫자"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  </div>
                  <button type="button" className="button button-secondary" onClick={confirmCode} disabled={verifying}>
                    {verifying ? "확인 중입니다" : "인증 확인"}
                  </button>{" "}
                  <button type="button" className="button button-secondary" onClick={requestCode} disabled={verifying}>
                    {verifying ? "보내는 중입니다" : "인증번호 다시 받기"}
                  </button>
                </>
              )}
              {verifyFailure ? <p role="alert">{verifyFailure}</p> : null}
            </>
          )}
        </section>
      ) : null}
      {failure && !failure.field ? <p role="alert">{failure.message}</p> : null}
      {verificationRequired && !grant ? (
        <p className="notice" role="status">연락처 인증을 완료해야 신청할 수 있습니다. 위에서 인증번호를 받아 확인하세요.</p>
      ) : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "신청 중입니다" : "신청하기"}
      </button>
    </form>
  );
}
