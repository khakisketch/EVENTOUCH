/*
 * ConsoleEmptyState — design-system foundation (2026-11-20, direction C1).
 * One empty / filtered-out / soft-error block for console lists and panels.
 * Replaces the ~15 hand-rolled empty states (.empty, per-screen "no rows"
 * boxes). Hook-free; the action is passed in as a ProductButton/ProductLink
 * so primary-action role rules stay with the caller (one primary per screen).
 *
 * Shared-gap additions (2026-11-20, optional; the default output is unchanged):
 *  - tone "amber": work waiting on a person (a missing desk, a gap in
 *    coverage). Amber border, amber wash, amber title; the words still say
 *    what is missing, colour is never the only signal.
 *  - size "sm": a block inside a card or a tight list (less padding, one step
 *    smaller title). Default "md".
 *  - titleAs defaults to `p`, so an empty state never adds a heading the page
 *    outline did not ask for. Where the block IS the section's content and
 *    needs a title in the outline, pass `titleAs="h3"` under the section's h2
 *    (`h2` only where no section heading sits above).
 */
import type { ReactNode } from "react";
import styles from "./console-empty-state.module.css";

export type ConsoleEmptyStateKind = "empty" | "filtered" | "error-soft";

type ConsoleEmptyStateProps = {
  /** empty = nothing exists yet (dashed); filtered = a filter hides rows (flat); error-soft = could not load, not urgent. */
  kind?: ConsoleEmptyStateKind;
  /** amber = work waiting on a person. Default keeps the kind's own colours. */
  tone?: "default" | "amber";
  /** sm = inside a card or tight list. */
  size?: "md" | "sm";
  title: ReactNode;
  description?: ReactNode;
  /** A ProductButton or ProductLink. Keep it secondary unless this is the screen's one primary action. */
  action?: ReactNode;
  /** Decorative icon; hidden from assistive technology. */
  icon?: ReactNode;
  /** Element for the title. Default `p`; use `h3` under a section h2 when the title belongs in the outline. */
  titleAs?: "p" | "h2" | "h3" | "h4";
  className?: string;
};

export default function ConsoleEmptyState({
  kind = "empty",
  tone = "default",
  size = "md",
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
      data-tone={tone === "amber" ? "amber" : undefined}
      data-size={size === "sm" ? "sm" : undefined}
      role={kind === "error-soft" ? "status" : undefined}
    >
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      <Title className={styles.title}>{title}</Title>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
