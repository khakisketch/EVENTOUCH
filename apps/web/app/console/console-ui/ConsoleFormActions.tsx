import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

type ConsoleFormActionsProps = {
  children: ReactNode;
  /** Quiet helper or cost note beside the buttons. */
  note?: ReactNode;
  /** `end` right-aligns; `between` pins the note left and buttons right. */
  align?: "end" | "between";
  /**
   * Keeps the row at the bottom of the scrolling work area while its form is
   * longer than the window (행사 설정의 접수 양식·기능 저장 줄). It gets a
   * hairline on top and the white work surface behind, so fields never show
   * through. A sticky row stays layout only: it still performs no automatic
   * save, and its buttons keep their own roles.
   */
  sticky?: boolean;
};

/**
 * Standardized action row closing an editing unit. Layout only: it owns no
 * write semantics and performs no automatic save. Hook-free.
 */
export default function ConsoleFormActions({
  children,
  note,
  align = "end",
  sticky = false,
}: ConsoleFormActionsProps) {
  const classNames = [
    styles.formActions,
    align === "between" ? styles.formActionsBetween : "",
    sticky ? styles.formActionsSticky : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classNames}>
      {note ? <div className={styles.formActionsNote}>{note}</div> : null}
      <div className={styles.formActionsButtons}>{children}</div>
    </div>
  );
}
