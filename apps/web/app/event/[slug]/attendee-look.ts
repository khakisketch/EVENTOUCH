import { contrastRatio, DEFAULT_HOME_STYLE, normalizeHomeStyle, type HomeStyle } from "../../../lib/attendee-home";
import { normalizeEventColor } from "../../../lib/event-palette";
import type { AttendeeMode } from "./ui/AttendeeSurface";

// Which of the two attendee looks an event gets, and with which colors. The
// default is a1 (white ground, event color as the accent). a2 (the event's own
// background color as the ground, white cards on it) switches on by itself when
// the agency picked a ground color in 참가자 페이지: no setting, no server
// change. The product default sky blue (DEFAULT_HOME_STYLE) is the value an
// untouched page stores, not a choice, so it reads as a1; a white or near-white
// pick is a1 too. The accent is the published 강조색 (the product brand when
// none is published).
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
  const custom = chosen !== DEFAULT_HOME_STYLE.backgroundColor.toUpperCase() && contrastRatio(chosen, WHITE) >= WHITE_LIKE;
  const color = accent ? normalizeEventColor(accent) : custom ? chosen : normalizeEventColor("");
  return custom ? { mode: "a2", color, ground: chosen } : { mode: "a1", color, ground: null };
}
