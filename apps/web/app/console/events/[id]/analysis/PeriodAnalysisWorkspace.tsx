"use client";

import ProductButton from "../../../../ui/ProductButton";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleRefreshButton from "../../../console-ui/ConsoleRefreshButton";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { InfoIcon } from "../../../console-ui/ConsoleIcons";
import { consoleFetch } from "../../../../../lib/console-api";
import { cancellationNeedsReview } from "../../../../../lib/cancellation-state.cjs";
import {
  RANGE_DAYS_CAP,
  analyzePeriod,
  localDateKey,
  presetRange,
  type PeriodEntry,
  type PeriodPreset,
} from "../../../../../lib/period-analysis";
import styles from "./analysis.module.css";

type AnalysisData = {
  eventName: string;
  meta: string | undefined;
  eventDate: string;
  canManage: boolean;
  available: boolean;
  applications: string[];
  entries: PeriodEntry[];
  cancellationReview: number;
  updatedAt: string;
};

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; data: AnalysisData };

const READ_TIMEOUT_MS = 8000;
const PRESETS: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  { value: "today", label: "오늘" },
  { value: "yesterday", label: "어제" },
  { value: "last7", label: "최근 7일" },
  { value: "all", label: "행사 전체" },
  { value: "custom", label: "직접 선택" },
];
const UPDATED_FORMAT = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => asRecord(item) !== null) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default function PeriodAnalysisWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [preset, setPreset] = useState<PeriodPreset>("last7");
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    (async () => {
      try {
        const res = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(loginHrefForLocation(window.location.pathname, window.location.search));
          return;
        }
        if (res.status === 403 || res.status === 404) {
          setState({ kind: "failed", message: res.status === 404 ? "행사를 찾을 수 없습니다." : "행사에 대한 접근 권한을 확인하세요." });
          return;
        }
        const body = (await res.json().catch(() => null)) as { state?: Record<string, unknown> & { workspaces?: Record<string, Record<string, unknown> | undefined> } | null } | null;
        if (cancelled) return;
        const bootstrap = body?.state;
        const event = records(bootstrap?.events).find((item) => item.id === eventId);
        const workspace = bootstrap?.workspaces?.[eventId];
        if (!res.ok || !bootstrap || !event || !workspace) {
          setState({ kind: "failed", message: "기간 분석을 불러오지 못했습니다." });
          return;
        }
        // 운영 현황과 같은 판정: 운영자 계정이 있을 때만 집계를 보여 준다.
        const canManage = records(bootstrap.accounts).some((account) => ["AGENCY", "MANAGER"].includes(text(account.role)));
        const sourceAvailability = asRecord(workspace.reportSourceAvailability);
        const complete = (value: unknown) => Array.isArray(value) && records(value).length === value.length;
        const participantsAvailable = sourceAvailability?.participants === true && complete(workspace.participants);
        const checksAvailable = sourceAvailability?.checks === true && complete(workspace.checks);
        const people = records(workspace.participants).filter((person) => String(person.status || "").toUpperCase() !== "CANCELLED");
        const checkRecords = records(workspace.checks).filter((check) => typeof check.id === "string" && check.id && check.corrected !== true);
        const client = records(bootstrap.clients).find((item) => item.id === event.clientId);
        const workspaceVenue = asRecord(workspace.venue);
        setState({
          kind: "ready",
          data: {
            eventName: text(event.name) || "이름 없는 행사",
            meta: formatConsoleEventMeta({
              clientName: text(client?.name),
              date: text(event.date),
              start: text(event.start),
              end: text(event.end),
              venue: text(workspaceVenue?.name) || text(event.venue),
            }),
            eventDate: text(event.date),
            canManage,
            available: participantsAvailable && checksAvailable,
            applications: people.map((person) => text(person.createdAt)).filter((value) => value !== ""),
            entries: checkRecords
              .filter((check) => text(check.action) === "IN")
              .map((check) => ({ at: text(check.at), key: text(check.participantId) || String(check.id) })),
            cancellationReview: people.filter(cancellationNeedsReview).length,
            updatedAt: new Date().toISOString(),
          },
        });
      } catch {
        if (!cancelled) setState({ kind: "failed", message: "기간 분석을 불러오지 못했습니다." });
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [eventId, reload, router]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setReload((current) => current + 1);
  }, []);

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="analysis" eventId={eventId} eventName="">
        <ConsoleStatePanel kind="loading" message="기간 분석을 불러오는 중입니다." onRetry={refresh} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="analysis" eventId={eventId} eventName="">
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={refresh} />
      </ConsolePage>
    );
  }

  const { data } = state;
  const now = new Date();
  const selectedRange = preset === "custom"
    ? customRange ?? presetRange("last7", now, data)
    : presetRange(preset, now, data);
  function choosePreset(next: PeriodPreset) {
    if (next === "custom" && preset !== "custom") setCustomRange(selectedRange);
    setPreset(next);
  }

  return (
    <ConsolePage pageId="analysis" eventId={eventId} eventName={data.eventName} meta={data.meta}
      headerActions={data.canManage ? (
        <span className={`${styles.updated} console-header-inline`}>
          <time dateTime={data.updatedAt}><span className={styles.updatedLabel}>조회 </span>{UPDATED_FORMAT.format(new Date(data.updatedAt))}</time>
          <ConsoleRefreshButton label="새로고침" busy={refreshing} onRefresh={refresh} />
        </span>
      ) : undefined}>
      {!data.canManage ? (
        <ConsoleFeedback kind="warning">기간 분석은 행사 운영자만 볼 수 있습니다.</ConsoleFeedback>
      ) : !data.available ? (
        <p className={styles.note}>참가자 또는 출입 기록을 확인할 수 없어 기간 분석을 표시할 수 없습니다. 새로고침해도 계속되면 시스템 관리자에게 문의하세요.</p>
      ) : (
        <PeriodView
          data={data}
          preset={preset}
          range={selectedRange}
          onPresetChange={choosePreset}
          onRangeChange={setCustomRange}
        />
      )}
    </ConsolePage>
  );
}

