"use client";

// A color choice that is easy to use and good to look at: a row of curated
// swatches, then "직접 고르기" which opens a real picker (a saturation/value
// field, a hue bar, a hex box, the browser eyedropper where it exists, recent
// colors, and colors taken from the banner picture). Values are always
// uppercase #RRGGBB, the form the server stores.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import styles from "./color-field.module.css";

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#B9DEF0";
  const r = parseInt(value.slice(1, 3), 16) / 255;
  const g = parseInt(value.slice(3, 5), 16) / 255;
  const b = parseInt(value.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const RECENT_KEY = "eventouch.recent-colors";
function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && /^#[0-9A-F]{6}$/.test(item)).slice(0, 6) : [];
  } catch { return []; }
}
function rememberColor(hex: string) {
  try {
    const next = [hex, ...readRecent().filter((item) => item !== hex)].slice(0, 6);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode: recents are a convenience */ }
}

/** The most common distinct colors of a picture, for "배너에서". */
export async function paletteFromImage(url: string, count = 5): Promise<string[]> {
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(image, 0, 0, 32, 32);
    const { data } = context.getImageData(0, 0, 32, 32);
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 200) continue;
      const key = ((data[index] >> 5) << 6) | ((data[index + 1] >> 5) << 3) | (data[index + 2] >> 5);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n += 1; bucket.r += data[index]; bucket.g += data[index + 1]; bucket.b += data[index + 2];
      buckets.set(key, bucket);
    }
    const picked: Array<[number, number, number]> = [];
    for (const bucket of [...buckets.values()].sort((left, right) => right.n - left.n)) {
      const color: [number, number, number] = [Math.round(bucket.r / bucket.n), Math.round(bucket.g / bucket.n), Math.round(bucket.b / bucket.n)];
      if (picked.every((other) => Math.hypot(other[0] - color[0], other[1] - color[1], other[2] - color[2]) > 60)) picked.push(color);
      if (picked.length >= count) break;
    }
    return picked.map(([r, g, b]) => `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  } catch { return []; }
}

type EyeDropperLike = { open: () => Promise<{ sRGBHex: string }> };

type Props = {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  swatches: ReadonlyArray<{ color: string; name: string }>;
  disabled?: boolean;
  /** A picture whose colors are offered as "배너에서". */
  paletteSource?: string | null;
  /** Show only the picker and swatches without the "직접 고르기" toggle row heading. */
  compact?: boolean;
};

export default function ColorField({ label, value, onChange, swatches, disabled = false, paletteSource = null, compact = false }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value);
  const [recent, setRecent] = useState<string[]>([]);
  const [palette, setPalette] = useState<string[]>([]);
  const area = useRef<HTMLDivElement | null>(null);
  const hasEyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const known = swatches.some((swatch) => swatch.color === value);

  // Follow outside changes (a preset, a reset, a loaded draft) without
  // fighting the hue the operator is dragging.
  useEffect(() => {
    if (hsvToHex(hsv) !== value) { setHsv(hexToHsv(value)); }
    setHexText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => { if (open) setRecent(readRecent()); }, [open]);
  useEffect(() => {
    if (!open || !paletteSource) { setPalette([]); return; }
    let cancelled = false;
    void paletteFromImage(paletteSource).then((colors) => { if (!cancelled) setPalette(colors); });
    return () => { cancelled = true; };
  }, [open, paletteSource]);

  function commit(next: Hsv) {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexText(hex);
    onChange(hex);
  }
  function finish() { rememberColor(hsvToHex(hsv)); }

  function pointer(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = area.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
    commit({ ...hsv, s, v });
  }
  function areaKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: Math.max(0, hsv.s - step) }, ArrowRight: { s: Math.min(1, hsv.s + step) },
      ArrowUp: { v: Math.min(1, hsv.v + step) }, ArrowDown: { v: Math.max(0, hsv.v - step) },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    commit({ ...hsv, ...move });
  }
  function typed(text: string) {
    setHexText(text);
    const normalized = text.startsWith("#") ? text : `#${text}`;
    if (/^#[0-9a-f]{6}$/i.test(normalized)) { const hex = normalized.toUpperCase(); setHsv(hexToHsv(hex)); onChange(hex); }
  }
  async function eyedrop() {
    try {
      const Ctor = (window as unknown as { EyeDropper: new () => EyeDropperLike }).EyeDropper;
      const result = await new Ctor().open();
      const hex = result.sRGBHex.toUpperCase();
      setHsv(hexToHsv(hex)); setHexText(hex); onChange(hex); rememberColor(hex);
    } catch { /* cancelled */ }
  }

  const hueColor = useMemo(() => hsvToHex({ h: hsv.h, s: 1, v: 1 }), [hsv.h]);

  return (
    <div className={styles.field}>
      <div className={styles.swatches} role="radiogroup" aria-label={label}>
        {swatches.map((swatch) => (
          <button
            key={swatch.color}
            type="button"
            role="radio"
            aria-checked={swatch.color === value}
            aria-label={`${swatch.name} ${swatch.color}`}
            title={swatch.name}
            className={styles.swatch}
            style={{ background: swatch.color }}
            disabled={disabled}
            onClick={() => { onChange(swatch.color); rememberColor(swatch.color); }}
          />
        ))}
        <button
          type="button"
          className={styles.custom}
          aria-expanded={open}
          aria-controls={`${id}-picker`}
          data-active={!known || open || undefined}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <span className={styles.wheel} aria-hidden="true" style={!known ? { boxShadow: `inset 0 0 0 4px ${value}` } : undefined} />
          {compact ? null : <span>직접 고르기</span>}
          {compact ? <span className="sr-only">{label} 직접 고르기</span> : null}
        </button>
      </div>
      {open ? (
        <div className={styles.picker} id={`${id}-picker`}>
          <div
            ref={area}
            className={styles.area}
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
            role="slider"
            tabIndex={0}
            aria-label={`${label} 채도와 밝기`}
            aria-valuetext={`채도 ${Math.round(hsv.s * 100)}%, 밝기 ${Math.round(hsv.v * 100)}%`}
            aria-valuenow={Math.round(hsv.s * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            onKeyDown={areaKey}
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer(event); }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pointer(event); }}
            onPointerUp={finish}
          >
            <span className={styles.knob} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }} aria-hidden="true" />
          </div>
          <input
            className={styles.hue}
            type="range"
            min={0}
            max={359}
            value={Math.round(hsv.h)}
            aria-label={`${label} 색상`}
            onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
            onPointerUp={finish}
            onKeyUp={finish}
          />
          <div className={styles.hexRow}>
            <input
              className={styles.hex}
              type="text"
              inputMode="text"
              spellCheck={false}
              maxLength={7}
              aria-label={`${label} 색 코드`}
              value={hexText}
              onChange={(event) => typed(event.target.value.toUpperCase())}
              onBlur={() => { setHexText(value); finish(); }}
            />
            {hasEyedropper ? <button type="button" className={styles.eye} onClick={() => void eyedrop()} aria-label="화면에서 색 찍기" title="화면에서 색 찍기">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4l6 6-9 9-4 1 1-4zM13 5l6 6" /></svg>
            </button> : null}
          </div>
          {palette.length || recent.length ? (
            <div className={styles.more}>
              {palette.length ? <div><small>배너에서</small><div className={styles.chips}>{palette.map((color) => <button key={color} type="button" className={styles.chip} style={{ background: color }} aria-label={`배너에서 뽑은 색 ${color}`} onClick={() => { onChange(color); rememberColor(color); }} />)}</div></div> : null}
              {recent.length ? <div><small>최근</small><div className={styles.chips}>{recent.map((color) => <button key={color} type="button" className={styles.chip} style={{ background: color }} aria-label={`최근 색 ${color}`} onClick={() => onChange(color)} />)}</div></div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
