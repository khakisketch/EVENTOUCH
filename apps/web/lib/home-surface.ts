import type { CSSProperties } from "react";
import { DEFAULT_HOME_STYLE, type HomeStyle } from "./attendee-home";

// The surface variables of an attendee screen: the chosen home background and
// the readable ink for it. Shared by the home and the event guide so both draw
// the same ground.
export function homeSurfaceStyle(homeStyle: HomeStyle): CSSProperties {
  const style = {
    "--home-background-color": homeStyle.backgroundColor,
  } as CSSProperties;
  if (homeStyle.backgroundColor === DEFAULT_HOME_STYLE.backgroundColor) return style;
  const dark = "#17252B";
  const light = "#FFFFFF";
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16) / 255) ?? [0, 0, 0];
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground: string, background: string) => {
    const foregroundLuminance = foreground === light ? 1 : luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  };
  // Brand-adjacent candidates first; on mid-luminance customer backgrounds
  // both can fall below the 4.5:1 body-text floor (e.g. #75828E: dark 4.00,
  // white 3.93), so escalate to whichever of pure black/white clears it.
  // The guard uses 4.55, not 4.5, so boundary picks keep a real margin
  // against float rounding in the checker. The pick always adapts to the
  // background — never an unconditional gray.
  let ink = contrast(dark, homeStyle.backgroundColor) >= contrast(light, homeStyle.backgroundColor) ? dark : light;
  if (contrast(ink, homeStyle.backgroundColor) < 4.55) {
    ink = contrast("#000000", homeStyle.backgroundColor) >= contrast("#FFFFFF", homeStyle.backgroundColor)
      ? "#000000"
      : "#FFFFFF";
  }
  return {
    ...style,
    "--home-background-ink": ink,
    "--home-background-copy": ink,
  } as CSSProperties;
}
