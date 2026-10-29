// Event-card header theme: published participant-home background only.
//
// The console home reads one value per event from the already-loaded
// `/api/bootstrap` workspaces: `pageExperience.published.homeStyle.
// backgroundColor`. Drafts never leak onto cards — the only trustworthy
// marker that a publish happened is a non-empty `publishedAt` string next
// to the published block (the publish command always writes both, while
// saves only bump `draftVersion`). A missing, malformed, or never-published
// style falls back to the existing `--soft` header.
//
// The header keeps the pale A2 feel by mixing the published color 15% over
// white, and the date/time line uses fixed neutral ink on any published
// theme. Status badges keep their semantic tokens and are never tinted.
//
// Pure module: no React, no DOM, no network. Safe for unit tests and for
// import from client components (it only widens the client bundle by a few
// pure functions).

export const THEME_INK = "#111318";
export const THEME_BRAND_TEXT = "#1438A8";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Share of the published color in the pale header tint (rest is white). */
export const THEME_TINT_RATIO = 0.15;
/** Minimum text contrast for the date/time line on the tinted header. */
export const THEME_MIN_CONTRAST = 4.5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/**
 * Read the published card color from an already-loaded bootstrap workspace.
 * Returns the normalized `#RRGGBB` background or null when there is no
 * trustworthy published style (never published, malformed, or invalid).
 * `publishedAt` is the publish marker; `draft` is never consulted.
 */
export function readPublishedCardColor(workspace: unknown): string | null {
  if (!isRecord(workspace)) return null;
  const pageExperience = isRecord(workspace.pageExperience) ? workspace.pageExperience : null;
  if (!pageExperience) return null;
  const publishedAt = pageExperience.publishedAt;
  if (typeof publishedAt !== "string" || !publishedAt.trim()) return null;
  const published = isRecord(pageExperience.published) ? pageExperience.published : null;
  if (!published) return null;
  const homeStyle = isRecord(published.homeStyle) ? published.homeStyle : null;
  if (!homeStyle) return null;
  const raw = homeStyle.backgroundColor;
  if (!isThemeColor(raw)) return null;
  return raw.trim().toUpperCase();
}

function channelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const parts = hex.slice(1).match(/.{2}/g);
  const channels = (parts ?? ["00", "00", "00"]).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map(channelToLinear);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio between two `#RRGGBB` colors. */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function toHexByte(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0").toUpperCase();
}

/** Mix a valid `#RRGGBB` color `ratio` (0-1) over white. Returns `#RRGGBB`. */
export function tintAgainstWhite(hex: string, ratio: number = THEME_TINT_RATIO): string {
  const parts = hex.slice(1).match(/.{2}/g) ?? ["00", "00", "00"];
  const mixed = parts.map((part) => {
    const channel = parseInt(part, 16);
    return toHexByte(channel * ratio + 255 * (1 - ratio));
  });
  return `#${mixed.join("")}`;
}

export type CardHeaderTheme = { background: string; color: string };

/**
 * Resolve the A2 header paint for one card. Null means "no published custom
 * theme": the caller falls back to the existing `--soft` surface with
 * `--brand-text` date text. A published color always yields a pale tint with
 * fixed neutral ink for the date line: operator colors must never combine
 * with unrelated brand text on every hue, even when the orange would
 * pass contrast. The ink still clears 4.5:1 on the pale tint.
 * Only validated hex in, only computed hex out — no arbitrary CSS strings.
 */
export function cardHeaderTheme(publishedColor: string | null): CardHeaderTheme | null {
  if (publishedColor === null) return null;
  if (!isThemeColor(publishedColor)) return null;
  const background = tintAgainstWhite(publishedColor.trim().toUpperCase());
  return { background, color: THEME_INK };
}
