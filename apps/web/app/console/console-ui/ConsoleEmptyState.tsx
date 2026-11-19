/*
 * ConsoleEmptyState — design-system foundation (2026-11-20, direction C1).
 * One empty / filtered-out / soft-error block for console lists and panels.
 * Replaces the ~15 hand-rolled empty states (.empty, per-screen "no rows"
 * boxes). Hook-free; the action is passed in as a ProductButton/ProductLink
 * so primary-action role rules stay with the caller (one primary per screen).
 */
import type { ReactNode } from "react";
import styles from "./console-empty-state.module.css";

export type ConsoleEmptyStateKind = "empty" | "filtered" | "error-soft";

type ConsoleEmptyStateProps = {
  /** empty = nothing exists yet (dashed); filtered = a filter hides rows (flat); error-soft = could not load, not urgent. */
  kind?: ConsoleEmptyStateKind;
  title: ReactNode;
  description?: ReactNode;
  /** A ProductButton or ProductLink. Keep it secondary unless this is the screen's one primary action. */
  action?: ReactNode;
  /** Decorative icon; hidden from assistive technology. */
  icon?: ReactNode;
  /** Element for the title. Default `p`: pick a heading only when it fits the page outline. */
  titleAs?: "p" | "h2" | "h3" | "h4";
  className?: string;
};

export default function ConsoleEmptyState({
  kind = "empty",
  title,
  description,
  action,
  icon,
  titleAs: Title = "p",
  className,
}: ConsoleEmptyStateProps) {
  return (
    <div
      className={[styles.empty, className].filter(Boolean).join(" ")}
      data-console-empty={kind}
      role={kind === "error-soft" ? "status" : undefined}
    >
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      <Title className={styles.title}>{title}</Title>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
