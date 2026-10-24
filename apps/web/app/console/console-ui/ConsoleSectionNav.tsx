import styles from "./console-ui.module.css";

export type ConsoleSectionNavItem = {
  /** Must match an existing section heading id on the page. */
  id: string;
  label: string;
};

type ConsoleSectionNavProps = {
  items: readonly ConsoleSectionNavItem[];
  label?: string;
  /**
   * Id of the section currently in view. The matching link alone carries
   * `aria-current="location"` with a token-only active style (background
   * plus a non-color signal), so the current position reads once, in the
   * links themselves. Omitted by pages without section tracking, which
   * keep rendering a regular nav with no current marker.
   */
  activeId?: string;
  /**
   * Fired when the operator explicitly jumps through a link (mouse, touch,
   * or keyboard activation), once the target section resolves. Lets the
   * page name the jumped-to section at once instead of waiting for the
   * scroll spy, which cannot see headings parked outside its band.
   */
  onNavigate?: (id: string) => void;
};

/**
 * In-page jump links to existing section headings. Native anchors only,
 * not app navigation. Renders nothing when there are no items so empty
 * pages keep no dead space.
 *
 * Activating a link makes the target focusable and hands focus to it
 * directly, so the browser hands focus to the section it jumped to and the
 * next Tab continues inside it instead of back at the top of the page. The
 * fragment still changes, so a section can be copied and reopened.
 */
export default function ConsoleSectionNav({ items, label, activeId, onNavigate }: ConsoleSectionNavProps) {
  if (!items.length) return null;

  return (
    <nav className={styles.sectionNav} aria-label={label ?? "섹션 바로가기"}>
      <ul className={styles.sectionNavList}>
        {items.map((item) => {
          const isActive = activeId !== undefined && item.id === activeId;
          return (
          <li key={item.id}>
            <a
              className={styles.sectionNavLink}
              href={`#${item.id}`}
              data-skip-to={item.id}
              aria-current={isActive ? "location" : undefined}
              onClick={() => {
                // The anchor still navigates (the fragment stays copyable),
                // but the target is made focusable first and focus is handed
                // over directly, so the next Tab continues inside the jumped
                // section instead of back at the top of the page. Focus moves
                // without scrolling first; the explicit scroll lands the
                // viewport on the section even where the browser would not
                // scroll a programmatic focus on its own.
                const target = document.getElementById(item.id);
                if (!target) return;
                // The operator chose this section explicitly: report it at
                // once so the page can name it instead of waiting for the
                // scroll spy, which may never see this heading cross its band.
                onNavigate?.(item.id);
                if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
                if (target instanceof HTMLElement) target.focus({ preventScroll: true });
                target.scrollIntoView({ block: "start" });
              }}
            >
              {item.label}
            </a>
          </li>
          );
        })}
      </ul>
    </nav>
  );
}
