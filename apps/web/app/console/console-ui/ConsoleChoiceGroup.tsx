"use client";

import type { ReactNode } from "react";
import styles from "./console-choice-group.module.css";

export type ConsoleChoice = { value: string; label: string; description?: string; disabled?: boolean };

/** A saved single choice. Native radios own selection and keyboard behavior. */
export default function ConsoleChoiceGroup({ id, label, value, options, onChange, invalid, describedBy, disabled, hint, layout = "wrap" }: {
  id: string;
  label: string;
  value: string;
  options: readonly ConsoleChoice[];
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  hint?: ReactNode;
  layout?: "wrap" | "compare";
}) {
  const description = hint ?? options.find((option) => option.value === value)?.description;
  const descriptionId = description ? `${id}-hint` : undefined;
  return <fieldset id={id} className={styles.choiceGroup} disabled={disabled} tabIndex={-1}
    aria-invalid={invalid || undefined} aria-describedby={[descriptionId, describedBy].filter(Boolean).join(" ") || undefined}
    onFocus={(event) => {
      // Existing field-error owners focus the field id; forward that focus
      // into the selected native input instead of adding a new Tab stop.
      if (event.target === event.currentTarget) {
        const selected = event.currentTarget.querySelector<HTMLInputElement>('input:checked:not(:disabled)');
        (selected ?? event.currentTarget.querySelector<HTMLInputElement>('input:not(:disabled)'))?.focus();
      }
    }}>
    <legend>{label}</legend>
    <div className={`${styles.choiceOptions} ${layout === "compare" ? styles.choiceCompare : ""}`}>
      {options.map((option, index) => <label key={option.value} className={styles.choiceOption} htmlFor={`${id}-${index}`}>
        <input id={`${id}-${index}`} type="radio" name={id} value={option.value} checked={value === option.value}
          disabled={option.disabled} aria-invalid={invalid || undefined}
          onChange={() => onChange(option.value)} />
        <span className={styles.choiceLabel}>{option.label}</span>
      </label>)}
    </div>
    {description ? <p className={styles.choiceHint} id={descriptionId}>{description}</p> : null}
  </fieldset>;
}

export const EVENT_FORMAT_CHOICES = [
  { value: "", label: "미지정" },
  { value: "offline", label: "현장" },
  { value: "online", label: "온라인" },
  { value: "hybrid", label: "혼합" },
] as const;
