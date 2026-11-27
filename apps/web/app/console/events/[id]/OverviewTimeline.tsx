import type { CSSProperties } from "react";
import styles from "./overview-timeline.module.css";

/*
 * 운영 현황 일정 (owner 2026-11-27): 글자 목록 대신 행사일마다 시간 막대 하나.
 * 프로그램은 실제 시간 길이만큼 놓이고, 행사 운영 시간은 점선, 오늘이면 지금 시각 선이 지난다.
 * 폰에서는 같은 마크업이 시간순 목록으로 바뀐다. 상태는 브라우저 시계로만 표시한다.
 */
export type TimelineProgram = { id: string; title: string; date: string; start: string; end: string; place: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = new Intl.DateTimeFormat("ko-KR", { weekday: "short" });
const MAX_DAYS = 4;

function minutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour > 23 || minute > 59 ? null : hour * 60 + minute;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function clock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function dayLabel(day: string, today: string): { name: string; sub: string } {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const base = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  const distance = Math.round((target.getTime() - base.getTime()) / 86_400_000);
  const weekday = WEEKDAY.format(target);
  const dday = distance === 0 ? "" : distance > 0 ? ` · D-${distance}` : ` · D+${-distance}`;
  return { name: distance === 0 ? "오늘" : `${m}.${d}`, sub: distance === 0 ? `${m}.${d} ${weekday}` : `${weekday}${dday}` };
}

/** Days to draw: the event day plus other program days from today on, oldest first. */
export function timelineDays(programs: TimelineProgram[], eventDate: string, now: Date): { days: string[]; hidden: number } {
  const today = dateKey(now);
  const all = [...new Set(programs.map((program) => program.date).filter((date) => DATE_RE.test(date)))]
    .filter((date) => date === eventDate || date >= today)
    .sort();
  return { days: all.slice(0, MAX_DAYS), hidden: Math.max(0, all.length - MAX_DAYS) };
}

export default function OverviewTimeline({ programs, eventDate, eventStart, eventEnd, now }: {
  programs: TimelineProgram[]; eventDate: string; eventStart: string; eventEnd: string; now: Date;
}) {
  const today = dateKey(now);
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const { days, hidden } = timelineDays(programs, eventDate, now);
  const shown = programs.filter((program) => days.includes(program.date));
  const timed = shown.filter((program) => minutes(program.start) !== null);
  const untimed = shown.filter((program) => minutes(program.start) === null);
  const openStart = minutes(eventStart);
  const openEnd = minutes(eventEnd);

  // Axis: the event hours widened to every program, whole hours, at least four hours.
  const starts = timed.map((program) => minutes(program.start) as number);
  const ends = timed.map((program) => {
    const start = minutes(program.start) as number;
    const end = minutes(program.end);
    return end !== null && end > start ? end : start + 30;
  });
  const lows = [openStart, ...starts].filter((value): value is number => value !== null);
  const highs = [openEnd, ...ends].filter((value): value is number => value !== null);
  const low = Math.floor((lows.length ? Math.min(...lows) : 9 * 60) / 60) * 60;
  let high = Math.min(24 * 60, Math.ceil((highs.length ? Math.max(...highs) : low + 8 * 60) / 60) * 60);
  if (high - low < 4 * 60) high = Math.min(24 * 60, low + 4 * 60);
  const span = high - low;
  const at = (value: number) => `${((value - low) / span) * 100}%`;
  const step = span > 12 * 60 ? 120 : 60;
  const ticks: number[] = [];
  for (let tick = low; tick <= high; tick += step) ticks.push(tick);

  // One full-text line under the bars: what is on now (today) or what comes next, since short blocks truncate.
  const ordered = timed.slice().sort((a, b) => a.date.localeCompare(b.date) || (minutes(a.start) as number) - (minutes(b.start) as number));
  const endOf = (program: TimelineProgram) => {
    const start = minutes(program.start) as number;
    const end = minutes(program.end);
    return end !== null && end > start ? end : start + 30;
  };
  const running = ordered.find((program) => program.date === today && (minutes(program.start) as number) <= nowMinute && nowMinute <= endOf(program));
  const current = running ? { title: running.title, place: running.place, left: endOf(running) - nowMinute } : null;
  const upcoming = running ? null : ordered.find((program) => program.date > today || (program.date === today && (minutes(program.start) as number) > nowMinute));
  const next = upcoming ? { title: upcoming.title, place: upcoming.place, when: `${upcoming.date === today ? "오늘" : dayLabel(upcoming.date, today).name} ${upcoming.start}` } : null;

  return (
    <div className={styles.timeline}>
      <div className={styles.scale} aria-hidden="true">
        <span />
        <div className={styles.ticks} style={{ "--steps": span / step } as CSSProperties}>
          {ticks.map((tick, index) => (
            <span key={tick} style={{ "--left": at(tick) } as CSSProperties} data-edge={index === 0 ? "start" : index === ticks.length - 1 ? "end" : undefined}>
              {index === ticks.length - 1 ? `${tick / 60}시` : String(tick / 60).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>
      {days.map((day) => {
        const label = dayLabel(day, today);
        const isToday = day === today;
        const rows = timed
          .filter((program) => program.date === day)
          .sort((a, b) => (minutes(a.start) as number) - (minutes(b.start) as number) || a.title.localeCompare(b.title, "ko"));
        const lastEnd = rows.reduce((latest, program) => {
          const start = minutes(program.start) as number;
          const end = minutes(program.end);
          return Math.max(latest, end !== null && end > start ? end : start + 30);
        }, -1);
        const showGap = day === eventDate && openEnd !== null && lastEnd >= 0 && openEnd - lastEnd >= 60;
        return (
          <div className={styles.day} key={day}>
            <p className={styles.dayLabel}><strong>{label.name}</strong><span>{label.sub}</span></p>
            <div className={styles.track} style={{ "--steps": span / step } as CSSProperties}>
              {day === eventDate && openStart !== null && openEnd !== null && openEnd > openStart ? (
                <span className={styles.open} style={{ "--left": at(openStart), "--width": `${((openEnd - openStart) / span) * 100}%` } as CSSProperties} aria-hidden="true" />
              ) : null}
              <ol className={styles.blocks} aria-label={`${label.name} 일정 ${rows.length}개`}>
                {rows.map((program) => {
                  const start = minutes(program.start) as number;
                  const rawEnd = minutes(program.end);
                  const end = rawEnd !== null && rawEnd > start ? rawEnd : start + 30;
                  const status = day < today || (isToday && end < nowMinute) ? "done" : isToday && start <= nowMinute && nowMinute <= end ? "current" : "upcoming";
                  const time = program.end ? `${program.start}–${program.end}` : program.start;
                  const lead = status === "current" ? `진행 중 · ${end - nowMinute}분 남음` : status === "done" ? "끝남" : "";
                  const meta = [lead, time, program.place].filter(Boolean).join(" · ");
                  return (
                    <li key={program.id} className={styles.block} data-status={status} aria-current={status === "current" ? "step" : undefined}
                      title={`${time} ${program.title}${program.place ? ` · ${program.place}` : ""}`}
                      style={{ "--left": at(start), "--width": `${Math.max(((end - start) / span) * 100, 3)}%` } as CSSProperties}>
                      <strong>{program.title}</strong>
                      <span>{meta}</span>
                    </li>
                  );
                })}
              </ol>
              {showGap ? <span className={styles.gap} style={{ "--left": at(lastEnd) } as CSSProperties}>{clock(lastEnd)} 이후 일정 없음</span> : null}
              {isToday && nowMinute >= low && nowMinute <= high ? (
                <span className={styles.now} style={{ "--left": at(nowMinute) } as CSSProperties} aria-hidden="true"><span>{clock(nowMinute)}</span></span>
              ) : null}
            </div>
          </div>
        );
      })}
      {current ? (
        <p className={styles.nowLine} aria-live="polite">
          <strong>진행 중</strong><span>{current.title}</span><small>{[current.place, `${current.left}분 남음`].filter(Boolean).join(" · ")}</small>
        </p>
      ) : next ? (
        <p className={styles.nowLine} data-kind="next"><strong>다음</strong><span>{next.title}</span><small>{[next.when, next.place].filter(Boolean).join(" · ")}</small></p>
      ) : null}
      {untimed.length || hidden ? (
        <p className={styles.note}>
          {untimed.length ? `시간 미정 ${untimed.length}개 · ${untimed.slice(0, 3).map((program) => program.title).join(", ")}` : ""}
          {untimed.length && hidden ? " · " : ""}
          {hidden ? `다른 행사일 ${hidden}일 더 있음` : ""}
        </p>
      ) : null}
    </div>
  );
}
