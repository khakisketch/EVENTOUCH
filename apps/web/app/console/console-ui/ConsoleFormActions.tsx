import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

type ConsoleFormActionsProps = {
  children: ReactNode;
  /** Quiet helper or cost note beside the buttons. */
  note?: ReactNode;
  /** `end` right-aligns; `between` pins the note left and buttons right. */
  align?: "end" | "between";
};

/**
 * Standardized action row closing an editing unit. Layout only: it owns no
 * write semantics and performs no automatic save. Hook-free.
 */
export default function ConsoleFormActions({
  children,
  note,
  align = "end",
}: ConsoleFormActionsProps) {
  const classNames = [
    styles.formActions,
    align === "between" ? styles.formActionsBetween : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classNames}>
      {note ? <div className={styles.formActionsNote}>{note}</div> : null}
      <div className={styles.formActionsButtons}>{children}</div>
    </div>
  );
}
