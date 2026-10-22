"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

// One grammar for the commands that cannot be undone or that leave the
// product: the screen states what will happen, and the operator confirms in
// place. A native browser dialog loses that context on a phone and on a
// screen reader, so the console no longer uses one for these.
//
// Dialog dismissal gates (discarding unsaved input) keep their own contract in
// ConsoleDialog/canClose and are not routed through here.
type ConsoleConfirmProps = {
  summary: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  // Visual tone of the confirming button only. The default keeps the filled
  // primary; a workspace may pass its own tokenized outline (e.g. a danger
  // outline for deletes) without changing copy, order, handlers or focus.
  confirmClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConsoleConfirm({
  summary,
  confirmLabel,
  cancelLabel = "취소",
  busy = false,
  confirmClassName = "button button-primary",
  onConfirm,
  onCancel,
}: ConsoleConfirmProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // The confirmation replaces the action that opened it, so focus moves to
    // the confirming button instead of leaving it on the trigger.
    confirmRef.current?.focus();
  }, []);

  return (
    <div className={styles.confirmRegion} role="group" aria-label="실행 확인">
      <p className={styles.confirmSummary}>{summary}</p>
      <div className={styles.confirmActions}>
        <button
          ref={confirmRef}
          type="button"
          className={confirmClassName}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "처리 중…" : confirmLabel}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
