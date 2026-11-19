/*
 * StatCard + StatRow — design-system foundation (2026-11-20, direction C1).
 * One big-number card (label, tabular number, unit, detail) and its responsive
 * grid. Replaces the five hand-rolled stat/summary cards. Use only where the
 * number is the job; otherwise print the number inline. Hook-free. With `href`
 * the whole card is one link (the label, number and unit form its name).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./stat-card.module.css";

export type StatCardTone = "default" | "wait" | "ok";

type StatCardProps = {
  label: string;
  value: ReactNode;
  unit?: string;
  detail?: ReactNode;
  /** wait = work waiting on a person (amber); ok = done / healthy (green). */
  tone?: StatCardTone;
  /** Makes the whole card a single link target. */
  href?: string;
  className?: string;
};

export default function StatCard({ label, value, unit, detail, tone = "default", href, className }: StatCardProps) {
  const classNames = [styles.card, href ? styles.link : "", className].filter(Boolean).join(" ");
  const body = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={styles.figure}>
        <strong className={styles.value}>{value}</strong>
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </span>
      {detail ? <span className={styles.detail}>{detail}</span> : null}
    </>
  );
  if (href) {
    return <Link href={href} className={classNames} data-stat-card={tone}>{body}</Link>;
  }
  return <div className={classNames} data-stat-card={tone}>{body}</div>;
}

type StatRowProps = {
  /** Columns on wide screens; the row folds to fewer on phones. */
  columns?: 2 | 3 | 4;
  /** Names the group for assistive technology. */
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
};

export function StatRow({ columns = 4, ariaLabel, children, className }: StatRowProps) {
  return (
    <div
      className={[styles.row, className].filter(Boolean).join(" ")}
      data-stat-row={columns}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}
