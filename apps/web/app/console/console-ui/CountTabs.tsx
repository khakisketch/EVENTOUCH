"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./count-tabs.module.css";

export type CountTabItem = {
  key: string;
  /** Compact visible label. */
  label: string;
  count: number;
  /** "wait" paints the badge amber: reserved for work waiting on a person. */
  tone?: "wait" | "default";
  /** Full accessible name when the visible label is compact ("승인 대기 · 6명"). */
  srLabel?: string;
};

type CountTabsProps = {
  items: readonly CountTabItem[];
  /** Key of the pressed tab, or null when a custom filter is active. */
  value: string | null;
  onChange: (key: string) => void;
  ariaLabel: string;
  /** Marks a stage dot in front of a label (행사 목록 진행 중). */
  dots?: Readonly<Record<string, "live">>;
  /** One quiet text at the end of the row (not a card). */
  aside?: ReactNode;
  className?: string;
};

/**
 * One row of filter tabs with pill count badges. Same state, setters and
 * `aria-pressed` semantics as the card strips it replaced: this is a
 * presentation of existing filters, never a second filter system.
 */
export default function CountTabs({ items, value, onChange, ariaLabel, dots, aside, className }: CountTabsProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Phones scroll the row inside its own box: keep the chosen tab in view
  // without moving the page itself.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const track = trackRef.current;
    const active = track?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!track || !active) return;
    const left = active.offsetLeft - track.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < track.scrollLeft) track.scrollLeft = left - 8;
    else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth + 8;
  }, [value]);

  return (
    <div className={`${styles.row}${className ? ` ${className}` : ""}`} data-count-tabs>
      <div className={styles.track} ref={trackRef} role="group" aria-label={ariaLabel}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.tab}
            data-tab={item.key}
            data-tone={item.tone === "wait" && item.count > 0 ? "wait" : undefined}
            aria-pressed={value === item.key}
            onClick={() => onChange(item.key)}
          >
            {item.srLabel ? <span className="sr-only">{item.srLabel}</span> : null}
            <span className={styles.label} aria-hidden={item.srLabel ? "true" : undefined}>
              {dots?.[item.key] ? <i className={styles.dot} data-dot={dots[item.key]} aria-hidden="true" /> : null}
              {item.label}
            </span>
            <em className={styles.badge} aria-hidden={item.srLabel ? "true" : undefined}>{item.count}</em>
          </button>
        ))}
      </div>
      {aside ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
