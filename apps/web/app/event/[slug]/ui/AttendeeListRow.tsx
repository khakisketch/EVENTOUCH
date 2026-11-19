import Link from "next/link";
import type { ReactNode } from "react";
import AttendeeIcon, { type AttendeeIconName } from "./AttendeeIcon";
import styles from "./AttendeeListRow.module.css";

// A row of a menu or list: an icon tile in the event's soft color (a solid
// accent disc on an a2 ground), the title with its meta line and a chevron.
// The whole row is one target of at least 56px: a link with href, a button with
// onClick, or a static row without either. Rows belong in an AttendeeList
// inside a card.
export function AttendeeList({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  // role="list" keeps the list semantics when list-style is removed.
  return <ul className={className ? `${styles.list} ${className}` : styles.list} role="list" aria-label={label}>{children}</ul>;
}

type RowProps = {
  icon: AttendeeIconName;
  title: ReactNode;
  meta?: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Replaces the chevron, e.g. a count or a status word. */
  trailing?: ReactNode;
  className?: string;
};

export default function AttendeeListRow({ icon, title, meta, href, onClick, disabled, trailing, className }: RowProps) {
  const body = (
    <>
      <span className={styles.tile} aria-hidden="true"><AttendeeIcon name={icon} size={22} /></span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : href || onClick ? <span className={styles.chevron} aria-hidden="true"><AttendeeIcon name="chevron" size={20} /></span> : null}
    </>
  );
  const classes = className ? `${styles.row} ${className}` : styles.row;
  if (href && !disabled) {
    return <li className={styles.item}><Link className={classes} href={href}>{body}</Link></li>;
  }
  if (onClick) {
    return <li className={styles.item}><button type="button" className={classes} onClick={onClick} disabled={disabled}>{body}</button></li>;
  }
  return <li className={styles.item}><div className={classes}>{body}</div></li>;
}
