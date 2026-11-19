import Link from "next/link";
import type { ReactNode } from "react";
import AttendeeIcon from "./AttendeeIcon";
import styles from "./AttendeeSectionHeader.module.css";

// A section's head: a small label, a big title and, when there is somewhere to
// go, one action link. It sits on the ground by default (white ink on an a2
// ground); inside a card pass inCard so it keeps the card's ink.
export default function AttendeeSectionHeader({
  label,
  title,
  level = 2,
  size = "lg",
  action,
  inCard = false,
  className,
}: {
  label?: ReactNode;
  title: ReactNode;
  level?: 2 | 3 | 4;
  /** lg is the screen-section title; sm suits a block inside a screen. */
  size?: "lg" | "sm";
  action?: { label: string; href: string; ariaLabel?: string };
  inCard?: boolean;
  className?: string;
}) {
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  const classes = [styles.header, inCard ? styles.inCard : "", className].filter(Boolean).join(" ");
  return (
    <header className={classes}>
      <div className={styles.text}>
        {label ? <p className={styles.label}>{label}</p> : null}
        <Heading className={`${styles.title} ${size === "sm" ? styles.titleSmall : ""}`}>{title}</Heading>
      </div>
      {action ? (
        <Link className={styles.action} href={action.href} aria-label={action.ariaLabel}>
          <span>{action.label}</span>
          <AttendeeIcon name="chevron" size={16} />
        </Link>
      ) : null}
    </header>
  );
}
