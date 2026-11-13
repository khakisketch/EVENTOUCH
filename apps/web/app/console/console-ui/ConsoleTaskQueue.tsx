import Link from "../../ui/ProductLink";
import { ArrowRightIcon } from "./ConsoleIcons";
import styles from "./console-task-queue.module.css";

export type ConsoleTask = { key: string; title: string; count: string | null; hint: string; action: string; href: string };

export default function ConsoleTaskQueue({ items, label, empty = "확인할 항목이 없습니다.", variant }: {
  items: ConsoleTask[]; label: string; empty?: string; variant?: "live-overview";
}) {
  if (!items.length) return <p className={styles.empty} role="status">{empty}</p>;
  const liveOverview = variant === "live-overview";
  return <ul className={liveOverview ? `${styles.queue} ${styles.liveOverview}` : styles.queue} aria-label={label}>
    {items.map((item, index) => <li key={item.key} data-task={item.key}>
      <div className={styles.copy}>
        <div className={styles.head}><p>{item.title}</p>{item.count ? <span>{item.count}</span> : null}</div>
        {item.hint ? <p className={styles.hint}>{item.hint}</p> : null}
      </div>
      <Link variant={index === 0 ? "primary" : "ghost"} className={styles.action} href={item.href}>{item.action}{liveOverview ? <ArrowRightIcon /> : null}</Link>
    </li>)}
  </ul>;
}
