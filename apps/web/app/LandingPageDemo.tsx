"use client";

import { useState, type CSSProperties } from "react";
import { LandingIcon, type LandingIconName } from "./LandingIcons";
import styles from "./landing-sections.module.css";

const LAYOUTS = [
  { id: "tile", label: "타일형", hint: "공지·일정·참여를 큰 카드로 한눈에" },
  { id: "poster", label: "포스터형", hint: "큰 배너와 원형 바로가기" },
  { id: "instagram", label: "인스타형", hint: "승인된 현장 사진을 피드로" },
] as const;

const GROUNDS = [
  { id: "a1", label: "흰색" },
  { id: "a2", label: "행사 색" },
] as const;

const COLORS = [
  { id: "orange", label: "주황", value: "#E76D26" },
  { id: "teal", label: "청록", value: "#0B7A7C" },
  { id: "indigo", label: "남색", value: "#3F55C2" },
  { id: "plum", label: "자주", value: "#8A3A87" },
  { id: "forest", label: "초록", value: "#2F7050" },
] as const;

type LayoutId = (typeof LAYOUTS)[number]["id"];
type GroundId = (typeof GROUNDS)[number]["id"];

// The product picks the ink that reads on an event colour by contrast; this
// drawn sample does the same so every colour above stays legible.
const SAMPLE_INK = "#19191C";
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const readableOn = (hex: string) => (contrast(luminance(SAMPLE_INK), luminance(hex)) >= contrast(1, luminance(hex)) ? SAMPLE_INK : "#FFFFFF");

const SHORTCUTS: ReadonlyArray<{ label: string; icon: LandingIconName }> = [
  { label: "공지사항", icon: "notice" },
  { label: "프로그램", icon: "clock" },
  { label: "오시는 길", icon: "pin" },
  { label: "순위 투표", icon: "vote" },
  { label: "룰렛 이벤트", icon: "gift" },
  { label: "행사 참여", icon: "spark" },
];

/**
 * The attendee page is configured per event. This is a drawn sample of the
 * three layouts and a few event colors, not the live product; it changes
 * nothing and loads no event data.
 */
export default function LandingPageDemo() {
  const [layout, setLayout] = useState<LayoutId>("poster");
  const [colorId, setColorId] = useState<(typeof COLORS)[number]["id"]>("orange");
  const [ground, setGround] = useState<GroundId>("a1");
  const color = COLORS.find((item) => item.id === colorId) ?? COLORS[0];
  const current = LAYOUTS.find((item) => item.id === layout) ?? LAYOUTS[0];
  const ink = readableOn(color.value);

  return (
    <div className={styles.demo}>
      <div className={styles.demoControls}>
        <div className={styles.demoGroup}>
          <p id="demo-layout-label">화면 구성</p>
          <div className={styles.demoLayouts} role="radiogroup" aria-labelledby="demo-layout-label">
            {LAYOUTS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={layout === item.id}
                className={styles.demoLayout}
                onClick={() => setLayout(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.demoGroup}>
          <p id="demo-ground-label">화면 바탕</p>
          <div className={styles.demoGrounds} role="radiogroup" aria-labelledby="demo-ground-label">
            {GROUNDS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={ground === item.id}
                className={styles.demoGround}
                onClick={() => setGround(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.demoGroup}>
          <p id="demo-color-label">행사 색 <span>{color.label}</span></p>
          <div className={styles.demoColors} role="radiogroup" aria-labelledby="demo-color-label">
            {COLORS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={colorId === item.id}
                aria-label={item.label}
                className={styles.demoSwatch}
                style={{ "--swatch": item.value } as CSSProperties}
                onClick={() => setColorId(item.id)}
              />
            ))}
          </div>
        </div>
        <ul className={styles.demoFacts}>
          <li>고른 구성은 참가자 홈과 행사 안내에 함께 적용됩니다.</li>
          <li>행사 색 위의 글자색은 읽기 쉬운 대비로 자동 조정됩니다.</li>
        </ul>
      </div>

      <figure className={styles.demoStage}>
        <div className={styles.demoPhone} data-ground={ground} style={{ "--demo": color.value, "--demo-on": ink, "--demo-shade": ink === SAMPLE_INK ? "var(--paper)" : "var(--stage)" } as CSSProperties} aria-label={`${current.label} 참가자 화면 구성 예시`} role="img">
          <div className={styles.demoBanner}>
            <span>12월 12일 · 코엑스</span>
            <strong>파트너<br />컨퍼런스</strong>
          </div>
          <div className={styles.demoTicket}>
            <span><LandingIcon name="qr" size={18} /></span>
            <b>모바일 티켓</b>
            <i>열기</i>
          </div>
          <div key={layout} className={styles.demoBody} data-layout={layout}>
            {layout === "tile" ? (
              <>
                <div className={styles.demoTiles}>
                  {SHORTCUTS.slice(0, 4).map((item) => (
                    <span key={item.label}><i><LandingIcon name={item.icon} size={18} /></i>{item.label}</span>
                  ))}
                </div>
                <div className={styles.demoNotice}><b>입장 전 QR을 준비해 주세요</b><span>신청 후 받은 티켓 QR을 화면에 띄워 주세요.</span></div>
              </>
            ) : layout === "poster" ? (
              <>
                <p>행사 안내</p>
                <div className={styles.demoCircles}>
                  {SHORTCUTS.slice(0, 3).map((item) => (
                    <span key={item.label}><i><LandingIcon name={item.icon} size={20} /></i>{item.label}</span>
                  ))}
                </div>
                <p>행사 참여</p>
                <div className={styles.demoCircles}>
                  {SHORTCUTS.slice(3).map((item) => (
                    <span key={item.label}><i><LandingIcon name={item.icon} size={20} /></i>{item.label}</span>
                  ))}
                </div>
                <div className={styles.demoNotice}><b>입장 전 QR을 준비해 주세요</b><span>신청 후 받은 티켓 QR을 화면에 띄워 주세요.</span></div>
              </>
            ) : (
              <>
                <p>승인된 현장 사진</p>
                <div className={styles.demoFeed}>
                  {Array.from({ length: 9 }, (_, i) => <span key={i} data-n={i} />)}
                </div>
              </>
            )}
          </div>
        </div>
        <figcaption>
          <strong>{current.label}</strong> · 화면 구성 예시, 실제 행사 데이터가 아닙니다.
        </figcaption>
      </figure>
    </div>
  );
}
