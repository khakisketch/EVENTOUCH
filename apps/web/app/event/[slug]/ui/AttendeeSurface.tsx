import type { CSSProperties, ReactNode } from "react";
import { readableInk } from "../../../../lib/attendee-home";
import { normalizeEventColor, paletteStyle } from "../../../../lib/event-palette";
import styles from "./AttendeeSurface.module.css";

// The one wrapper of the attendee design system. It applies the event palette
// (--ev-accent and friends) and the ground, and marks the mode so every
// attendee component restyles itself from one switch:
//   a1  white ground, event color as the accent (the default)
//   a2  the event color is the ground and white cards sit on it (opt-in)
export type AttendeeMode = "a1" | "a2";

/** Reads a stored mode; anything but "a2" is the default a1. */
export function attendeeMode(value: unknown): AttendeeMode {
  return value === "a2" ? "a2" : "a1";
}

type SurfaceStyle = CSSProperties & Record<`--${string}`, string>;

export default function AttendeeSurface({
  color,
  mode = "a1",
  ground,
  as: Tag = "div",
  className,
  style,
  children,
  ...rest
}: {
  /** The event color; empty or invalid falls back to the product brand. */
  color?: string | null;
  mode?: AttendeeMode;
  /** a2 only: the ground color when it differs from the accent (the event's background color). */
  ground?: string | null;
  as?: "div" | "main" | "section";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "style" | "className" | "children">) {
  const accentColor = normalizeEventColor(color ?? "");
  const a2 = mode === "a2";
  const groundColor = a2 ? normalizeEventColor(ground ?? accentColor) : null;
  const vars: SurfaceStyle = {
    ...(paletteStyle(accentColor) as SurfaceStyle),
    "--ev-ground": groundColor ?? "var(--paper)",
    "--ev-ground-ink": groundColor ? readableInk(groundColor) : "var(--ink)",
  };
  return (
    <Tag
      {...rest}
      className={className ? `${styles.surface} ${className}` : styles.surface}
      style={{ ...vars, ...style }}
      data-attendee-mode={mode}
    >
      {children}
    </Tag>
  );
}
