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
}: ConsoleSectionProps) {
  const classNames = [
    styles.section,
    density === "compact" ? styles.sectionCompact : "",
    divider ? styles.sectionDivider : "",
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
      {children}
    </section>
  );
}
