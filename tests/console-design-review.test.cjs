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

// --- 1. Content ledger: flat rows with token rhythm + local danger outline ---

test("content ledger rows are flat, token-spaced and state-dotted", () => {
  const css = read("console/events/[id]/content/content.module.css");
  assert.match(css, /\.ledgerItem \+ \.ledgerItem\s*\{[^}]*border-top:\s*1px solid var\(--line\)/s);
  // Reopened 2026-11-19: the state dot sits in a 36px tinted circle and the status word is a tinted pill.
  assert.match(css, /\.ledgerRow\s*\{[^}]*grid-template-columns:\s*36px minmax\(0,\s*1fr\) auto/s);
  assert.match(css, /\.ledgerRow\s*\{[^}]*min-height:\s*80px/s);
  assert.match(css, /\.rowText\s*\{[^}]*gap:\s*var\(--s1\)/s);
  assert.match(css, /\.dot\[data-status="live"\]::after\s*\{[^}]*background:\s*var\(--success\)/s);
  assert.match(css, /\.dot\[data-status="edit"\]::after\s*\{[^}]*background:\s*var\(--warning\)/s);
  assert.match(css, /\.rowStatus\[data-status="live"\]\s*\{[^}]*background:\s*var\(--success-soft\)/s);
  noNewHex(css, "content.module.css");
  noNewHex(read("console/events/[id]/content/content-preview.module.css"), "content-preview.module.css");
});

test("notice and schedule deletes share a local danger outline, nothing else", () => {
  const css = read("console/events/[id]/content/content.module.css");
  assert.match(css, /\.dangerGhost\s*\{[^}]*border:\s*1px solid var\(--danger-line\)/s);
  assert.match(css, /\.dangerGhost\s*\{[^}]*color:\s*var\(--danger\)/s);
  assert.doesNotMatch(css, /\.dangerGhost[^}]*outline:/s);
  const workspace = read("console/events/[id]/content/ContentWorkspace.tsx");
  const usages = workspace.match(/styles\.dangerGhost/g) || [];
  assert.equal(usages.length, 2, `two editor deletes retain the local outline, found ${usages.length}`);
  assert.equal((workspace.match(/confirmClassName="button button-danger"/g) || []).length, 2, 'both inline delete confirmations stay destructive');
  assert.match(workspace, /className=\{styles\.dangerGhost\} variant="destructive"[\s\S]{0,260}requestNoticeDelete\(editingNotice\)/s);
  assert.match(workspace, /className=\{styles\.dangerGhost\} variant="destructive"[\s\S]{0,260}requestProgramDelete\(editingProgram\)/s);
});

test("content rows open their editor and carry no per-row buttons", () => {
  const workspace = read("console/events/[id]/content/ContentWorkspace.tsx");
  assert.equal((workspace.match(/<LedgerRow/g) || []).length, 2, "notices and schedule share one ledger row");
  assert.match(workspace, /onOpen=\{canWritePage \? \(\) => openNoticeEdit\(item\) : undefined\}/);
  assert.match(workspace, /onOpen=\{canWritePrograms \? \(\) => openProgramEdit\(item\) : undefined\}/);
  assert.doesNotMatch(workspace, /uiStyles\.recordRow/);
});

test("content keeps its copy, handlers and in-place confirms", () => {
  const workspace = read("console/events/[id]/content/ContentWorkspace.tsx");
  assert.match(workspace, /공지를 삭제할까요/);
  assert.match(workspace, /일정을 삭제할까요/);
  assert.match(workspace, /confirmClassName="button button-danger"/);
  assert.match(workspace, /<ConsoleConfirm/);
  assert.match(workspace, /onConfirm=\{\(\) => void deleteNotice\(editingNotice\)\}/);
  assert.match(workspace, /onConfirm=\{\(\) => void deleteProgram\(editingProgram\)\}/);
  assert.match(workspace, /<PublicationReview/);
  assert.match(workspace, /onConfirm=\{\(\) => void applyPublication\(\)\}/);
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
  assert.match(css, /\.personName\s*\{[^}]*font-weight:\s*var\(--fw-strong\)/s);
  assert.match(css, /\.personContact\s*\{[^}]*color:\s*var\(--muted\)/s);
  assert.match(css, /\.personContact\s*\{[^}]*font-size:\s*var\(--text-sm\)/s);
  assert.match(css, /\.personRole small\s*\{[^}]*color:\s*var\(--muted\)/s);
  const workspace = read("console/team/TeamWorkspace.tsx");
  assert.match(workspace, /<h3 className=\{teamStyles\.personName\}>/);
  assert.match(workspace, /<StatusPill tone=\{ROLE_PILL_TONE\[invitation\.role\] \?\? "neutral"\} size="sm">\{roleLabel\(invitation\.role\)\}<\/StatusPill>\s*<small>/);
  assert.match(workspace, />\{account\.name\}<\/button>/);
});

test("team keeps every field, action and section order", () => {
  const workspace = read("console/team/TeamWorkspace.tsx");
  assert.match(workspace, /roleLabel\(account\.role\)/);
  assert.match(workspace, /사용 중지/);
  assert.match(workspace, /<SafeContact value=\{invitation\.email\} \/>/);
  assert.match(workspace, /담당 행사 미지정/);
  assert.match(workspace, /만료 \{expiry\}/);
  assert.match(workspace, /<RevokeInviteButton/);
  assert.match(workspace, /비밀번호 재설정/);
  assert.ok(
    workspace.indexOf('headingId="pending-invites"') < workspace.indexOf('aria-label="구성원 목록"'),
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
  assert.equal(groups.length, 5, `five analytic subgroups, found ${groups.length}`);
  for (const heading of ["등록 그룹", "부스 이용", "프로그램 응답", "만족도", "행사 사진"]) {
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

// --- 4. Event ledger: quiet countdown, attention only when near ------------


