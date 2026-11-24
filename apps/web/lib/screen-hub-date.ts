/**
 * 참가자 화면 허브(디자인·공지·안내·참여 이벤트)의 날짜 표기 (2026-11-24).
 *
 * "M월 D일 (요일)" and "M월 D일 (요일) 오후 H:MM"; the year is added only when it is
 * not the current year. Pure functions with an injectable "now" so they are testable.
 */

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function dayLabel(year: number, month: number, day: number, now: Date): string | null {
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const prefix = year === now.getFullYear() ? "" : `${year}년 `;
  return `${prefix}${month}월 ${day}일 (${WEEKDAYS[probe.getUTCDay()]})`;
}

/** "2027-01-16" -> "2027년 1월 16일 (토)"; anything else is returned unchanged. */
export function formatDay(value: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return value;
  return dayLabel(Number(match[1]), Number(match[2]), Number(match[3]), now) ?? value;
}

/** An ISO instant in the browser's time zone: "11월 24일 (화) 오후 3:07". */
export function formatDayTime(value: string, now: Date = new Date()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value.slice(0, 10);
  const date = new Date(time);
  const day = dayLabel(date.getFullYear(), date.getMonth() + 1, date.getDate(), now);
  if (!day) return value.slice(0, 10);
  const hour = date.getHours();
  const meridiem = hour < 12 ? "오전" : "오후";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${day} ${meridiem} ${hour12}:${String(date.getMinutes()).padStart(2, "0")}`;
}
