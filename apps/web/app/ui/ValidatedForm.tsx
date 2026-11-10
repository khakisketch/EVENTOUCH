"use client";

import { revealDetailsFor } from "./reveal-details";
import { useEffect, useId, useState, type ComponentProps } from "react";

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type FieldError = { control: Control; message: string };

function isControl(element: Element): element is Control {
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
}

function describe(control: Control): string {
  const label = control.labels?.[0]?.textContent?.trim().replace(/\s+/g, " ") || control.getAttribute("aria-label") || "입력 항목";
  const value = control.validity;
  if (value.valueMissing) return `${label}: 필수 항목입니다.`;
  if (value.typeMismatch) return `${label}: ${control instanceof HTMLInputElement && control.type === "email" ? "이메일 주소" : "입력 형식"}를 확인하세요.`;
  if (value.tooShort || value.tooLong) return `${label}: 입력 길이를 확인하세요.`;
  if (value.rangeUnderflow || value.rangeOverflow || value.stepMismatch || value.badInput) return `${label}: 허용된 숫자 범위를 확인하세요.`;
  return `${label}: 입력 내용을 확인하세요.`;
}

/** Shared constraint feedback. Domain validation and command receipts remain with each caller. */
export default function ValidatedForm(props: ComponentProps<"form">) {
  return <ValidatedFormBody key={props.id} {...props} />;
}

function ValidatedFormBody({ children, onSubmit, onInputCapture, ref: externalRef, ...props }: ComponentProps<"form">) {
  const [errors, setErrors] = useState<FieldError[]>([]);
  const id = useId();
  useEffect(() => {
    const restored: Array<() => void> = [];
    errors.forEach(({ control }, index) => {
      const invalid = control.getAttribute("aria-invalid");
      const described = control.getAttribute("aria-describedby");
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", [described, `${id}-error-${index}`].filter(Boolean).join(" "));
      restored.push(() => {
        if (invalid === null) control.removeAttribute("aria-invalid"); else control.setAttribute("aria-invalid", invalid);
        if (described === null) control.removeAttribute("aria-describedby"); else control.setAttribute("aria-describedby", described);
      });
    });
    return () => restored.forEach((restore) => restore());
  }, [errors, id]);

  function submit(event: Parameters<NonNullable<ComponentProps<"form">["onSubmit"]>>[0]) {
    const invalid = Array.from(event.currentTarget.elements).filter(isControl).filter((control) => control.willValidate && !control.validity.valid);
    if (invalid.length) {
      event.preventDefault();
      event.stopPropagation();
      setErrors(invalid.map((control) => ({ control, message: describe(control) })));
      {
        const first = invalid[0];
        first.checkValidity();
        revealDetailsFor(first);
        first.focus();
      }
      return;
    }
    setErrors([]);
    onSubmit?.(event);
  }

  return <form {...props} ref={externalRef} noValidate onSubmit={submit} onInputCapture={(event) => {
    onInputCapture?.(event);
    const control = event.target;
    if (control instanceof Element && isControl(control) && control.validity.valid && errors.some((error) => error.control === control)) setErrors((current) => current.filter((error) => error.control !== control));
  }}>
    {errors.length ? <div className="form-validation" role="alert"><p>입력 내용을 확인해 주세요.</p><ul>{errors.map((error, index) => <li key={index} id={`${id}-error-${index}`}><button type="button" onClick={() => error.control.focus()}>{error.message}</button></li>)}</ul></div> : null}
    {children}
  </form>;
}
