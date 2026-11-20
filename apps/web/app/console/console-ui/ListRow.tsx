"use client";

/*
 * ListRow — design-system foundation (2026-11-20, direction C1).
 * One list row: leading slot (avatar/tile), title + meta, trailing slot
 * (pill/meter/chevron). Replaces the hand-rolled participant, program,
 * client and team rows. With `href` or `onClick` the WHOLE row is one link or
 * button, so the trailing slot must stay non-interactive (pill, meter,
 * chevron). Static rows may hold their own controls in the trailing slot.
 * Hook-free.
 *
 * Shared-gap additions (2026-11-20, all optional; the default output is
 * unchanged). Pick the row's interaction in one of four ways:
 *  1. `href` / `onClick`: the body is one link or button (above).
 *  2. `cover` + <ListRowOpen> as the `title`: the title is the ONE button and
 *     its ::after stretches the hit area over the whole row, so the row is a
 *     single target without nesting controls. Controls in `center`,
 *     `trailing` and `action` stay clickable above it (reorder buttons, a
 *     switch). This is the documented pattern for "name button covers the row".
 *  3. `action`: a separate control (switch, menu) beside a row that is itself
 *     a link/button; it sits outside the target, never inside it.
 *  4. `as="summary"`: the row is the <summary> of a <details>; the chevron turns
 *     when it opens. The row is one target, so keep slots non-interactive.
 * Other options:
 *  - `id`, `data-*`, `aria-*` and other DOM attributes go to the row element;
 *    `titleProps` goes to the title element (focus target, `aria-labelledby`).
 *  - `titleAs` "h3" | "h4" makes the title a heading for rows that belong in
 *    the page outline. A button row keeps a span (a heading may not live in a
 *    <button>).
 *  - `center` is a flexible slot between the text and `trailing` (a bar or
 *    meter); `trailingWidth="free"` lifts the 50% cap on `trailing`.
 *  - `variant="timeline"` with `time` adds a time column and a rail dot
 *    (`railTone`) joined by a line to the next row.
 */
import Link from "next/link";
import type { ButtonHTMLAttributes, HTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { ChevronRightIcon } from "./ConsoleIcons";
import styles from "./list-row.module.css";

export type ListRowRailTone = "ok" | "wait" | "info" | "neutral";

type ListRowProps = Omit<HTMLAttributes<HTMLElement>, "title" | "children" | "className" | "onClick"> & {
  title: ReactNode;
  /** Title element. Default `span`. A button row (`onClick`) always keeps a span. */
  titleAs?: "span" | "h3" | "h4";
  /** Attributes for the title element (id, tabIndex for a focus target). */
  titleProps?: Omit<HTMLAttributes<HTMLElement>, "children" | "className">;
  meta?: ReactNode;
  /** Avatar or tile; decorative or self-labelled. */
  leading?: ReactNode;
  /** Flexible slot between the text and `trailing`: a bar or meter. */
  center?: ReactNode;
  /** Pill, meter or text. Non-interactive when the row itself is a target. */
  trailing?: ReactNode;
  /** `capped` (default) limits `trailing` to half the row; `free` lets it size to its content. */
  trailingWidth?: "capped" | "free";
  /** A separate control beside the row target (switch, menu). Outside the link or button. */
  action?: ReactNode;
  /** Whole row becomes a link. */
  href?: string;
  /** Whole row becomes a button (ignored when `href` is set). */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** The title holds one <ListRowOpen> whose hit area covers the row. Static rows only. */
  cover?: boolean;
  /** Marks the row as the current item of a list. */
  current?: boolean;
  /** Decorative chevron after the trailing slot; only on interactive rows. */
  chevron?: boolean;
  density?: "dense" | "comfortable";
  /** `timeline` puts `time` and a rail dot before the text. */
  variant?: "row" | "timeline";
  /** Timeline: the time column (use a <time> element). */
  time?: ReactNode;
  /** Timeline: the rail dot tone. */
  railTone?: ListRowRailTone;
  /** Row element; use `li` inside a `ul`, `summary` inside a `details`. */
  as?: "div" | "li" | "summary";
  className?: string;
};

type ListRowOpenProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

/**
 * The one button of a `cover` row: put it in the row's `title`. It looks like
 * the title text; its ::after covers the row. Give it an `aria-label` that
 * names the action when the visible text alone is not enough.
 */
export function ListRowOpen({ type = "button", ...props }: ListRowOpenProps) {
  return <button type={type} className={styles.titleOpen} {...props} />;
}

export default function ListRow({
  title,
  titleAs = "span",
  titleProps,
  meta,
  leading,
  center,
  trailing,
  trailingWidth = "capped",
  action,
  href,
  onClick,
  cover = false,
  current,
  chevron = false,
  density = "comfortable",
  variant = "row",
  time,
  railTone = "neutral",
  as: Root = "div",
  className,
  ...rest
}: ListRowProps) {
  const isSummary = Root === "summary";
  const linked = Boolean(href || onClick);
  const interactive = linked || isSummary;
  const Title = onClick && !href ? "span" : titleAs;
  const timeline = variant === "timeline";
  const content = (
    <>
      {timeline ? <span className={styles.time}>{time}</span> : null}
      {timeline ? <span className={styles.rail} data-rail={railTone} aria-hidden="true" /> : null}
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.main}>
        <Title {...titleProps} className={styles.title}>{title}</Title>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </span>
      {center ? <span className={styles.center}>{center}</span> : null}
      {trailing ? <span className={styles.trailing} data-width={trailingWidth === "free" ? "free" : undefined}>{trailing}</span> : null}
      {interactive && chevron ? <span className={styles.chevron} aria-hidden="true"><ChevronRightIcon /></span> : null}
    </>
  );
  const ariaCurrent = current ? "true" : undefined;
  const marks = {
    "data-density": density,
    "data-list-row-variant": timeline ? "timeline" : undefined,
    "data-has-action": action ? "true" : undefined,
  };

  // The row IS the <summary>: one element carries the row and the body styles.
  if (isSummary) {
    return (
      <summary
        {...rest}
        className={[styles.row, styles.body, styles.summary, className].filter(Boolean).join(" ")}
        data-list-row="interactive"
        {...marks}
      >
        {content}
      </summary>
    );
  }

  const Container = Root;
  return (
    <Container
      {...rest}
      className={[styles.row, className].filter(Boolean).join(" ")}
      data-list-row={linked ? "interactive" : cover ? "cover" : "static"}
      {...marks}
    >
      {href ? (
        <Link href={href} className={styles.body} aria-current={ariaCurrent}>{content}</Link>
      ) : onClick ? (
        <button type="button" className={styles.body} onClick={onClick} aria-current={ariaCurrent}>{content}</button>
      ) : (
        <div className={styles.body} aria-current={ariaCurrent}>{content}</div>
      )}
      {action ? <span className={styles.action}>{action}</span> : null}
    </Container>
  );
}
