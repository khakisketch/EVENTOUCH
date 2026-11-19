"use client";

import { useState, type CSSProperties } from "react";
import { LandingIcon, type LandingIconName } from "./LandingIcons";
import styles from "./landing-sections.module.css";

const LAYOUTS = [
  { id: "tile", label: "타일형", hint: "공지·일정·참여를 큰 카드로 한눈에" },
  { id: "poster", label: "포스터형", hint: "큰 배너와 원형 바로가기" },
  { id: "instagram", label: "인스타형", hint: "승인된 현장 사진을 피드로" },
] as const;

const COLORS = [
  { id: "orange", label: "주황", value: "#E76D26" },
  { id: "teal", label: "청록", value: "#0E8587" },
  { id: "indigo", label: "남색", value: "#3F55C2" },
  { id: "plum", label: "자주", value: "#8A3A87" },
  { id: "forest", label: "초록", value: "#2F7050" },
] as const;

type LayoutId = (typeof LAYOUTS)[number]["id"];

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
  const color = COLORS.find((item) => item.id === colorId) ?? COLORS[0];
  const current = LAYOUTS.find((item) => item.id === layout) ?? LAYOUTS[0];

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
          <li>참가자는 링크 하나로 신청, 티켓, 참여까지 이어집니다.</li>
          <li>고른 구성은 참가자 홈과 행사 안내에 함께 적용됩니다.</li>
        </ul>
      </div>

      <figure className={styles.demoStage}>
        <div className={styles.demoPhone} style={{ "--demo": color.value } as CSSProperties} aria-label={`${current.label} 참가자 화면 구성 예시`} role="img">
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
