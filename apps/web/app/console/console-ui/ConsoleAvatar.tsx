/*
 * ConsoleAvatar — design-system foundation (2026-11-20, direction C1).
 * Initial avatar (first grapheme of the name) tinted by status. Replaces the
 * four hand-rolled avatars (participant roster, team, feed, clients).
 * Hook-free. Decorative by default (the name is shown next to it); pass
 * `label` to expose it as an image with a name.
 *
 * Shared-gap addition (2026-11-20, optional; the default output is unchanged):
 * `src` shows the entity's own logo instead of the initial. A logo sits in a
 * white tile with a hairline (rounded square, `contain` fit: logos are rarely
 * square), so it reads as the client's mark and not as a person. Without a
 * `src` the initial avatar stands in; a failed image is not special-cased, so
 * pass `src` only for a logo that exists. Same sizes, same decorative/labelled
 * rules (the image itself carries `alt=""`; the name belongs beside it or in
 * `label`).
 */
import styles from "./console-avatar.module.css";

export type ConsoleAvatarTone = "ok" | "wait" | "info" | "neutral";

type ConsoleAvatarProps = {
  name: string;
  tone?: ConsoleAvatarTone;
  /** sm 28px, md 34px, lg 48px. */
  size?: "sm" | "md" | "lg";
  /** Accessible name when the avatar stands alone. Omit when the name is printed beside it. */
  label?: string;
  /** The entity's own logo URL; replaces the initial and draws a white hairline tile. */
  src?: string;
  className?: string;
};

/** First user-perceived character, so emoji and combined Hangul stay whole. */
export function firstGrapheme(name: string): string {
  const text = name.trim();
  if (!text) return "?";
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    const first = new Segmenter("ko", { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment.toUpperCase();
  }
  return (Array.from(text)[0] ?? "?").toUpperCase();
}

export default function ConsoleAvatar({ name, tone = "neutral", size = "md", label, src, className }: ConsoleAvatarProps) {
  return (
    <span
      className={[styles.avatar, className].filter(Boolean).join(" ")}
      data-console-avatar={tone}
      data-size={size}
      data-logo={src ? "true" : undefined}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : "true"}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.logo} src={src} alt="" />
      ) : firstGrapheme(name)}
    </span>
  );
}
