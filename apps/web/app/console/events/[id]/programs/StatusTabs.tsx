// Local count tabs: a segmented control whose segments carry a count badge.
// The shared console-ui CountTabs is being built by another workstream; this
// small equivalent can be swapped for it later without changing callers
// (same value / label / count shape, same aria-pressed group semantics).

import styles from "./programs.module.css";

export type StatusTab = { value: string; label: string; count: number; tone?: "live" | "prep" | "review" };

export default function StatusTabs({ label, tabs, value, onChange }: {
  label: string;
  tabs: StatusTab[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.statusTabs} role="group" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.value || "all"} type="button" aria-pressed={value === tab.value} data-tone={tab.tone} onClick={() => onChange(tab.value)}>
          {tab.label}<small>{tab.count}</small>
        </button>
      ))}
    </div>
  );
}
