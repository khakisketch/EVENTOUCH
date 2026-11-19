"use client";

import { useEffect, useRef, useState } from "react";
import { niceMax, type HourBucket, type PeriodPoint } from "../../../../../lib/period-analysis";
import ConsoleEmptyState from "../../../console-ui/ConsoleEmptyState";
import styles from "./analysis.module.css";

// 기간 분석의 도형 셋: 일별 막대(SVG), 시간대별 입장(HTML 막대), 소속별 신청(가로 막대).
// 값은 모두 위쪽 분석 결과를 그대로 그리며 여기서 다시 집계하지 않는다.

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 2026-11-18 -> 11/18 (수). 로컬 달력 날짜만 쓴다. */
export function dayLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  return `${month}/${day} (${weekday})`;
}

function useElementWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(240, Math.round(node.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function axisTicks(max: number): number[] {
  const intervals = max <= 4 ? max : max % 4 === 0 ? 4 : max % 5 === 0 ? 5 : 2;
  return Array.from({ length: intervals + 1 }, (_, index) => (max / intervals) * index);
}

export function DailyChart({
  points,
  label,
  empty,
}: {
  points: PeriodPoint[];
  label: string;
  empty: boolean;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(720);
  const [active, setActive] = useState<number | null>(null);
  const compact = width < 520;
  const height = compact ? 200 : 260;
  const left = 30;
  const right = 6;
  const top = 14;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotBottom = height - bottom;
  const plotHeight = plotBottom - top;
  const count = Math.max(1, points.length);
  const slot = plotWidth / count;
  const peakValue = Math.max(0, ...points.map((point) => Math.max(point.applications, point.entries)));
  const yMax = niceMax(peakValue);
  const ticks = axisTicks(yMax);
  const maxBar = count <= 3 ? 44 : count <= 10 ? 26 : 20;
  const pairGap = slot > 14 ? 3 : 1;
  const barWidth = Math.max(2, Math.min(maxBar, (slot * 0.8 - pairGap) / 2));
  const y = (value: number) => plotBottom - (value / yMax) * plotHeight;
  const barHeight = (value: number) => (value > 0 ? Math.max(2, (value / yMax) * plotHeight) : 0);
  const stride = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / 56))));

  const peak = points.reduce<PeriodPoint | null>((best, point) => (!best || point.entries > best.entries ? point : best), null);
  const shown = active !== null ? points[active] : null;

  return (
    <div className={styles.chartBox} ref={boxRef}>
      <p className={styles.readout} aria-hidden="true">
        {shown ? (
          <>
            <strong>{dayLabel(shown.key)}</strong> 신청 <b>{shown.applications}명</b> · 입장 <b>{shown.entries}명</b>
          </>
        ) : peak && peak.entries > 0 ? (
          <>가장 많이 입장한 날 <strong>{dayLabel(peak.key)}</strong> · <b>{peak.entries}명</b></>
        ) : empty ? null : (
          <>날짜 위에 올리면 그날의 신청·입장을 볼 수 있어요.</>
        )}
      </p>
      <svg className={styles.chart} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}
        onPointerLeave={() => setActive(null)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? styles.baseline : styles.grid} />
            <text x={left - 8} y={y(tick) + 4} textAnchor="end" className={styles.axis}>{Math.round(tick * 10) / 10}</text>
          </g>
        ))}
        {points.map((point, index) => {
          const x = left + index * slot + (slot - barWidth * 2 - pairGap) / 2;
          const applicationsHeight = barHeight(point.applications);
          const entriesHeight = barHeight(point.entries);
          return (
            <g key={point.key} data-active={active === index ? "true" : undefined}>
              {active === index ? <rect x={left + index * slot} y={top} width={slot} height={plotHeight} className={styles.band} /> : null}
              <rect x={x} y={plotBottom - applicationsHeight} width={barWidth} height={applicationsHeight} rx={2} className={styles.barApplications}>
                <title>{`${point.key} 신청 ${point.applications}명`}</title>
              </rect>
              <rect x={x + barWidth + pairGap} y={plotBottom - entriesHeight} width={barWidth} height={entriesHeight} rx={2} className={styles.barEntries}>
                <title>{`${point.key} 입장 ${point.entries}명(일별 고유)`}</title>
              </rect>
            </g>
          );
        })}
        {points.map((point, index) => (
          index % stride === 0 ? (
            <text key={`tick-${point.key}`} x={left + index * slot + slot / 2} y={height - 8} textAnchor="middle" className={styles.axis}>
              {point.label}
            </text>
          ) : null
        ))}
        {points.map((point, index) => (
          <rect key={`hit-${point.key}`} x={left + index * slot} y={top} width={slot} height={plotHeight + bottom - 6}
            className={styles.hit} onPointerEnter={() => setActive(index)} onPointerDown={() => setActive(index)} />
        ))}
      </svg>
      {empty ? <p className={styles.chartEmpty}>이 기간에는 신청도 입장도 없습니다.</p> : null}
    </div>
  );
}

