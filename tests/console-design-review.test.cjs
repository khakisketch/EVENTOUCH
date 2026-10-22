// Visual-hierarchy pass over console content / team / reports / directory.
// Source contracts only: spacing, badge rhythm, danger tone, identity split,
// subgroup separation, numeric alignment, quiet countdown. Copy, actions,
// ordering, handlers, guards and countdown logic are pinned unchanged.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.resolve(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");

function noNewHex(source, file) {
  const found = source.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(found, [], `${file} must use tokens, found literals: ${found.join(", ")}`);
}

// --- 1. Content notices: token rhythm + local danger outline ----------------

test("notice rows separate title, badge row and body with tokens", () => {
  const css = read("console/events/[id]/content/content.module.css");
  assert.match(css, /\.recordTitle\s*\{[^}]*margin:\s*0 0 var\(--s1\)/s);
  assert.match(css, /\.badgeRow\s*\{[^}]*gap:\s*var\(--s2\)/s);
  assert.match(css, /\.badgeRow\s*\{[^}]*margin-bottom:\s*var\(--s2\)/s);
  assert.match(css, /\.body\s*\{[^}]*margin:\s*var\(--s2\) 0 0/s);
  noNewHex(css, "content.module.css");
});

test("content badges read inline with token padding", () => {
  const css = read("console/events/[id]/content/content.module.css");
  assert.match(css, /\.badge\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.badge\s*\{[^}]*padding:\s*var\(--s1\) var\(--s2\)/s);
});

test("notice and schedule deletes share a local danger outline, nothing else", () => {
  const css = read("console/events/[id]/content/content.module.css");
  assert.match(css, /button\.dangerGhost\s*\{[^}]*border-color:\s*var\(--danger-line\)/s);
  assert.match(css, /button\.dangerGhost\s*\{[^}]*color:\s*var\(--danger\)/s);
  assert.doesNotMatch(css, /\.dangerGhost[^}]*outline:/s);
  const workspace = read("console/events/[id]/content/ContentWorkspace.tsx");
  const usages = workspace.match(/styles\.dangerGhost/g) || [];
  assert.equal(usages.length, 4, `two row deletes + two delete confirms, found ${usages.length}`);
  assert.match(workspace, /requestNoticeDelete\(item\)[\s\S]*?dangerGhost/s);
  assert.match(workspace, /requestProgramDelete\(item\)[\s\S]*?dangerGhost/s);
});

