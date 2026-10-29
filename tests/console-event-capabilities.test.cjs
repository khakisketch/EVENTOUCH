// Event write capabilities: the console UI mirrors server/event-permissions.js
// through apps/web/lib/event-capabilities.ts, and every owned event screen
// reads the scoped event bootstrap. Source-contract + runtime parity only
// (no build/server/npm test).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const serverPermissions = require("../server/event-permissions.js");

const clientSource = read("apps/web/lib/event-capabilities.ts");

function clientScopeMap() {
  const map = new Map();
  const entry = /"([^"]+)":\s*"([a-z.]+)"/g;
  let match;
  while ((match = entry.exec(clientSource)) !== null) {
    if (match[1] === "scope" || match[1] === "label" || match[1] === "description") continue;
    map.set(match[1], match[2]);
  }
  return map;
}

test("server scope map stays the single authority with eight grants plus the alias", () => {
  const { EVENT_PERMISSIONS, COMMAND_WRITE_SCOPE } = serverPermissions;
  assert.deepEqual(
    [...EVENT_PERMISSIONS].sort(),
    ["all", "booth", "messages", "onsite", "page", "participants", "programs", "results", "settings"].sort(),
    "eight scopes plus all"
  );
  const scopes = new Set(Object.values(COMMAND_WRITE_SCOPE));
  for (const scope of ["participants", "page", "programs", "onsite", "booth", "messages", "results", "settings"]) {
    assert.ok(scopes.has(scope), `server map covers ${scope}`);
  }
  assert.equal(COMMAND_WRITE_SCOPE["participants.write"], "participants", "compat alias stays participants");
  assert.equal(COMMAND_WRITE_SCOPE["reward.create"], "results", "roster reward.create is results");
  assert.equal(COMMAND_WRITE_SCOPE["program.save"], "programs", "content program.save is programs");
  assert.equal(COMMAND_WRITE_SCOPE["notice.save"], "page", "content notice.save is page");
  assert.equal(COMMAND_WRITE_SCOPE["form.publish"], "participants", "settings form.publish is participants");
  assert.equal(COMMAND_WRITE_SCOPE["event.update"], "settings", "settings event.update is settings");
  assert.equal(COMMAND_WRITE_SCOPE["display.set"], "programs", "operations display.set is programs");
  assert.equal(COMMAND_WRITE_SCOPE["desk.save"], "onsite", "operations desk.save is onsite");
  assert.equal(COMMAND_WRITE_SCOPE["booth.save"], "booth", "operations booth.save is booth");
  assert.equal(COMMAND_WRITE_SCOPE["attendee.page.save"], "page", "page editor is page scope");
  assert.equal(COMMAND_WRITE_SCOPE["evidence.photo.add"], "results", "photos are results");
  assert.equal(COMMAND_WRITE_SCOPE["report.create"], "results", "reports are results");
});

test("server runtime: omitted-shaped full beats explicit empty, unknown denies", () => {
  const { managerWriteAllowed } = serverPermissions;
  assert.equal(managerWriteAllowed(["all"], "reward.create"), true, "all grants everything");
  assert.equal(managerWriteAllowed([], "participant.status"), false, "explicit [] grants nothing");
  assert.equal(managerWriteAllowed(["participants"], "participant.status"), true);
  assert.equal(managerWriteAllowed(["participants"], "reward.create"), false, "cross-scope stays denied");
  assert.equal(managerWriteAllowed(["results"], "reward.create"), true);
  assert.equal(managerWriteAllowed(["bogus"], "reward.create"), false, "unknown grant denies");
  assert.equal(managerWriteAllowed(["participants"], "no.such.command"), false, "unknown command denies");
});

test("client command map is an exact parity copy of the server map", () => {
  const client = clientScopeMap();
  const server = serverPermissions.COMMAND_WRITE_SCOPE;
  assert.equal(client.size, Object.keys(server).length, "same entry count");
  for (const [command, scope] of Object.entries(server)) {
    assert.equal(client.get(command), scope, `client mirrors ${command} -> ${scope}`);
  }
});

test("client grant normalization: only omitted is full, malformed denies", () => {
  assert.match(
    clientSource,
    /if \(found\.write === undefined\) return \["all"\]/,
    "omitted write reads as full access"
  );
  assert.match(
    clientSource,
    /if \(!Array\.isArray\(found\.write\)\) return \[\]/,
    "malformed explicit write denies instead of widening"
  );
  assert.doesNotMatch(
    clientSource,
    /!Array\.isArray\(found\.write\)\) return \["all"\]/,
    "malformed write must never widen to full"
  );
  assert.match(clientSource, /role === "AGENCY"[\s\S]{0,80}return true/, "AGENCY bypasses");
  assert.match(clientSource, /role !== "MANAGER"[\s\S]{0,40}return false/, "non-managers hold no writes");
  assert.match(clientSource, /if \(!scope\) return false/, "unknown commands deny");
});

test("client scope catalog names all eight grants with console wording", () => {
  for (const scope of ["participants", "page", "programs", "onsite", "booth", "messages", "results", "settings"]) {
    assert.match(clientSource, new RegExp(`scope: "${scope}"`), `${scope} is catalogued`);
  }
  assert.match(clientSource, /label: "참가자·명단"/, "roster wording kept");
  assert.match(clientSource, /label: "결과·경품"/, "results wording kept");
});

