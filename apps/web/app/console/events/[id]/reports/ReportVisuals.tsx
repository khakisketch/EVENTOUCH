import styles from "./reports.module.css";

// Decorative shapes only. Every value drawn here is already printed as text
// by the caller, so these are aria-hidden and never carry meaning alone.

/** One ratio (0-100) as a ring. Fill uses the report's accent, track is neutral. */
export function RateRing({ value, size = 88, label }: { value: number; size?: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span className={styles.ring} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 36 36" width={size} height={size}>
        <circle className={styles.ringTrack} cx="18" cy="18" r="15.9155" fill="none" strokeWidth="3.4" />
        {clamped > 0 ? (
          <circle className={styles.ringFill} cx="18" cy="18" r="15.9155" fill="none" strokeWidth="3.4" strokeLinecap="round"
            strokeDasharray={`${clamped} 100`} transform="rotate(-90 18 18)" />
        ) : null}
      </svg>
      {label ? <span className={styles.ringLabel}>{label}</span> : null}
    </span>
  );
}

/** Seven close steps as seven segments; steps up to `position` are filled. */
export function StepBar({ position, total = 7 }: { position: number; total?: number }) {
  return (
    <span className={styles.stepBar} aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <i key={index} className={index < position ? styles.stepOn : undefined} />
      ))}
    </span>
  );
}

/** Ink tone for the nth category: first is darkest, later ones lighter. */
export function inkTone(index: number): string {
  const ramp = [100, 70, 48, 32, 20, 12];
  return `color-mix(in srgb, var(--ink) ${ramp[Math.min(index, ramp.length - 1)]}%, var(--paper))`;
}