export function HourlyBars({ buckets }: { buckets: HourBucket[] }) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.entries, 0);
  if (total === 0) return <ConsoleEmptyState kind="filtered" title="이 기간에는 입장 기록이 없습니다." />;
  const used = buckets.filter((bucket) => bucket.entries > 0).map((bucket) => bucket.hour);
  let first = Math.max(0, Math.min(...used) - 1);
  let last = Math.min(23, Math.max(...used) + 1);
  while (last - first < 7) {
    if (first > 0) first -= 1;
    if (last - first < 7 && last < 23) last += 1;
    if (first === 0 && last === 23) break;
  }
  const visible = buckets.slice(first, last + 1);
  const max = Math.max(...visible.map((bucket) => bucket.entries));
  const labelStep = visible.length > 12 ? 3 : 2;
  return (
    <ol className={styles.hours} aria-label="시간대별 입장 인원">
      {visible.map((bucket) => {
        const pct = (bucket.entries / max) * 100;
        const isPeak = bucket.entries === max;
        return (
          <li key={bucket.hour} data-peak={isPeak ? "true" : undefined} data-empty={bucket.entries === 0 ? "true" : undefined}>
            <span className="sr-only">{`${bucket.hour}시 ${bucket.entries}명`}</span>
            <span className={styles.hourTrack} aria-hidden="true">
              {bucket.entries > 0 && (isPeak || visible.length <= 12) ? (
                <span className={styles.hourCount} style={{ "--h": pct } as React.CSSProperties}>{bucket.entries}</span>
              ) : null}
              <span className={styles.hourBar} style={{ "--h": pct } as React.CSSProperties} />
            </span>
            <span className={styles.hourLabel} aria-hidden="true">
              {(bucket.hour - first) % labelStep === 0 ? bucket.hour : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function CompanyBars({
  top,
  otherCount,
  otherNames,
  blank,
  total,
}: {
  top: Array<{ name: string; count: number }>;
  otherCount: number;
  otherNames: number;
  blank: number;
  total: number;
}) {
  if (total === 0) return <ConsoleEmptyState kind="filtered" title="이 기간에는 신청이 없습니다." />;
  if (top.length === 0) return <ConsoleEmptyState kind="filtered" title="이 기간 신청에는 소속이 입력되지 않았습니다." />;
  const rows = [
    ...top.map((item) => ({ name: item.name, count: item.count, quiet: false })),
    ...(otherCount > 0 ? [{ name: `그 외 ${otherNames}곳`, count: otherCount, quiet: true }] : []),
    ...(blank > 0 ? [{ name: "소속 미기재", count: blank, quiet: true }] : []),
  ];
  const max = Math.max(...rows.map((row) => row.count));
  return (
    <ul className={styles.shares} aria-label="소속별 신청 인원">
      {rows.map((row) => (
        <li key={row.name} data-quiet={row.quiet ? "true" : undefined}>
          <span className={styles.shareName}>{row.name}</span>
          <span className={styles.shareValue}>{row.count}<small>명 · {Math.round((row.count / total) * 100)}%</small></span>
          <span className={styles.shareTrack} aria-hidden="true"><span style={{ width: `${(row.count / max) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}
