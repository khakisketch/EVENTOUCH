"use strict";

// Team and permissions (팀·권한), approved 2026-11-16 (design-review
// team-options-b.html → team-options-b4.html, option A: three-bar gauge).
// Reopened 2026-11-19: a status strip tops the list, tabs are a segmented pill
// control, avatars take the role colour and role/state read as pills. Rows stay
// flat and hold one control. Reopened 2026-11-20 (디자인 시스템 적용): count tabs, ConsoleAvatar,
// StatusPill and ConsoleEmptyState replace the hand-made parts. Source-only; rendering rides the real browser check.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console", "team");
const team = fs.readFileSync(path.join(DIR, "TeamWorkspace.tsx"), "utf8");
const css = fs.readFileSync(path.join(DIR, "team.module.css"), "utf8");

test("approved team design stays locked: three tabs, flat people rows, no buttons in a row", () => {
  // Tabs: 구성원 / 행사별 권한 (owner only) / 연동·활동; panels stay mounted.
  assert.match(team, /<ConsoleSectionNav mode="tabs" label="팀·권한 작업" items=\{tabItems\} initialId="team-members" onNavigate=\{setActiveTab\} \/>/u);
  assert.match(css, /\.tabsHost :global\(\[role="tab"\]\[aria-selected="true"\]\)\s*\{[^}]*background:\s*var\(--ink\)/su, "the chosen tab is an ink-filled segment");
  assert.match(team, /\.\.\.\(state\.isOwner \? \[\{ id: "team-event-permissions", label: "행사별 권한" \}\] : \[\]\)/u);
  assert.match(team, /\{ id: "team-operations", label: "연동·활동" \}/u);
  assert.doesNotMatch(team, /operationsDetails|<details/u, "연동·활동 is a tab, not a folded box");
  assert.doesNotMatch(team, /toolbarLabel|비밀번호 재설정은 소유자만 가능하며, 재설정 시/u, "no toolbar label or standing sentence above the list");

  // Rows: initial, name and contact, role, state, arrow. The name button's
  // ::after is the whole-row hit area, so rows hold no buttons of their own.
  assert.match(css, /\.peopleList\s*\{[^}]*border-top:\s*1px solid var\(--line\)/su);
  assert.match(css, /\.rowOpen::after\s*\{[^}]*inset:\s*0/su);
  assert.doesNotMatch(css, /\.(?:personRow|permRow)\s*\{[^}]*(?:box-shadow|border-radius)/su, "a row is not a card");
  for (const marker of ["teamStyles.personRow", "teamStyles.permRow"]) {
    const start = team.indexOf(`<li className={${marker}}`);
    assert.ok(start > 0, `${marker} rows exist`);
    const row = team.slice(start, team.indexOf("</li>", start));
    assert.doesNotMatch(row, /<ProductButton/u, `${marker} holds no ProductButton`);
    assert.equal((row.match(/<button/g) ?? []).length, 1, `${marker} has exactly one control: the name button`);
  }
  assert.match(team, /id=\{`member-open-\$\{account\.id\}`\}/u);
  assert.match(team, /id=\{`invite-open-\$\{invitation\.id\}`\}/u);
  assert.ok(team.indexOf('headingId="pending-invites"') < team.indexOf('aria-label="구성원 목록"'), "pending invites stay above members");
  assert.match(team, /대기 중인 초대를 확인할 수 없습니다\./u, "an unknown queue is never reported as an empty one");

  // One orange action on the page.
  assert.match(team, /className="button button-primary"\s+disabled=\{hasUnconfirmedInvite \|\| refreshState !== "idle"\}/u);
});

