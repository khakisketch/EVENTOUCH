"use client";

import type { ReactNode } from "react";
import styles from "./OptionCards.module.css";

export type OptionCard = {
  value: string;
  label: string;
  /** One quiet line: what happens if this is chosen. Keep it short. */
  hint?: string;
  icon?: ReactNode;
  /** "kakao" paints the icon tile in the Kakao yellow; everything else stays neutral. */
  tone?: "kakao";
  disabled?: boolean;
};

/**
 * One choice out of a few, drawn as cards (icon tile, label, one quiet line).
 * Native radios own selection and keyboard behavior; the card is only the
 * label around them, so a screen reader still hears a radio group.
 * Field-error owners focus the group id; that focus moves into the chosen
 * (or first) radio instead of adding a Tab stop.
 */
export default function OptionCards({ id, legend, value, options, onChange, disabled, invalid, describedBy, columns = 3 }: {
  id: string;
  legend: string;
  value: string;
  options: readonly OptionCard[];
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  columns?: 1 | 2 | 3;
}) {
  return (
    <fieldset id={id} className={styles.group} data-columns={columns} disabled={disabled} tabIndex={-1}
      aria-invalid={invalid || undefined} aria-describedby={describedBy}
      onFocus={(event) => {
        if (event.target === event.currentTarget) {
          const chosen = event.currentTarget.querySelector<HTMLInputElement>("input:checked:not(:disabled)");
          (chosen ?? event.currentTarget.querySelector<HTMLInputElement>("input:not(:disabled)"))?.focus();
        }
      }}>
      <legend className="sr-only">{legend}</legend>
      {options.map((option, index) => (
        <label key={option.value} className={styles.card} htmlFor={`${id}-${index}`} data-tone={option.tone} data-disabled={option.disabled || undefined}>
          <input id={`${id}-${index}`} className={styles.input} type="radio" name={id} value={option.value}
            checked={value === option.value} disabled={option.disabled} aria-invalid={invalid || undefined}
            onChange={() => onChange(option.value)} />
          {option.icon ? <span className={styles.tile} aria-hidden="true">{option.icon}</span> : null}
          <span className={styles.text}>
            <strong>{option.label}</strong>
            {option.hint ? <small>{option.hint}</small> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
