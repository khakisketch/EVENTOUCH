"use strict";

// Event list (행사), approved 2026-11-14 (design-review events-options.html,
// B2). Reopened 2026-11-19: the stage tabs became filter cards (big count plus
// share bar), the running event a dark board, rows gained a date tile and a
// stage pill, and the search/toggle/view switch became pills. Source-only;
// rendering rides the real browser check.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console");
const home = fs.readFileSync(path.join(DIR, "ConsoleHome.tsx"), "utf8");
const css = fs.readFileSync(path.join(DIR, "console-home.module.css"), "utf8");
const row = home.slice(home.indexOf("function EventRow("), home.indexOf("export default function ConsoleHome()"));

test("approved event list design stays locked", () => {
  // One bordered unit: the running event. No card around the list, no column header.
  assert.match(css, /\.directorySection\.directorySection\s*\{[^}]*border:\s*0/su, "the list has no wrapping card");
  assert.doesNotMatch(home, /directoryColumns|<select/u, "no column header and no stage dropdown");
  assert.equal([...css.matchAll(/\.liveCard\s*\{[^}]*border:\s*1px/gsu)].length, 1, "the running event is the page's one card");
  assert.match(home, /className=\{styles\.liveCard\}/u);
  assert.match(home, /운영 현황 열기/u);

  // Reopened 2026-11-20 (owner: 카드 띠도 개수 탭으로): the stage filter is one row of
  // count tabs (CountTabs: aria-pressed buttons, ink fill when chosen); the toggle keeps its queue count.
  assert.match(home, /<CountTabs\s+ariaLabel="진행 단계"\s+value=\{filter\}/u);
  assert.match(home, /items=\{FILTERS\.map\(\(item\) => \(\{ key: item\.id, label: item\.label, count: counts\[item\.id\] \}\)\)\}/u);
  assert.doesNotMatch(css, /\.stageTab|\.stageCount|\.stageBar/u, "the four stage cards are gone");
  assert.match(home, /aria-label=\{`승인 대기 있는 행사만 보기 \(\$\{pendingQueueCount\}건\)`\}/u);
  const order = ["styles.homeSearch", "styles.homeWork"].map((token) => home.indexOf(token));
  assert.ok(order.every((p) => p >= 0) && order[0] < order[1], "search first, then the approval toggle");
  assert.match(home, /placeholder="행사 검색"/u);
  assert.match(home, /aria-label="행사명·고객사·장소 검색"/u);

  // Groups, in this order: running card, upcoming, past.
  const groups = ["styles.liveCard", "다가오는 행사", "지난 행사"].map((t) => home.indexOf(t));
  assert.ok(groups.every((p) => p >= 0) && groups[0] < groups[1] && groups[1] < groups[2]);
});

test("a row is name, one date line, countdown, arrow; the next action is a sibling link", () => {
  // Reopened 2026-11-19: a date tile leads and the stage is a tinted pill with a dot.
  assert.match(row, /styles\.dateTile/u, "a date tile leads the row");
  assert.match(row, /styles\.stageChip/u, "the stage reads as a tinted pill");
  assert.match(row, /styles\.stageDot/u, "the pill keeps the dot shape beside the colour");
  assert.doesNotMatch(row, /stage-badge|eventStageClassName/u);
  assert.match(row, /<strong>\{lead\}<\/strong>/u, "the date leads in strong type");
  assert.match(row, /"일정 미정"/u, "unknown dates stay explicit");
  assert.match(row, /`시간 \$\{time\}`/u, "time-only events keep their explicit label");
  assert.match(row, /cardHeaderTheme\(event\.themeColor\)/u, "published-only theme dot");
  assert.doesNotMatch(row, /fetch\s*\(/u, "no per-row fetch");
  assert.doesNotMatch(row, /draft/iu, "drafts never reach rows");
  assert.doesNotMatch(row, /onDuplicate|복제|등록 인원|현재 입장|<dl/u, "no duplicate control and no permanent KPIs");
  assert.doesNotMatch(row, /aria-label=\{`[^`]*열기[^`]*`\}/u, "the entry link's name comes from its contents");
  assert.match(row, /<span className="sr-only"> \{stageLabel\} · 열기<\/span>/u, "the stage word lives in the accessible name");

  // Approval: exactly one visible summary, a separate real destination, never nested.
  assert.equal((row.match(/승인 대기 \{event\.pending\}명 처리/g) || []).length, 1);
  assert.match(row, /participants\?status=PENDING/u);
  assert.match(row, /aria-label=\{`\$\{event\.name\} 승인 대기 \$\{event\.pending\}명 처리`\}/u);
  assert.match(row, /\{event\.pending > 0 \? \(\s*<ProductLink\s+className=\{styles\.rowAction\}/su, "the action renders only for a real queue");
  assert.ok(row.indexOf("</ProductLink>") < row.indexOf("styles.rowAction"), "the action is not nested in the entry link");
  assert.equal((row.match(/<ProductLink/g) || []).length, 2, "one entry and one optional action");
  assert.match(css, /\.rowAction\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /\.rowActionPill\s*\{[^}]*var\(--warning-soft\)/su, "waiting work is the amber pill");
  assert.match(css, /\.rowAction\s*\{[^}]*word-break:\s*keep-all[^}]*overflow-wrap:\s*anywhere/su);
  for (const sel of [".eventRowLink:focus-visible", ".rowAction:focus-visible"]) {
    assert.ok(css.includes(sel), `${sel} keeps a visible focus style`);
  }
});

test("the countdown stays quiet text; only today and tomorrow are emphasised", () => {
  assert.doesNotMatch(css, /\.eventRecency\s*\{[^}]*background/su, "the countdown stays text unless it is today or tomorrow");
  assert.match(css, /\.eventRecency\s*\{[^}]*color:\s*var\(--muted\)[^}]*font-variant-numeric:\s*tabular-nums/su);
  assert.match(css, /\.eventRecency\[data-soon\]\s*\{[^}]*background:\s*var\(--ink\)[^}]*font-weight:\s*800/su, "today and tomorrow become an ink pill");
  assert.match(home, /recency === "오늘" \|\| recency === "내일"/u);
  for (const token of ["오늘", "내일", "어제", "D-${days}", "D+${days}"]) assert.ok(home.includes(token), `countdown keeps ${token}`);
  assert.match(home, /event\.date > todayKey/u);
  assert.match(home, /date === todayKey/u);
});

test("create stays the lone page-level action; view switch and calendar are kept", () => {
  assert.match(home, /headerActions=\{[\s\S]*?setCreateOpen\(true\)[\s\S]*?새 행사 만들기/u);
  assert.equal((home.match(/headerActions=/g) || []).length, 1);
  assert.match(home, /className=\{`button button-primary \$\{styles\.createTrigger\}`\}/u);
  assert.match(home, /aria-pressed=\{view === "calendar"\}/u);
  assert.match(home, /aria-pressed=\{view === "cards"\}/u);
  assert.match(home, /styles\.dayCell/u, "the calendar view is untouched");
  assert.equal((home.match(/<ConsoleToolbar/g) || []).length, 1);
  assert.match(css, /\.viewActive\s*\{[^}]*color:\s*var\(--ink\)/su, "the selected view is ink, never orange");
});

test("phones stack the row to one column and tokens only", () => {
  const phone = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(phone, /\.eventRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
  assert.match(phone, /\.liveCard\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
  assert.match(css, /\.eventName\s*\{[^}]*word-break:\s*keep-all[^}]*overflow-wrap:\s*anywhere/su);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(/u);
});
