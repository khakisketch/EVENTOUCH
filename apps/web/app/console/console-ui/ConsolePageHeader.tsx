import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./console-ui.module.css";

export type ConsoleEventMeta = {
  clientName?: string;
  date?: string;
  start?: string;
  end?: string;
  venue?: string;
};

export type ConsolePageBack = {
  href: string;
  label: string;
};

type ConsolePageHeaderProps = {
  title: string;
  back?: ConsolePageBack;
  meta?: ReactNode;
  badges?: ReactNode;
  /** Header actions are supplementary and must use the secondary button style. */
  actions?: ReactNode;
  className?: string;
};

function formatDate(value: string): string {
  const date = value.trim();
  if (!date) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : date;
}

export function formatConsoleEventMeta(meta: ConsoleEventMeta): string | undefined {
  const time = [meta.start?.trim(), meta.end?.trim()].filter(Boolean).join("–");
  const values = [
    meta.clientName?.trim(),
    formatDate(meta.date ?? ""),
    time,
    meta.venue?.trim(),
  ].filter((value): value is string => Boolean(value));
  return values.length ? values.join(" · ") : undefined;
}

export default function ConsolePageHeader({
  title,
  back,
  meta,
  badges,
  actions,
  className,
}: ConsolePageHeaderProps) {
  const classNames = [styles.pageHeader, className].filter(Boolean).join(" ");

  return (
    <header className={classNames}>
      <div className={styles.pageIdentity}>
        {back ? (
          <Link className={styles.backLink} href={back.href}>
            {back.label}
          </Link>
        ) : null}
        <h1>{title}</h1>
        {meta ? <p className={styles.pageMeta}>{meta}</p> : null}
        {badges ? <div className={styles.pageBadges}>{badges}</div> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </header>
  );
}
