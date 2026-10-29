'use strict';

// Intake must not overclaim publicity: DRAFT events answer the public 404
// (server authority in server/public-events.js), so a just-published intake
// that reads "접수 중" with no gate sends a first-time operator to share a
// dead link. Settings keeps additive, state-specific notes next to the
// intake status: a closed DRAFT names both remaining steps (publish + stage),
// an open DRAFT names the stage step, and an open ENDED names the closed
// public route plus the archive precondition. Existing publish/close copy,
// stage flow, and server behavior stay untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS = path.join(__dirname, '..', 'apps', 'web', 'app', 'console', 'events', '[id]', 'settings', 'SettingsWorkspace.tsx');

function source() {
  return fs.readFileSync(SETTINGS, 'utf8');
}

test('intake draft gate: closed DRAFT names publish plus stage', () => {
  const text = source();
  assert.match(text, /currentStage === "DRAFT" && !state\.registrationOpen/);
  assert.match(text, /공개 접수: 닫힘/);
  assert.match(text, /접수를 열려면 양식을 게시하고,/);
  assert.match(text, /href="#settings-stage"/);
});

test('intake draft gate: open DRAFT names the stage step only', () => {
  const text = source();
  assert.match(text, /currentStage === "DRAFT" && state\.registrationOpen/);
  assert.match(text, /공개 접수: 닫힘/);
  assert.match(text, /기획 단계에서는 공개 페이지가 열리지 않아 참가 신청을 받을 수 없습니다/);
  assert.match(text, /하면 게시된 양식대로 접수가 열립니다/);
});

test('intake gate: open ENDED names the closed public route', () => {
  const text = source();
  assert.match(text, /currentStage === "ENDED" && state\.registrationOpen/);
  assert.match(text, /공개 접수: 닫힘/);
  assert.match(text, /종료된 행사에서는 신청을 받을 수 없습니다/);
  assert.match(text, /보관하려면 접수를 닫으세요/);
});

test('intake gate: stored line names itself a setting outside READY/LIVE', () => {
  const text = source();
  assert.match(text, /currentStage === "READY" \|\| currentStage === "LIVE"/);
  // Established READY/LIVE wording stays verbatim for the flows asserting on it.
  assert.match(text, /현재 \{state\.registrationOpen \? "접수 중" : "접수 닫힘"\} · 게시된 양식 버전 \{state\.publishedVersion\}/);
  // DRAFT/ENDED qualify the same numbers as a stored setting, so a flagged
  // intake never reads as public acceptance.
  assert.match(text, /\(설정\) · 게시된 양식 버전 \{state\.publishedVersion\}/);
});

test('intake gate: ENDED publish is honestly disabled, close stays open', () => {
  const text = source();
  assert.match(text, /endedPublishBlocked = currentStage === "ENDED"/);
  assert.match(text, /disabled=\{busy \|\| archived \|\| !canWriteIntake \|\| endedPublishBlocked\}/);
  assert.match(text, /종료된 행사에서는 양식을 게시할 수 없습니다/);
  // form.close keeps its existing gate so the archive precondition
  // (registration shut) stays reachable from ENDED: the publish button is
  // the only intake control carrying endedPublishBlocked.
  assert.match(text, /onClick=\{\(\) => void runCommand\("form\.close"/);
  assert.match(text, /disabled=\{busy \|\| archived \|\| !canWriteIntake\}/);
  assert.match(text, /disabled=\{busy \|\| archived \|\| !canWriteIntake \|\| endedPublishBlocked\}/);
});

test('intake draft gate: publish/close copy and stage authority are untouched', () => {
  const text = source();
  // Established READY/LIVE wording stays verbatim.
  assert.match(text, /양식을 게시하고 접수를 열었습니다/);
  assert.match(text, /접수를 닫았습니다/);
  assert.match(text, /현재 \{state\.registrationOpen \? "접수 중" : "접수 닫힘"\}/);
  // DRAFT names the remaining step instead of claiming a real opening.
  assert.match(text, /양식을 게시했습니다\. 진행 단계에서 운영 준비\(으\)로 전환하면 접수가 열립니다\./);
  // The notes are additive and conditional: they never edit the stage flow.
  assert.match(text, /진행 단계에서 운영 준비\(으\)로 전환/);
});
