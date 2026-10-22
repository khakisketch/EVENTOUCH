import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

type ConsoleSectionProps = {
  headingId: string;
  title: string;
  description?: ReactNode;
  /** Section actions are supplementary and must use the secondary button style. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  density?: "default" | "compact";
  divider?: boolean;
  /**
   * Visual surface. `plain` keeps the section chrome-free on the page ground;
   * `panel` lifts one self-contained unit onto paper. Never nest panels.
   */
  surface?: "plain" | "panel";
  /**
   * Body width. `full` spans the page; `form` caps the body at the shared
   * reading width while the section header keeps page alignment.
   */
  width?: "full" | "form";
};

export default function ConsoleSection({
  headingId,
  title,
  description,
  action,
  children,
  className,
  density = "default",
  divider = false,
  surface = "plain",
  width = "full",
}: ConsoleSectionProps) {
  const classNames = [
    styles.section,
    density === "compact" ? styles.sectionCompact : "",
    divider ? styles.sectionDivider : "",
    surface === "panel" ? styles.sectionPanel : "",
    width === "form" ? styles.sectionForm : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <section className={classNames} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionCopy}>
          <h2 className={styles.sectionTitle} id={headingId}>{title}</h2>
          {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        </div>
        {action ? <div className={styles.sectionAction}>{action}</div> : null}
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