test("in-place confirms span the full row, never a third column", () => {
  const css = read("console/events/[id]/content/content.module.css");
  assert.match(css, /li\.recordRow\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /li\.recordRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
  assert.match(css, /li\.recordRow > \[role="group"\]\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(css, /@media \(max-width: 768px\)\s*\{[^}]*li\.recordRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  const workspace = read("console/events/[id]/content/ContentWorkspace.tsx");
  const rows = workspace.match(/uiStyles\.recordRow\} \$\{styles\.recordRow\}/g) || [];
  assert.equal(rows.length, 2, `notice + schedule rows share the local grid, found ${rows.length}`);
  assert.match(workspace, /<ConsoleConfirm/);
  assert.equal(rows.length, 2);});

test("content keeps its copy, handlers and in-place confirms", () => {
  const workspace = read("console/events/[id]/content/ContentWorkspace.tsx");
  assert.match(workspace, /공지를 삭제할까요/);
  assert.match(workspace, /일정을 삭제할까요/);
  assert.match(workspace, /confirmClassName=\{`button button-secondary \$\{styles\.dangerGhost\}`\}/);
  assert.match(workspace, /<ConsoleConfirm/);
  assert.match(workspace, /onConfirm=\{\(\) => void deleteNotice\(item\)\}/);
  assert.match(workspace, /onConfirm=\{\(\) => void deleteProgram\(item\)\}/);
  assert.match(workspace, /onClick=\{\(\) => void toggleNoticePublish\(item\)\}/);
  assert.match(workspace, /전광판 출력/);
});

test("the shared confirm keeps its primary default and focus contract", () => {
  const confirm = read("console/console-ui/ConsoleConfirm.tsx");
  assert.match(confirm, /confirmClassName = "button button-primary"/);
  assert.match(confirm, /aria-label="실행 확인"/);
  assert.match(confirm, /confirmRef\.current\?\.focus\(\)/);
  assert.match(confirm, /className=\{confirmClassName\}/);
});

// --- 2. Team identity: strong name, subordinate role, stacked lines ----------

test("team identity splits name from role with tokens only", () => {
  const css = read("console/team/team.module.css");
  noNewHex(css, "team.module.css");
  assert.match(css, /\.memberName\s*\{[^}]*font-weight:\s*800/s);
  assert.match(css, /\.memberRole\s*\{[^}]*color:\s*var\(--muted\)/s);
  assert.match(css, /\.memberRole\s*\{[^}]*font-size:\s*var\(--small\)/s);
  assert.match(css, /\.inviteDetail\s*\{[^}]*gap:\s*var\(--s1\)/s);
  const workspace = read("console/team/TeamWorkspace.tsx");
  assert.match(workspace, /<strong className=\{teamStyles\.memberName\}>\{invitation\.name\}<\/strong>/);
  assert.match(workspace, /<p className=\{teamStyles\.memberRole\}>\{roleLabel\(invitation\.role\)\}<\/p>/);
  assert.match(workspace, /<strong className=\{teamStyles\.memberName\}>\{account\.name\}<\/strong>/);
});

test("team keeps every field, action and section order", () => {
  const workspace = read("console/team/TeamWorkspace.tsx");
  assert.match(workspace, /roleLabel\(account\.role\)/);
  assert.match(workspace, /사용 중지/);
  assert.match(workspace, /\{invitation\.email\}/);
  assert.match(workspace, /담당 행사 미지정/);
  assert.match(workspace, /만료: \{expiry\}/);
  assert.match(workspace, /<RevokeInviteButton/);
  assert.match(workspace, /비밀번호 재설정/);
  assert.ok(
    workspace.indexOf('headingId="pending-invites"') < workspace.indexOf('headingId="team-members"'),
    "pending invites stay above members"
  );
});

// --- 3. Reports: subgroup separation + right-aligned numerics ---------------

test("report subgroups separate at s5 with s2 inner rhythm", () => {
  const css = read("console/events/[id]/reports/reports.module.css");
  assert.match(css, /\.subgroup\s*\{[^}]*margin-top:\s*var\(--s5\)/s);
  assert.match(css, /\.subgroup\s*\{[^}]*gap:\s*var\(--s2\)/s);
  noNewHex(css, "reports.module.css");
  const workspace = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  const groups = workspace.match(/className=\{styles\.subgroup\}/g) || [];
  assert.equal(groups.length, 4, `four analytic subgroups, found ${groups.length}`);
  for (const heading of ["등록 그룹", "부스 이용", "프로그램 응답", "만족도"]) {
    assert.match(workspace, new RegExp(`<div className=\\{styles\\.subgroup\\}>\\s*<h3>${heading}</h3>`));
  }
});

test("only numeric report columns align right with tabular figures", () => {
  const css = read("console/events/[id]/reports/reports.module.css");
  assert.match(css, /\.num\s*\{[^}]*text-align:\s*right/s);
  assert.match(css, /\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
  const workspace = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  for (const header of ["인원", "인증", "응답", "평균"]) {
    assert.match(workspace, new RegExp(`className=\\{styles\\.num\\}>${header}</th>`), `${header} header aligns right`);
  }
  assert.match(workspace, /<th scope="col">종류<\/th>/, "the kind column stays left");
  assert.match(workspace, /<th scope="col">그룹<\/th>/, "name columns stay left");
  assert.match(workspace, /<th scope="col">항목<\/th>/, "item columns stay left");
});

test("reports keep every column, scroll regions and print isolation", () => {
  const workspace = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  const regions = workspace.match(/role="region" tabIndex=\{0\}/g) || [];
  assert.ok(regions.length >= 4, `scroll regions preserved, found ${regions.length}`);
  for (const label of ["등록 그룹별 인원 표", "부스별 인증 수 표", "프로그램별 응답 표"]) {
    assert.match(workspace, new RegExp(`aria-label="${label}"`));
  }
  assert.match(workspace, /\.cloneNode\(true\)/);
  assert.match(workspace, /report-printing/);
  assert.match(workspace, /EVENTOUCH · 결과 보고서/);
});

// --- 4. Event directory: quiet countdown, attention only when near ----------

test("countdown defaults quiet and fills only for today and tomorrow", () => {
  const css = read("console/console-home.module.css");
  noNewHex(css, "console-home.module.css");
  assert.match(css, /\.eventRecency\s*\{[^}]*background:\s*var\(--surface-muted\)/s);
  assert.match(css, /\.eventRecency\s*\{[^}]*color:\s*var\(--muted\)/s);
  assert.match(css, /\.eventRecencySoon\s*\{[^}]*background:\s*var\(--brand\)/s);
  assert.match(css, /\.eventCardAction\s*\{[^}]*min-inline-size:\s*var\(--s7\)/s);
  assert.match(css, /\.approvalLink\s*\{[^}]*min-inline-size:\s*var\(--s7\)/s);
  const home = read("console/ConsoleHome.tsx");
  assert.match(home, /recency === "오늘" \|\| recency === "내일"/);
  assert.match(home, /styles\.eventRecencySoon/);
  for (const token of ["오늘", "내일", "어제", "D-${days}", "D+${days}"]) {
    assert.ok(home.includes(token === "D-${days}" ? "D-${days}" : token), `countdown keeps ${token}`);
  }
});

test("directory cards keep their order, content and countdown logic", () => {  const home = read("console/ConsoleHome.tsx");
  const card = home.slice(home.indexOf("function EventCard("), home.indexOf("export default function ConsoleHome()"));
  const order = ["eventRecency", "eventDate", "eventName", "eventStatus"].map((name) => card.indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "recency, date, name and status keep their positions");
  assert.match(home, /event\.date > todayKey/);
  assert.match(home, /date === todayKey/);
  assert.match(home, /className=\{styles\.eventCard\}>/);
});
