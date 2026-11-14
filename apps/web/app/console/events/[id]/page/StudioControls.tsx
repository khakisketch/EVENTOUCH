"use client";

// Small visual controls for the attendee page studio: a segmented choice and
// picture cards. Both are radio groups (one tab stop, arrows move), and a
// card names itself in text; the picture is decoration.

import type { KeyboardEvent, ReactNode } from "react";
import styles from "./studio-controls.module.css";

type Option<T extends string> = { value: T; name: string; art?: ReactNode; disabled?: boolean };

function arrowMove<T extends string>(event: KeyboardEvent<HTMLElement>, options: Array<Option<T>>, value: T, onChange: (value: T) => void) {
  const enabled = options.filter((option) => !option.disabled);
  const index = enabled.findIndex((option) => option.value === value);
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step || index < 0) return;
  event.preventDefault();
  const next = enabled[(index + step + enabled.length) % enabled.length];
  onChange(next.value);
  const group = event.currentTarget.closest('[role="radiogroup"]');
  requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}

export function Seg<T extends string>({ label, value, options, onChange, disabled = false }: { label: string; value: T; options: Array<Option<T>>; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className={styles.seg} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled || option.disabled}
          className={styles.segItem}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => arrowMove(event, options, value, onChange)}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

export function ChoiceCards<T extends string>({ label, value, options, onChange, disabled = false }: { label: string; value: T; options: Array<Option<T>>; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className={styles.cards} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled || option.disabled}
          className={styles.card}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => arrowMove(event, options, value, onChange)}
        >
          <span className={styles.art} aria-hidden="true">{option.art}</span>
          <span className={styles.cardName}>{option.name}</span>
        </button>
      ))}
    </div>
  );
}
