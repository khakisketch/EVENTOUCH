"use client";

import { useEffect, useRef, useState } from "react";
import { LandingIcon, type LandingIconName } from "./LandingIcons";
import styles from "./landing-sections.module.css";

const ROWS: ReadonlyArray<{ moment: string; icon: LandingIconName; old: string; now: string }> = [
  { moment: "행사 전 명단", icon: "users", old: "흩어진 파일, 누가 왔는지 나중에 정리", now: "승인·입장 상태가 한 명단에 모여 보임" },
  { moment: "입구 체크인", icon: "qr", old: "종이 명단을 눈으로 대조", now: "QR·검색 체크인, 이미 입장한 티켓은 바로 안내" },
  { moment: "문자 안내", icon: "mail", old: "문자 보내고 전달 확인 불가", now: "예약·발송 결과·미확인 복구까지 기록" },
  { moment: "행사 후 집계", icon: "chart", old: "행사 후 수기 집계", now: "입장 기록이 자동으로 집계됨" },
];

/**
 * Four things that happen on the day, shown the old way first. The page turns
 * the comparison over once when it is first seen; the reader can flip it back.
 */
export default function LandingCompare() {
  const [now, setNow] = useState(false);
  const touched = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    let timer = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      timer = window.setTimeout(() => { if (!touched.current) setNow(true); }, 1400);
    }, { threshold: 0.55 });
    io.observe(el);
    return () => { io.disconnect(); window.clearTimeout(timer); };
  }, []);

  const choose = (next: boolean) => { touched.current = true; setNow(next); };

  return (
    <div ref={root} className={styles.compare} data-now={now ? "true" : "false"}>
      <div className={styles.compareSwitch} role="group" aria-label="비교 기준">
        <button type="button" aria-pressed={!now} onClick={() => choose(false)}>종이·엑셀 명단</button>
        <button type="button" aria-pressed={now} onClick={() => choose(true)}>EVENTOUCH</button>
        <i aria-hidden="true" />
      </div>
      <ul className={styles.compareGrid}>
        {ROWS.map((row) => (
          <li key={row.moment} className={styles.compareCard}>
            <span className={styles.compareIcon}><LandingIcon name={row.icon} size={20} /></span>
            <p className={styles.compareMoment}>{row.moment}</p>
            <div className={styles.compareText}>
              <p className={styles.compareOld} aria-hidden={now}><LandingIcon name="x" size={16} />{row.old}</p>
              <p className={styles.compareNow} aria-hidden={!now}><LandingIcon name="check" size={16} />{row.now}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
