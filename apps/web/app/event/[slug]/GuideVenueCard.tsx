import type { ReactNode } from "react";
import GuideIcon from "./GuideIcon";
import styles from "./public-event.module.css";

// The venue card of the event guide: the place name with its address slot, then
// directions, venue notes, contact and the floor map. The public guide fills
// `address` with the copy button and the map link; the console preview passes
// plain text. `editingClassName` is the preview's outline while the venue is edited.
export default function GuideVenueCard({
  name,
  address,
  directions,
  description,
  contact,
  map,
  editing = false,
  editingClassName,
}: {
  name: string;
  address?: ReactNode;
  directions: string;
  description: string;
  contact: string;
  map: { src: string; alt: string; caption?: ReactNode } | null;
  editing?: boolean;
  editingClassName?: string;
}) {
  return (
    <div className={editing && editingClassName ? `${styles.card} ${editingClassName}` : styles.card} data-editing={editing || undefined}>
      {name || address ? (
        <div className={styles.venueHead}>
          <span className={styles.venueBubble} aria-hidden="true"><GuideIcon type="venue" /></span>
          <div className={styles.venueBody}>
            {name ? <p className={styles.venueName}>{name}</p> : null}
            {address}
          </div>
        </div>
      ) : null}
      {directions || description || contact ? (
        <dl className="event-facts">
          {directions ? <div className="event-fact"><dt>오시는 길</dt><dd className={styles.venueText}>{directions}</dd></div> : null}
          {description ? <div className="event-fact"><dt>행사장 안내</dt><dd className={styles.venueText}>{description}</dd></div> : null}
          {contact ? <div className="event-fact"><dt>문의</dt><dd>{contact}</dd></div> : null}
        </dl>
      ) : null}
      {map ? (
        <figure className={styles.venueMap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={map.src} alt={map.alt} loading="lazy" decoding="async" />
          {map.caption ? <figcaption>{map.caption}</figcaption> : null}
        </figure>
      ) : null}
    </div>
  );
}
