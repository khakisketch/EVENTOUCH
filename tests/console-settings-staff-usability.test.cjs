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

test("settings names the section in view next to the jump nav", () => {
  // The shared jump nav stays; the readout follows the same anchor-observer
  // grammar as field operations, draws, and the attendee page editor.
  assert.match(settings, /<ConsoleSectionNav/u);
  assert.match(settings, /className=\{styles\.navSticky\}/u);
  assert.match(settings, /현재 위치:/u);
  assert.match(settings, /IntersectionObserver/u);
  assert.match(settings, /rootMargin: "-30% 0px -60% 0px"/u);
  assert.match(settings, /getElementById\(id\)/u);
  for (const [id, label] of [
    ["settings-basics", "기본 정보"],
    ["settings-intake", "참가 접수"],
    ["settings-features", "기능"],
    ["settings-stage", "진행 단계"],
    ["settings-page", "참가자 페이지"],
  ]) {
    assert.ok(
      settings.includes(`{ id: "${id}", label: "${label}" }`),
      `${id} stays in the jump nav as "${label}"`
    );
    assert.ok(settings.includes(`"${id}"`), `${id} is observed`);
  }
  assert.match(settingsCss, /\.navSticky \{/u);
  assert.match(settingsCss, /\.navNow \{/u);
});

test("settings keeps its jump nav, save state, and folding", () => {
  assert.match(settings, /label="행사 설정 구역"/u);
  assert.match(settings, /sectionStatusLine\(basicsStatus, "basics"\)/u);
  assert.match(settings, /sectionStatusLine\(intakeStatus, "intake"\)/u);
  assert.match(settings, /sectionStatusLine\(featuresStatus, "features"\)/u);
  assert.match(settings, /data-settings-collapse="stage"/u);
  assert.match(settings, /data-settings-collapse="page"/u);
  assert.match(settings, /data-settings-scope-note/u);
  assert.match(settingsCss, /min-height: 44px/u);
  assert.doesNotMatch(settingsCss, /#[0-9a-fA-F]{3,8}/u);
  assert.doesNotMatch(settingsCss, /rgb\(/u);
});

test("staff success folds the input and hands off to the next participant", () => {
  // The result block keeps its exact next-step grammar: primary "다음
  // 참가자" first, auxiliary nametag after it.
  assert.match(staff, /aria-label="스캔 결과"/u);
  assert.match(
    staff,
    /className="button button-primary" onClick=\{prepareNextParticipant\}>[\s\S]*?다음 참가자/u
  );
  assert.match(staff, /ref=\{nextParticipantRef\}/u);
  // Preparing the next participant clears the just-processed input (no stale
  // value left to resend) and restores the folded dock for the next person.
  const prepare = staff.slice(
    staff.indexOf("function prepareNextParticipant()")
  );
  assert.match(prepare, /setTicket\(""\)/u);
  assert.match(prepare, /setResult\(\{ kind: "idle" \}\)/u);
  // A success folds the scan dock away; failures keep the form so the same
  // ticket can be retried in place.
  assert.match(staff, /scanDockHasContent && result\.kind !== "ok"/u);
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

test("no API surface changes on either screen", () => {
  for (const [name, source] of [
    ["settings", settings],
    ["staff", staff],
  ]) {
    const fetched = [
      ...source.matchAll(/fetch\("([^"]+)"|fetch\(`([^`]+)`/ug),
    ].map((match) =>
      (match[1] ?? match[2]).replace(/\$\{[^}]*\}/g, ":param")
    );
    assert.ok(fetched.length > 0, `${name} has fetch calls to audit`);
    const allowed = new Set([
      "/api/auth/me",
      "/api/bootstrap",
      "/api/events/:param/commands",
    ]);
    for (const url of fetched) {
      assert.ok(allowed.has(url), `${name} unexpected API surface: ${url}`);
    }
    assert.doesNotMatch(source, /localStorage/u);
    assert.doesNotMatch(source, /sessionStorage/u);
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
  assert.doesNotMatch(settings, /window\.confirm/u);
});
