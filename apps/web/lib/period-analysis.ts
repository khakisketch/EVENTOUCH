// 기간 분석: 운영 현황의 고정 집계(오늘·어제·최근 7일)와 같은 정의를
// 브라우저 로컬 날짜 범위에 그대로 적용한다. 신청은 취소 제외 참가자의
// 신청 시각(createdAt), 입장은 정정되지 않은 IN 기록이며 같은 날 재입장은
// 한 명으로 센다. 이 모듈은 계산만 하고 화면·네트워크를 모른다.

export const RANGE_DAYS_CAP = 62;

export type PeriodEntry = { at: string; key: string };

export type PeriodPreset = "today" | "yesterday" | "last7" | "all" | "custom";

export type PeriodPoint = { key: string; label: string; applications: number; entries: number };

export type PeriodAnalysis = {
  error: string | null;
  clamped: boolean;
  effectiveTo: string | null;
  points: PeriodPoint[];
  periodApplications: number;
  dailyEntriesSum: number;
  periodUnique: number;
};

export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseLocalDay(value: string): { key: string; start: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) return null;
  return { key: localDateKey(date), start: date };
}

export function toLocalKey(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return localDateKey(new Date(time));
}

function addDays(date: Date, offset: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

/**
 * 버튼으로 고른 기간의 시작·종료 날짜. 직접 선택은 입력값을 그대로 쓰므로
 * 여기서 다루지 않는다. 행사 전체는 가장 이른 신청·입장·행사 날짜부터 오늘
 * (또는 더 늦은 기록·행사 날짜)까지다.
 */
export function presetRange(
  preset: Exclude<PeriodPreset, "custom">,
  now: Date,
  context: { eventDate: string; applications: string[]; entries: PeriodEntry[] },
): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "today") return { from: localDateKey(today), to: localDateKey(today) };
  if (preset === "yesterday") {
    const yesterday = addDays(today, -1);
    return { from: localDateKey(yesterday), to: localDateKey(yesterday) };
  }
  if (preset === "last7") return { from: localDateKey(addDays(today, -6)), to: localDateKey(today) };
  const keys = [
    ...context.applications.map(toLocalKey),
    ...context.entries.map((entry) => toLocalKey(entry.at)),
    parseLocalDay(context.eventDate)?.key ?? null,
  ].filter((key): key is string => key !== null).sort();
  const first = keys[0] ?? localDateKey(today);
  const last = keys[keys.length - 1] ?? first;
  const todayKey = localDateKey(today);
  return { from: first, to: last > todayKey ? last : todayKey > first ? todayKey : first };
}

export function analyzePeriod(
  applications: string[],
  entries: PeriodEntry[],
  fromInput: string,
  toInput: string,
): PeriodAnalysis {
  const parsedFrom = parseLocalDay(fromInput);
  const parsedTo = parseLocalDay(toInput);
  const empty = { clamped: false, effectiveTo: null, points: [], periodApplications: 0, dailyEntriesSum: 0, periodUnique: 0 };
  if (!parsedFrom || !parsedTo) return { ...empty, error: "날짜를 YYYY-MM-DD 형식으로 입력하세요." };
  if (parsedFrom.start.getTime() > parsedTo.start.getTime()) {
    return { ...empty, error: "시작 날짜가 끝 날짜보다 늦습니다. 순서를 바꾸세요." };
  }

  let clamped = false;
  let effectiveTo = parsedTo;
  const span = Math.round((parsedTo.start.getTime() - parsedFrom.start.getTime()) / 86_400_000) + 1;
  if (span > RANGE_DAYS_CAP) {
    clamped = true;
    const capped = addDays(parsedFrom.start, RANGE_DAYS_CAP - 1);
    effectiveTo = { key: localDateKey(capped), start: capped };
  }
  const days: string[] = [];
  let cursor = new Date(parsedFrom.start);
  for (;;) {
    const key = localDateKey(cursor);
    days.push(key);
    if (key === effectiveTo.key || days.length > RANGE_DAYS_CAP) break;
    cursor = addDays(cursor, 1);
  }

  const appByDay = new Map<string, number>();
  for (const createdAt of applications) {
    const key = toLocalKey(createdAt);
    if (key !== null) appByDay.set(key, (appByDay.get(key) ?? 0) + 1);
  }
  const entriesByDay = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = toLocalKey(entry.at);
    if (key === null) continue;
    const set = entriesByDay.get(key) ?? new Set<string>();
    set.add(entry.key);
    entriesByDay.set(key, set);
  }
  const points = days.map((key) => ({
    key,
    label: key.slice(5).replace("-", "/"),
    applications: appByDay.get(key) ?? 0,
    entries: entriesByDay.get(key)?.size ?? 0,
  }));
  const periodUnique = new Set<string>();
  for (const key of days) {
    for (const id of entriesByDay.get(key) ?? []) periodUnique.add(id);
  }
  return {
    error: null,
    clamped,
    effectiveTo: effectiveTo.key,
    points,
    periodApplications: points.reduce((sum, point) => sum + point.applications, 0),
    dailyEntriesSum: points.reduce((sum, point) => sum + point.entries, 0),
    periodUnique: periodUnique.size,
  };
}

