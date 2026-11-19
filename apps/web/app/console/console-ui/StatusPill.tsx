/*
 * StatusPill — design-system foundation (2026-11-20, direction C1).
 * One status pill. Replaces the global .status-chip / .pill status use and the
 * per-screen badges (7+ variants). Hook-free. The label is always visible:
 * colour is never the only signal. Orange text uses --brand-text, never white
 * on --brand.
 */
import type { ReactNode } from "react";
import styles from "./status-pill.module.css";

export type StatusPillTone = "ok" | "wait" | "info" | "danger" | "neutral" | "live" | "ink";

type StatusPillProps = {
  tone?: StatusPillTone;
  size?: "sm" | "md";
  /** Leading status dot (decorative). */
  dot?: boolean;
  children: ReactNode;
  className?: string;
};

export default function StatusPill({ tone = "neutral", size = "md", dot = false, children, className }: StatusPillProps) {
  return (
    <span
      className={[styles.pill, className].filter(Boolean).join(" ")}
      data-status-pill={tone}
      data-size={size}
    >
      {dot ? <i className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
