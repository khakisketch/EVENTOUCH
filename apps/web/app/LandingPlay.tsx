"use client";

import { useEffect, useRef, useState } from "react";
import ProductPreview from "./ProductPreview";
import styles from "./landing-play.module.css";

// Hands-on section of the public landing (owner choice 2026-11-25): a visitor runs the stage
// draw and spins the phone roulette themselves. Everything is drawn and picked in the browser;
// nothing is sent, stored or read from an event.
const WINNERS = [
  { digits: [2, 1, 7], name: "김하늘" },
  { digits: [3, 0, 4], name: "이도윤" },
  { digits: [2, 9, 7], name: "박서연" },
  { digits: [1, 5, 8], name: "정하윤" },
] as const;

const PRIZES = ["스마트 워치", "커피 쿠폰", "텀블러", "에코백", "상품권", "기념품"] as const;

// Six equal sectors, the first one starting at twelve o'clock, drawn clockwise.
const SECTORS = [
  { path: "M0 0 L0 -98 A98 98 0 0 1 84.87 -49 Z", x: 33, y: -57 },
  { path: "M0 0 L84.87 -49 A98 98 0 0 1 84.87 49 Z", x: 66, y: 0 },
  { path: "M0 0 L84.87 49 A98 98 0 0 1 0 98 Z", x: 33, y: 57 },
  { path: "M0 0 L0 98 A98 98 0 0 1 -84.87 49 Z", x: -33, y: 57 },
  { path: "M0 0 L-84.87 49 A98 98 0 0 1 -84.87 -49 Z", x: -66, y: 0 },
  { path: "M0 0 L-84.87 -49 A98 98 0 0 1 0 -98 Z", x: -33, y: -57 },
] as const;

const SPIN_MS = 3600;
const TICK_MS = 70;
const FIRST_LOCK = 14;
const LOCK_STEP = 9;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function DrawDemo() {
  const [digits, setDigits] = useState<readonly number[]>(WINNERS[2].digits);
  const [phase, setPhase] = useState<"ready" | "running" | "done">("ready");
  const [name, setName] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearInterval(timer.current), []);

  function run() {
    if (phase === "running") return;
    const winner = WINNERS[Math.floor(Math.random() * WINNERS.length)];
    const finish = () => {
      setDigits(winner.digits);
      setName(winner.name);
      setPhase("done");
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    let tick = 0;
    setPhase("running");
    timer.current = window.setInterval(() => {
      tick += 1;
      if (tick > FIRST_LOCK + LOCK_STEP * 2) {
        window.clearInterval(timer.current);
        finish();
        return;
      }
      setDigits(winner.digits.map((digit, i) => (tick > FIRST_LOCK + i * LOCK_STEP ? digit : Math.floor(Math.random() * 10))));
    }, TICK_MS);
  }

  return (
    <article className={styles.draw} aria-labelledby="play-draw-title">
      <h3 id="play-draw-title">무대 추첨</h3>
      <p className={styles.lead}>모두가 보는 대형 화면에서 럭키번호가 떨어집니다.</p>
      <div className={styles.slot} aria-hidden="true">
        {digits.map((digit, i) => <span key={i}>{digit}</span>)}
      </div>
      <div className={styles.winner} role="status" aria-live="polite">
        <span>{phase === "running" ? "추첨 중" : phase === "done" ? "당첨 참가자" : "추첨 대기"}</span>
        <strong>{phase === "done" ? name : phase === "running" ? "…" : "버튼을 눌러 보세요"}</strong>
        {phase === "done" ? <span className={styles.srOnly}>럭키번호 {digits.join("")}</span> : null}
      </div>
      <button type="button" className={styles.drawButton} onClick={run} aria-disabled={phase === "running"}>
        {phase === "running" ? "추첨 중" : phase === "done" ? "다시 추첨" : "추첨 시작"}
      </button>
    </article>
  );
}

function RouletteDemo() {
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [prize, setPrize] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function spin() {
    if (spinning) return;
    const pick = Math.floor(Math.random() * PRIZES.length);
    // The pointer sits at twelve o'clock: bring the middle of the picked sector there.
    const target = 360 - (pick * 60 + 30);
    const next = rotation + 1800 + ((target - (rotation % 360) + 360) % 360);
    setRotation(next);
    if (prefersReducedMotion()) {
      setPrize(PRIZES[pick]);
      return;
    }
    setPrize("");
    setSpinning(true);
    timer.current = window.setTimeout(() => {
      setSpinning(false);
      setPrize(PRIZES[pick]);
    }, SPIN_MS + 100);
  }

  return (
    <article className={styles.roulette} aria-labelledby="play-roulette-title">
      <h3 id="play-roulette-title">휴대폰 룰렛</h3>
      <p className={styles.lead}>참가자가 각자 돌리고 바로 당첨됩니다.</p>
      <div className={styles.wheel}>
        {/* The disc clips the turning square, whose corners would otherwise widen a narrow page. */}
        <div className={styles.disc} aria-hidden="true">
          <div className={styles.rotor} style={{ transform: `rotate(${rotation}deg)` }}>
            <svg viewBox="-100 -100 200 200">
              {SECTORS.map((sector, i) => <path key={sector.path} d={sector.path} data-odd={i % 2 === 1} />)}
              {SECTORS.map((sector, i) => <text key={i} x={sector.x} y={sector.y}>{i + 1}</text>)}
            </svg>
          </div>
        </div>
        <svg className={styles.pointer} viewBox="0 0 44 40" aria-hidden="true"><path d="M4 4H40L22 34Z" /></svg>
        <button type="button" className={styles.hub} onClick={spin} aria-label={spinning ? "룰렛이 돌아가는 중" : "START · 룰렛 돌리기"} aria-disabled={spinning}>
          {spinning ? "…" : "START"}
        </button>
      </div>
      <ol className={styles.prizes}>
        {PRIZES.map((label) => <li key={label} data-won={label === prize || undefined}>{label}</li>)}
      </ol>
      <div className={styles.prize} role="status" aria-live="polite">
        <span>{spinning ? "룰렛이 멈추고 있습니다" : prize ? "내 당첨 경품" : "룰렛 대기"}</span>
        <strong>{prize || (spinning ? "…" : "START를 눌러 보세요")}</strong>
      </div>
    </article>
  );
}

export default function LandingPlay() {
  return (
    <div className={styles.play}>
      <div className={styles.games}>
        <DrawDemo />
        <RouletteDemo />
      </div>
      <article className={styles.checkin} id="play-checkin" aria-labelledby="play-checkin-title">
        <div className={styles.checkinCopy}>
          <h3 id="play-checkin-title">체크인</h3>
          <p>참가자는 티켓 QR을 보여 주고, 배정된 스태프는 휴대폰 웹에서 스캔하거나 명단에서 찾습니다. 운영자는 입장 상황을 현장 모드에서 봅니다.</p>
          <small>쓰는 화면 · 입장 관리, 현장 모드</small>
        </div>
        <div className={styles.phones}>
          <div className={styles.phone}><ProductPreview variant="ticket" /></div>
          <div className={styles.phone}><ProductPreview variant="staff" /></div>
        </div>
      </article>
    </div>
  );
}
