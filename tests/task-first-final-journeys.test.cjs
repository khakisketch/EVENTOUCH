// Task-first final journeys: event-create inline customer, invitation
// role-aware next step, frozen-report archive bridge.
// Source contracts only: views, receipts, gates, copy and links are pinned.
// Copy, commands, permissions and server behavior stay unchanged; the
// browser proof lives in scripts/web-task-first-final-journeys.cjs.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");
const rootRead = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("report-to-settings standalone action keeps the shared 44px button target", () => {
  const flow = read("console/events/[id]/reports/EventCloseFlow.tsx");
  assert.match(flow, /<Link className="button button-secondary" href=\{href\(`\$\{base\}\/settings#settings-stage`\)\}/);
  assert.match(flow, /closeHandoffHref\(target, eventId, report\?\.id\)/, 'the same target now carries the explicit close return');
});

test("committed inline customer remains offered when the event draft is explicitly discarded", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  const home = read("console/ConsoleHome.tsx");
  assert.match(dialog, /onClientRegistered\?\.\(\{ id: clientRecordId, name: payload\.name \}\)/);
  assert.match(home, /onClientRegistered=\{/);
  assert.match(home, /new Map\(current\.clients\)\.set\(client\.id, client\.name\)/);
});

function noNewHex(source, file) {
  const found = source.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(found, [], `${file} must use tokens, found literals: ${found.join(", ")}`);
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// --- 1. Event-create inline customer: one dialog, subview, no nested modal --

test("event dialog keeps a single focus trap with an in-dialog customer subview", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  const mounts = dialog.match(/<ConsoleDialog/g) || [];
  assert.equal(mounts.length, 1, `one dialog shell, found ${mounts.length}`);
  assert.match(dialog, /clientMode.*("select" \| "create"|"create" \| "select")/);
  assert.doesNotMatch(dialog, /aria-modal/);
  assert.match(dialog, /newClientNameRef\.current\?\.focus\(\)/);
  assert.match(dialog, /clientSelectRef\.current\?\.focus\(\)/);
});

test("event dialog posts customers to the existing organization REST path", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  assert.match(dialog, /fetch\("\/api\/clients"/);
  assert.match(dialog, /pendingClientRef/);
  assert.match(dialog, /fingerprint/);
  assert.match(dialog, /같은 요청으로 다시 시도하세요/);
});

