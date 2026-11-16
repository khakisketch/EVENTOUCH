"use strict";

// Clients (고객사), approved 2026-11-16 (design-review clients-options.html,
// option A). Source-only; rendering rides the real browser check. Change it
// only on a new owner decision.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const DIR = path.join(__dirname, "..", "apps", "web", "app", "console", "clients");
const list = fs.readFileSync(path.join(DIR, "ClientsList.tsx"), "utf8");
const css = fs.readFileSync(path.join(DIR, "clients.module.css"), "utf8");

test("approved clients design stays locked", () => {
  // A flat list: hairline rows, no card, no buttons inside a row.
  assert.match(css, /\.clientList\s*\{[^}]*border-top:\s*1px solid var\(--line\)/su);
  assert.doesNotMatch(css, /\.clientRow\s*\{[^}]*(?:box-shadow|border-radius|background:\s*var\(--paper\))/su, "a row is not a card");
  const row = list.slice(list.indexOf("<li className={styles.clientRow}"), list.indexOf("</ul>"));
  assert.doesNotMatch(row, /<ProductButton|<details|<label/u, "a row holds no secondary controls");
  assert.match(row, /<h3 className=\{styles\.clientName\}>/u, "the name keeps its heading level");
  assert.match(css, /\.clientOpen::after\s*\{[^}]*inset:\s*0/su, "the whole row opens the drawer");

  // Row order: logo or initial, name, contact, file state, arrow.
  const order = ["styles.clientAvatar", "styles.clientName", "styles.clientContact", "styles.clientFiles", "styles.clientArrow"].map((t) => row.indexOf(t));
  assert.ok(order.every((p) => p >= 0) && order.every((p, i) => i === 0 || order[i - 1] < p));

  // File state is a dot plus the word; color is never the only signal.
  assert.match(row, /data-state=\{client\.logoFileId \? "yes" : "no"\}/u);
  assert.match(row, /className="sr-only"> \{client\.logoFileId \? "등록됨" : "없음"\}/u);
  assert.match(css, /\.clientFiles > span\[data-state="no"\]::before\s*\{[^}]*box-shadow:\s*inset/su);

  // One orange action on the page; the count stays, the section title is assistive-only.
  assert.equal([...list.matchAll(/button-primary/gu)].length, 2, "고객사 등록 and the drawer save, nothing else");
  assert.match(css, /\.listSection \[data-console-section-head\]\s*\{[^}]*clip:/su);
  assert.doesNotMatch(list, /검색 지우기/u, "the search input clears itself");
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