// ---- 2026-11-20 재설계: 직전 같은 길이 기간 비교, 시간대·소속 분해 ----
// 모두 이미 불러온 신청·입장 기록에서만 계산한다. 새 서버 값이나 추정은 없다.

/** 선택 기간 바로 앞의 같은 일수 기간. 날짜가 잘못되면 null. */
export function previousRange(from: string, days: number): { from: string; to: string } | null {
  const start = parseLocalDay(from);
  if (!start || !Number.isInteger(days) || days < 1) return null;
  return {
    from: localDateKey(addDays(start.start, -days)),
    to: localDateKey(addDays(start.start, -1)),
  };
}

export type PeriodDelta = { previous: number; change: number; direction: "up" | "down" | "same"; percent: number | null };

/** 이전 값이 0이면 비율은 만들지 않는다(0으로 나누지 않고 지어내지도 않는다). */
export function periodDelta(current: number, previous: number): PeriodDelta {
  const change = current - previous;
  return {
    previous,
    change,
    direction: change > 0 ? "up" : change < 0 ? "down" : "same",
    percent: previous > 0 ? Math.round((Math.abs(change) / previous) * 100) : null,
  };
}

export type HourBucket = { hour: number; entries: number };

/**
 * 시간대별 입장. 일별 고유 입장(같은 날 한 명은 한 번)의 첫 입장 시각을 그
 * 시각의 시(브라우저 로컬)에 센다. 그래서 24칸의 합은 일별 입장 합과 같다.
 */
export function hourlyEntries(entries: PeriodEntry[], fromKey: string, toKey: string): HourBucket[] {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: 0 }));
  const firstByDay = new Map<string, number>();
  for (const entry of entries) {
    const time = Date.parse(entry.at);
    if (!Number.isFinite(time)) continue;
    const day = localDateKey(new Date(time));
    if (day < fromKey || day > toKey) continue;
    const id = `${day}|${entry.key}`;
    const known = firstByDay.get(id);
    if (known === undefined || time < known) firstByDay.set(id, time);
  }
  for (const time of firstByDay.values()) buckets[new Date(time).getHours()].entries += 1;
  return buckets;
}

export type CompanyShare = { name: string; count: number };

/** 기간 신청을 소속별로 센다. 상위 limit개 + 나머지 합 + 미기재. */
export function companyBreakdown(
  applicants: Array<{ at: string; company: string }>,
  fromKey: string,
  toKey: string,
  limit = 5,
): { top: CompanyShare[]; otherCount: number; otherNames: number; blank: number; total: number } {
  const counts = new Map<string, number>();
  let blank = 0;
  let total = 0;
  for (const item of applicants) {
    const day = toLocalKey(item.at);
    if (day === null || day < fromKey || day > toKey) continue;
    total += 1;
    const name = item.company.trim();
    if (!name) blank += 1;
    else counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sorted = [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
  const rest = sorted.slice(limit);
  return {
    top: sorted.slice(0, limit),
    otherCount: rest.reduce((sum, item) => sum + item.count, 0),
    otherNames: rest.length,
    blank,
    total,
  };
}

/** y축 눈금용 보기 좋은 최대값(1·2·4·5×10^n). */
export function niceMax(value: number): number {
  if (value <= 4) return Math.max(1, Math.ceil(value));
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}
