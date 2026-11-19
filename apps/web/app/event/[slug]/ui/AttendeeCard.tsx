import { useId, type ReactNode } from "react";
import styles from "./AttendeeCard.module.css";

// The attendee card: a 22px-radius surface. "soft" is a quiet gray panel on a
// white ground (a1); "white" is a hairline-bordered white card. On an a2 ground
// (the event color) both become white cards. With a heading it is a labelled
// region; without one it is a plain block.
export type AttendeeCardProps = {
  surface?: "soft" | "white";
  padding?: "sm" | "md" | "lg";
  heading?: ReactNode;
  /** Heading level; the page's own heading hierarchy decides. */
  headingLevel?: 2 | 3 | 4;
  as?: "div" | "section" | "article";
  className?: string;
  children: ReactNode;
};

export default function AttendeeCard({
  surface = "soft",
  padding = "md",
  heading,
  headingLevel = 2,
  as,
  className,
  children,
}: AttendeeCardProps) {
  const headingId = useId();
  const Tag = as ?? (heading ? "section" : "div");
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const classes = [styles.card, styles[surface], styles[padding], className].filter(Boolean).join(" ");
  return (
    <Tag className={classes} aria-labelledby={heading ? headingId : undefined}>
      {heading ? <Heading id={headingId} className={styles.heading}>{heading}</Heading> : null}
      {children}
    </Tag>
  );
}
