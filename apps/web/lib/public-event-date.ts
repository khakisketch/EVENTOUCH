const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// The server and browser must render the same label before hydration.
export function publicEventDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [dateTime, yearText, monthText, dayText] = match;
  const [year, month, day] = [yearText, monthText, dayText].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const weekday = WEEKDAYS[date.getUTCDay()];
  return {
    dateTime,
    label: `${year}년 ${month}월 ${day}일 (${weekday})`,
    shortLabel: `${monthText}.${dayText} (${weekday})`,
  };
}
