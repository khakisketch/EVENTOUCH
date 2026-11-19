"use strict";

// Clients (고객사), approved 2026-11-16 (design-review clients-options.html,
// option A). Reopened 2026-11-19: a three-card file-status strip tops the list,
// avatars are tinted tiles and file state is a pill (dot plus word). Reopened
// 2026-11-20 (디자인 시스템 적용): ConsoleAvatar, StatusPill, CountTabs and
// ConsoleEmptyState replace the hand-made parts. The list
// stays flat and rows still hold no controls. Source-only; rendering rides the
// real browser check.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console", "clients");
const list = fs.readFileSync(path.join(DIR, "ClientsList.tsx"), "utf8");
const css = fs.readFileSync(path.join(DIR, "clients.module.css"), "utf8");

test("approved clients design stays locked", () => {
  // A flat list: hairline rows, no card, no buttons inside a row.
  assert.match(css, /\.clientRow\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)/su, "hairline rows");
  assert.doesNotMatch(css, /\.clientRow\s*\{[^}]*(?:box-shadow|border-radius|background:\s*var\(--paper\))/su, "a row is not a card");
  const row = list.slice(list.indexOf("<li className={styles.clientRow}"), list.indexOf("</ul>"));
  assert.doesNotMatch(row, /<ProductButton|<details|<label/u, "a row holds no secondary controls");
  assert.match(row, /<h3 className=\{styles\.clientName\}>/u, "the name keeps its heading level");
  assert.match(css, /\.clientOpen::after\s*\{[^}]*inset:\s*0/su, "the whole row opens the drawer");

  // Row order: logo or initial, name, contact, file state, arrow. Reopened 2026-11-20:
  // the initial is the shared ConsoleAvatar and the logo keeps a local white tile.
  const order = ["styles.clientLogo", "styles.clientName", "styles.clientContact", "styles.clientFiles", "styles.clientArrow"].map((t) => row.indexOf(t));
  assert.ok(order.every((p) => p >= 0) && order.every((p, i) => i === 0 || order[i - 1] < p));
  assert.match(row, /<ConsoleAvatar name=\{client\.name\} size="lg" \/>/u, "no hand-rolled initial avatar");

  // File state is a StatusPill (dot plus the word); color is never the only signal.
  assert.match(row, /<StatusPill tone=\{client\.logoFileId \? "ok" : "neutral"\} size="sm" dot>/u);
  assert.match(row, /<StatusPill tone=\{client\.docFileId \? "ok" : "neutral"\} size="sm" dot>/u);
  assert.match(row, /className="sr-only"> \{client\.logoFileId \? "등록됨" : "없음"\}/u);
  assert.doesNotMatch(css, /\.clientAvatar|\.clientFiles > span/u, "avatar and pill shapes live in console-ui now");

  // One orange action on the page; the count stays, the section title is assistive-only.
  assert.equal([...list.matchAll(/button-primary/gu)].length, 2, "고객사 등록 and the drawer save, nothing else");
  assert.match(css, /\.listSection \[data-console-section-head\]\s*\{[^}]*clip:/su);
  assert.doesNotMatch(list, /검색 지우기/u, "the search input clears itself");
});

test("reopened 2026-11-20 (디자인 시스템 적용): count tabs with the quiet count, shared empty states, from real data only", () => {
  // The three cards became count tabs that also filter the loaded list locally
  // (전체 / 로고 등록 / 사업자등록증 등록); the result count rides the tabs' aside.
  assert.match(list, /<CountTabs\s+className=\{styles\.fileTabs\}\s+ariaLabel="고객사 자료 보기"/u);
  assert.doesNotMatch(css, /\.stat\b|\.stats\b|\.statBar/u, 'the stat cards are gone');
  assert.match(list, /state\.clients\.filter\(\(client\) => client\.logoFileId\)\.length/u);
  assert.match(list, /state\.clients\.filter\(\(client\) => client\.docFileId\)\.length/u);
  assert.match(list, /aside=\{\s*<span className=\{styles\.count\} role="status" data-quiet=/u);
  assert.doesNotMatch(list, /participant-count|consoleUiStyles\.empty/u, "no global count class and no hand-rolled empty box");
  assert.equal([...list.matchAll(/<ConsoleEmptyState/gu)].length, 2, "none registered, and nothing matches the filter");
  assert.match(list, /kind="filtered"[\s\S]{0,500}variant="ghost"[\s\S]{0,200}필터 초기화/u, "a filtered-out list offers the reset");
  assert.match(list, /<StatusPill tone=\{fileId \? "ok" : "neutral"\} size="sm">/u, "the drawer file rows show the same state pill");
});

test("info and files are managed in one drawer with the write gates intact", () => {
  assert.match(list, /presentation="drawer"/u);
  assert.match(list, /title=\{draft\.id \? "고객사 정보 수정" : "고객사 등록"\}/u);
  // Files wait for a saved form: unsaved fields would go with the drawer that
  // closes to show the recovery panel.
  assert.match(list, /const filesLocked = writeLocked \|\| draftDiffers \|\| clientUncertain \|\| saving \|\| checkingClient \|\| uploading !== null;/u);
  assert.match(list, /저장하지 않은 변경이 있습니다\. 저장한 뒤 파일을 바꿀 수 있습니다\./u);
  const start = list.slice(list.indexOf("function startUpload("), list.indexOf("function fileRow("));
  assert.match(start, /void uploadAttachment\(client, kind, file\);[\s\S]*setDraft\(null\);/u, "upload recovery is visible on the page, not behind the scrim");
  // Removal stays behind the in-place confirm that names the client.
  assert.match(list, /removeSummary\(draftClient, removePending\.kind\)/u);
  assert.match(list, /confirmLabel="제거한다"/u);
  // Members without write permission see the same rows and a read-only drawer.
  assert.match(list, /else setViewing\(client\)/u);
  assert.match(list, /viewing && !state\.canManage/u);
  // Write commands and receipts are untouched.
  for (const token of ["commandId: attempt.commandId", "uploadCommandId", "linkCommandId", "서버 처리 확인", "같은 파일 요청 다시 확인", "파일 확인 그만두기"]) {
    assert.ok(list.includes(token), `${token} stays`);
  }
});
