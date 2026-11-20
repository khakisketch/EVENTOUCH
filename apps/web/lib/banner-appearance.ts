import { bannerFillCss, bannerFillTone, type HomeStyle } from "./attendee-home";

// What an attendee banner shows, decided once for every screen that wears the
// published banner (the home and guide hero, the ticket / application / engage
// strip). The agency picks one of three kinds in 참가자 페이지: a gradient, a solid
// color, or a picture. A picture banner can have nothing to show (no upload and the
// agency chose no default art, or the file failed to load): that is the quiet
// "neutral" banner, always read as light. Only the markup differs between screens.
export const DEFAULT_BANNER_ART = "/attendee-home-banner.png";

export type BannerAppearance = {
  /** CSS background of a gradient or solid banner; null for the picture banner. */
  fill: string | null;
  /** The picture banner (the banner kind is neither gradient nor solid). */
  imageMode: boolean;
  /** A picture banner with no picture to show. */
  neutral: boolean;
  /** The picture URL to load, or null when the banner shows no picture. */
  source: string | null;
  /** Text tone: a color banner reads its own colors, a picture follows the chosen tone. */
  tone: "light" | "dark";
};

export function bannerAppearance(
  homeStyle: HomeStyle,
  keyvisual: string | null,
  defaultHomeBanner: "legacy" | "neutral",
  imageFailed: boolean,
): BannerAppearance {
  const fill = bannerFillCss(homeStyle);
  const imageMode = fill === null;
  const noDefaultArt = defaultHomeBanner === "neutral";
  const neutral = imageMode && (imageFailed || (!keyvisual && noDefaultArt));
  const source = imageMode && !imageFailed ? keyvisual || (noDefaultArt ? null : DEFAULT_BANNER_ART) : null;
  const tone = fill ? bannerFillTone(homeStyle) : neutral ? "light" : homeStyle.textTone;
  return { fill, imageMode, neutral, source, tone };
}
