import type { CSSProperties } from "react";
import { DEFAULT_HOME_STYLE, readableInk, type HomeStyle } from "./attendee-home";

// The surface variables of an attendee screen: the chosen home background and
// the readable ink for it. Shared by the home and the event guide so both draw
// the same ground.
export function homeSurfaceStyle(homeStyle: HomeStyle): CSSProperties {
  const style = {
    "--home-background-color": homeStyle.backgroundColor,
  } as CSSProperties;
  if (homeStyle.backgroundColor === DEFAULT_HOME_STYLE.backgroundColor) return style;
  // The ink comes from the shared algorithm (lib/attendee-home readableInk).
  const ink = readableInk(homeStyle.backgroundColor);
  return {
    ...style,
    "--home-background-ink": ink,
    "--home-background-copy": ink,
  } as CSSProperties;
}
