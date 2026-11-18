import Link from "next/link";
import styles from "./public-event-context.module.css";
import type { PublicEventContext as EventContext } from "../../../lib/public-event-context";

export default function PublicEventContext({
  slug,
  context,
  showDate = true,
  align = "center",
}: {
  slug: string;
  context: EventContext;
  showDate?: boolean;
  align?: "start" | "center";
}) {
  const showVisibleDate = showDate && Boolean(context.date);
  const showVisibleTime = Boolean(context.time);
  const showSchedule = showVisibleDate || showVisibleTime;
  if (!showSchedule && !context.place && !context.hasVenueGuide) return null;

  return (
    <div
      className={styles.context}
      data-align={align}
      role="group"
      aria-label={showVisibleDate ? "행사 일시와 장소" : showVisibleTime ? "행사 시간과 장소" : "행사 장소"}
    >
      {showSchedule ? (
        <>
          {showVisibleDate ? <time dateTime={context.dateTime || undefined}>{context.date}</time> : null}
          {showVisibleDate && showVisibleTime ? <span className={styles.separator} aria-hidden="true">·</span> : null}
          {showVisibleTime ? <span>{context.time}</span> : null}
        </>
      ) : null}
      {showSchedule && context.place ? <span className={styles.separator} aria-hidden="true">·</span> : null}
      {context.place ? <span className={styles.place}>{context.place}</span> : null}
      {context.hasVenueGuide ? (
        <Link className={styles.guideLink} href={`/event/${encodeURIComponent(slug)}#public-venue`}>
          오시는 길
        </Link>
      ) : null}
    </div>
  );
}
