"use client";

import ProductButton from "../../ui/ProductButton";

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
  initialFocus?: "confirm" | "cancel";
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConsoleConfirm({
  summary,
  confirmLabel,
  cancelLabel = "취소",
  busy = false,
  confirmClassName = "button button-primary",
  initialFocus = "confirm",
  onConfirm,
  onCancel,
}: ConsoleConfirmProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    // Most reviews focus the confirming action. Discard prompts can instead
    // start on the safe choice while retaining the same return-focus behavior.
    if (initialFocus === "cancel") cancelRef.current?.focus();
    else confirmRef.current?.focus();
  }, [initialFocus]);

  function cancel() {
    const trigger = returnFocusRef.current;
    onCancel();
    // An inline confirmation may disappear along with its focused cancel
    // button. Restore the initiating control only when nothing else has
    // deliberately received focus and the original control still exists.
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body && trigger?.isConnected && trigger.getClientRects().length && !trigger.matches(":disabled")) {
        trigger.focus({ preventScroll: true });
      }
    });
  }

  return (
    <div className={styles.confirmRegion} role="group" aria-label="실행 확인">
      <p className={styles.confirmSummary}>{summary}</p>
      <div className={styles.confirmActions}>
        <ProductButton
          ref={confirmRef}
          type="button"
          className={confirmClassName}
          onClick={onConfirm}
          onKeyDown={(event) => {
            // Opening review moves focus here. A held activation key must
            // not confirm the new operation without a separate key press.
            if (event.repeat && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          disabled={busy}
        >
          {busy ? "처리 중…" : confirmLabel}
        </ProductButton>
        <ProductButton ref={cancelRef} type="button" className="button button-secondary" onClick={cancel} disabled={busy}>
          {cancelLabel}
        </ProductButton>
      </div>
    </div>
  );
}
