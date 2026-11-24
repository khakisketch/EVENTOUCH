import type { CSSProperties } from "react";
import { contrastRatio, INK_FLOOR, readableInk } from "./attendee-home";

// One place that turns an event's color into the colors an attendee screen
// needs. Contrast math is shared with the home ground (lib/attendee-home), so
// the ink on an accent, the accent as text and the ink on a ground all follow
// the same 4.5:1 rule. A color is never shipped without a readable pair.
export type EventPalette = {
  /** The event color as a fill: buttons, chips, icons, progress. */
  accent: string;
  /** A deeper (or, for very dark colors, lighter) accent for hover and pressed fills. */
  accentStrong: string;
  /** About an 11% tint of the accent on white, for icon tiles and quiet chips. */
  accentSoft: string;
  /** Text on the accent fill (at least 4.55:1 on both accent and accentStrong). */
  onAccent: string;
  /** The accent as text or a line on white, on accentSoft and on the soft card (at least 4.55:1 on each). */
  accentInk: string;
};

// The product brand is the fallback for an empty or invalid event color.
export const BRAND_EVENT_COLOR = "#EA552E";
const WHITE = "#FFFFFF";
const SOFT_SHARE = 0.11;
// The soft card surface of the attendee components (5% of --ink on white),
// so accent text also reads inside a soft card.
const SOFT_CARD = "#F2F2F3";
const STRONG_SPAN = 12;
// The product's own near-black on-brand ink; used instead of pure black when
// it clears the same floor, so a bright accent does not get a harsh label.
const SOFT_BLACK = "#19191C";

type Rgb = [number, number, number];

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d + 6) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const channel = (n: number) => 255 * (ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return toHex([channel(0), channel(8), channel(4)]);
}

function mix(color: Rgb, over: Rgb, share: number): string {
  return toHex(color.map((v, i) => v * share + over[i] * (1 - share)) as Rgb);
}

export function normalizeEventColor(color: unknown): string {
  const rgb = typeof color === "string" ? parseHex(color) : null;
  return rgb ? toHex(rgb) : BRAND_EVENT_COLOR;
}

/**
 * The attendee palette of an event color. Every pair is AA-safe: onAccent on
 * accent and accentStrong, accentInk on white and on accentSoft. Empty or
 * invalid input gives the product brand's palette.
 */
export function deriveEventPalette(color: string): EventPalette {
  const accent = normalizeEventColor(color);
  const rgb = parseHex(accent) as Rgb;
  const accentSoft = mix(rgb, [255, 255, 255], SOFT_SHARE);

  let onAccent = readableInk(accent);
  if (onAccent === "#000000" && contrastRatio(SOFT_BLACK, accent) >= INK_FLOOR) onAccent = SOFT_BLACK;

  // Accent as text: keep the hue and saturation, lower the lightness until it
  // reads on every surface it sits on: white, its own tint and the soft card.
  const [h, s, l] = toHsl(rgb);
  const reads = (ink: string) => [WHITE, accentSoft, SOFT_CARD].every((ground) => contrastRatio(ink, ground) >= INK_FLOOR);
  let accentInk = accent;
  for (let light = l; light >= 0 && !reads(accentInk); light -= 1) {
    accentInk = fromHsl(h, s, light);
  }
  if (!reads(accentInk)) accentInk = "#000000";

  // Hover/pressed fill: a step away from the page (deeper, or lighter for very
  // dark colors), stopping before onAccent would stop reading on it.
  const direction = l <= 22 ? 1 : -1;
  let accentStrong = accent;
  for (let step = 1; step <= STRONG_SPAN; step += 1) {
    const candidate = fromHsl(h, s, Math.min(100, Math.max(0, l + direction * step)));
    if (contrastRatio(onAccent, candidate) < INK_FLOOR) break;
    accentStrong = candidate;
  }

  return { accent, accentStrong, accentSoft, onAccent, accentInk };
}

/**
 * The accent as small text directly on a ground color (an a2 page's own ground, not
 * white). accentInk is only proven on white and the soft card; on a tinted ground
 * it can fall under 4.5:1 (e.g. #B24E14 on #B9DEF0 reads 3.69:1). The accent keeps
 * its hue and saturation and gets darker until it clears the floor; when even black
 * cannot keep that hue, the ground's own readable ink is used.
 */
export function accentInkOn(color: string, ground: string): string {
  const accent = normalizeEventColor(color);
  const base = normalizeEventColor(ground);
  const { accentInk } = deriveEventPalette(accent);
  if (contrastRatio(accentInk, base) >= INK_FLOOR) return accentInk;
  const [h, s, l] = toHsl(parseHex(accentInk) as Rgb);
  for (let light = l - 1; light >= 0; light -= 1) {
    const candidate = fromHsl(h, s, light);
    if (contrastRatio(candidate, base) >= INK_FLOOR) return candidate;
  }
  return readableInk(base);
}

/** The palette as CSS custom properties for an attendee screen's root. */
export function paletteStyle(color: string): CSSProperties {
  const palette = deriveEventPalette(color);
  return {
    "--ev-accent": palette.accent,
    "--ev-accent-strong": palette.accentStrong,
    "--ev-accent-soft": palette.accentSoft,
    "--ev-on-accent": palette.onAccent,
    "--ev-accent-ink": palette.accentInk,
  } as CSSProperties;
}
