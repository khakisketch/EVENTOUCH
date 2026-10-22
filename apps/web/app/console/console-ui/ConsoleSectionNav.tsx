import styles from "./console-ui.module.css";

export type ConsoleSectionNavItem = {
  /** Must match an existing section heading id on the page. */
  id: string;
  label: string;
};

type ConsoleSectionNavProps = {
  items: readonly ConsoleSectionNavItem[];
  label?: string;
};

/**
 * In-page jump links to existing section headings. Native anchors only,
 * not app navigation. Renders nothing when there are no items so empty
 * pages keep no dead space. Hook-free.
 */
export default function ConsoleSectionNav({ items, label }: ConsoleSectionNavProps) {
  if (!items.length) return null;

  return (
    <nav className={styles.sectionNav} aria-label={label ?? "섹션 바로가기"}>
      <ul className={styles.sectionNavList}>
        {items.map((item) => (
          <li key={item.id}>
            <a className={styles.sectionNavLink} href={`#${item.id}`}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
