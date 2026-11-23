"use client";

import type { CSSProperties, ReactNode } from "react";
import type { AttendeeTheme } from "./event-theme";
import { useBannerAppearance } from "./use-banner-appearance";
import styles from "./event-banner.module.css";

// The event's identity on a phone screen after the guide: the banner the agency
// published (picture, gradient or solid fill) with the event name over it. The
// ticket and the application sheet start with it so the attendee never doubts
// which event the screen belongs to.
export default function EventBanner({
  theme,
  title,
  kicker,
  titleAs = "p",
  className = "",
  compact = false,
}: {
  theme: AttendeeTheme;
  title: string;
  kicker?: ReactNode;
  titleAs?: "p" | "h1" | "h2";
  className?: string;
  // A shorter strip for passes that carry no QR, so their next step stays in the first screen.
  compact?: boolean;
}) {
  const { homeStyle, keyvisual, defaultHomeBanner } = theme;
  const { fill, source, tone, onImageError } = useBannerAppearance(homeStyle, keyvisual, defaultHomeBanner);
  const style = fill ? ({ background: fill } as CSSProperties) : undefined;
  const Title = titleAs;
  return (
    <div className={`${styles.banner} ${className}`} style={style} data-tone={tone} data-compact={compact || undefined} data-fill={fill ? "color" : source ? "image" : "neutral"}>
      {source ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.artwork} src={source} alt="" decoding="async" fetchPriority="high" onError={onImageError} />
      ) : null}
      {kicker ? <div className={styles.kicker}>{kicker}</div> : null}
      <Title className={styles.title}>{title}</Title>
    </div>
  );
}
