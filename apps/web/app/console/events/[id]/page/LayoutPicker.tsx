"use client";

// The first choice on the attendee page: which composition the home takes.
// Each card is the real home rendered small with the event's own colors and
// banner, so what you pick is what attendees get. The photo-first layout is
// reserved and shown locked.

import type { CSSProperties } from "react";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import { readableInk, type HomeLayout, type HomeStyle, type MenuShape } from "../../../../../lib/attendee-home";
import type { HomeMenus, HomeProgram } from "../../../../../lib/attendee-home-menus";
import styles from "./layout-picker.module.css";

const LAYOUTS: Array<{ id: HomeLayout; name: string; hint: string }> = [
  { id: "tile", name: "타일형", hint: "정사각 타일 메뉴" },
  { id: "poster", name: "포스터형", hint: "큰 배너와 아이콘 메뉴" },
  { id: "typography", name: "타이포형", hint: "이미지 없이 큰 글자" },
];

type Props = {
  value: HomeLayout;
  menuShape: MenuShape;
  homeStyle: HomeStyle;
  eventName: string;
  keyvisual: string | null;
  defaultHomeBanner: "legacy" | "neutral";
  homeMenus: HomeMenus;
  programs: HomeProgram[];
  unavailable: Array<"notice" | "lucky" | "roulette" | "vote" | "stamp">;
  disabled?: boolean;
  onLayout: (layout: HomeLayout) => void;
  onMenuShape: (shape: MenuShape) => void;
};

export default function LayoutPicker({ value, menuShape, homeStyle, eventName, keyvisual, defaultHomeBanner, homeMenus, programs, unavailable, disabled = false, onLayout, onMenuShape }: Props) {
  return (
    <div className={styles.picker}>
      <div className={styles.cards} role="radiogroup" aria-label="홈 레이아웃">
        {LAYOUTS.map((layout) => {
          const sample: HomeStyle = { ...homeStyle, layout: layout.id };
          const vars = { "--home-background-color": sample.backgroundColor, "--home-background-ink": readableInk(sample.backgroundColor) } as CSSProperties;
          return (
            <div
              key={layout.id}
              role="radio"
              aria-checked={value === layout.id}
              aria-disabled={disabled || undefined}
              tabIndex={disabled ? -1 : value === layout.id ? 0 : -1}
              className={styles.card}
              onClick={() => { if (!disabled) onLayout(layout.id); }}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key === " " || event.key === "Enter") { event.preventDefault(); onLayout(layout.id); return; }
                const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const index = LAYOUTS.findIndex((item) => item.id === layout.id);
                const next = LAYOUTS[(index + step + LAYOUTS.length) % LAYOUTS.length];
                onLayout(next.id);
                requestAnimationFrame(() => event.currentTarget.parentElement?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
              }}
            >
              <span className={styles.thumb} aria-hidden="true">
                <span className={`${styles.scaled} ${attendeeHomeStyles.homePage}`} style={vars} inert>
                  <AttendeeHomeLanding
                    eventName={eventName}
                    hasTicket
                    keyvisual={keyvisual}
                    defaultHomeBanner={defaultHomeBanner}
                    homeStyle={sample}
                    homeMenus={homeMenus}
                    programs={programs}
                    unavailable={unavailable}
                    preview
                  />
                </span>
              </span>
              <span className={styles.name}>{layout.name}</span>
              <span className={styles.hint}>{layout.hint}</span>
            </div>
          );
        })}
        <button type="button" role="radio" aria-checked={false} aria-disabled="true" className={`${styles.card} ${styles.locked}`} tabIndex={-1} onClick={(event) => event.preventDefault()}>
          <span className={`${styles.thumb} ${styles.lockedThumb}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          </span>
          <span className={styles.name}>인스타형</span>
          <span className={styles.hint}>사진 중심 · 곧 제공</span>
        </button>
      </div>
      {value === "poster" ? (
        <div className={styles.shapes} role="radiogroup" aria-label="포스터형 메뉴 모양">
          <span className={styles.shapesLabel}>메뉴 모양</span>
          {(["circle", "list"] as const).map((shape) => (
            <button key={shape} type="button" role="radio" aria-checked={menuShape === shape} className={styles.shape} disabled={disabled} onClick={() => onMenuShape(shape)}>
              <span className={styles.shapeArt} data-shape={shape} aria-hidden="true"><i /><i /><i /></span>
              {shape === "circle" ? "원형 아이콘" : "목록"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