test("customer retry keeps its own receipt and never touches the event request", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  const saver = functionBody(dialog, "saveNewClient");
  assert.match(saver, /pendingClientRef/);
  assert.match(saver, /commandId: attempt\.commandId/);
  assert.doesNotMatch(saver, /commandIdRef/);
  assert.doesNotMatch(saver, /generatedSlugRef/);
  assert.doesNotMatch(saver, /setName\(/);
  assert.doesNotMatch(saver, /setSlug\(/);
  assert.doesNotMatch(saver, /setDate\(/);
  assert.doesNotMatch(saver, /setStart\(/);
  assert.doesNotMatch(saver, /setEnd\(/);
  assert.doesNotMatch(saver, /setCapacity\(/);
});

test("customer success selects the new record and returns the draft unchanged", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  assert.match(dialog, /const clientRecordId: string = record\.id;/);
  assert.match(dialog, /setClientId\(clientRecordId\)/);
  assert.match(dialog, /setClientMode\("select"\)/);
  assert.match(dialog, /고객사를 등록하고 선택했습니다/);
  assert.match(dialog, /setExtraClients/);
});

test("event dialog dismissal covers the pending customer write", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  assert.match(dialog, /clientWriteRef\.current/);
  assert.match(dialog, /if \(pendingClientRef\.current\) return window\.confirm\("고객사 등록 결과를 아직 확인하지 못했습니다/);
  assert.match(dialog, /작성 중인 고객사 내용이 사라집니다\. 닫을까요\?/);
});

test("inline customer form reuses directory copy and stays out of duplicate mode", () => {
  const dialog = read("console/CreateEventDialog.tsx");
  assert.match(dialog, /고객사명 \(필수\)/);
  assert.match(dialog, /담당자 이메일/);
  assert.match(dialog, /clientMode === "create" && !effectiveDuplicate/);
  // The AGENCY gate stays server-side ("고객사 관리 권한을 확인하세요" in
  // server/state.js saveClient); the dialog surfaces that message verbatim
  // as a definitive 4xx and keeps the event draft.
  assert.match(dialog, /must not rewrite the customer list|organization-level/);
  const saver = functionBody(dialog, "saveNewClient");
  assert.match(saver, /pendingClientRef\.current = null;/);
});

// --- 2. Invitation accept: role-aware next step on the existing login rail ---

test("invite page surfaces the stored event scope and status", () => {
  const page = read("invite/[token]/page.tsx");
  assert.match(page, /eventId\?: unknown/);
  assert.match(page, /status\?: unknown/);
  assert.match(page, /eventId: typeof invitation\.eventId === "string" \? invitation\.eventId : null/);
});

test("invite accept routes each role through the existing login next redirect", () => {
  const accept = read("invite/[token]/InviteAccept.tsx");
  assert.match(accept, /from "\.\.\/\.\.\/auth-redirect"/);
  assert.match(accept, /loginHref\(loginNextForRole\(invitation\.role, invitation\.eventId\)\)/);
  assert.match(accept, /if \(role === "STAFF"\) return "\/staff"/);
  assert.match(accept, /\/console\/events\/\$\{eventId\}/);
  assert.match(accept, /return "\/console"/);
  assert.doesNotMatch(accept, /href="\/login"/);
});

test("staff invites never fabricate an event assignment", () => {
  const accept = read("invite/[token]/InviteAccept.tsx");
  const routing = functionBody(accept, "loginNextForRole");
  const staffLine = routing.split("\n").find((line) => line.includes('"/staff"'));
  assert.ok(staffLine, "STAFF branch must return the hub path");
  assert.doesNotMatch(staffLine, /eventId/);
  assert.doesNotMatch(staffLine, /\$\{/);
  assert.match(accept, /수락 후 로그인하면 운영자가 배정한 업무 목록으로 이동합니다/);
  assert.match(accept, /아직 배정되지 않았다면 대기 상태/);
});

test("invite copy and roles stay as written", () => {
  const accept = read("invite/[token]/InviteAccept.tsx");
  assert.match(accept, /초대를 수락했습니다/);
  assert.match(accept, /팀 초대 수락/);
  assert.match(accept, /비밀번호가 일치하지 않습니다/);
  assert.match(accept, /수락 후 로그인하면 담당 행사로 이동합니다/);
  assert.match(accept, /수락 후 로그인하면 운영 콘솔로 이동합니다/);
});

// --- 3. Frozen report: live archive checklist beside the next action ------

test("reports carry the live archive prerequisites from bootstrap", () => {
  const workspace = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  assert.match(workspace, /stage: string;/);
  assert.match(workspace, /registrationOpen: boolean;/);
  assert.match(workspace, /openModules: Array<\{ name: string; type: string \}>;/);
  assert.match(workspace, /registrationOpen: workspace\.registrationOpen === true/);
  assert.match(workspace, /text\(module\.status\) === "OPEN"/);
});

test("frozen detail links to the existing settings stage anchor with exact remainders", () => {
  const workspace = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  const flow = read("console/events/[id]/reports/EventCloseFlow.tsx");
  assert.match(flow, /\/settings#settings-stage/);
  assert.match(workspace, /보관 전제 · 조회 시점/);
  assert.match(flow, /새로고침 시 갱신됩니다/);
  assert.match(workspace, /loadedAt \? capturedLabel\(loadedAt\)/);
  assert.match(flow, /참가 접수 열림 — 보관 전에 접수 닫기가 필요합니다/);
  assert.match(flow, /진행 중인 참여 프로그램/);
  assert.match(workspace, /생성 시점 그대로 유지/);
  assert.doesNotMatch(workspace, /"event\.stage"/);
  assert.match(workspace, /eventCloseHref\(eventId, detail\.id\)/, 'detail returns to the single checklist with the chosen report');
});

test("archive checklist stays outside the frozen print article", () => {
  const workspace = read("console/events/[id]/reports/ReportsWorkspace.tsx");
  const articleClose = workspace.indexOf("</article>");
  const checklist = workspace.indexOf("archiveCheck");
  assert.ok(articleClose >= 0 && checklist > articleClose, "checklist must follow the frozen article");
  assert.match(workspace, /cloneNode\(true\)/);
  assert.match(workspace, /articleRef\.current/);
});

// --- 4. Team accepted STAFF -> event assignment connection ----------------

test("team offers an event picker only on active staff rows", () => {
  const team = read("console/team/TeamWorkspace.tsx");
  assert.match(team, /account\.role === "STAFF" && account\.active/);
  assert.match(team, /행사 배정/);
  assert.match(team, /aria-expanded=\{assignOpenId === account\.id\}/);
  assert.match(team, /function StaffAssignmentPanel\(/);
});

test("team assignment hands the person off per event and never writes", () => {
  const team = read("console/team/TeamWorkspace.tsx");
  assert.match(team, /events\.length === 1 && events\[0\] \? events\[0\]\.id : ""/);
  assert.match(team, /배정할 행사를 선택하세요/);
  assert.match(team, /배정할 행사를 선택하면 이동 링크가 나타납니다/);
  // Per-event person handoff: the link carries the staff account id as a
  // query before the staff anchor, and options name the server stage.
  assert.match(team, /buildStaffAssignHandoffHref\(chosen\.id, accountId\)/);
  assert.match(team, /sortTeamEventsForAssign\(events\)/);
  assert.match(team, /teamEventOptionLabel\(item\)/);
  // The query key and anchor live in the shared helper the link calls.
  const handoffHelper = read("console/console-handoff.ts");
  assert.match(handoffHelper, /assignAccount/);
  assert.match(handoffHelper, /#ops-staff/);
  assert.doesNotMatch(team, /staff\.assign/);
  assert.doesNotMatch(team, /\/commands/);
});

test("team assignment link appears only for the chosen event (generic otherwise)", () => {
  const team = read("console/team/TeamWorkspace.tsx");
  const panel = team.slice(team.indexOf("function StaffAssignmentPanel("));
  // The handoff link renders only after an event is chosen; otherwise the
  // panel keeps its generic guidance and close path instead of forcing a
  // destination.
  const chosenAt = panel.indexOf("{chosen ? (");
  assert.ok(chosenAt >= 0, "link renders only after a choice");
  const fallbackAt = panel.indexOf("배정할 행사를 선택하면 이동 링크가 나타납니다");
  assert.ok(fallbackAt > chosenAt, "unchosen state keeps the generic guidance");
  assert.match(panel, /선택하세요<\/option>/);
  assert.match(panel, />\s*닫기\s*</);
});

test("team assignment styles use tokens with full touch targets", () => {
  const css = read("console/team/team.module.css");
  const found = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(found, [], `team.module.css must use tokens, found literals: ${found.join(", ")}`);
  assert.match(css, /\.assignField select\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.assignLink\s*\{[^}]*min-height:\s*44px/s);
});

// --- 5. Response-loss fault routing + journey script coverage ---------------

test("gateway can lose a committed client.save REST response outside the command log", () => {
  const gateway = rootRead("tests/helpers/web-api-gateway.cjs");
  assert.match(gateway, /requestURL\.pathname === '\/api\/clients'/);
  assert.match(gateway, /command: 'client\.save'/);
  assert.match(gateway, /const faultTarget = command \|\| restFault/);
  // REST faults never join the command-path write log other audits count:
  // the /api/clients branch builds its identity without pushing.
  const branchStart = gateway.indexOf("requestURL.pathname === '/api/clients'");
  assert.ok(branchStart >= 0, "missing /api/clients fault branch");
  const branch = gateway.slice(branchStart, gateway.indexOf("}", branchStart) + 1);
  assert.match(branch, /restFault = \{/);
  assert.doesNotMatch(branch, /commands\.push/);
});

test("journey script injects the customer loss and replays the same receipt", () => {
  const script = rootRead("scripts/web-task-first-final-journeys.cjs");
  assert.match(script, /loseFirstResponseFor: 'client\.save'/);
  assert.match(script, /waitForResponseLoss\('client\.save'\)/);
  assert.match(script, /같은 요청 다시 시도/);
  assert.match(script, /exactly one customer record expected/);
});

test("journey script walks team assignment into the offered operations dialog", () => {
  const script = rootRead("scripts/web-task-first-final-journeys.cjs");
  assert.match(script, /team-staff-assignment/);
  assert.match(script, /행사 배정/);
  assert.match(script, /#assign-account/);
  assert.match(script, /assignAccount/);
  assert.match(script, /#ops-staff/);
  assert.match(script, /배정 저장/);
});

test("journey script expects only the anonymous session-probe 401", () => {
  const script = rootRead("scripts/web-task-first-final-journeys.cjs");
  assert.match(script, /anonymousWindow = !cookie/);
  assert.match(script, /anonymousWindow && status === 401 && pathname === '\/api\/auth\/me'/);
  assert.match(script, /signedIn\(\)/);
  assert.doesNotMatch(script, /errors\.length = 0/);
});

test("journey script captures the new surfaces at both widths", () => {
  const script = rootRead("scripts/web-task-first-final-journeys.cjs");
  for (const name of ["final-event-client-subview", "final-report-archive-checklist", "final-team-assign-panel"]) {
    assert.match(script, new RegExp(`shotBoth\\('${name}'\\)`));
  }
});

test("workflow touch-ups use tokens only", () => {
  noNewHex(read("console/events/[id]/reports/reports.module.css"), "reports.module.css");
  const dialog = read("console/CreateEventDialog.tsx");
  assert.doesNotMatch(dialog, /#[0-9a-fA-F]{3,8}\b/, "CreateEventDialog adds no color literals");
  const accept = read("invite/[token]/InviteAccept.tsx");
  assert.doesNotMatch(accept, /#[0-9a-fA-F]{3,8}\b/, "InviteAccept adds no color literals");
});
