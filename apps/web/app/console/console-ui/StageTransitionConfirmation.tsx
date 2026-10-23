"use client";

import { useEffect, useRef, type ReactNode } from "react";
import ConsoleFormActions from "./ConsoleFormActions";

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
  useEffect(() => { confirmRef.current?.focus(); }, []);
  const actionText = busy ? "전환 중입니다" : retry ? "같은 요청 다시 시도" : "정말 전환합니다";
  return (
    <div className={className} role="group" aria-label="단계 전환 확인">
      <p>정말 {label} 단계로 전환합니다?</p>
      {children}
      <ConsoleFormActions>
        <button ref={confirmRef} type="button" className="button button-secondary" onClick={onConfirm}
          onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
          disabled={busy || disabled} aria-describedby={describedBy} aria-label={`${actionText} · ${label} 단계로`}>
          {actionText}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy || cancelDisabled}>취소</button>
      </ConsoleFormActions>
    </div>
  );
}
