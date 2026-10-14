"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PublishedField } from "./page";

type Props = {
  slug: string;
  fields: PublishedField[];
  consentText: string;
  formVersion: number;
};

type Failure = { message: string; field?: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function RegisterForm({ slug, fields, consentText, formVersion }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [consent, setConsent] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function setValue(id: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const body: Record<string, unknown> = {
        commandId: randomCommandId(),
        formVersion,
        consent: consentText ? consent : undefined,
      };
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
              value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
              onChange={(event) => setValue(field.id, event.target.value)}
              aria-invalid={invalid || undefined}
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
            />
            필수 정보 수집 안내에 동의합니다
          </label>
          <p>{consentText}</p>
          {failure?.field === "consent" ? <p role="alert">{failure.message}</p> : null}
        </div>
      ) : null}
      {failure && !failure.field ? <p role="alert">{failure.message}</p> : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "신청 중입니다" : "신청하기"}
      </button>
    </form>
  );
}
