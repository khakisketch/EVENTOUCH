/*
 * StatusPill — design-system foundation (2026-11-20, direction C1).
 * One status pill. Replaces the global .status-chip / .pill status use and the
 * per-screen badges (7+ variants), including the dark-stage LivePill of the
 * 현장 모드 room. Hook-free. The label is always visible: colour is never the
 * only signal. Orange text uses --brand-text, never white on --brand.
 *
 * Shared-gap additions (2026-11-20, all optional; the default output is
 * unchanged):
 *  - Any other DOM attribute (`id`, `title`, `role`, `aria-*`, `data-*`) is
 *    passed to the <span>. `data-status-pill` and `data-size` stay ours.
 *  - tone "on-dark" (quiet outline), "on-dark-ok", "on-dark-wait" and
 *    "on-dark-danger" are for dark faces (the live room, staff column, dark
 *    hero cards). They use the light status line colours (--on-dark-* in
 *    tokens.css), never the light-surface tints, so contrast holds on --stage.
 *  - align "start" | "center" | "end" places the pill inside a grid or flex
 *    cell of a list (the pill column of a row), replacing per-screen
 *    `justify-self` overrides.
 */
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./status-pill.module.css";

export type StatusPillTone =
  | "ok" | "wait" | "info" | "danger" | "neutral" | "live" | "ink"
  | "on-dark" | "on-dark-ok" | "on-dark-wait" | "on-dark-danger";

type StatusPillProps = Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className"> & {
  tone?: StatusPillTone;
  size?: "sm" | "md";
  /** Leading status dot (decorative). */
  dot?: boolean;
  /** Where the pill sits in the grid or flex cell of a list row. Default: where the layout puts it. */
  align?: "start" | "center" | "end";
  children: ReactNode;
  className?: string;
};

export default function StatusPill({ tone = "neutral", size = "md", dot = false, align, children, className, ...rest }: StatusPillProps) {
  return (
    <span
      {...rest}
      className={[styles.pill, className].filter(Boolean).join(" ")}
      data-status-pill={tone}
      data-size={size}
      data-align={align}
    >
      {dot ? <i className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
