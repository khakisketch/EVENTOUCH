"use client";

import ValidatedForm from "../../../ui/ValidatedForm";


import { useEffect, useRef, useState } from "react";
import ProductLink from "../../../ui/ProductLink";
import ProductButton from "../../../ui/ProductButton";
import { useRouter } from "next/navigation";
import { BUILT_IN_FIELDS, parseRegisterData } from "./register-data";
import type { PublishedField } from "./register-data";
import styles from "./register.module.css";
import { useUnsavedNavigationGuard } from "../../../../lib/use-unsaved-navigation-guard";
import { postAttendeeRequest } from "../attendee-request";

type Props = {
  slug: string;
  fields: PublishedField[];
  // Without SMS, the original browser tab may be the only way back.
  recoveryBlocked?: boolean;
  recoveryContact?: string;
  consentText: string;
  consentVersion: number;
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

export default function RegisterForm(initial: Props) {
  const { slug, recoveryBlocked } = initial;
  const [form, setForm] = useState(() => ({ fields: initial.fields, consentText: initial.consentText,
    consentVersion: initial.consentVersion, formVersion: initial.formVersion,
    verificationRequired: initial.verificationRequired, recoveryContact: initial.recoveryContact,
    approvalRequired: initial.approvalRequired, paymentPending: initial.paymentPending }));
  const { fields, consentText, consentVersion, formVersion, verificationRequired, recoveryContact, approvalRequired, paymentPending } = form;
  const router = useRouter();
  // Keep the entire original request in memory, not in browser storage: its
  // id can replay a ticket and the body contains personal information.
  const attemptRef = useRef<{ body: Record<string, unknown> } | null>(null);
  const submitGateRef = useRef(false);
  const protectAttemptRef = useRef(false);
  const retryNoticeRef = useRef<HTMLElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFieldFocusRef = useRef<{ field: string; origin: Element | null } | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [consent, setConsent] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [formUpdated, setFormUpdated] = useState(false);
  const [formRefreshRequested, setFormRefreshRequested] = useState(false);
  const [formRefreshError, setFormRefreshError] = useState("");
  const [formClosed, setFormClosed] = useState(false);
  const [formRefreshNeedsNewVersion, setFormRefreshNeedsNewVersion] = useState(true);
  const formRefreshRef = useRef<AbortController | null>(null);
  const currentFormRef = useRef({ formVersion, consentVersion });
  currentFormRef.current = { formVersion, consentVersion };
  // Registering twice is a common, recoverable situation: the attendee needs
  // the way back to their ticket, not only the rejection.
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [signupSuperseded, setSignupSuperseded] = useState(false);
  const [retryNoticeVersion, setRetryNoticeVersion] = useState(0);
  // Phone-ownership proof for verified-only events. The grant is bound to
  // the exact digits shown; editing the number afterwards voids it.
  const [grant, setGrant] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [requestUncertain, setRequestUncertain] = useState(false);
  const [confirmationUncertain, setConfirmationUncertain] = useState(false);
  const [code, setCode] = useState("");
  const [verifyFailure, setVerifyFailure] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const verificationVersionRef = useRef(0);
  const verificationBusyRef = useRef(false);

  useEffect(() => {
    return () => { formRefreshRef.current?.abort(); formRefreshRef.current = null; };
  }, []);

  async function refreshForm() {
    // Never replace the body of an unconfirmed signup. A later click may
    // cancel a slow refresh and try again without losing the current inputs.
    if (protectAttemptRef.current || retryPending || submitting) return;
    formRefreshRef.current?.abort();
    const controller = new AbortController();
    formRefreshRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const current = () => formRefreshRef.current === controller;
    setFormRefreshRequested(true);
    setFormRefreshError("");
    try {
      const response = await fetch(`/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const next = parseRegisterData(await response.json());
      if (!next) throw new Error("invalid");
      if (!current()) return;
      if (!next.registrationOpen || next.stage === "ENDED" || next.publishedVersion < 1) {
        setFormClosed(true);
        setFormRefreshError("현재 참가 신청을 받지 않습니다. 입력한 내용은 이 화면에 남아 있습니다.");
        return;
      }
      if (next.publishedVersion < formVersion || (formRefreshNeedsNewVersion && next.publishedVersion === formVersion)) {
        setFormRefreshError("최신 변경 사항을 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
        return;
      }
      const nextFields = [...BUILT_IN_FIELDS, ...next.fields];
      const oldTypes = new Map(fields.map((field) => [field.id, field.type]));
      setValues((previous) => Object.fromEntries(nextFields.flatMap((field) => {
        const value = previous[field.id];
        if (oldTypes.get(field.id) !== field.type || value === undefined ||
            (field.type === "select" && typeof value === "string" && value !== "" && !field.options.includes(value))) return [];
        return [[field.id, value]];
      })));
      if (verificationRequired !== next.verificationRequired) {
        verificationVersionRef.current += 1;
        setGrant(""); setCodeSent(false); setCode(""); setRequestUncertain(false); setConfirmationUncertain(false); setVerifyFailure(null);
      }
      setForm({ fields: nextFields, consentText: next.consentText, consentVersion: next.consentVersion,
        formVersion: next.publishedVersion, verificationRequired: next.verificationRequired,
        recoveryContact: next.recoveryContact, approvalRequired: next.approvalRequired, paymentPending: next.paymentPending });
      setConsent(false);
      setFormClosed(false);
      setFailure(null);
      setFormUpdated(true);
      window.requestAnimationFrame(() => document.getElementById(next.consentText ? "consent" : "field-name")?.focus());
    } catch {
      if (current()) setFormRefreshError("최신 양식을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    } finally {
      window.clearTimeout(timeout);
      if (current()) { formRefreshRef.current = null; setFormRefreshRequested(false); }
    }
  }

  const hasInput = consent || code.trim() !== "" || Object.values(values).some((value) =>
    typeof value === "string" ? value.trim() !== "" : value === true
  );
  useUnsavedNavigationGuard((hasInput && !signupSuperseded) || retryPending || submitting || verifying,
    retryPending || submitting
      ? "신청 결과를 확인 중입니다. 이동해도 서버 처리는 취소되지 않으며, 원래 입력을 다시 보낼 수 없을 수 있습니다."
      : "작성 중인 신청 내용이 있습니다. 이동하면 저장하지 않은 입력이 사라집니다.");

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
      (signupSuperseded ? retryNoticeRef.current : submitButtonRef.current)?.scrollIntoView({ block: "end", inline: "nearest" });
    }
  }, [retryNoticeVersion, signupSuperseded]);

  useEffect(() => {
    const pending = pendingFieldFocusRef.current;
    if (submitting || !pending || failure?.field !== pending.field) return;
    pendingFieldFocusRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (document.hidden || (active && active !== document.body && active !== pending.origin && active.isConnected)) return;
      const target = document.getElementById(pending.field === "consent" ? "consent" : `field-${pending.field}`);
      if (!(target instanceof HTMLElement)) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "center", behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [failure, submitting]);

  function markResultUnknown() {
    setRetryPending(true);
    setRetryNoticeVersion((version) => version + 1);
  }

  function setValue(id: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [id]: value }));
    setFailure((current) => current?.field === id ? null : current);
    if (id === "phone" && typeof value === "string") {
      setAlreadyRegistered(false);
      verificationVersionRef.current += 1;
      setGrant("");
      setCodeSent(false);
      setRequestUncertain(false);
      setConfirmationUncertain(false);
      setCode("");
      setVerifyFailure(verifying ? "연락처가 바뀌었습니다. 처리 후 다시 인증하세요." : null);
    }
  }

  async function requestCode() {
    if (verifying || verificationBusyRef.current) return;
    const phone = typeof values.phone === "string" ? values.phone : "";
    if (!phone.trim()) {
      setFailure({ field: "phone", message: "연락처를 먼저 입력하세요." });
      document.getElementById("field-phone")?.focus();
      return;
    }
    const version = verificationVersionRef.current;
    verificationBusyRef.current = true;
    setVerifying(true);
    setVerifyFailure(null);
    try {
      const { res, data } = await postAttendeeRequest<{ ok?: unknown; error?: unknown }>(
        `/api/public/events/${encodeURIComponent(slug)}/verification/request`, { phone, purpose: "ENROLL" }
      );
      if (version !== verificationVersionRef.current) return;
      if (!res.ok) {
        if (res.status >= 500 || [408, 425].includes(res.status)) {
          setCodeSent(true); setRequestUncertain(true);
          return;
        }
        setVerifyFailure(
          requestUncertain
            ? `이전 요청의 발송 여부는 아직 확인되지 않았습니다. ${typeof data?.error === "string" ? data.error : "잠시 후 다시 시도하세요."}`
            : typeof data?.error === "string" ? data.error : "인증번호를 보내지 못했습니다."
        );
        return;
      }
      if (data?.ok !== true) {
        setCodeSent(true); setRequestUncertain(true);
        return;
      }
      setCodeSent(true);
      setRequestUncertain(false);
      setConfirmationUncertain(false);
      setCode("");
    } catch {
      if (version === verificationVersionRef.current) {
        setCodeSent(true); setRequestUncertain(true);
      }
    } finally {
      verificationBusyRef.current = false;
      setVerifying(false);
    }
  }

  async function confirmCode() {
    if (verifying || verificationBusyRef.current) return;
    const phone = typeof values.phone === "string" ? values.phone : "";
    const version = verificationVersionRef.current;
    verificationBusyRef.current = true;
    setVerifying(true);
    setVerifyFailure(null);
    try {
      const { res, data } = await postAttendeeRequest<{
        error?: unknown;
        grant?: unknown;
      }>(`/api/public/events/${encodeURIComponent(slug)}/verification/confirm`, { phone, code });
      if (version !== verificationVersionRef.current) return;
      if (!res.ok || typeof data?.grant !== "string" || !data.grant) {
        if (confirmationUncertain || res.ok || res.status >= 500 || [408, 425, 429].includes(res.status)) {
          setConfirmationUncertain(true);
          setVerifyFailure("인증 결과를 확인하지 못했습니다. 번호가 이미 사용됐을 수 있습니다. 다시 확인하거나 새 인증번호를 받으세요.");
          return;
        }
        setVerifyFailure(
          typeof data?.error === "string" ? data.error : "인증번호를 확인하세요."
        );
        return;
      }
      setGrant(data.grant);
      setConfirmationUncertain(false);
    } catch {
      if (version === verificationVersionRef.current) {
        setConfirmationUncertain(true);
        setVerifyFailure("인증 결과를 확인하지 못했습니다. 번호가 이미 사용됐을 수 있습니다. 다시 확인하거나 새 인증번호를 받으세요.");
      }
    } finally {
      verificationBusyRef.current = false;
      setVerifying(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || formClosed || (verificationRequired && recoveryBlocked)) return;
    if (!retryPending && verificationRequired && !grant) {
      setVerifyFailure("연락처 인증을 먼저 완료하세요.");
      requestAnimationFrame(() => document.getElementById("verification-panel")?.focus());
      return;
    }
    const focusOrigin = document.activeElement;
    pendingFieldFocusRef.current = null;
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
      const { res, data } = await postAttendeeRequest<{
        error?: unknown;
        field?: unknown;
        code?: unknown;
        participant?: { ticket?: unknown } | null;
      }>(`/api/events/${encodeURIComponent(slug)}/signup`, attemptRef.current.body);
      if (!res.ok) {
        if (data?.code === "SIGNUP_RESULT_SUPERSEDED") {
          attemptRef.current = null;
          protectAttemptRef.current = false;
          setRetryPending(false);
          setSignupSuperseded(true);
          setRetryNoticeVersion((version) => version + 1);
          return;
        }
        // Receipt lookup precedes this specific server verdict. If the same
        // request had committed it would replay; this 409 proves the old
        // form request did not commit, even after an earlier lost response.
        if (res.status === 409 && data?.code === "SIGNUP_FORM_CHANGED") {
          const submittedVersion = attemptRef.current?.body.formVersion;
          attemptRef.current = null;
          protectAttemptRef.current = false;
          setRetryPending(false);
          // A refresh may already have arrived while the request was in
          // flight. Keep its inputs but require a fresh consent immediately.
          if (submittedVersion !== currentFormRef.current.formVersion) {
            setConsent(false);
            setFailure(null);
            setFormUpdated(true);
            requestAnimationFrame(() => document.getElementById(consentText ? "consent" : "field-name")?.focus());
            return;
          }
          setFormUpdated(false);
          setFormRefreshRequested(false);
          setFormRefreshNeedsNewVersion(true);
          setFormRefreshError("");
          setFailure({ field: "formVersion", message: "신청 양식 또는 동의 안내가 변경되었습니다. 최신 내용을 확인해 주세요." });
          requestAnimationFrame(() => document.getElementById("signup-form-changed")?.focus());
          return;
        }
        // A proxy timeout, 5xx, rate limit, or an error on a later retry does
        // not prove the original request failed. Keep the exact request.
        const rejected = res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        if (retryPending || !rejected) {
          markResultUnknown();
          return;
        }
        attemptRef.current = null;
        protectAttemptRef.current = false;
        if (data?.code === "SIGNUP_VERIFICATION_REQUIRED") {
          setGrant("");
          setCodeSent(false);
          setCode("");
          setRequestUncertain(false);
          setConfirmationUncertain(false);
          if (!verificationRequired) {
            setFormRefreshNeedsNewVersion(false);
            setFormRefreshError("");
            setFailure({ field: "formVersion", message: "참가 신청의 인증 조건이 바뀌었습니다. 최신 내용을 확인해 주세요." });
            requestAnimationFrame(() => document.getElementById("signup-form-changed")?.focus());
            return;
          }
        }
        const message =
          typeof data?.error === "string" ? data.error : "신청을 저장하지 못했습니다";
        setAlreadyRegistered(/이미 등록|중복/.test(message));
        const errorField = typeof data?.field === "string" ? data.field : undefined;
        const mappedField = fields.some((field) => field.id === errorField) || (errorField === "consent" && consentText)
          ? errorField : undefined;
        if (mappedField) pendingFieldFocusRef.current = { field: mappedField, origin: focusOrigin };
        setFailure({
          message,
          field: mappedField,
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

  const duplicateRecovery = alreadyRegistered ? (
    recoveryBlocked ? (
      <p className="registration-duplicate" role="status">
        이미 신청하신 연락처로 등록되어 있습니다. 문자로 다시 연결할 수 없으므로 신청을 완료한 브라우저 탭을 확인하세요.
        {recoveryContact ? ` 문의: ${recoveryContact}` : " 탭을 찾을 수 없다면 행사 주최 측에 문의하세요."}
      </p>
    ) : (
      <p className="registration-duplicate" role="status">
        이미 신청하신 연락처로 등록되어 있습니다.{" "}
        <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>내 티켓 찾기</ProductLink>
      </p>
    )
  ) : null;

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
            {field.required ? " (필수)" : " (선택)"}
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
            {field.required ? " (필수)" : " (선택)"}
          </label>
          {invalid ? <p id={errorId} role="alert">{failure?.message}</p> : null}
        </div>
      );
    }
    return (
      <div className="form-field" key={field.id}>
        <label htmlFor={`field-${field.id}`}>
          {field.label}
          {field.required ? " (필수)" : " (선택)"}
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
          <p className={`verification-help ${styles.phoneHint}`} id={`field-${field.id}-hint`}>숫자만 입력해도 됩니다. 예: 01012345678</p>
        ) : null}
        {invalid ? <p id={errorId} role="alert">{failure?.message}</p> : null}
        {field.id === "phone" && failure?.field === "phone" ? duplicateRecovery : null}
      </div>
    );
  }

  return (
    <ValidatedForm className={`registration-form ${styles.form}`} onSubmit={onSubmit}>
      <fieldset className="registration-fields" disabled={submitting || retryPending || signupSuperseded}>
      <legend className="sr-only">참가 신청 정보</legend>
      <section className={styles.stepSection} aria-label="신청 결과 안내">
        <h2 className={styles.outcomeTitle}>신청하면 어떻게 되나요</h2>
        <p className={styles.outcomeNote} role="note">
          {approvalRequired && paymentPending
            ? "신청 접수 후 운영자 승인과 결제 확인이 모두 끝나면 입장 QR이 표시됩니다."
            : approvalRequired
              ? "신청 접수 후 운영자가 승인하면 입장 QR이 표시됩니다."
              : paymentPending
                ? "신청 접수 후 결제 확인이 끝나면 입장 QR이 표시됩니다."
                : "신청하면 입장 티켓이 바로 발급됩니다."}
          {verificationRequired ? " 신청 전 연락처 인증이 필요합니다." : null}
          {recoveryBlocked ? (
            <> 문자 복구가 불가능하므로 신청을 마친 브라우저 탭을 닫지 마세요. {recoveryContact ? `문의: ${recoveryContact}` : "탭을 찾을 수 없다면 행사 주최 측에 문의하세요."}</>
          ) : null}
        </p>
      </section>
      <section className={styles.stepSection} aria-label="신청 정보 입력">
        <h2 className={styles.stepTitle}>누가 참가하나요</h2>
        {fields.map(renderField)}
      </section>
      {verificationRequired && !signupSuperseded && !recoveryBlocked ? (
        <section className={`${styles.stepSection}`} aria-label="연락처 인증">
        <section className="verification-panel" id="verification-panel" aria-label="연락처 인증" tabIndex={-1}>
          <h2>연락처 인증</h2>
          {grant ? (
            <p className="state-success" role="status">연락처 인증됨. 번호를 바꾸면 다시 인증하세요.</p>
          ) : (
            <>
              <p>신청 연락처가 본인 것인지 문자 인증번호로 확인합니다. 인증을 마쳐야 신청할 수 있습니다.</p>
              {!codeSent ? (<>
                <ProductButton type="button" className="button button-secondary" onClick={requestCode} disabled={verifying}>
                  {verifying ? "보내는 중입니다" : "인증번호 받기"}
                </ProductButton>
                <ProductButton type="button" className="button button-secondary" disabled={verifying} onClick={() => {
                  const phone = typeof values.phone === "string" ? values.phone.trim() : "";
                  if (!phone) { setFailure({ field: "phone", message: "연락처를 먼저 입력하세요." }); document.getElementById("field-phone")?.focus(); return; }
                  setCodeSent(true); setRequestUncertain(true); setVerifyFailure(null);
                }}>이미 받은 인증번호 입력</ProductButton>
              </>) : (
                <>
                  <p className={requestUncertain ? "notice" : "state-success"} role="status">{requestUncertain ? "발송 여부는 미확인입니다. 문자가 오면 가장 최근 번호를 입력하세요." : "인증번호 요청을 접수했습니다. 10분 안에 입력하세요. 문자가 오지 않으면 다시 받으세요."}</p>
                  <p>새 번호를 요청하면 이전 번호를 사용할 수 없을 수 있습니다.</p>
                  <div className="form-field">
                    <label htmlFor="verify-code">인증번호 6자리</label>
                    <input
                      id="verify-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6자리 숫자"
                      value={code}
                      disabled={verifying}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  </div>
                  <ProductButton type="button" className="button button-secondary" onClick={confirmCode} disabled={verifying}>
                    {verifying ? "확인 중입니다" : "인증 확인"}
                  </ProductButton>{" "}
                  <ProductButton type="button" className="button button-secondary" onClick={requestCode} disabled={verifying}>
                    {verifying ? "보내는 중입니다" : "인증번호 다시 받기"}
                  </ProductButton>
                </>
              )}
              {verifyFailure ? <p role="alert">{verifyFailure}</p> : null}
              <p className="verification-help">
                문자가 오지 않거나 인증이 계속되지 않으면{" "}
                <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내에서 운영 정보를 확인하세요.</ProductLink>
              </p>
            </>
          )}
        </section>
        </section>
      ) : null}
      {consentText ? (
        <section className={styles.stepSection} aria-label="정보 수집 동의">
          <h2 className={styles.stepTitle}>정보 수집 동의</h2>
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
              정보 수집 안내에 동의합니다 (필수)
            </label>
            <p className="preserve-lines">{consentText}</p>
            <p className="consent-meta">동의 버전 {consentVersion} · 동의 시각과 함께 기록되며, 행사 종료 후 파기 기준은 행사 주최 측에 확인하세요.</p>
            {failure?.field === "consent" ? <p id="consent-error" role="alert">{failure.message}</p> : null}
          </div>
        </section>
      ) : null}
      </fieldset>
      {failure?.field === "formVersion" ? (
        <section className="registration-retry" role="alert" tabIndex={-1} id="signup-form-changed">
          <p>{failure.message}</p>
          <p>입력한 내용은 유지됩니다. 최신 안내를 확인하고 다시 동의해 주세요.</p>
          <ProductButton type="button" className="button button-secondary" onClick={() => void refreshForm()}>최신 신청 양식 불러오기</ProductButton>
          {formRefreshRequested ? <p role="status">최신 내용을 확인하고 있습니다. 연결이 늦으면 다시 눌러 주세요.</p> : null}
          {formRefreshError ? <p role="alert">{formRefreshError}</p> : null}
        </section>
      ) : null}
      {formUpdated && !failure ? <p role="status">{consentText ? "최신 신청 양식을 불러왔습니다. 입력 내용을 확인하고 동의 안내를 다시 읽어 주세요." : "최신 신청 양식을 불러왔습니다. 입력 내용을 다시 확인해 주세요."}</p> : null}
      {failure && !failure.field ? <p role="alert">{failure.message}</p> : null}
      {failure?.field !== "phone" ? duplicateRecovery : null}
      {verificationRequired && !grant && !signupSuperseded ? (
        <p className="notice" role="status">신청하려면 위에서 연락처 인증을 완료하세요.</p>
      ) : null}
      {verificationRequired && recoveryBlocked ? <p role="alert">현재 연락처 인증을 사용할 수 없습니다. 행사 주최 측에 문의하세요.</p> : null}
      {retryPending ? (
        <section className="registration-retry" role="alert" tabIndex={-1} ref={retryNoticeRef}>
          <h2>신청 결과를 확인하지 못했습니다</h2>
          <p>이미 신청되었을 수 있습니다. 입력한 정보는 결과를 확인할 때까지 변경할 수 없습니다.</p>
          <p>아래 버튼으로 같은 신청을 다시 확인하세요. 확인하기 전에는 이 페이지를 새로고침하거나 닫지 마세요.</p>
          <p>계속 확인되지 않으면 <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`} target="_blank" rel="noopener noreferrer">행사 안내 (새 탭)</ProductLink>에서 주최 측의 안내를 확인하세요.</p>
        </section>
      ) : null}
      {signupSuperseded ? (
        <section className="registration-retry" role="alert" tabIndex={-1} ref={retryNoticeRef}>
          <h2>이전 신청 정보를 확인해 주세요</h2>
          <p>신청이 처리된 뒤 참가 정보가 변경되었습니다.</p>
          {recoveryBlocked ? (
            <p>{recoveryContact ? `문의: ${recoveryContact}` : "행사 주최 측에 문의하세요."}</p>
          ) : <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>내 티켓 찾기</ProductLink>}
        </section>
      ) : null}
      <div className={styles.submitBlock}>
        <ProductButton ref={submitButtonRef} variant="primary" type="submit" disabled={submitting || signupSuperseded || formClosed || (verificationRequired && recoveryBlocked) || failure?.field === "formVersion"}>
          {submitting ? (retryPending ? "신청 결과 확인 중입니다" : "신청 중입니다") : (retryPending ? "신청 결과 다시 확인" : "신청하기")}
        </ProductButton>
      </div>
    </ValidatedForm>
  );
}
