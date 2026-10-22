import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

type ConsoleToolbarProps = {
  /** Search/filter controls. Stretches left; wraps on narrow screens. */
  filters?: ReactNode;
  /** Task actions. Pins right; primary buttons live here, not the header. */
  actions?: ReactNode;
  /** Selection summary. Renders a second row only while provided. */
  selection?: ReactNode;
  children?: ReactNode;
};

/**
 * One toolbar row for list workspaces. Empty slots render nothing, so a
 * page with only filters shows only filters: no fake placeholder rows.
 * Filter children wrap with equal weight; no child is special by
 * position. A filter that must own its row opts in with
 * `data-toolbar-span="full"`. Actions share one 44px baseline and stack
 * full-width on narrow screens; an intentionally paired group opts in
 * with `data-toolbar-inline`. Hook-free.
 */
export default function ConsoleToolbar({
  filters,
  actions,
  selection,
  children,
}: ConsoleToolbarProps) {
  if (!filters && !actions && !selection && !children) return null;

  return (
    <div className={styles.toolbar}>
      {filters || actions ? (
        <div className={styles.toolbarMain}>
          {filters ? <div className={styles.toolbarFilters}>{filters}</div> : null}
          {actions ? <div className={styles.toolbarActions}>{actions}</div> : null}
        </div>
      ) : null}
      {selection ? <div className={styles.toolbarSelection}>{selection}</div> : null}
      {children}
    </div>
  );
}