test("owned event screens read the scoped event bootstrap through consoleFetch", () => {
  const scoped = [
    "apps/web/app/console/events/[id]/participants/ParticipantList.tsx",
    "apps/web/app/console/events/[id]/participants/import/ImportWizard.tsx",
    "apps/web/app/console/events/[id]/content/ContentWorkspace.tsx",
    "apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx",
    "apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx",
    "apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx",
    "apps/web/app/console/events/[id]/draws/DrawsWorkspace.tsx",
    "apps/web/app/console/events/[id]/rewards/RewardsWorkspace.tsx",
    "apps/web/app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx",
    "apps/web/app/console/events/[id]/reports/ReportsWorkspace.tsx",
  ];
  for (const file of scoped) {
    const source = read(file);
    assert.ok(
      source.includes("`/api/events/${encodeURIComponent(eventId)}/bootstrap`"),
      `${file} reads the scoped event bootstrap`
    );
    assert.ok(source.includes("consoleFetch"), `${file} goes through the shared transport`);
    assert.ok(source.includes("canWriteEvent"), `${file} gates writes through the capability helper`);
    assert.doesNotMatch(
      source,
      /consoleFetch\("\/api\/bootstrap"/,
      `${file} keeps no full bootstrap read`
    );
  }
  for (const [file, endpoint] of [
    ["apps/web/app/console/team/TeamWorkspace.tsx", "/api/console/directory"],
    ["apps/web/app/console/team/OperationsPanels.tsx", "/api/bootstrap"],
  ]) {
    const source = read(file);
    assert.ok(source.includes("consoleFetch"), `${file} goes through the shared transport`);
    assert.ok(
      source.includes(`consoleFetch("${endpoint}"`),
      `${file} reads its required directory or organization-wide audit context`
    );
  }
});

test("each owned screen probes the scope its writes need", () => {
  const probes = [
    ["apps/web/app/console/events/[id]/participants/ParticipantList.tsx", ["participant.status", "group.assign", "reward.create"]],
    ["apps/web/app/console/events/[id]/participants/import/ImportWizard.tsx", ["participant.import"]],
    ["apps/web/app/console/events/[id]/content/ContentWorkspace.tsx", ["notice.save", "program.save"]],
    ["apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx", ["event.update", "form.publish"]],
    ["apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx", ["attendee.page.save"]],
    ["apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx", ["desk.save", "booth.save", "display.set"]],
    ["apps/web/app/console/events/[id]/draws/DrawsWorkspace.tsx", ["draw.run", "reward.assign"]],
    ["apps/web/app/console/events/[id]/rewards/RewardsWorkspace.tsx", ["reward.create"]],
    ["apps/web/app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx", ["evidence.photo.add"]],
    ["apps/web/app/console/events/[id]/reports/ReportsWorkspace.tsx", ["report.create"]],
  ];
  for (const [file, commands] of probes) {
    const source = read(file);
    for (const command of commands) {
      assert.ok(source.includes(`"${command}"`), `${file} probes ${command}`);
    }
  }
});

test("team editor is owner-only, idempotent, and names read-only honestly", () => {
  const team = read("apps/web/app/console/team/TeamWorkspace.tsx");
  assert.ok(team.includes("orgPermissions: Array.isArray(account.orgPermissions)"), "team DTO retains normalized organization grants rather than dropping them");
  assert.ok(team.includes("EVENT_WRITE_SCOPES"), "editor lists the server scopes");
  assert.ok(team.includes("getEventWriteGrants"), "editor reads stored grants");
  assert.ok(
    team.includes("`/api/events/${encodeURIComponent(chosen.id)}/members`"),
    "editor posts the membership route"
  );
  assert.match(team, /같은 요청으로 다시 시도/, "ambiguous saves keep the idempotent retry");
  assert.match(team, /읽기 전용/, "explicit empty grant is explained as read-only");
  assert.doesNotMatch(team, /team\.manage/, "team.manage grants no team writes");
  assert.match(team, /비밀번호 재설정.*조직 소유자|조직 소유자가 재설정/, "reset stays owner-only");
});

test("team editor freezes context on unknown results and targets managers only", () => {
  const team = read("apps/web/app/console/team/TeamWorkspace.tsx");
  assert.ok(team.includes("disabled={frozen}"), "event select, checkboxes, edits and cancel freeze");
  assert.match(team, /submitGateRef\.current \|\| frozen/, "sync handlers refuse new keys while frozen");
  assert.match(
    team,
    /eventId: chosen\.id, accountId: account\.id, write/,
    "pending attempt stores its full context for the exact replay"
  );
  assert.match(team, /결과가 확인될 때까지 다른 변경은 잠급니다/, "result-unknown note explains the freeze");
  assert.match(team, /UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE/, "unknown request keeps the stronger guard copy");
  assert.match(team, /managerAccounts/, "STAFF get no meaningless grant UI");
  assert.match(team, /편집 대상이 아닙니다/, "staff exclusion is explained, not silent");
});

test("read-only and cross-scope copy stays visible, staff pins kept", () => {
  const roster = read("apps/web/app/console/events/[id]/participants/ParticipantList.tsx");
  assert.match(roster, /상태 변경 권한이 없습니다\./, "roster staff pin kept");
  assert.match(roster, /경품 등록은 결과 쓰기 권한이 따로 필요합니다/, "roster cross-scope note kept");
  assert.match(roster, /조회 \$\{formatClock\(fetchedAt\)\}/, "roster shows its read time");
  const ops = read("apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx");
  assert.match(ops, /현장 운영을 변경할 운영 권한이 없습니다/, "operations staff pin kept");
  const content = read("apps/web/app/console/events/[id]/content/ContentWorkspace.tsx");
  assert.match(content, /콘텐츠를 관리할 운영 권한이 없습니다\./, "content denial pin kept");
});
