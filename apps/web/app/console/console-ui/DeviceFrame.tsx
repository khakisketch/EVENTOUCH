"use client";

// One device simulator for every console preview. The content is laid out at
// the device's real CSS width (a 390px phone, a 1280px venue screen) and the
// whole device is scaled down to the room it is given, so a preview reads like
// the real page instead of a squeezed copy. The bezel, buttons, status bar,
// camera island and home indicator are decorative (aria-hidden); the inner
// content keeps its own semantics, and the scrolling screen can be named with
// `scrollLabel` so it is reachable by keyboard.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import styles from "./device-frame.module.css";

export type DeviceVariant = "phone" | "screen" | "tablet";

type Spec = {
  width: number;
  viewportHeight: number;
  bezel: number;
  // Status row above and home row below the scrolling content.
  top: number;
  bottom: number;
  // Hardware sticking out of the body on each side (phone buttons).
  side: number;
  // Stand under a venue screen.
  stand: number;
};

const SPECS: Record<DeviceVariant, Spec> = {
  phone: { width: 390, viewportHeight: 700, bezel: 11, top: 50, bottom: 30, side: 4, stand: 0 },
  tablet: { width: 768, viewportHeight: 960, bezel: 20, top: 28, bottom: 22, side: 0, stand: 0 },
  screen: { width: 1280, viewportHeight: 720, bezel: 14, top: 0, bottom: 0, side: 0, stand: 64 },
};

function spec(variant: DeviceVariant, width?: number, viewportHeight?: number): Spec {
  const base = SPECS[variant];
  return { ...base, width: width ?? base.width, viewportHeight: viewportHeight ?? base.viewportHeight };
}

/** Outer size of the whole device (bezel, buttons and stand included) in CSS px. */
export function deviceSize(variant: DeviceVariant, width?: number, viewportHeight?: number): { width: number; height: number } {
  const s = spec(variant, width, viewportHeight);
  return {
    width: s.width + 2 * s.bezel + 2 * s.side,
    height: s.top + s.viewportHeight + s.bottom + 2 * s.bezel + s.stand,
  };
}

function channel(hex: string, index: number): number {
  const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// Status bar ink that stays readable on the page's own top color.
function statusInk(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return "rgb(30 32 38)";
  const luminance = 0.2126 * channel(color, 0) + 0.7152 * channel(color, 1) + 0.0722 * channel(color, 2);
  return luminance > 0.4 ? "rgb(20 22 26)" : "rgb(255 255 255)";
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function StatusGlyphs() {
  return (
    <span className={styles.glyphs}>
      <svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></svg>
      <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M1.2 4.3a10 10 0 0 1 14.6 0" /><path d="M3.9 7a6.2 6.2 0 0 1 9.2 0" /><circle cx="8.5" cy="10.2" r="1.1" fill="currentColor" stroke="none" /></svg>
      <svg width="28" height="13" viewBox="0 0 28 13" fill="none"><rect x="0.6" y="0.6" width="23.8" height="11.8" rx="3.6" stroke="currentColor" opacity="0.4" strokeWidth="1.2" /><rect x="2.4" y="2.4" width="20.2" height="8.2" rx="2.2" fill="currentColor" /><path d="M26 4.4v4.2c.9-.3 1.5-1.2 1.5-2.1S26.9 4.7 26 4.4Z" fill="currentColor" opacity="0.45" /></svg>
    </span>
  );
}

export type DeviceFrameProps = {
  variant?: DeviceVariant;
  children: ReactNode;
  /** CSS width of the device's screen; default is the real device (390 / 1280 / 768). */
  width?: number;
  /** Height of the scrolling content area; the status and home rows are added. */
  viewportHeight?: number;
  /** Widest the device is drawn on the page (CSS px); default: its real size. */
  maxDisplayWidth?: number;
  /** Page color under the status bar and home indicator (phone, tablet). */
  chromeColor?: string;
  /** Names the scrolling screen so keyboard users can scroll it. */
  scrollLabel?: string;
  /** Visible caption under the device ("참가자 폰에서 보이는 화면"). */
  caption?: ReactNode;
  /** Screen is a static redraw and never scrolls. */
  fixed?: boolean;
  className?: string;
  contentClassName?: string;
  contentStyle?: CSSProperties;
  contentRef?: Ref<HTMLDivElement>;
  /** Lets a caller that measures its own host drive the scale. */
  onScale?: (scale: number) => void;
};

export default function DeviceFrame({
  variant = "phone",
  children,
  width,
  viewportHeight,
  maxDisplayWidth,
  chromeColor = "#FFFFFF",
  scrollLabel,
  caption,
  fixed = false,
  className = "",
  contentClassName = "",
  contentStyle,
  contentRef,
  onScale,
}: DeviceFrameProps) {
  const s = spec(variant, width, viewportHeight);
  const size = deviceSize(variant, width, viewportHeight);
  const fitRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const onScaleRef = useRef(onScale);
  onScaleRef.current = onScale;

  useIsomorphicLayoutEffect(() => {
    const node = fitRef.current;
    if (!node) return;
    const measure = () => {
      const available = node.clientWidth;
      if (!available) return;
      const next = available / size.width;
      setScale(next);
      onScaleRef.current?.(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [size.width]);

  const ink = statusInk(chromeColor);
  const vars = {
    "--df-w": `${s.width}px`,
    "--df-vh": `${s.viewportHeight}px`,
    "--df-bezel": `${s.bezel}px`,
    "--df-top": `${s.top}px`,
    "--df-bottom": `${s.bottom}px`,
    "--df-side": `${s.side}px`,
    "--df-stand": `${s.stand}px`,
    "--df-chrome": chromeColor,
    "--df-ink": ink,
  } as CSSProperties;

  const scrollProps = scrollLabel ? { role: "region" as const, "aria-label": scrollLabel, tabIndex: 0 } : {};

  return (
    <div className={`${styles.root} ${className}`} data-device={variant} style={{ maxWidth: maxDisplayWidth ?? size.width }}>
      <div className={styles.fit} ref={fitRef} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
        <div
          className={styles.device}
          style={{ ...vars, width: size.width, height: size.height, transform: `scale(${scale ?? 1})`, visibility: scale === null ? "hidden" : "visible" }}
        >
          {variant === "screen" ? <span className={styles.floor} aria-hidden="true" /> : null}
          <div className={styles.body}>
            {variant === "phone" ? (
              <span className={styles.buttons} aria-hidden="true">
                <i className={styles.btnAction} />
                <i className={styles.btnUp} />
                <i className={styles.btnDown} />
                <i className={styles.btnPower} />
              </span>
            ) : null}
            <div className={styles.glass}>
              {variant !== "screen" ? (
                <div className={styles.status} aria-hidden="true">
                  <span className={styles.clock}>9:41</span>
                  {variant === "phone" ? <span className={styles.island}><i /></span> : <span className={styles.camera} />}
                  <StatusGlyphs />
                </div>
              ) : null}
              <div
                className={`${styles.content} ${fixed ? styles.contentFixed : ""} ${contentClassName}`}
                style={contentStyle}
                ref={contentRef}
                {...scrollProps}
              >
                {children}
              </div>
              {variant !== "screen" ? <div className={styles.home} aria-hidden="true"><i /></div> : null}
            </div>
            {variant === "screen" ? <span className={styles.led} aria-hidden="true" /> : null}
          </div>
          {variant === "screen" ? (
            <span className={styles.stand} aria-hidden="true"><i className={styles.neck} /><i className={styles.foot} /></span>
          ) : null}
        </div>
      </div>
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </div>
  );
}