test("reopened 2026-11-20 (디자인 시스템 적용): count tabs that also narrow the list, shared avatar, role and state pills", () => {
  // The status line became CountTabs: all / the three roles / waiting invitations
  // (owner only) / stopped accounts. They count the loaded accounts and narrow
  // the people list locally (no API). The default tab is 전체, so every row,
  // id and drawer entry the audits use is present on first paint.
  assert.match(team, /<CountTabs\s+className=\{teamStyles\.peopleTabs\}\s+ariaLabel="구성원 보기"/u);
  assert.doesNotMatch(css, /\.teamStats|\.statTotal|\.statWait|\.statOff|\.roleBar|\.teamSummary|\.sumFlag/u, "the status cards and the summary line are gone");
  assert.match(team, /state\.accounts\.filter\(\(account\) => account\.role === role\)\.length/u);
  assert.match(team, /\.\.\.\(state\.isOwner \? \[\{ key: "invites", label: "대기 중인 초대"/u, "the invitation count is owner-only like the queue");
  assert.match(team, /tone: state\.invitations\.length > 0 \? "wait" as const : "default" as const/u, "waiting invitations are the only amber count");
  assert.match(team, /const \[peopleFilter, setPeopleFilter\] = useState<PeopleFilter>\("all"\)/u);
  assert.match(team, /<ConsoleAvatar name=\{account\.name\} size="lg"/u, "the shared avatar, not a hand-rolled one");
  assert.match(team, /<ConsoleAvatar name=\{invitation\.name\} size="lg" tone="wait" \/>/u);
  assert.match(team, /const ROLE_PILL_TONE: Record<string, StatusPillTone> = \{ AGENCY: "ink", MANAGER: "info", STAFF: "ok" \}/u);
  assert.match(team, /<StatusPill tone="wait" size="sm" dot>대기 중<\/StatusPill>/u);
  assert.match(team, /<StatusPill tone="neutral" size="sm" dot>사용 중지<\/StatusPill>/u);
  assert.doesNotMatch(css, /\.rolePill|\.avatar\b|\.inviteDot|\.offDot/u, "role, avatar and state shapes live in console-ui now");
  assert.doesNotMatch(css, /\.(?:personRow|permRow)\s*\{[^}]*(?:box-shadow|border-radius)/su, "a row is still not a card");
});

test("member drawer is docked, owner-only, and keeps the role and account write contracts", () => {
  assert.match(team, /title=\{memberRow\.name\}\s+presentation="inspector"/u, "docked beside the list so the shell recovery notice stays reachable");
  assert.match(team, /memberRow && state\.canManageTeam/u, "no drawer for members without team permission");
  assert.match(team, /<div className=\{teamStyles\.dockSlot\} hidden=\{activeTab !== "team-members"\}>/u, "the docked drawer hides with its tab instead of unmounting");
  assert.match(css, /\.memberLayout\[data-open\]\s*\{[^}]*grid-template-columns/su, "list and docked drawer sit side by side on wide screens");
  assert.match(css, /\.dockSlot \[role="dialog"\]\s*\{[^}]*overflow:\s*visible/su, "the drawer flows with the page and never scrolls on its own");
  assert.match(team, /canClose=\{\(\) => \{ requestCloseMember\(\); return false; \}\}/u, "every dismissal goes through the role panel");
  assert.match(team, /roleEditorRef\.current\.requestSwitch\(null\)/u);
  assert.match(team, /roleEditorRef\.current\.requestSwitch\(nextId\)/u, "choosing another row asks like closing does");
  assert.match(team, /<OrgRoleEditorPanel\s+key=\{memberRow\.id\}/u, "a new member never inherits another member's draft");
  // An in-flight request blocks leaving; an unknown one asks first.
  assert.match(team, /memberActionRef\.current === "busy"\) return false/u);
  assert.match(team, /memberActionRef\.current !== "uncertain" \|\| window\.confirm\(UNCONFIRMED_WRITE_CLOSE_MESSAGE\)/u);
  assert.equal((team.match(/useReportUnsettled\(/g) ?? []).length, 4, "hook definition + disable, reactivate and revoke");
  // Reset opens its own dialog after the drawer has really closed.
  assert.match(team, /requestCloseMember\(\(\) => \{ setNotice\(null\); setResetTarget\(memberRow\); \}\)/u);
  // Role words say what the role can do.
  for (const note of ["모든 행사·팀·설정을 관리합니다.", "행사를 운영합니다. 행사마다 쓰기 권한을 정합니다.", "현장에서 스캔·경품 지급만 합니다. 행사 배정이 필요합니다."]) assert.ok(team.includes(note), note);
  // Frozen request replay is untouched.
  for (const token of ["const attempt: FrozenMembershipAttempt = isRetry", "ORGANIZATION_CONTEXT_CHANGED", "expectedContextVersion"]) assert.ok(team.includes(token), `${token} stays`);
});

test("event permissions read as a three-bar gauge with four named levels", () => {
  assert.match(team, /all: \{ name: "전체", note: \(\) => "이 행사의 모든 것을 바꿀 수 있어요", bars: 3 \}/u);
  assert.match(team, /nosettings: \{ name: "설정 제외", note: \(\) => "행사 설정만 못 바꿔요", bars: 2 \}/u);
  assert.match(team, /custom: \{ name: "직접 설정", note: \(count\) => `\$\{count\}개 범위만 바꿀 수 있어요`, bars: 1 \}/u);
  assert.match(team, /readonly: \{ name: "읽기 전용", note: \(\) => "볼 수만 있어요", bars: 0 \}/u);
  assert.match(team, /const NO_SETTINGS_SCOPES = WRITE_SCOPE_IDS\.filter\(\(scope\) => scope !== "settings"\)/u);
  assert.match(css, /\.gaugeBars i\[data-on\]\s*\{\s*background:\s*var\(--ink\)/su);
  // The stored value is still the server's scope list.
  assert.match(team, /setDraft\(level === "all" \? \["all"\] : level === "nosettings" \? \[\.\.\.NO_SETTINGS_SCOPES\] : \[\]\)/u);
  assert.match(team, /draft\.includes\("all"\) \? \["all"\] : \[\.\.\.new Set\(draft\)\]/u);
  assert.match(team, /\/api\/events\/\$\{encodeURIComponent\(chosen\.id\)\}\/members/u);
  // Drawer: levels first, the eight scopes only on request, one orange save.
  assert.match(team, /title=\{`\$\{editingAccount\.name\} · 쓰기 권한`\}\s+presentation="drawer"/u);
  assert.match(team, /직접 선택/u);
  assert.match(team, /\{customOpen \? \(\s*<div role="group"/u, "the eight scopes stay folded until asked for");
  assert.match(team, /<em>추천<\/em>/u);
  assert.match(team, /canClose=\{cancelEdit\}/u, "dirty scope edits and unsettled saves gate dismissal");
  assert.match(team, /\{busy \? "저장 중입니다" : retryable \? "같은 요청으로 다시 시도" : "권한 저장"\}/u);
  // Unsettled saves keep the drawer and freeze everything else.
  assert.match(team, /const frozen = busy \|\| retryable;/u);
});
