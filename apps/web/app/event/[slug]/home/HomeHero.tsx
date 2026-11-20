"use client";

import type { CSSProperties } from "react";
import type { HomeStyle } from "../../../../lib/attendee-home";
import { useBannerAppearance } from "../use-banner-appearance";
import styles from "./home.module.css";
import L from "./home-layouts.module.css";

// The banner of an attendee screen, shared by the home and the event guide so
// both read the same published design: the picture, gradient or solid fill, the
// tone, focus and overlay the agency chose in 참가자 페이지. `subtitle` replaces
// the home's own subtitle (the event guide puts the date and venue there).
export default function HomeHero({
  eventName,
  homeStyle,
  layout,
  keyvisual,
  defaultHomeBanner = "legacy",
  subtitle,
  preview = false,
  label,
}: {
  eventName: string;
  homeStyle: HomeStyle;
  layout: "tile" | "poster" | "instagram";
  keyvisual: string | null;
  defaultHomeBanner?: "legacy" | "neutral";
  subtitle?: string;
  preview?: boolean;
  label: string;
}) {
  const { fill, imageMode, neutral: neutralBanner, source: imageSource, tone, imageFailed, onImageError } = useBannerAppearance(homeStyle, keyvisual, defaultHomeBanner);
  const title = homeStyle.heroTitle?.trim() || eventName;
  const textHidden = imageMode && homeStyle.heroLayout === "image-only" && !neutralBanner;
  const heroClass = [
    L.hero,
    tone === "dark" ? L.toneDark : L.toneLight,
    L[`align${capitalize(homeStyle.textAlign)}`],
    homeStyle.titleScale === "large" ? L.titleLarge : "",
    layout === "tile" && homeStyle.heroLayout === "bottom-overlay" ? L.textBottom : "",
    imageMode && homeStyle.overlay !== "none" ? L[`overlay${capitalize(homeStyle.overlay)}${capitalize(tone)}`] : "",
    homeStyle.imageFocus === "top" ? L.focusTop : homeStyle.imageFocus === "bottom" ? L.focusBottom : "",
  ].filter(Boolean).join(" ");

  // The console builder embeds this banner inside its own preview section
  // (under the preview h2): there it renders an h3 with identical styling so
  // the builder page keeps a single h1. Public pages keep the h1.
  const Title = preview ? "h3" : "h1";
  const subtitleText = (subtitle ?? homeStyle.heroSubtitle).trim();
  const style = fill ? ({ background: fill } as CSSProperties) : undefined;

  return (
    <section className={heroClass} style={style} aria-label={label} data-neutral={neutralBanner || undefined}>
      {imageSource ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={L.artwork} src={imageSource} alt="" onError={onImageError} />
      ) : imageMode && imageFailed ? (
        <div className={styles.bannerImageFailure} role="status">배너 이미지를 불러오지 못했습니다.</div>
      ) : null}
      <div className={`${L.heroText}${textHidden ? ` ${styles.visuallyHidden}` : ""}`}>
        <Title className={L.title}>{title}</Title>
        {homeStyle.heroLayout !== "image-only" && subtitleText ? <p className={L.subtitle} data-hero-subtitle>{subtitleText}</p> : null}
      </div>
    </section>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
