// Pure helpers for the 현장 모드 screen: the day's cue order, which cue is on
// now, and the venue-display choices. No imports so the contract test can
// transpile and run it directly. The cue logic follows the 운영 현황 runbook
// (EventOverview.tsx: sorted by start, matched against the browser clock) and
// adds one rule: a cue with no end time runs until the next cue starts, so a
// start-only schedule still moves forward instead of staying "upcoming" forever.

export type LiveProgram = { id: string; title: string; date: string; start: string; end: string; place: string };
export type LiveCueStatus = "done" | "current" | "next" | "upcoming";
export type LiveCue = LiveProgram & { status: LiveCueStatus };

export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function timeInMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The event day's full order with a status per cue. Today's cues are judged
 * against `now`; a past day is all done, a future day all upcoming. Exactly one
 * cue is "next" (the first one still ahead), so the right pane can name it.
 * When no cue carries the event date but some carry today's, today's are used,
 * which is the case when the stage was moved to 진행 중 on a different day.
 */
export function liveCues(programs: LiveProgram[], eventDate: string, now: Date): { date: string; cues: LiveCue[] } {
  const today = localDateKey(now);
  let date = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : today;
  if (!programs.some((program) => program.date === date) && programs.some((program) => program.date === today)) date = today;
  const minuteNow = now.getHours() * 60 + now.getMinutes();
  const isToday = date === today;
  const isPast = date < today;
  const ordered = programs
    .filter((program) => program.date === date)
    .slice()
    .sort((left, right) =>
      (timeInMinutes(left.start) ?? -1) - (timeInMinutes(right.start) ?? -1) ||
      left.title.localeCompare(right.title, "ko"));
  let nextTaken = false;
  const cues = ordered.map((program, index): LiveCue => {
    let status: LiveCueStatus = isPast ? "done" : "upcoming";
    if (isToday) {
      const start = timeInMinutes(program.start);
      const explicitEnd = timeInMinutes(program.end);
      const following = ordered.slice(index + 1).map((item) => timeInMinutes(item.start)).find((value): value is number => value !== null && (start === null || value > start));
      // An open-ended cue ends where the next one begins; the last one stays on.
      if (start === null || start > minuteNow) status = "upcoming";
      else if (explicitEnd !== null) status = explicitEnd < minuteNow ? "done" : "current";
      else status = following !== undefined && following <= minuteNow ? "done" : "current";
    }
    if (status === "upcoming" && !nextTaken) { status = "next"; nextTaken = true; }
    return { ...program, status };
  });
  return { date, cues };
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[\s·・\-–—_()[\]{}.,:;!?'"“”‘’]+/g, "");
}

/**
 * A participation event belongs to a cue when the two titles contain one
 * another (e.g. cue "오프닝 OX 퀴즈" and event "OX 퀴즈"). Participation events
 * carry no schedule time of their own, so a title is the only honest link.
 */
export function titlesMatch(left: string, right: string): boolean {
  const a = squash(left);
  const b = squash(right);
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

export type LiveDisplay = { type: string; moduleId: string; noticeId: string; drawId: string };
export type LiveDisplayDraw = { id: string; name: string; at: string };
export type LiveDisplayOptions = {
  notices: Array<{ id: string; title: string; published: boolean }>;
  modules: Array<{ id: string; title: string; type: string; published: boolean; revealed: boolean; draws: LiveDisplayDraw[]; /** Its feature is on; missing counts as on. */ enabled?: boolean }>;
  approvedPhotos: number;
  approvedQuestions: number;
};

export function displayKey(display: LiveDisplay): string {
  const target = display.type === "notice" ? display.noticeId : display.moduleId;
  return display.drawId ? `${display.type}|${target}|${display.drawId}` : `${display.type}|${target}`;
}

const DRAW_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function drawDisplayLabel(draw: LiveDisplayDraw, moduleTitle: string): string {
  const parsed = Date.parse(draw.at);
  const at = Number.isFinite(parsed) ? DRAW_TIME_FORMAT.format(parsed) : "시각 미확인";
  return `추첨 결과 · ${draw.name || moduleTitle} · ${at}`;
}

type DisplayChoice = { value: string; label: string; /** Its feature is switched off: shown only to name what is on air. */ off?: boolean };

function collectChoices(options: LiveDisplayOptions, includeOff: boolean): DisplayChoice[] {
  const choices: DisplayChoice[] = [{ value: "idle|", label: "유휴 화면 (안내 없음)" }];
  for (const notice of options.notices) {
    if (notice.published) choices.push({ value: `notice|${notice.id}`, label: `공지 · ${notice.title}` });
  }
  for (const module of options.modules) {
    if (!module.published) continue;
    const off = module.enabled === false;
    // The server only outputs a module whose feature is on (setDisplay), so the picker
    // skips leftovers of a switched-off feature; the on-air label still names them.
    if (off && !includeOff) continue;
    const mark = off ? { off: true } : {};
    if (module.type === "poll") choices.push({ value: `poll|${module.id}`, label: `투표 · ${module.title}`, ...mark });
    if (module.type === "quiz" && module.revealed) choices.push({ value: `quiz|${module.id}`, label: `퀴즈 정답 · ${module.title}`, ...mark });
    if (module.type === "draw" && module.draws[0]) choices.push({ value: `draw|${module.id}|${module.draws[0].id}`, label: drawDisplayLabel(module.draws[0], module.title), ...mark });
    if (module.type === "qa" && (options.approvedQuestions > 0 || includeOff)) choices.push({ value: `qa|${module.id}`, label: `Q&A · ${module.title}`, ...mark });
  }
  if (options.approvedPhotos > 0 || includeOff) choices.push({ value: "photo|", label: options.approvedPhotos > 0 ? `사진 · 승인 ${options.approvedPhotos}장` : "사진" });
  return choices;
}

/** Output choices mirror the server contract: unpublished, unrevealed or switched-off things are not offered. */
export function displayChoices(options: LiveDisplayOptions): Array<{ value: string; label: string }> {
  return collectChoices(options, false).map(({ value, label }) => ({ value, label }));
}

/** What the venue screen shows now, in words. */
export function currentDisplayLabel(display: LiveDisplay, options: LiveDisplayOptions): string {
  if (display.type === "idle") return "유휴 화면";
  const choices = collectChoices(options, true);
  const drawModule = display.type === "draw"
    ? options.modules.find((module) => module.id === display.moduleId && module.type === "draw" && module.published)
    : undefined;
  const draw = display.drawId ? drawModule?.draws.find((item) => item.id === display.drawId) : drawModule?.draws[0];
  if (draw && drawModule) return drawDisplayLabel(draw, drawModule.title);
  if (display.type === "draw" && display.drawId) return "기본 화면 · 선택한 추첨 결과 출력 불가";
  const onAir = choices.find((choice) => choice.value === displayKey(display));
  if (!onAir) return "출력 확인 필요";
  return onAir.off ? `${onAir.label} · 기능 꺼짐` : onAir.label;
}
