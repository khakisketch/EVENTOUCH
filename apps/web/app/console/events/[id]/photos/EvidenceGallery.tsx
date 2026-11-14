"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./evidence-photos.module.css";

// Justified rows: every row has the same height and photos keep their own
// ratio (no crop, no letterbox). Stored width/height lay the rows out first; a
// phone portrait JPEG is stored sideways with an EXIF rotation flag, so the
// ratio the browser actually shows (naturalWidth / naturalHeight) replaces the
// stored one as soon as an image loads. A photo with no stored size holds a
// 4:3 slot until then.

export type GalleryItem = {
  id: string;
  src: string;
  label: string;
  time: string | null;
  width?: number;
  height?: number;
};

const GAP = 6;
const FALLBACK_RATIO = 4 / 3;

export type RowPlan = { from: number; to: number; height: number };

// Greedy line breaking: fill a row at the target height, then scale it to
// the container width. The last row stays at the target height, and a lone
// very wide photo is capped so it never towers.
export function planRows(ratios: number[], width: number, target: number, gap: number): RowPlan[] {
  const rows: RowPlan[] = [];
  let from = 0;
  let sum = 0;
  for (let index = 0; index < ratios.length; index += 1) {
    sum += ratios[index];
    const count = index - from + 1;
    if (sum * target + gap * (count - 1) >= width) {
      const height = Math.min((width - gap * (count - 1)) / sum, target * 1.6);
      rows.push({ from, to: index + 1, height });
      from = index + 1;
      sum = 0;
    }
  }
  if (from < ratios.length) rows.push({ from, to: ratios.length, height: target });
  return rows;
}

export default function EvidenceGallery({ items, onOpen, addSlot }: { items: GalleryItem[]; onOpen: (id: string) => void; addSlot?: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const pendingRef = useRef<Record<string, number>>({});
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const update = () => setWidth(Math.max(240, Math.floor(node.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => { if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current); }, []);

  function remember(id: string, image: HTMLImageElement) {
    const ratio = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 0;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    pendingRef.current[id] = ratio;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = {};
      setMeasured((current) => {
        let changed = false;
        const next = { ...current };
        for (const [key, value] of Object.entries(batch)) {
          if (!current[key] || Math.abs(current[key] - value) / value > 0.01) { next[key] = value; changed = true; }
        }
        return changed ? next : current;
      });
    });
  }

  const ratios = items.map((item) => measured[item.id] ?? (item.width && item.height ? item.width / item.height : FALLBACK_RATIO));
  const cells: Array<GalleryItem | "add"> = addSlot ? [...items, "add"] : items;
  const allRatios = addSlot ? [...ratios, 1] : ratios;
  const target = width < 520 ? 112 : width < 900 ? 150 : 200;
  const rows = planRows(allRatios, width, target, GAP);

  return (
    <div ref={boxRef} className={styles.gallery}>
      {rows.map((row) => (
        <div key={row.from} className={styles.galleryRow} style={{ height: row.height, gap: GAP }}>
          {cells.slice(row.from, row.to).map((cell, offset) => {
            const index = row.from + offset;
            const cellWidth = allRatios[index] * row.height;
            if (cell === "add") {
              return <div key="add" className={`${styles.galleryCell} ${styles.galleryCellAdd}`} style={{ width: Math.min(cellWidth, 160), height: Math.min(row.height, 160) }}>{addSlot}</div>;
            }
            return (
              <div key={cell.id} id={`evidence-photo-${cell.id}`} tabIndex={-1} className={styles.galleryCell} style={{ width: cellWidth, height: row.height }}>
                <button type="button" className={styles.galleryButton} aria-label={`${cell.label} 크게 보기`} onClick={() => onOpen(cell.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={cell.src} alt="" loading="lazy" decoding="async" onLoad={(event) => remember(cell.id, event.currentTarget)} />
                  {cell.time ? <span className={styles.galleryTime}>{cell.time}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
