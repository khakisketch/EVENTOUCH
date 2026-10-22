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
 * pages keep no dead space.
 *
 * Activating a link makes the target focusable, so the browser hands
 * focus to the section it jumped to and the next Tab continues inside it
 * instead of back at the top of the page. The fragment still changes, so
 * a section can be copied and reopened.
 */
export default function ConsoleSectionNav({ items, label }: ConsoleSectionNavProps) {
  if (!items.length) return null;

  return (
    <nav className={styles.sectionNav} aria-label={label ?? "섹션 바로가기"}>
      <ul className={styles.sectionNavList}>
        {items.map((item) => (
          <li key={item.id}>
            <a
              className={styles.sectionNavLink}
              href={`#${item.id}`}
              data-skip-to={item.id}
              onClick={() => {
                // The anchor still navigates (the fragment stays copyable),
                // but the target is made focusable first so the browser
                // hands focus to the section it jumped to.
                const target = document.getElementById(item.id);
                if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
