"use client";

import ProductButton from "../../ui/ProductButton";

import { useEffect, useId, useRef, type ReactNode } from "react";
import ConsoleFormActions from "./ConsoleFormActions";
import { eventStageLabel } from "../../event-stage";

// One confirmation grammar for settings transitions and the close-flow's
// inline archive. Callers still own permissions, prerequisites and receipts.
export default function StageTransitionConfirmation({ label, busy, disabled = false, cancelDisabled = false, retry = false, describedBy, className, onConfirm, onCancel, children }: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  cancelDisabled?: boolean;
  retry?: boolean;
  describedBy?: string;
  className?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Move keyboard focus without forcing a scroll: the confirmation replaces an
  // inline control, so a focus-driven jump would move the very button the
  // operator (or a stability check) is about to press. Matches the hash-link
  // focus contract in DESIGN.md (focus the heading/control, never steal scroll).
  useEffect(() => { confirmRef.current?.focus({ preventScroll: true }); }, []);
  const actionText = busy ? "전환 중입니다" : retry ? "같은 요청 다시 시도" : "정말 전환합니다";
  // Reopened 2026-11-26: every 보관 confirmation says what locks for good, wherever it is opened.
  const locks = label === eventStageLabel("ARCHIVED");
  const lockId = useId();
  return (
    <div className={className} role="group" aria-label="단계 전환 확인">
      <p>정말 {label} 단계로 전환합니다?</p>
      {locks ? <p id={lockId}><strong>보관하면 수정, 메시지 발송, 보고서 정정이 영구히 잠기며 되돌릴 수 없습니다.</strong></p> : null}
      {children}
      <ConsoleFormActions>
        <ProductButton ref={confirmRef} type="button" className="button button-secondary" onClick={onConfirm}
          onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
          disabled={busy || disabled} aria-describedby={[describedBy, locks ? lockId : undefined].filter(Boolean).join(" ") || undefined} aria-label={`${actionText} · ${label} 단계로`}>
          {actionText}
        </ProductButton>
        <ProductButton type="button" className="button button-secondary" onClick={onCancel} disabled={busy || cancelDisabled}>취소</ProductButton>
      </ConsoleFormActions>
    </div>
  );
}
