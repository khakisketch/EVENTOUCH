import { useEffect, useState } from "react";
import type { HomeStyle } from "../../../lib/attendee-home";
import { bannerAppearance, type BannerAppearance } from "../../../lib/banner-appearance";

// The banner state both attendee banners (HomeHero, EventBanner) share: what the
// published design shows, plus whether the picture failed to load. A failed picture
// falls back to the quiet banner until a different picture is published.
export function useBannerAppearance(
  homeStyle: HomeStyle,
  keyvisual: string | null,
  defaultHomeBanner: "legacy" | "neutral",
): BannerAppearance & { imageFailed: boolean; onImageError: () => void } {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [keyvisual]);
  return {
    ...bannerAppearance(homeStyle, keyvisual, defaultHomeBanner, imageFailed),
    imageFailed,
    onImageError: () => setImageFailed(true),
  };
}
