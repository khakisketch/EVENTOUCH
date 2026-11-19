import { Section } from "@astryxdesign/core/Section";
import { Heading } from "@astryxdesign/core/Heading";
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
   * Editing width. `full` spans the page; `form` keeps the complete editing
   * unit, including its heading and actions, at the shared reading width.
   */
  width?: "full" | "form";
  /**
   * Heading treatment. `rule` (design-system C1) puts a hairline under the
   * title row and sets the title at the section scale; `default` is unchanged.
   */
  heading?: "default" | "rule";
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
  heading = "default",
}: ConsoleSectionProps) {
  const classNames = [
    styles.section,
    density === "compact" ? styles.sectionCompact : "",
    divider ? styles.sectionDivider : "",
    surface === "panel" ? styles.sectionPanel : "",
    width === "form" ? styles.sectionForm : "",
    heading === "rule" ? styles.sectionRule : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <Section variant="transparent" padding={0} className={classNames} role="region" aria-labelledby={headingId} data-workspace-section={headingId}>
      <div className={styles.sectionHead} data-console-section-head>
        <div className={styles.sectionCopy}>
          <Heading level={2} className={styles.sectionTitle} id={headingId}>{title}</Heading>
          {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        </div>
        {action ? <div className={styles.sectionAction}>{action}</div> : null}
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </Section>
  );
}
