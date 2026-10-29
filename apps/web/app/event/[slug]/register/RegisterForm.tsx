"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PublishedField } from "./page";
import styles from "./register.module.css";

type Props = {
  slug: string;
  fields: PublishedField[];
  // Without SMS the ticket can only be reopened on the device that applied:
  // the form must not promise a recovery that does not exist.
  recoveryBlocked?: boolean;
  consentText: string;
  formVersion: number;
  verificationRequired: boolean;
  // Approval-gated events issue the entry QR only after an operator
  // approves: the lead must promise a receipt, not an immediate ticket.
  approvalRequired?: boolean;
  // Paid-flow events (v1-excluded from payment UI, but the server still
  // lands these signups payment-pending): same receipt promise.
  paymentPending?: boolean;
};

type Failure = { message: string; field?: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // The request id can recover the issued ticket, so it must remain
  // unpredictable even on browsers without randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export default function RegisterForm({ slug, fields, consentText, formVersion, verificationRequired, recoveryBlocked, approvalRequired, paymentPending }: Props) {
  const router = useRouter();
  // Keep the entire original request in memory, not in browser storage: its
  // id can replay a ticket and the body contains personal information.
  const attemptRef = useRef<{ body: Record<string, unknown> } | null>(null);
  const submitGateRef = useRef(false);
  const protectAttemptRef = useRef(false);
  const retryNoticeRef = useRef<HTMLElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [consent, setConsent] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Registering twice is a common, recoverable situation: the attendee needs
  // the way back to their ticket, not only the rejection.
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [retryNoticeVersion, setRetryNoticeVersion] = useState(0);
  // Phone-ownership proof for verified-only events. The grant is bound to
  // the exact digits shown; editing the number afterwards voids it.
  const [grant, setGrant] = useState("");
  const [grantPhone, setGrantPhone] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verifyFailure, setVerifyFailure] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      if (!protectAttemptRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, []);

  useEffect(() => {
    if (retryNoticeVersion > 0) {
      retryNoticeRef.current?.focus({ preventScroll: true });
      // Keep the explanation and its action together in the mobile viewport.
      submitButtonRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
    }
  }, [retryNoticeVersion]);

  function markResultUnknown() {
    setRetryPending(true);
    setRetryNoticeVersion((version) => version + 1);
  }

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
    if (submitGateRef.current) return;
    if (!retryPending && verificationRequired && !grant) {
      setFailure({ message: "연락처 인증을 먼저 완료하세요.", field: "phone" });
      return;
    }
    submitGateRef.current = true;
    setSubmitting(true);
    setFailure(null);
    setAlreadyRegistered(false);
    let navigating = false;
    try {
      if (!attemptRef.current) {
        const body: Record<string, unknown> = {
          commandId: randomCommandId(),
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
        attemptRef.current = { body };
      }
      protectAttemptRef.current = true;
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attemptRef.current.body),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        participant?: { ticket?: unknown } | null;
      } | null;
      if (!res.ok) {
        // A proxy timeout, 5xx, rate limit, or an error on a later retry does
        // not prove the original request failed. Keep the exact request.
        const rejected = res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        if (retryPending || !rejected) {
          markResultUnknown();
          return;
        }
        attemptRef.current = null;
        protectAttemptRef.current = false;
        const message =
          typeof data?.error === "string" ? data.error : "신청을 저장하지 못했습니다";
        setAlreadyRegistered(/이미 등록|중복/.test(message));
        const errorField = typeof data?.field === "string" ? data.field : undefined;
        setFailure({
          message,
          field: fields.some((field) => field.id === errorField) || (errorField === "consent" && consentText)
            ? errorField : undefined,
        });
        return;
      }
      const ticket = data?.participant?.ticket;
      if (typeof ticket !== "string" || !ticket) {
        markResultUnknown();
        return;
      }
      // The bearer travels in memory and in this one navigation only. The
      // ticket page consumes it once and cleans the address right away.
      // `registered=1` rides the same navigation so the ticket screen can
      // read this arrival as a fresh completion receipt; it is cleaned
      // together with the bearer and never persists.
      protectAttemptRef.current = false;
      router.push(`/event/${encodeURIComponent(slug)}/ticket?ticket=${encodeURIComponent(ticket)}&registered=1`);
      navigating = true;
    } catch {
      if (attemptRef.current) {
        protectAttemptRef.current = true;
        markResultUnknown();
      }
      else setFailure({ message: "신청을 시작하지 못했습니다. 브라우저를 확인한 뒤 다시 시도하세요." });
    } finally {
      if (!navigating) {
        submitGateRef.current = false;
        setSubmitting(false);
      }
    }
  }

  // A single section in the organizer's published field order: the array
  // already carries the customer-defined sequence (field.move included),
  // so every field renders exactly once, in place, with no ID-based split.
  function renderField(field: PublishedField) {
    const invalid = failure?.field === field.id;
    const errorId = `field-${field.id}-error`;
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
            aria-describedby={invalid ? errorId : undefined}
            required={field.required}
          >
            <option value="">선택하세요</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {invalid ? <p id={errorId} role="alert">{failure?.message}</p> : null}
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
              aria-describedby={invalid ? errorId : undefined}
              required={field.required}
            />
            {field.label}
            {field.required ? " (필수)" : ""}
          </label>
          {invalid ? <p id={errorId} role="alert">{failure?.message}</p> : null}
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
          autoComplete={
            field.id === "phone" ? "tel"
            : field.id === "name" ? "name"
            : field.id === "email" ? "email"
            : field.id === "company" ? "organization"
            : undefined
          }
          inputMode={field.id === "phone" ? "tel" : undefined}
          value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
          onChange={(event) => setValue(field.id, event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={[
            field.id === "phone" ? `field-${field.id}-hint` : "",
            invalid ? errorId : "",
          ].filter(Boolean).join(" ") || undefined}
          required={field.required}
        />
        {field.id === "phone" ? (
          <p className="verification-help" id={`field-${field.id}-hint`}>숫자만 입력해도 됩니다. 예: 01012345678</p>
        ) : null}
        {invalid ? <p id={errorId} role="alert">{failure?.message}</p> : null}
      </div>
    );
  }

  return (
    <form className={`registration-form ${styles.form}`} onSubmit={onSubmit}>
      <fieldset className="registration-fields" disabled={submitting || retryPending}>
      <legend className="sr-only">참가 신청 정보</legend>
      {verificationRequired ? (
        <section className={`${styles.stepSection}`} aria-label="연락처 인증">
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
                  <p className="state-success" role="status">인증번호 요청을 접수했습니다. 10분 안에 입력하세요. 문자가 오지 않으면 다시 받으세요.</p>
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
              <p className="verification-help">
                문자가 오지 않거나 인증이 계속되지 않으면{" "}
                <Link href={`/event/${encodeURIComponent(slug)}`}>행사 안내에서 운영 정보를 확인하세요.</Link>
              </p>
            </>
          )}
        </section>
        </section>
      ) : null}
      <section className={styles.stepSection} aria-label="신청 결과 안내">
        <p className={styles.stepLabel}>신청하면 어떻게 되나요</p>
        <p className={styles.outcomeNote} role="note">
          {approvalRequired && paymentPending
            ? (verificationRequired
              ? "연락처 인증 후 아래 정보를 입력하면 신청이 접수되고, 운영자 승인과 결제 확인이 모두 끝나면 입장 QR이 표시됩니다."
              : "아래 정보를 입력하면 신청이 접수되고, 운영자 승인과 결제 확인이 모두 끝나면 입장 QR이 표시됩니다.")
            : (approvalRequired
            ? (verificationRequired
              ? "연락처 인증 후 아래 정보를 입력하면 신청이 접수되고, 운영자 승인 뒤 입장 QR이 표시됩니다."
              : "아래 정보를 입력하면 신청이 접수되고, 운영자 승인 뒤 입장 QR이 표시됩니다.")
            : (paymentPending
              ? (verificationRequired
                ? "연락처 인증 후 아래 정보를 입력하면 신청이 접수되고, 결제 확인이 끝나면 입장 QR이 표시됩니다."
                : "아래 정보를 입력하면 신청이 접수되고, 결제 확인이 끝나면 입장 QR이 표시됩니다.")
              : (verificationRequired
                ? "연락처 인증 후 아래 정보를 입력하면 입장 티켓이 바로 발급됩니다."
                : "아래 정보를 입력하면 입장 티켓이 바로 발급됩니다.")))}
          {/* Device-binding lives in the same promise strip: a second muted
              note below it repeated the identical rule and split the outcome
              from the form on small phones. */}
          {recoveryBlocked ? (
            <> 이 행사에서는 문자로 티켓을 다시 연결할 수 없어, 티켓은 신청한 기기에서만 열 수 있습니다. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.</>
          ) : null}
        </p>
      </section>
      <section className={styles.stepSection} aria-label="신청 정보 입력">
        <h2 className={styles.stepTitle}>누가 참가하나요</h2>
        {fields.map(renderField)}
      </section>
      {consentText ? (
        <section className={styles.stepSection} aria-label="정보 수집 동의">
          <h2 className={styles.stepTitle}>꼭 필요한 정보만 보관합니다</h2>
          <div className={`consent-field ${styles.consentPanel}`}>
            <label htmlFor="consent">
              <input
                id="consent"
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                aria-invalid={failure?.field === "consent" || undefined}
                aria-describedby={failure?.field === "consent" ? "consent-error" : undefined}
                required
              />
              필수 정보 수집 안내에 동의합니다
            </label>
            <p className="preserve-lines">{consentText}</p>
            <p className="consent-meta">동의 버전 {formVersion} · 동의 시각과 함께 기록되며, 행사 종료 후 파기 기준은 행사 안내의 문의처로 운영자에게 확인하세요.</p>
            {failure?.field === "consent" ? <p id="consent-error" role="alert">{failure.message}</p> : null}
          </div>
        </section>
      ) : null}
      </fieldset>
      {failure && !failure.field ? <p role="alert">{failure.message}</p> : null}
      {alreadyRegistered ? (
        recoveryBlocked ? (
          <p className="registration-duplicate" role="status">
            이미 신청하신 연락처로 등록되어 있습니다. 이 행사에서는 문자로 티켓을 다시 연결할 수 없어
            신청한 기기에서만 열 수 있습니다. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.
          </p>
        ) : (
          <p className="registration-duplicate" role="status">
            이미 신청하신 연락처로 등록되어 있습니다.{" "}
            <Link href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>내 티켓 찾기</Link>
          </p>
        )
      ) : null}
      {verificationRequired && !grant ? (
        <p className="notice" role="status">연락처 인증을 완료하면 아래에서 신청 정보를 입력할 수 있습니다.</p>
      ) : null}
      {retryPending ? (
        <section className="registration-retry" role="alert" tabIndex={-1} ref={retryNoticeRef}>
          <h2>신청 결과를 확인하지 못했습니다</h2>
          <p>이미 신청되었을 수 있습니다. 입력한 정보는 결과를 확인할 때까지 변경할 수 없습니다.</p>
          <p>아래 버튼으로 같은 신청을 다시 확인하세요. 확인하기 전에는 이 페이지를 새로고침하거나 닫지 마세요.</p>
          <p>계속 확인되지 않으면 <Link href={`/event/${encodeURIComponent(slug)}`} target="_blank" rel="noopener noreferrer">행사 안내·문의처 (새 탭)</Link>로 연락하세요.</p>
        </section>
      ) : null}
      <div className={styles.submitBlock}>
        <button ref={submitButtonRef} type="submit" disabled={submitting}>
          {submitting ? (retryPending ? "신청 결과 확인 중입니다" : "신청 중입니다") : (retryPending ? "신청 결과 다시 확인" : "신청하기")}
        </button>
      </div>
    </form>
  );
}
