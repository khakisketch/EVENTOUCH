"use client";

/*
 * SettingsToc, 목차 for 행사 설정. Local to this screen. Desktop: a sticky side list
 * that says which section holds unsaved edits ("변경됨") and what each one currently is.
 * Reopened 2026-11-21 (owner: 행사 설정 시안 A + ① 구역 상태 타일): on phones the same
 * list becomes four status tiles (current value and a dot for what needs a look); once
 * the tiles scroll out of view a one-row chip bar sticks under the top bar, marks the
 * section being read, and a 맨 위로 button appears. Anchor links point at the existing
 * section anchors; the basics entry is a button because it opens the drawer rather than
 * scrolling. Nothing here writes or changes what a section saves.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import StatusPill from "../../../console-ui/StatusPill";
import styles from "./settings-toc.module.css";

export type SettingsTocItem = {
  id: string;
  label: string;
  /** Current state in one short phrase ("접수 중", "기능 9개 사용"). */
  hint?: ReactNode;
  /** Second quiet line on the phone tile ("확인할 안내 1건"). */
  note?: ReactNode;
  /** ok = fine, attention = something to look at, neutral = informational. */
  tone?: "ok" | "attention" | "neutral";
  /** Unsaved edits wait in this section. */
  dirty?: boolean;
  /** Anchor target; omit when `onSelect` opens a drawer instead. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
};

/**
 * The phone top bar is sticky and the chip bar sits right under it. It is 57px on a
 * plain screen but taller on a notched one (its top padding grows with the safe area),
 * so the real height is measured; 57 is only the fallback before the first measure.
 */
const TOP_BAR_FALLBACK = 57;
const PHONE_QUERY = "(max-width: 768px)";
const SECTION_ATTR = "data-settings-section";

function measureTopBar(): number {
  if (typeof window === "undefined" || !window.matchMedia?.(PHONE_QUERY).matches) return TOP_BAR_FALLBACK;
  const bar = document.querySelector<HTMLElement>(".console-sidebar");
  return bar ? Math.round(bar.getBoundingClientRect().height) || TOP_BAR_FALLBACK : TOP_BAR_FALLBACK;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export default function SettingsToc({ items }: { items: readonly SettingsTocItem[] }) {
  const tiles = useRef<HTMLOListElement>(null);
  const [stuck, setStuck] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [barHeight, setBarHeight] = useState(TOP_BAR_FALLBACK);

  // Follow the top bar's real height (safe area, orientation, font scaling).
  useEffect(() => {
    const update = () => setBarHeight(measureTopBar());
    update();
    const bar = document.querySelector<HTMLElement>(".console-sidebar");
    const resizeObserver = bar && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    // border-box: safe-area growth changes the bar's padding, not its content box.
    if (bar) resizeObserver?.observe(bar, { box: "border-box" });
    window.addEventListener("resize", update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // The chip bar and 맨 위로 appear only after the tiles have scrolled above the top bar.
  useEffect(() => {
    const list = tiles.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    }, { rootMargin: `-${barHeight}px 0px 0px 0px` });
    observer.observe(list);
    return () => observer.disconnect();
  }, [barHeight]);

  // The section being read is the last one whose top has passed the reading line.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let active: string | null = null;
      for (const item of items) {
        const section = document.querySelector<HTMLElement>(`[${SECTION_ATTR}="${item.id}"]`);
        if (section && section.getBoundingClientRect().top <= 200) active = item.id;
      }
      setCurrent((previous) => (previous === active ? previous : active));
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [items]);

  // Keep the chip of the section being read inside the scrolling chip row.
  const chipList = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!stuck) return;
    chipList.current?.querySelector<HTMLElement>('[aria-current="location"]')
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [current, stuck]);

  const toneOf = (item: SettingsTocItem) => (item.dirty ? "attention" : item.tone ?? "neutral");

  return (
    <>
      <nav className={styles.toc} aria-label="설정 목차" data-settings-toc>
        <ol className={styles.list} ref={tiles}>
          {items.map((item, index) => {
            const body = (
              <>
                <span className={styles.index} aria-hidden="true">{index + 1}</span>
                <span className={styles.copy}>
                  <span className={styles.label}>
                    <span className={styles.dot} data-tone={toneOf(item)} aria-hidden="true" />
                    {item.label}
                  </span>
                  {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
                  {item.note ? <span className={styles.note}>{item.note}</span> : null}
                </span>
                {item.dirty ? <StatusPill tone="wait" size="sm" dot>변경됨</StatusPill> : null}
              </>
            );
            const active = current === item.id ? "true" : undefined;
            return (
              <li key={item.id} className={styles.item}>
                {item.href ? (
                  <a className={styles.link} href={item.href} data-current={active}>{body}</a>
                ) : (
                  <button type="button" className={styles.link} data-current={active} disabled={item.disabled} onClick={item.onSelect}>{body}</button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {/* Phones only (CSS): a zero-height sticky row, so it adds nothing to the layout. */}
      <div className={styles.chipsAnchor} style={{ "--settings-bar-h": `${barHeight}px` } as CSSProperties}>
        {stuck ? (
          <div className={styles.chips}>
            <nav ref={chipList} className={styles.chipList} aria-label="설정 구역 바로가기">
            {items.map((item) => {
              const active = current === item.id;
              const content = (
                <>
                  <span className={styles.dot} data-tone={toneOf(item)} aria-hidden="true" />
                  {item.label}
                </>
              );
              return item.href ? (
                <a key={item.id} className={styles.chip} href={item.href} aria-current={active ? "location" : undefined}>{content}</a>
              ) : (
                <button key={item.id} type="button" className={styles.chip} aria-current={active ? "location" : undefined} disabled={item.disabled} onClick={item.onSelect}>{content}</button>
              );
            })}
            </nav>
            <button
              type="button"
              className={styles.chipTop}
              aria-label="맨 위로"
              onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" })}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 14 6-6 6 6" /></svg>
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
