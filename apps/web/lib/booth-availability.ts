type BoothAvailability = {
  status: string;
  startsAt?: string | null;
  endsAt?: string | null;
  capacity?: number;
  used?: number;
};

// Keep this validation in step with the server's boothScheduleTime. A local
// timestamp without an offset has no stable meaning across browsers.
export function boothScheduleTime(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return Number.NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const offset = match[8];
  if (offset.toUpperCase() !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return Number.NaN;
  }
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(hourText) > 23 || Number(minuteText) > 59 || (secondText && Number(secondText) > 59)) return Number.NaN;
  return Date.parse(value);
}

const BOOTH_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function formatBoothScheduleTime(value: string): string {
  const instant = boothScheduleTime(value);
  if (instant === null) return "미설정";
  if (!Number.isFinite(instant)) return "시간 확인 필요";
  return `${BOOTH_TIME_FORMAT.format(instant)} (한국 시간)`;
}

export function boothOperatingStatus(booth: BoothAvailability, now: number | null = Date.now(), uncertaintyMs = 0) {
  const startsAt = boothScheduleTime(booth.startsAt);
  const endsAt = boothScheduleTime(booth.endsAt);
  if (booth.status === "CLOSED") return "운영 종료";
  if (booth.status === "WAITING") return startsAt !== null && now !== null && now + uncertaintyMs < startsAt ? "운영 예정" : "운영 대기";
  if (booth.status !== "OPEN") return "상태 확인 필요";
  if ((startsAt !== null && !Number.isFinite(startsAt)) || (endsAt !== null && !Number.isFinite(endsAt)) ||
      (startsAt !== null && endsAt !== null && startsAt >= endsAt)) return "운영 시간 확인 필요";
  if (now !== null && startsAt !== null && now + uncertaintyMs < startsAt) return "운영 예정";
  if (now !== null && endsAt !== null && now - uncertaintyMs > endsAt) return "운영 종료";
  const capacity = Number(booth.capacity) || 0;
  if (capacity > 0 && Number(booth.used || 0) >= capacity) return "수량 소진";
  if ((startsAt !== null || endsAt !== null) && (now === null ||
      (startsAt !== null && now - uncertaintyMs < startsAt) ||
      (endsAt !== null && now + uncertaintyMs > endsAt))) return "인증 시 시간 확인";
  return "운영 중";
}

// An uncertain clock must never prevent trying the server-authoritative
// command; invalid schedules and explicitly closed booths remain blocked.
export function boothCanAttempt(status: string | null): boolean {
  return status === "운영 중" || status === "인증 시 시간 확인";
}

export function isBoothContextChanged(code: unknown) {
  return code === "BOOTH_MODE_CHANGED" || code === "BOOTH_UNAVAILABLE";
}
