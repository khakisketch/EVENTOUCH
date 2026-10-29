// Settings position readout + staff booth next-step and code copy.
// Source-contract test only (no build/server/npm test).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const settings = read(
  "apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx"
);
const settingsCss = read(
  "apps/web/app/console/events/[id]/settings/settings.module.css"
);
const staff = read("apps/web/app/staff/StaffEventWork.tsx");
const staffCss = read("apps/web/app/staff/staff-event-work.module.css");

test("settings names the selected tab with four real tabs", () => {
  // The shared jump nav is replaced by four accessible tabs; the selected
  // tab and its dirty dot name the state in view, and the same tab grammar
  // is used by field operations, draws, and the attendee page editor for
  // their own navs.
  assert.doesNotMatch(settings, /<ConsoleSectionNav/u);
  assert.match(settings, /role="tablist"/u);
  assert.match(settings, /role="tab"/u);
  assert.match(settings, /role="tabpanel"/u);
  assert.match(settings, /aria-selected/u);
  assert.match(settings, /hidden=\{activeTab !==/u);
  assert.match(settings, /tabDirtyDot/u);
  assert.match(settings, /저장 안 됨/u);
  for (const [id, label] of [
    ["settings-basics", "기본 정보"],
    ["settings-intake", "참가 접수"],
    ["settings-features", "운영 기능"],
    ["settings-stage", "진행 단계"],
  ]) {
    assert.ok(
      settings.includes(label),
      `${id} stays as the "${label}" tab`
    );
    assert.ok(settings.includes(`"${id}"`), `${id} anchor survives for deep links`);
  }
  // The attendee-page supporting block is content, never a fifth tab label.
  assert.doesNotMatch(settings, /label: "참가자 페이지"/u);
  assert.match(settingsCss, /\.tab/u);
  assert.match(settingsCss, /tabDirtyDot|tabPanel/u);
});

test("settings keeps its tabs, save state, and scope note", () => {
  assert.match(settings, /aria-label="행사 설정 탭"|행사 설정 구역/u);
  assert.match(settings, /sectionStatusLine\(basicsStatus, "basics"\)/u);
  assert.match(settings, /sectionStatusLine\(intakeStatus, "intake"\)/u);
  assert.match(settings, /sectionStatusLine\(featuresStatus, "features"\)/u);
  assert.doesNotMatch(settings, /data-settings-collapse/u);
  assert.match(settings, /data-settings-scope-note/u);
  assert.match(settingsCss, /min-height: 44px/u);
  assert.doesNotMatch(settingsCss, /#[0-9a-fA-F]{3,8}/u);
  assert.doesNotMatch(settingsCss, /rgb\(/u);
});

test("staff success folds the input and hands off to the next participant", () => {
  // The result block keeps its exact next-step grammar: primary "다음
  // 참가자" first, auxiliary nametag after it. The step locks while a
  // correction result is unresolved (or the organization changed in another
  // tab), so a tap cannot skip the review or strand retained work.
  assert.match(staff, /aria-label="스캔 결과"/u);
  assert.match(
    staff,
    /<button type="button" ref=\{nextParticipantRef\} className="button button-primary" disabled=\{writeLocked\} onClick=\{prepareNextParticipant\}>\s*다음 참가자/u
  );
  assert.match(staff, /ref=\{nextParticipantRef\}/u);
  assert.match(staff, /const writeLocked = correctionLocked \|\| orgChanged/u);
  // Preparing the next participant clears the just-processed input (no stale
  // value left to resend) and restores the folded input for the next person.
  const prepare = staff.slice(
    staff.indexOf("function prepareNextParticipant()")
  );
  assert.match(prepare, /setTicket\(""\)/u);
  assert.match(prepare, /setResult\(\{ kind: "idle" \}\)/u);
  // A success folds the scan input away; failures keep the form so the same
  // ticket can be retried in place.
  assert.match(staff, /scanInputHasWork && result\.kind !== "ok"/u);
  // Success moves focus to the next step instead of stranding it on the
  // folded input.
  assert.match(staff, /nextParticipantRef = useRef<HTMLButtonElement \| null>/u);
  assert.match(staff, /if \(result\.kind !== "ok"\) return;/u);
  assert.match(staff, /nextParticipantRef\.current/u);
});

test("staff booth codes stay fully readable with a client-side copy path", () => {
  // Read-only full-code line under the booth input: long ET:BOOTH codes
  // truncate inside the single-line field.
  assert.match(staff, /data-ticket-full-code/u);
  assert.match(staff, /입력한 코드 전체/u);
  assert.match(staff, /<code>\{ticket\}<\/code>/u);
  // Copy travels through the clipboard only; the code itself never changes.
  assert.match(staff, /copyTicketCode/u);
  assert.match(staff, /navigator\.clipboard\.writeText\(code\)/u);
  assert.match(staff, /입력한 코드를 복사했습니다\./u);
  assert.match(staff, /\{\s*ticketCopyNotice \? <p role="status"/u);
  // The SELF-mode QR copy path is untouched.
  assert.match(staff, /setBoothCopyNotice\("부스 코드를 복사했습니다\./u);
  assert.match(staff, /<details className=\{prizeStyles\.codeFallback\}>/u);
  // Touch size, keyboard focus, and tokens for the new affordances.
  assert.match(staffCss, /\.ticketFullCode \{/u);
  assert.match(staffCss, /\.ticketFullCode code \{\s*overflow-wrap: anywhere;/u);
  assert.match(staffCss, /\.ticketCopy \{\s*min-height: 44px;/u);
  assert.match(staffCss, /\.ticketCopy:focus-visible,/u);
  assert.doesNotMatch(staffCss, /#[0-9a-fA-F]{3,8}/u);
  assert.doesNotMatch(staffCss, /rgb\(/u);
});

test("existing event command paths remain fixed; approved organization REST paths are explicit", () => {
  const expected = {
    // Settings reads the scoped event bootstrap plus the directory client
    // list through the shared transport; writes keep the command endpoint.
    settings: ["/api/auth/me", "/api/events/:param/bootstrap", "/api/console/directory", "/api/events/:param/commands"],
    // Staff keeps the full bootstrap read (assignment projection) through
    // the shared operator transport; writes keep the command endpoint.
    staff: ["/api/bootstrap", "/api/events/:param/commands"],
  };
  for (const [name, source] of [
    ["settings", settings],
    ["staff", staff],
  ]) {
    const fetched = [
      ...source.matchAll(/(?:consoleFetch|operatorFetch|fetch)\(\s*[`"']([^`"']+)["`']/ug),
    ].map((match) => match[1].replace(/\$\{[^}]*\}/g, ":param"));
    assert.deepEqual([...new Set(fetched)].sort(), [...expected[name]].sort(), `${name} API surface`);
    assert.doesNotMatch(source, /localStorage/u);
    assert.doesNotMatch(source, /sessionStorage/u);
  }
  for (const [file, allowed] of [
    ["apps/web/app/OrganizationSwitcher.tsx", ["/api/auth/me", "/api/auth/organizations", "/api/auth/organizations/select"]],
    ["apps/web/lib/organization-selection.ts", ["/api/auth/organizations/select"]],
  ]) {
    const source = read(file);
    const paths = [...source.matchAll(/operatorFetch\(\s*[`"']([^`"']+)["`']/ug)].map((match) => match[1]);
    assert.deepEqual([...new Set(paths)].sort(), allowed, `${file} uses only approved organization REST paths`);
    assert.doesNotMatch(source, /(?:localStorage|sessionStorage)/u, "no credential or organization state in browser persistence");
  }
  for (const command of [
    "event.update",
    "event.features",
    "event.stage",
    "form.publish",
    "form.close",
  ]) {
    assert.ok(settings.includes(`"${command}"`), `settings keeps ${command}`);
  }
  for (const command of [
    "check.scan",
    "booth.visit",
    "reward.lookup",
    "reward.collect",
    "check.correct",
  ]) {
    assert.ok(staff.includes(`"${command}"`), `staff keeps ${command}`);
  }
  // The staff confirm grammar stays: reward collection still confirms.
  assert.match(staff, /window\.confirm\(`\$\{rewardTarget\.name\}/u);
  // Settings keeps drafts across tab switches (panels stay mounted hidden)
  // and guards page leave through the shared draft guard, not a tab confirm.
  assert.doesNotMatch(settings, /window\.confirm/u);
  assert.match(settings, /hidden=\{activeTab !==/u);
});
