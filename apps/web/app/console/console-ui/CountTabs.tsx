"use client";

/*
 * CountTabs — one row of segmented tabs with pill count badges (owner
 * decision 2026-11-20: 카드 띠 → 개수 탭). Replaces the strip of big-number
 * cards on list screens and the per-screen ink-pill tab rows.
 *
 * Two behaviours, one look:
 *  - mode "filter" (default): a group of `aria-pressed` buttons. The tabs are a
 *    presentation of an existing filter, never a second filter system.
 *  - mode "tablist" (shared-gap addition 2026-11-20): `role="tablist"` with
 *    `role="tab"` buttons, `aria-selected`, roving tabindex and the keyboard
 *    model of the ARIA tabs pattern (ArrowLeft/Right wrap around, Home, End).
 *    Use it when the tabs switch a panel (공지·안내 종류, 기간 분석 세부 보기).
 *    `idPrefix` gives each tab the id `${idPrefix}${key}` and `controls` names
 *    the panel (`aria-controls`), so the panel can point back with
 *    `aria-labelledby`. A tab without `count` shows no badge.
 *
 * Narrow screens (below 768px): `fit` "scroll" (default) scrolls the row
 * inside its own box, "wrap" lets the tabs wrap onto lines, "fill" shares the
 * width equally between the tabs.
 *
 * `toggle` is one extra pressed/unpressed pill after the tabs that narrows
 * TOGETHER with the chosen tab (행사 목록의 "승인 대기만": stage tab AND
 * waiting approvals). It is its own `aria-pressed` button, filter mode only.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./count-tabs.module.css";

export type CountTabItem = {
  key: string;
  /** Compact visible label. */
  label: string;
  /** Badge number. Omit for a plain tab without a badge. */
  count?: number;
  /** "wait" paints the badge amber: reserved for work waiting on a person. */
  tone?: "wait" | "default";
  /** Full accessible name when the visible label is compact ("승인 대기 · 6명"). */
  srLabel?: string;
  disabled?: boolean;
};

export type CountTabToggle = {
  key: string;
  label: string;
  count: number;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  /** "wait" paints the badge amber while the count is above zero. */
  tone?: "wait" | "default";
  /** Full accessible name when the visible label is compact. */
  ariaLabel?: string;
};

type CountTabsProps = {
  items: readonly CountTabItem[];
  /** Key of the pressed or selected tab, or null when a custom filter is active. */
  value: string | null;
  onChange: (key: string) => void;
  ariaLabel: string;
  /** `filter`: pressed buttons in a group. `tablist`: ARIA tabs that switch a panel. */
  mode?: "filter" | "tablist";
  /** tablist: tab id prefix, so a tab's id is `${idPrefix}${key}`. */
  idPrefix?: string;
  /** tablist: the panel id, or a function from a tab key to its panel id (`aria-controls`). */
  controls?: string | ((key: string) => string);
  /** Below 768px: scroll the row in its box (default), wrap onto lines, or share the width equally. */
  fit?: "scroll" | "wrap" | "fill";
  /** Marks a stage dot in front of a label (행사 목록 진행 중). */
  dots?: Readonly<Record<string, "live">>;
  /** A filter that narrows together with the chosen tab. Filter mode only. */
  toggle?: CountTabToggle;
  /** One quiet text at the end of the row (not a card). */
  aside?: ReactNode;
  className?: string;
};

/**
 * The tab a key moves to in tablist mode, or null when the key is not part of
 * the tabs pattern. ArrowLeft/Right wrap around, Home and End jump to the ends,
 * and disabled tabs are skipped.
 */
export function nextCountTabKey(items: readonly CountTabItem[], value: string | null, key: string): string | null {
  const enabled = items.filter((item) => !item.disabled);
  if (!enabled.length) return null;
  const at = enabled.findIndex((item) => item.key === value);
  const next = key === "ArrowRight" ? enabled[(at + 1) % enabled.length]
    : key === "ArrowLeft" ? enabled[(at + enabled.length - 1) % enabled.length]
      : key === "Home" ? enabled[0]
        : key === "End" ? enabled[enabled.length - 1]
          : null;
  return next ? next.key : null;
}

export default function CountTabs({
  items, value, onChange, ariaLabel, mode = "filter", idPrefix, controls, fit = "scroll", dots, toggle, aside, className,
}: CountTabsProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const tablist = mode === "tablist";

  // Phones scroll the row inside its own box: keep the chosen tab in view
  // without moving the page itself.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const track = trackRef.current;
    const active = track?.querySelector<HTMLElement>('[data-selected="true"]');
    if (!track || !active) return;
    const left = active.offsetLeft - track.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < track.scrollLeft) track.scrollLeft = left - 8;
    else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth + 8;
  }, [value]);

  const enabled = items.filter((item) => !item.disabled);
  const tabStop = enabled.some((item) => item.key === value) ? value : enabled[0]?.key;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!tablist) return;
    const next = nextCountTabKey(items, value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    trackRef.current?.querySelector<HTMLElement>(`[data-tab="${next.replace(/["\\]/g, "\\$&")}"]`)?.focus();
  }

  return (
    <div className={`${styles.row}${className ? ` ${className}` : ""}`} data-count-tabs data-fit={fit === "scroll" ? undefined : fit}>
      <div
        className={styles.track}
        ref={trackRef}
        role={tablist ? "tablist" : "group"}
        aria-label={ariaLabel}
        onKeyDown={tablist ? onKeyDown : undefined}
      >
        {items.map((item) => {
          const selected = value === item.key;
          const hidden = item.srLabel ? "true" : undefined;
          return (
            <button
              key={item.key}
              type="button"
              className={styles.tab}
              data-tab={item.key}
              data-selected={selected ? "true" : undefined}
              data-tone={item.tone === "wait" && (item.count ?? 0) > 0 ? "wait" : undefined}
              disabled={item.disabled}
              {...(tablist
                ? {
                  role: "tab",
                  id: idPrefix ? `${idPrefix}${item.key}` : undefined,
                  "aria-selected": selected,
                  "aria-controls": typeof controls === "function" ? controls(item.key) : controls,
                  tabIndex: item.key === tabStop ? 0 : -1,
                }
                : { "aria-pressed": selected })}
              onClick={() => onChange(item.key)}
            >
              {item.srLabel ? <span className="sr-only">{item.srLabel}</span> : null}
              <span className={styles.label} aria-hidden={hidden}>
                {dots?.[item.key] ? <i className={styles.dot} data-dot={dots[item.key]} aria-hidden="true" /> : null}
                {item.label}
              </span>
              {item.count !== undefined ? <em className={styles.badge} aria-hidden={hidden}>{item.count}</em> : null}
            </button>
          );
        })}
      </div>
      {!tablist && toggle ? (
        <button
          type="button"
          className={styles.toggle}
          data-toggle={toggle.key}
          data-selected={toggle.pressed ? "true" : undefined}
          data-tone={toggle.tone === "wait" && toggle.count > 0 ? "wait" : undefined}
          aria-pressed={toggle.pressed}
          aria-label={toggle.ariaLabel}
          onClick={() => toggle.onChange(!toggle.pressed)}
        >
          <span className={styles.label} aria-hidden={toggle.ariaLabel ? "true" : undefined}>{toggle.label}</span>
          <em className={styles.badge} aria-hidden={toggle.ariaLabel ? "true" : undefined}>{toggle.count}</em>
        </button>
      ) : null}
      {aside ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
