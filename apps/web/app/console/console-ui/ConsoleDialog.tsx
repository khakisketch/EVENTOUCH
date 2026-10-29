"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import styles from "./console-ui.module.css";

type ConsoleDialogProps = {
  title: string;
  titleId?: string;
  description?: ReactNode;
  /** Stable id for the description wrapper; defaults to `${headingId}-description`. */
  descriptionId?: string;
  onClose: () => void;
  /** While busy, Escape and backdrop clicks do not close the dialog. */
  busy?: boolean;
  /**
   * Synchronous dismissal gate consulted by the central Escape and backdrop
   * paths before `onClose`. Return false to keep the dialog mounted for
   * in-flight submit refs or dirty-form confirmation. Absent keeps the
   * existing default: closable whenever not busy. A caller Cancel button
   * should consult the same predicate, e.g.
   * `if (!busy && (!canClose || canClose())) onClose()`.
   */
  canClose?: () => boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /**
   * Opt-in sticky chrome for long forms (event create/duplicate). When true
   * the title row (with an explicit header close using the same
   * busy/canClose gate as Escape/backdrop) sticks to the top and the footer
   * sticks to the bottom of the shared `.dialog` scroller via inline token
   * styles. Default false keeps every existing caller byte-identical.
   */
  stickyChrome?: boolean;
  /** Visible header-close label; defaults to "닫기". */
  closeLabel?: string;
};

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/**
 * Shared modal shell for console management dialogs. The caller mounts it
 * conditionally and owns all form state, writes, idempotency keys and
 * destructive confirmations; this component owns only the chrome: trapped
 * Tab across actually visible controls, initial focus, Escape/backdrop
 * close (disabled while `busy`, gated by `canClose`), body scroll lock
 * and restoring the previously focused element when it is still connected.
 *
 * Visuals reuse the shared dialog tokens; no new modal dependency.
 */
export default function ConsoleDialog({
  title,
  titleId,
  description,
  descriptionId,
  onClose,
  busy = false,
  canClose,
  initialFocusRef,
  children,
  footer,
  wide = false,
  stickyChrome = false,
  closeLabel = "닫기",
}: ConsoleDialogProps) {
  const fallbackId = useId();
  const headingId = titleId ?? `console-dialog-${fallbackId}`;
  const descriptionElementId = descriptionId ?? `${headingId}-description`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const canCloseRef = useRef(canClose);
  canCloseRef.current = canClose;
  const initialFocusRefHolder = useRef(initialFocusRef);
  initialFocusRefHolder.current = initialFocusRef;

  function requestClose() {
    if (busyRef.current) return;
    if (canCloseRef.current && !canCloseRef.current()) return;
    onCloseRef.current();
  }
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialog = dialogRef.current;
    const requested = initialFocusRefHolder.current?.current;
    const usableRequested =
      requested &&
      dialog?.contains(requested) &&
      isVisible(requested) &&
      !requested.matches(":disabled")
        ? requested
        : null;
    const initialTarget =
      usableRequested ?? dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialog;
    if (initialTarget && isVisible(initialTarget)) {
      initialTarget.focus();
    } else {
      dialog?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((item) => item.tabIndex >= 0 && isVisible(item));
      if (!items.length) {
        // No tabbable controls: hold focus on the container so Tab can
        // never reach the page behind the dialog.
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Focus on the container itself or anywhere outside the dialog wraps
      // too; otherwise the container's own next Tab escapes behind the page.
      const outside = active === dialog || !(active instanceof Node && dialog.contains(active));
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Each mount saves and restores its own previous value, so nested
      // dialogs unwind in order without unlocking the outer lock early.
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className={wide ? `dialog ${styles.dialogWide}` : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={description ? descriptionElementId : undefined}
        tabIndex={-1}
      >
        {stickyChrome ? (
          <div
            style={{
              position: "sticky",
              top: "calc(var(--s5) * -1)",
              zIndex: 2,
              margin: "calc(var(--s5) * -1) calc(var(--s5) * -1) 0",
              padding: "var(--s5) clamp(var(--s3), 4vw, var(--s5)) var(--s3)",
              background: "var(--paper)",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--s3)",
            }}
          >
            <h2 id={headingId} style={{ margin: 0 }}>{title}</h2>
            <button
              type="button"
              className="button button-secondary"
              style={{ flex: "none" }}
              onClick={() => requestClose()}
              disabled={busy}
            >
              {closeLabel}
            </button>
          </div>
        ) : (
          <h2 id={headingId}>{title}</h2>
        )}
        {description ? <div className={styles.dialogDescription} id={descriptionElementId}>{description}</div> : null}
        {children}
        {footer ? (
          stickyChrome ? (
            <div
              className="dialog-actions"
              style={{
                position: "sticky",
                bottom: "calc(var(--s5) * -1)",
                zIndex: 2,
                margin: "0 calc(var(--s5) * -1) calc(var(--s5) * -1)",
                padding: "var(--s3) clamp(var(--s3), 4vw, var(--s5)) var(--s5)",
                background: "var(--paper)",
                borderTop: "1px solid var(--line)",
              }}
            >
              {footer}
            </div>
          ) : (
            <div className="dialog-actions">{footer}</div>
          )
        ) : null}
      </div>
    </div>
  );
}
