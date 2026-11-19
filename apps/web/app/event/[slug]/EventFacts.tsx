import Link from "next/link";
import type { PublicEventContext } from "../../../lib/public-event-context";
import AttendeeIcon from "./AttendeeIcons";
import styles from "./event-facts.module.css";

// When and where, as two icon rows. It says exactly what PublicEventContext
// says (same group label, same <time>, same venue guide link) but reads as
// the facts of a pass instead of a run-on line. `fallbackDate` is the plain
// date a screen already showed when the page's schedule label is withheld.
export default function EventFacts({
  slug,
  context,
  fallbackDate = "",
  showDate = true,
}: {
  slug: string;
  context: PublicEventContext;
  fallbackDate?: string;
  showDate?: boolean;
}) {
  const dateLabel = showDate ? context.date || fallbackDate : "";
  const showDateTime = Boolean(dateLabel);
  const showTime = Boolean(context.time);
  const showWhen = showDateTime || showTime;
  const showWhere = Boolean(context.place) || context.hasVenueGuide;
  if (!showWhen && !showWhere) return null;
  return (
    <div
      className={styles.facts}
      role="group"
      aria-label={showDateTime ? "행사 일시와 장소" : showTime ? "행사 시간과 장소" : "행사 장소"}
    >
      {showWhen ? (
        <div className={styles.row}>
          <span className={styles.icon}><AttendeeIcon name="calendar" /></span>
          <p className={styles.text}>
            {showDateTime ? <time className={styles.strong} dateTime={context.dateTime || undefined}>{dateLabel}</time> : null}
            {showTime ? <span className={showDateTime ? styles.sub : styles.strong}>{context.time}</span> : null}
          </p>
        </div>
      ) : null}
      {showWhere ? (
        <div className={styles.row}>
          <span className={styles.icon}><AttendeeIcon name="pin" /></span>
          <p className={styles.text}>
            {context.place ? <span className={styles.strong}>{context.place}</span> : null}
          </p>
          {context.hasVenueGuide ? (
            <Link className={styles.guideLink} href={`/event/${encodeURIComponent(slug)}#public-venue`}>오시는 길</Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
