import type { CSSProperties } from "react";
import { DEFAULT_HOME_STYLE, normalizeHomeStyle, type HomeStyle } from "../../../lib/attendee-home";
import { homeSurfaceStyle } from "../../../lib/home-surface";
import { asRecord, text } from "../../../lib/json-guards";

// The look an agency published for an event (ground color, banner fill or
// picture). The phone screens that follow registration (the application sheet,
// the ticket, engagement) wear it so the attendee keeps one identity from the
// guide to the desk. Everything here reads the public projection only.
export type AttendeeTheme = {
  homeStyle: HomeStyle;
  keyvisual: string | null;
  defaultHomeBanner: "legacy" | "neutral";
  /** The published 강조색 (the event color of the attendee design system), or null. */
  accent?: string | null;
};

export const DEFAULT_ATTENDEE_THEME: AttendeeTheme = {
  homeStyle: { ...DEFAULT_HOME_STYLE },
  keyvisual: null,
  defaultHomeBanner: "legacy",
  accent: null,
};

function record(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

// The one place a published banner picture is turned into a URL the browser may
// load: an inline data image or a file of this event. Anything else is no picture.
function keyvisualSource(slug: string, value: unknown): string | null {
  const image = record(value);
  const data = text(image.data);
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return data;
  const fileId = text(image.fileId);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) return null;
  return `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`;
}

/** Reads the published look out of a public workspace projection. */
export function readAttendeeTheme(slug: string, workspace: unknown): AttendeeTheme {
  const published = record(record(record(workspace).pageExperience).published);
  return {
    homeStyle: normalizeHomeStyle(published.homeStyle),
    keyvisual: keyvisualSource(slug, published.keyvisual),
    defaultHomeBanner: published.defaultHomeBanner === "neutral" ? "neutral" : "legacy",
    accent: typeof published.accent === "string" && /^#[0-9a-f]{6}$/i.test(published.accent) ? published.accent.toUpperCase() : null,
  };
}

/** Server-side load for pages whose own data does not carry the look. A failed
 *  read falls back to the default look; the page never fails because of it. */
export async function loadAttendeeTheme(slug: string): Promise<AttendeeTheme> {
  try {
    const base = process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
    const response = await fetch(`${base}/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (!response.ok) return DEFAULT_ATTENDEE_THEME;
    const data = record(await response.json());
    return readAttendeeTheme(slug, data.workspace);
  } catch {
    return DEFAULT_ATTENDEE_THEME;
  }
}

/** Ground color and its readable ink as CSS variables for the page root. */
export function attendeeGroundStyle(theme: AttendeeTheme): CSSProperties {
  return homeSurfaceStyle(theme.homeStyle);
}
