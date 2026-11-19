/*
 * SettingsToc — left table of contents for 행사 설정 (design-system apply,
 * 2026-11-20). Local to this screen: ConsoleSectionNav is a horizontal
 * underline strip, this one is a sticky side list that also says which
 * section holds unsaved edits ("변경됨") and what each one currently is.
 * Hook-free. Anchor links point at the existing section anchors; the basics
 * entry is a button because it opens the drawer rather than scrolling.
 */
import type { ReactNode } from "react";
import StatusPill from "../../../console-ui/StatusPill";
import styles from "./settings-toc.module.css";

export type SettingsTocItem = {
  id: string;
  label: string;
  /** Current state in one short phrase ("접수 중", "기능 9개 사용"). */
  hint?: ReactNode;
  /** Unsaved edits wait in this section. */
  dirty?: boolean;
  /** Anchor target; omit when `onSelect` opens a drawer instead. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
};

export default function SettingsToc({ items }: { items: readonly SettingsTocItem[] }) {
  return (
    <nav className={styles.toc} aria-label="설정 목차" data-settings-toc>
      <ol className={styles.list}>
        {items.map((item, index) => {
          const body = (
            <>
              <span className={styles.index} aria-hidden="true">{index + 1}</span>
              <span className={styles.copy}>
                <span className={styles.label}>{item.label}</span>
                {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
              </span>
              {item.dirty ? <StatusPill tone="wait" size="sm" dot>변경됨</StatusPill> : null}
            </>
          );
          return (
            <li key={item.id} className={styles.item}>
              {item.href ? (
                <a className={styles.link} href={item.href}>{body}</a>
              ) : (
                <button type="button" className={styles.link} disabled={item.disabled} onClick={item.onSelect}>{body}</button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
