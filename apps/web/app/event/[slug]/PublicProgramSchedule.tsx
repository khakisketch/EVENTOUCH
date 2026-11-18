"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { publicEventDate } from "../../../lib/public-event-date";
import styles from "./public-program-schedule.module.css";

export type PublicProgramScheduleItem = {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  place: string;
  speaker?: string;
  speakers?: string[];
  description: string;
};

export type PublicProgramSchedulePreviewItem = PublicProgramScheduleItem & {
  editing?: boolean;
  unpublished?: boolean;
};

type ScheduleGroup = {
  key: string;
  date: string | null;
  label: string;
  shortLabel: string;
  sessions: Array<{ item: PublicProgramSchedulePreviewItem; order: number }>;
};

function validTimeMinutes(value: string): number | null {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value.trim());
  if (!match) return null;
  const [hours, minutes] = match[0].split(":").map(Number);
  return hours * 60 + minutes;
}

function buildGroups(program: PublicProgramSchedulePreviewItem[], eventDate: string): ScheduleGroup[] {
  const fallbackDate = publicEventDate(eventDate);
  const groups = new Map<string, ScheduleGroup>();

  for (const [order, item] of program.entries()) {
    const suppliedDate = item.date.trim();
    const ownDate = publicEventDate(suppliedDate);
    const date = ownDate ?? (suppliedDate ? null : fallbackDate);
    const key = date?.dateTime ?? "unknown";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        date: date?.dateTime ?? null,
        label: date?.label ?? "날짜 미정",
        shortLabel: date?.shortLabel ?? "날짜 미정",
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push({ item, order });
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.sessions.sort((left, right) => {
      const leftTime = validTimeMinutes(left.item.start) ?? validTimeMinutes(left.item.end);
      const rightTime = validTimeMinutes(right.item.start) ?? validTimeMinutes(right.item.end);
      if (leftTime === null && rightTime === null) return left.order - right.order;
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return leftTime - rightTime || left.order - right.order;
    });
  }

  return result.sort((left, right) => {
    if (left.date === null && right.date === null) return 0;
    if (left.date === null) return 1;
    if (right.date === null) return -1;
    return left.date.localeCompare(right.date);
  });
}

function formatSessionTime(item: PublicProgramSchedulePreviewItem): string {
  const start = item.start.trim();
  const end = item.end.trim();
  const hasStart = validTimeMinutes(start) !== null;
  const hasEnd = validTimeMinutes(end) !== null;

  if (hasStart && hasEnd) return `${start}–${end}`;
  if (hasStart) return end ? `${start} 시작 · 종료 시각 확인 필요` : `${start} 시작`;
  if (hasEnd) return start ? `시작 시각 확인 필요 · ${end} 종료` : `${end} 종료`;
  if (start || end) return `시각 확인 필요 · ${[start, end].filter(Boolean).join(" ~ ")}`;
  return "시간 미정";
}

export default function PublicProgramSchedule({
  program,
  eventDate,
  preview = false,
}: {
  program: PublicProgramSchedulePreviewItem[];
  eventDate: string;
  preview?: boolean;
}) {
  const instanceId = useId();
  const groups = useMemo(() => buildGroups(program, eventDate), [program, eventDate]);
  const [selectedDate, setSelectedDate] = useState("all");
  const selectedGroup = groups.find((group) => group.key === selectedDate);
  useEffect(() => {
    if (selectedDate !== "all" && !selectedGroup) setSelectedDate("all");
  }, [selectedDate, selectedGroup]);
  const effectiveSelectedDate = selectedDate === "all" || selectedGroup
    ? selectedDate
    : "all";
  const visibleGroups = effectiveSelectedDate === "all"
    ? groups
    : groups.filter((group) => group.key === effectiveSelectedDate);
  const visibleCount = visibleGroups.reduce((count, group) => count + group.sessions.length, 0);
  const hasMultipleDates = groups.length > 1;

  return (
    <div className={styles.schedule}>
      {hasMultipleDates ? (
        <div className={styles.datePicker} role="group" aria-label="프로그램 날짜 선택">
          <button
            type="button"
            className={styles.dateButton}
            aria-pressed={effectiveSelectedDate === "all"}
            aria-label={`전체 날짜의 프로그램 ${program.length}개`}
            onClick={() => setSelectedDate("all")}
          >
            전체 <span>{program.length}</span>
          </button>
          {groups.map((group) => (
            <button
              type="button"
              key={group.key}
              className={styles.dateButton}
              aria-pressed={effectiveSelectedDate === group.key}
              aria-label={`${group.label} 프로그램 ${group.sessions.length}개`}
              onClick={() => setSelectedDate(group.key)}
            >
              {group.shortLabel} <span>{group.sessions.length}</span>
            </button>
          ))}
        </div>
      ) : null}
      {hasMultipleDates ? (
        <p className={styles.screenReaderStatus} role="status" aria-live="polite" aria-atomic="true">
          {effectiveSelectedDate === "all"
            ? `전체 날짜의 프로그램 ${program.length}개를 표시합니다.`
            : `${selectedGroup?.label ?? "선택한 날짜"}의 프로그램 ${visibleCount}개를 표시합니다.`}
        </p>
      ) : null}

      <div className={styles.groups}>
        {visibleGroups.map((group) => {
          const headingId = `${instanceId}-program-day-${group.key}`;
          return (
            <section key={group.key} className={styles.day} aria-labelledby={headingId}>
              <h3 id={headingId} className={styles.dayHeading}>
                {group.date ? <time dateTime={group.date}>{group.label}</time> : group.label}
              </h3>
              <ol className={styles.timeline}>
                {group.sessions.map(({ item, order }) => {
                  const dateLabel = item.date.trim()
                    ? group.date ? null : `날짜 확인 필요 · ${item.date.trim()}`
                    : group.date ? "행사 일정 기준" : "날짜 확인 필요";
                  const startTime = item.start.trim();
                  const endTime = item.end.trim();
                  const hasTimeRange = validTimeMinutes(startTime) !== null && validTimeMinutes(endTime) !== null;
                  const speakers = [item.speaker, ...(item.speakers ?? [])]
                    .map((speaker) => speaker?.trim() ?? "")
                    .filter(Boolean);

                  return (
                    <li key={`${item.id}-${order}`} className={styles.session} data-editing={item.editing || undefined}>
                      <p className={styles.time}>
                        {hasTimeRange ? (
                          <time
                            className={styles.timeRange}
                            dateTime={group.date ? `${group.date}T${startTime}` : undefined}
                            aria-label={`${startTime} 시작, ${endTime} 종료`}
                          >
                            <span>{startTime}</span>
                            <span className={styles.endTime}>–{endTime}</span>
                          </time>
                        ) : <span>{formatSessionTime(item)}</span>}
                        {dateLabel ? <span className={styles.dateNote}>{dateLabel}</span> : null}
                      </p>
                      <div className={styles.sessionBody}>
                        <h4>{item.title || (item.editing ? "제목 입력 중" : "제목 없음")}</h4>
                        {item.place.trim() ? <p className={styles.place}>{item.place}</p> : null}
                        {speakers.length ? <p className={styles.speaker}>{speakers.join(" · ")}</p> : null}
                        {preview && item.editing && item.unpublished
                          ? <p className={styles.draftTag}>게시 전 · 초안 미리보기</p>
                          : null}
                        {item.description.trim() ? (
                          <details className={styles.description}>
                          <summary data-disclosure-indicator>세션 설명</summary>
                            <p>{item.description}</p>
                          </details>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}
