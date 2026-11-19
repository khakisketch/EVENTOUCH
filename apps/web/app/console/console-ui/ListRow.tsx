"use client";

/*
 * ListRow — design-system foundation (2026-11-20, direction C1).
 * One list row: leading slot (avatar/tile), title + meta, trailing slot
 * (pill/meter/chevron). Replaces the hand-rolled participant, program,
 * client and team rows. With `href` or `onClick` the WHOLE row is one link or
 * button, so the trailing slot must stay non-interactive (pill, meter,
 * chevron). Static rows may hold their own controls in the trailing slot.
 * Hook-free.
 */
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { ChevronRightIcon } from "./ConsoleIcons";
import styles from "./list-row.module.css";

type ListRowProps = {
  title: ReactNode;
  meta?: ReactNode;
  /** Avatar or tile; decorative or self-labelled. */
  leading?: ReactNode;
  /** Pill, meter or text. Non-interactive when the row itself is a target. */
  trailing?: ReactNode;
  /** Whole row becomes a link. */
  href?: string;
  /** Whole row becomes a button (ignored when `href` is set). */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Marks the row as the current item of a list. */
  current?: boolean;
  /** Decorative chevron after the trailing slot; only on interactive rows. */
  chevron?: boolean;
  density?: "dense" | "comfortable";
  /** Row element; use `li` inside a `ul`. */
  as?: "div" | "li";
  className?: string;
};

export default function ListRow({
  title,
  meta,
  leading,
  trailing,
  href,
  onClick,
  current,
  chevron = false,
  density = "comfortable",
  as: Root = "div",
  className,
}: ListRowProps) {
  const interactive = Boolean(href || onClick);
  const content = (
    <>
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.main}>
        <span className={styles.title}>{title}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {interactive && chevron ? <span className={styles.chevron} aria-hidden="true"><ChevronRightIcon /></span> : null}
    </>
  );
  const ariaCurrent = current ? "true" : undefined;
  return (
    <Root
      className={[styles.row, className].filter(Boolean).join(" ")}
      data-list-row={interactive ? "interactive" : "static"}
      data-density={density}
    >
      {href ? (
        <Link href={href} className={styles.body} aria-current={ariaCurrent}>{content}</Link>
      ) : onClick ? (
        <button type="button" className={styles.body} onClick={onClick} aria-current={ariaCurrent}>{content}</button>
      ) : (
        <div className={styles.body} aria-current={ariaCurrent}>{content}</div>
      )}
    </Root>
  );
}
