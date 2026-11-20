import { contrastRatio, normalizeHomeStyle, type HomeStyle } from "./attendee-home";
import { normalizeEventColor } from "./event-palette";

// Which of the two attendee looks an event gets, and with which colors. a1 (white
// ground, the event color as the accent) is for a white ground; a2 (the event's
// own background color as the ground, white cards on it) switches on by itself
// whenever the page's ground color is not white: no setting, no server change.
// An untouched page stores the product default sky blue (DEFAULT_HOME_STYLE), so
// existing events keep their customer sky ground as a2; a white or near-white
// pick is a1. The accent is the published 강조색 (the product brand when none
// is published).
//
// Lives in lib so the console previews wear the same look as the attendee screens.
export type AttendeeMode = "a1" | "a2";

export type AttendeeLook = {
  mode: AttendeeMode;
  /** The event color for AttendeeSurface (buttons, chips, icon tiles, progress). */
  color: string;
  /** a2 only: the ground color. */
  ground: string | null;
};

const WHITE = "#FFFFFF";
/** Below this ratio against white a ground is white to the eye (#FAFAFA and paler). */
const WHITE_LIKE = 1.06;

export function attendeeLook(homeStyleInput: HomeStyle | unknown, accent?: string | null): AttendeeLook {
  const homeStyle = normalizeHomeStyle(homeStyleInput);
  const chosen = homeStyle.backgroundColor.toUpperCase();
  const custom = contrastRatio(chosen, WHITE) >= WHITE_LIKE;
  const color = accent ? normalizeEventColor(accent) : custom ? chosen : normalizeEventColor("");
  return custom ? { mode: "a2", color, ground: chosen } : { mode: "a1", color, ground: null };
}