function PeriodView({
  data,
  preset,
  range,
  onPresetChange,
  onRangeChange,
}: {
  data: AnalysisData;
  preset: PeriodPreset;
  range: { from: string; to: string };
  onPresetChange: (preset: PeriodPreset) => void;
  onRangeChange: (range: { from: string; to: string }) => void;
}) {
  const [showZeroDays, setShowZeroDays] = useState(false);
  const [showBasis, setShowBasis] = useState(false);

  const result = analyzePeriod(data.applications, data.entries, range.from, range.to);
  const { points, periodApplications, dailyEntriesSum, periodUnique } = result;
  const zeroPoints = points.filter((point) => point.applications === 0 && point.entries === 0);
  const activePoints = points.filter((point) => point.applications > 0 || point.entries > 0);
  const tablePoints = showZeroDays || zeroPoints.length === 0 ? points : activePoints;

  const maxValue = Math.max(1, ...points.map((point) => Math.max(point.applications, point.entries)));
  const chartWidth = 640;
  const chartHeight = 200;
  const axisPad = 8;
  const plotTop = 12;
  const plotBottom = chartHeight - 28;
  const pairGap = Math.max(2, Math.min(10, Math.floor((chartWidth - axisPad * 2) / Math.max(1, points.length) / 4)));
  const slot = points.length ? (chartWidth - axisPad * 2) / points.length : 0;
  const barWidth = Math.max(2, Math.min(26, (slot - pairGap) / 2));
  const bar = (value: number) => Math.round((value / maxValue) * (plotBottom - plotTop));
  const tickPoints = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, index) => index);
  const todayKey = localDateKey(new Date());

  return (
    <div className={styles.view}>
      <fieldset className={styles.presets}>
        <legend className="sr-only">기간 선택</legend>
        {PRESETS.map((item, index) => (
          <label key={item.value} className={styles.preset} htmlFor={`period-preset-${index}`}>
            <input id={`period-preset-${index}`} type="radio" name="period-preset" value={item.value}
              checked={preset === item.value} onChange={() => {
                onPresetChange(item.value);
                setShowZeroDays(false);
              }} />
            <span>{item.label}</span>
          </label>
        ))}
      </fieldset>

      {preset === "custom" ? (
        <div className={styles.rangeFields}>
          <div>
            <label htmlFor="range-from">시작일</label>
            <input id="range-from" type="date" value={range.from} max={range.to}
              onChange={(event) => onRangeChange({ ...range, from: event.target.value })} />
          </div>
          <div>
            <label htmlFor="range-to">종료일</label>
            <input id="range-to" type="date" value={range.to} min={range.from}
              onChange={(event) => onRangeChange({ ...range, to: event.target.value })} />
          </div>
        </div>
      ) : null}
      <p className={styles.dateLine}>
        {result.error ? null : `${points[0]?.key ?? range.from} ~ ${result.effectiveTo ?? range.to}${points[points.length - 1]?.key === todayKey ? " (오늘 포함)" : ""}`}
      </p>
      {result.error ? <p className={styles.error} role="alert">{result.error}</p> : null}
      {result.clamped && !result.error ? <p className={styles.note} role="status">최대 {RANGE_DAYS_CAP}일까지만 봅니다. 종료일을 {result.effectiveTo}로 맞췄습니다.</p> : null}

      {!result.error && points.length > 0 ? (
        <>
          <dl className={styles.totals}>
            <div><dt>신청</dt><dd>{periodApplications}<small>명</small></dd></div>
            <div><dt>일별 입장 합</dt><dd>{dailyEntriesSum}<small>명</small></dd></div>
            <div><dt>기간 고유 입장</dt><dd>{periodUnique}<small>명</small></dd></div>
          </dl>
          <p className="sr-only" role="status">
            기간 신청 {periodApplications}명 · 일별 입장 합 {dailyEntriesSum}명 · 기간 고유 입장 {periodUnique}명(중복 제거)
          </p>
          <svg className={styles.chart} viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`선택 기간 일별 신청·입장 막대그래프. 기간 신청 ${periodApplications}명, 일별 입장 합 ${dailyEntriesSum}명, 기간 고유 입장 ${periodUnique}명.`}>
            {[0, 0.5, 1].map((fraction) => {
              const y = plotBottom - (plotBottom - plotTop) * fraction;
              const value = Math.round(maxValue * fraction);
              return (
                <g key={fraction}>
                  <line x1={axisPad} x2={chartWidth - axisPad} y1={y} y2={y} className={styles.grid} />
                  <text x={axisPad} y={Math.max(10, y - 3)} className={styles.axis}>{value}</text>
                </g>
              );
            })}
            {points.map((point, index) => {
              const x = axisPad + index * slot + (slot - barWidth * 2 - pairGap) / 2;
              const appHeight = bar(point.applications);
              const entryHeight = bar(point.entries);
              return (
                <g key={point.key}>
                  <rect x={x} y={plotBottom - appHeight} width={barWidth} height={appHeight} className={styles.barApplications}>
                    <title>{`${point.key} 신청 ${point.applications}명`}</title>
                  </rect>
                  <rect x={x + barWidth + pairGap} y={plotBottom - entryHeight} width={barWidth} height={entryHeight} className={styles.barEntries}>
                    <title>{`${point.key} 입장 ${point.entries}명(일별 고유)`}</title>
                  </rect>
                </g>
              );
            })}
            {tickPoints.map((index) => {
              const point = points[index];
              if (!point) return null;
              return (
                <text key={`tick-${point.key}`} x={axisPad + index * slot + slot / 2} y={chartHeight - 8} textAnchor="middle" className={styles.axis}>
                  {point.label}
                </text>
              );
            })}
          </svg>
          <ul className={styles.legend} aria-label="막대그래프 범례">
            <li><span className={`${styles.swatch} ${styles.swatchApplications}`} aria-hidden="true" />신청</li>
            <li><span className={`${styles.swatch} ${styles.swatchEntries}`} aria-hidden="true" />입장(일별 고유)</li>
            <li className={styles.basisToggle}>
              <ProductButton type="button" className="button button-quiet" icon={<InfoIcon />} aria-expanded={showBasis} aria-controls="period-basis"
                onClick={() => setShowBasis((current) => !current)}>
                집계 기준
              </ProductButton>
            </li>
          </ul>
          {showBasis ? (
            <p className={styles.note} id="period-basis">
              신청은 신청 상태가 취소인 기록을 제외합니다.{data.cancellationReview ? " 취소 기록과 신청 상태가 다른 인원은 확인 전까지 포함합니다." : ""} 입장은 정정된 기록을 제외하며 같은 날의 재입장은 중복 집계하지 않습니다. 일별 입장은 그 날의 고유 입장자 수이며, 기간 고유 입장은 선택한 전체 기간의 중복 제거 수라서 일별 합과 다를 수 있습니다. 날짜는 이 브라우저의 달력 날짜입니다.
            </p>
          ) : null}
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="선택 기간 일별 신청·입장">
              <thead>
                <tr>
                  <th scope="col">날짜</th>
                  <th scope="col">신청</th>
                  <th scope="col">입장(일별 고유)</th>
                </tr>
              </thead>
              <tbody>
                {tablePoints.map((point) => (
                  <tr key={point.key}>
                    <th scope="row">{point.key}</th>
                    <td>{point.applications}명</td>
                    <td>{point.entries}명</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {zeroPoints.length > 0 ? (
            <p>
              <ProductButton type="button" className="button button-quiet" aria-expanded={showZeroDays}
                onClick={() => setShowZeroDays((current) => !current)}>
                {showZeroDays ? `0명 ${zeroPoints.length}일 접기` : `0명 ${zeroPoints.length}일 보기`}
              </ProductButton>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
