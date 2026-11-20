"use client";

import ProductButton from "../../../../ui/ProductButton";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleRefreshButton from "../../../console-ui/ConsoleRefreshButton";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import CountTabs from "../../../console-ui/CountTabs";
import StatCard from "../../../console-ui/StatCard";
import StatusPill from "../../../console-ui/StatusPill";
import { InfoIcon } from "../../../console-ui/ConsoleIcons";
import { consoleFetch } from "../../../../../lib/console-api";
import { cancellationNeedsReview } from "../../../../../lib/cancellation-state.cjs";
import {
  RANGE_DAYS_CAP,
  analyzePeriod,
  companyBreakdown,
  hourlyEntries,
  localDateKey,
  periodDelta,
  presetRange,
  previousRange,
  type PeriodAnalysis,
  type PeriodDelta,
  type PeriodEntry,
  type PeriodPreset,
} from "../../../../../lib/period-analysis";
import { CompanyBars, DailyChart, HourlyBars } from "./PeriodCharts";
import styles from "./analysis.module.css";

type AnalysisData = {
  eventName: string;
  meta: string | undefined;
  eventDate: string;
  canManage: boolean;
  available: boolean;
  applications: string[];
  applicants: Array<{ at: string; company: string }>;
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
type DetailTab = "hours" | "company" | "records";
const DETAIL_TABS: ReadonlyArray<{ key: DetailTab; label: string }> = [
  { key: "hours", label: "시간대별 입장" },
  { key: "company", label: "소속별 신청" },
  { key: "records", label: "일별 기록" },
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
            applicants: people
              .filter((person) => text(person.createdAt) !== "")
              .map((person) => ({ at: text(person.createdAt), company: text(person.company) })),
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

// 직전 같은 길이 기간과 비교할 때 붙는 이름. 오늘은 아직 끝나지 않은 하루라
// 증감을 계산하지 않고 어제 하루 전체를 기준값으로만 보여 준다.
function comparisonLabel(preset: PeriodPreset, days: number): string {
  if (preset === "today") return "어제 하루";
  if (preset === "yesterday") return "그제";
  if (preset === "last7") return "직전 7일";
  return days === 1 ? "전날" : `직전 ${days}일`;
}

function Compare({ delta, label }: { delta: PeriodDelta; label: string }) {
  // 두 기간 모두 0명이면 "변동 없음"은 정보가 아니라 소음이다.
  if (delta.previous === 0 && delta.change === 0) return null;
  return (
    <span className={styles.compare}>
      <StatusPill tone={delta.direction === "up" ? "ok" : "neutral"} size="sm">
        {delta.direction === "same" ? "변동 없음" : (
          <>
            <i className={styles.arrow} aria-hidden="true">{delta.direction === "up" ? "▲" : "▼"}</i>
            {Math.abs(delta.change)}명 {delta.direction === "up" ? "증가" : "감소"}
            {delta.percent !== null ? ` (${delta.percent}%)` : ""}
          </>
        )}
      </StatusPill>
      <span className={styles.base}>{label} {delta.previous}명</span>
    </span>
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
  const [detailTab, setDetailTab] = useState<DetailTab>("hours");

  const result: PeriodAnalysis = analyzePeriod(data.applications, data.entries, range.from, range.to);
  const { points, periodApplications, dailyEntriesSum, periodUnique } = result;
  const zeroPoints = points.filter((point) => point.applications === 0 && point.entries === 0);
  const activePoints = points.filter((point) => point.applications > 0 || point.entries > 0);
  const tablePoints = showZeroDays || zeroPoints.length === 0 ? points : activePoints;
  const todayKey = localDateKey(new Date());
  const days = points.length;
  const fromKey = points[0]?.key ?? range.from;
  const toKey = result.effectiveTo ?? range.to;

  // 직전 같은 길이 기간은 이미 불러온 기록에서 같은 정의로 다시 센다. 행사 전체는 비교할 앞 기간이 없다.
  const previous = (() => {
    if (result.error || days === 0 || preset === "all") return null;
    const span = previousRange(fromKey, days);
    return span ? analyzePeriod(data.applications, data.entries, span.from, span.to) : null;
  })();
  const compareLabel = comparisonLabel(preset, days);
  const showDelta = previous !== null && !previous.error && preset !== "today";
  const showReference = previous !== null && !previous.error && preset === "today";

  // 입장률은 행사 전체에서만 말이 된다(그 기간 밖에서 신청한 사람이 입장해도 분모에 없으므로).
  const rate = preset === "all" && !result.clamped && periodApplications > 0 && periodUnique <= periodApplications
    ? Math.round((periodUnique / periodApplications) * 100)
    : null;

  const hours = hourlyEntries(data.entries, fromKey, toKey);
  const companies = companyBreakdown(data.applicants, fromKey, toKey, 5);
  const emptyPeriod = periodApplications === 0 && dailyEntriesSum === 0;
  const chartLabel = `선택 기간 일별 신청·입장 막대그래프. 기간 신청 ${periodApplications}명, 일별 입장 합 ${dailyEntriesSum}명, 기간 고유 입장 ${periodUnique}명.`;

  const compareFor = (value: number, before: number) => showDelta && previous
    ? <Compare delta={periodDelta(value, before)} label={compareLabel} />
    : showReference && previous
      ? <span className={styles.base}>{compareLabel} {before}명</span>
      : null;
  const rateBlock = rate !== null ? (
    <span className={styles.rate}>
      <span className={styles.rateHead}>
        <span>신청 {periodApplications}명 중 {periodUnique}명 입장</span>
        <StatusPill tone="live">입장률 {rate}%</StatusPill>
      </span>
      <span className={styles.rateTrack} aria-hidden="true"><span style={{ width: `${rate}%` }} /></span>
    </span>
  ) : null;
  const heroCompare = rateBlock ?? (previous ? compareFor(periodUnique, previous.periodUnique) : null);
  const applicationsCompare = previous ? compareFor(periodApplications, previous.periodApplications) : null;
  const entriesCompare = previous ? compareFor(dailyEntriesSum, previous.dailyEntriesSum) : null;

  return (
    <div className={styles.view}>
      <div className={styles.controls}>
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
        <p className={styles.dateLine}>
          {result.error ? null : (
            <>
              <strong>{fromKey} ~ {toKey}</strong>
              <span>{days}일{points[days - 1]?.key === todayKey ? " · 오늘 포함" : ""}</span>
            </>
          )}
        </p>
      </div>

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
      {result.error ? <p className={styles.error} role="alert">{result.error}</p> : null}
      {result.clamped && !result.error ? <p className={styles.note} role="status">최대 {RANGE_DAYS_CAP}일까지만 봅니다. 종료일을 {result.effectiveTo}로 맞췄습니다.</p> : null}

      {!result.error && points.length > 0 ? (
        <>
          {/* 2026-11-20 (디자인 시스템 적용): 핵심 숫자는 기간 고유 입장 하나와 그 비교(또는 입장률).
              신청·일별 입장 합은 같은 줄의 보조 숫자이고, 시간대·소속·일별 기록은 아래 보조 탭에 둔다. */}
          <div className={styles.summary}>
            <StatCard
              className={styles.hero}
              size="hero"
              label="기간 고유 입장"
              value={<span data-metric="unique">{periodUnique}</span>}
              unit="명"
              detail={(
                <span className={styles.heroDetail}>
                  {heroCompare}
                  <span className={styles.hint}>선택한 기간 전체에서 중복 제거</span>
                </span>
              )}
            />
            <dl className={styles.side}>
              <div className={styles.sideRow}>
                <dt><i className={styles.dotApplications} aria-hidden="true" />신청</dt>
                <dd className={styles.sideValue}><b data-metric="applications">{periodApplications}</b>명</dd>
                <dd className={styles.sideNote}>{applicationsCompare}<span className={styles.hint}>취소 제외</span></dd>
              </div>
              <div className={styles.sideRow}>
                <dt><i className={styles.dotEntries} aria-hidden="true" />일별 입장 합</dt>
                <dd className={styles.sideValue}><b data-metric="entriesSum">{dailyEntriesSum}</b>명</dd>
                <dd className={styles.sideNote}>{entriesCompare}<span className={styles.hint}>하루 한 번씩 더한 값</span></dd>
              </div>
            </dl>
          </div>
          <p className="sr-only" role="status">
            기간 신청 {periodApplications}명 · 일별 입장 합 {dailyEntriesSum}명 · 기간 고유 입장 {periodUnique}명(중복 제거)
          </p>

          <ConsoleSection
            headingId="period-daily-title"
            title="일별 신청·입장"
            heading="rule"
            action={(
              <div className={styles.cardTools}>
                <ul className={styles.legend} aria-label="막대그래프 범례">
                  <li><span className={`${styles.swatch} ${styles.swatchApplications}`} aria-hidden="true" />신청</li>
                  <li><span className={`${styles.swatch} ${styles.swatchEntries}`} aria-hidden="true" />입장(일별 고유)</li>
                </ul>
                <ProductButton type="button" variant="ghost" icon={<InfoIcon />} aria-expanded={showBasis} aria-controls="period-basis"
                  onClick={() => setShowBasis((current) => !current)}>
                  집계 기준
                </ProductButton>
              </div>
            )}
          >
            {showBasis ? (
              <p className={styles.basis} id="period-basis">
                신청은 신청 상태가 취소인 기록을 제외합니다.{data.cancellationReview ? " 취소 기록과 신청 상태가 다른 인원은 확인 전까지 포함합니다." : ""} 입장은 정정된 기록을 제외하며 같은 날의 재입장은 중복 집계하지 않습니다. 일별 입장은 그 날의 고유 입장자 수이며, 기간 고유 입장은 선택한 전체 기간의 중복 제거 수라서 일별 합과 다를 수 있습니다. 날짜는 이 브라우저의 달력 날짜입니다.
              </p>
            ) : null}
            <DailyChart points={points} label={chartLabel} empty={emptyPeriod} />
          </ConsoleSection>

          <ConsoleSection headingId="period-detail-title" title="세부 보기" heading="rule">
            <CountTabs
              mode="tablist"
              ariaLabel="세부 보기 선택"
              idPrefix="period-tab-"
              controls={(key) => `period-panel-${key}`}
              fit="fill"
              value={detailTab}
              onChange={(key) => setDetailTab(key as DetailTab)}
              items={DETAIL_TABS}
              className={styles.subTabs}
            />
            <div className={styles.subPanel} role="tabpanel" id={`period-panel-${detailTab}`} aria-labelledby={`period-tab-${detailTab}`}>
              {detailTab === "hours" ? (
                <>
                  <p className={styles.cardSub}>하루의 첫 입장 시각 기준</p>
                  <HourlyBars buckets={hours} />
                </>
              ) : detailTab === "company" ? (
                <>
                  <p className={styles.cardSub}>많은 순 상위 5곳</p>
                  <CompanyBars {...companies} />
                </>
              ) : (
                <>
                  {zeroPoints.length > 0 ? (
                    <div className={styles.tableTools}>
                      <ProductButton type="button" variant="ghost" aria-expanded={showZeroDays}
                        onClick={() => setShowZeroDays((current) => !current)}>
                        {showZeroDays ? `0명 ${zeroPoints.length}일 접기` : `0명 ${zeroPoints.length}일 보기`}
                      </ProductButton>
                    </div>
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
                </>
              )}
            </div>
          </ConsoleSection>
        </>
      ) : null}
    </div>
  );
}
