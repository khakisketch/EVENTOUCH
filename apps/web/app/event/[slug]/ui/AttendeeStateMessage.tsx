import Link from "next/link";
import type { ReactNode } from "react";
import AttendeeIcon, { type AttendeeIconName } from "./AttendeeIcon";
import styles from "./AttendeeStateMessage.module.css";

// One message for what a screen cannot show or did not accept: nothing here
// yet (empty), something went wrong (error) or a neutral notice (info). It
// replaces the per-screen error lines and empty blocks. An error is announced
// at once (role="alert"); an empty or info state waits politely (role="status").
export type AttendeeStateKind = "empty" | "error" | "info";

const DEFAULT_ICON: Record<AttendeeStateKind, AttendeeIconName> = {
  empty: "board",
  error: "alert",
  info: "info",
};

export default function AttendeeStateMessage({
  kind,
  title,
  children,
  icon,
  action,
  className,
}: {
  kind: AttendeeStateKind;
  title: ReactNode;
  /** The explanation: what happened and what to do next. */
  children?: ReactNode;
  icon?: AttendeeIconName;
  action?: { label: string; href?: string; onClick?: () => void };
  className?: string;
}) {
  const classes = [styles.message, styles[kind], className].filter(Boolean).join(" ");
  return (
    <div className={classes} role={kind === "error" ? "alert" : "status"} data-state-kind={kind}>
      <span className={styles.icon} aria-hidden="true"><AttendeeIcon name={icon ?? DEFAULT_ICON[kind]} size={22} /></span>
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        {children ? <p className={styles.text}>{children}</p> : null}
        {action?.href ? (
          <Link className={styles.action} href={action.href}>{action.label}</Link>
        ) : action?.onClick ? (
          <button type="button" className={styles.action} onClick={action.onClick}>{action.label}</button>
        ) : null}
      </div>
    </div>
  );
}
