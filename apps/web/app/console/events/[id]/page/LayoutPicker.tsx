"use client";

// The first choice on the attendee page: which composition the home takes.
// Each card is the real home rendered small with the event's own colors and
// banner, so what you pick is what attendees get. The photo-first 인스타형 shows
// where the approved participant photos will go until there are some.

import type { CSSProperties } from "react";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import { readableInk, type HomeLayout, type HomePhoto, type HomeStyle } from "../../../../../lib/attendee-home";
import type { HomeMenus, HomeProgram } from "../../../../../lib/attendee-home-menus";
import styles from "./layout-picker.module.css";

const LAYOUTS: Array<{ id: HomeLayout; name: string; hint: string }> = [
  { id: "tile", name: "타일형", hint: "정사각 타일 메뉴" },
  { id: "poster", name: "포스터형", hint: "큰 배너와 아이콘 메뉴" },
  { id: "instagram", name: "인스타형", hint: "참가자 사진 피드" },
];

type Props = {
  value: HomeLayout;
  homeStyle: HomeStyle;
  eventName: string;
  keyvisual: string | null;
  defaultHomeBanner: "legacy" | "neutral";
  homeMenus: HomeMenus;
  programs: HomeProgram[];
  photos: HomePhoto[];
  unavailable: Array<"notice" | "lucky" | "roulette" | "vote" | "stamp">;
  disabled?: boolean;
  onLayout: (layout: HomeLayout) => void;
};

export default function LayoutPicker({ value, homeStyle, eventName, keyvisual, defaultHomeBanner, homeMenus, programs, photos, unavailable, disabled = false, onLayout }: Props) {
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
                    photos={photos}
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
      </div>
    </div>
  );
}
