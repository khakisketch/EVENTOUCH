// Contracts from the whole-product information review: what each screen puts
// in front of the operator. These pin approved copy and the desk edit path;
// they do not replace the rendered console audit or server behavior tests.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "apps", "web", "app");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("roster selection count names the visible subset and the full selection", () => {
  const list = read("console/events/[id]/participants/ParticipantList.tsx");
  assert.match(list, /현재 화면 \{effectiveSelection\.length\}명 선택 · 전체 선택 \{handoffIds\.length\}명 · 최대 200명/u);
  assert.doesNotMatch(list, /\}명 선택됨 · 전체 \{handoffIds\.length\}명/u, "the ambiguous 전체 label is gone");
  assert.match(list, /hiddenSelectedCount \? ` · 숨김 \$\{hiddenSelectedCount\}명\(그룹 지정 제외\)`/u, "hidden selection stays visible and its scope is named");
});

test("import review names immediate confirmation and the untouched consent record", () => {
  const wizard = read("console/events/[id]/participants/import/ImportWizard.tsx");
  assert.match(
    wizard,
    /가져온 유효 행은 승인 검토 없이 참가 확정으로 등록됩니다\. 동의 기록은 가져오기만으로 생성하지 않습니다\./u
  );
});

test("draw program target text names the check-in requirement", () => {
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.match(draws, /입장\(체크인\)한 승인 참가자 전체 대상/u);
  assert.doesNotMatch(draws, /승인 입장 참가자 전체 대상/u);
});

test("reward list can isolate connection-only gifts", () => {
  const rewards = read("console/events/[id]/rewards/RewardsWorkspace.tsx");
  assert.match(rewards, /rewardStatusFilter === "connection"[\s\S]{0,60}reward\.status !== "NEEDS_CONNECTION"/u);
  assert.match(rewards, /<option value="connection">연결 필요<\/option>/u);
});

test("program draw box points at the quota draw screen and quiz grading names its rule", () => {
  const programs = read("console/events/[id]/programs/ProgramsWorkspace.tsx");
  assert.match(programs, /쿼터·등급·업체 대상 추첨과 경품 연동은\{" "\}\s*<Link href=\{`\/console\/events\/\$\{encodeURIComponent\(props\.eventId\)\}\/draws`\}>추첨<\/Link> 화면에서 관리합니다/u);
  assert.match(programs, /채점은 앞뒤 공백을 제외한 완전 일치 기준입니다/u);
});

test("attendee home badges are Korean labels, never internal English keys", () => {
  const landing = read("event/[slug]/home/AttendeeHomeLanding.tsx");
  assert.match(landing, /const CATEGORY_LABEL: Record<Menu\["category"\], string> = \{\s*Utility: "필수",\s*info: "안내",\s*Engagement: "참여",\s*\}/su);
  assert.match(landing, /\{CATEGORY_LABEL\[menu\.category\]\}/u);
  assert.doesNotMatch(landing, /aria-hidden="true">\{menu\.category\}/u);
});

test("operations names booth load, unpublished map drafts, and can edit a desk", () => {
  const ops = read("console/events/[id]/operations/OperationsWorkspace.tsx");
  assert.match(ops, /인증 \$\{booth\.used\}회 · 잔여 \$\{Math\.max\(0, booth\.capacity - booth\.used\)\} \/ \$\{booth\.capacity\}/u);
  assert.match(ops, /인증 \$\{booth\.used\}회 · 잔여 제한 없음/u);
  assert.match(ops, /function mapMatchesPublished\(boothMap: BoothMapState\): boolean/u);
  assert.match(ops, /boothMap\.draft && !mapMatchesPublished\(boothMap\)/u);
  assert.match(ops, /초안이 아직 게시되지 않았습니다\./u);
  assert.match(ops, /setEditingDesk\(desk\); setDeskOpen\(true\)/u);
  assert.match(ops, /initial=\{editingDesk\}/u);
  assert.match(ops, /initial \? "데스크 편집" : "데스크 추가"/u);
  // Editing keeps the current open state and requires the direction change
  // confirmation the server enforces.
  assert.match(ops, /\{ id: initial\.id, name, action, mode, open: initial\.open \}/u);
  assert.match(ops, /if \(directionChanged && confirmDirection\) payload\.confirmDirectionChange = true/u);
  assert.match(ops, /disabled=\{busy \|\| !name\.trim\(\) \|\| \(directionChanged && !confirmDirection\)\}/u);
  assert.match(ops, /입장·퇴장 방향을 바꾸면 기존 기록과 섞일 수 있습니다\. 확인했습니다\./u);
});

test("settings explains that this product does not process payments", () => {
  const settings = read("console/events/[id]/settings/SettingsWorkspace.tsx");
  assert.match(settings, /Number\(basics\.price\) > 0 \?/u);
  assert.match(settings, /이 시스템은 결제를 처리하지 않습니다\. 참가비는 참가자에게 청구되지 않으며/u);
  // The payment toggle is gone from the feature screen (server id stays for
  // API compatibility); the group no longer advertises a payment feature.
  assert.doesNotMatch(settings, /\{ id: "payment", label: "결제" \}/u);
  assert.doesNotMatch(settings, /label: "유료·경품"/u);
  assert.match(settings, /label: "경품", ids: \["reward"\]/u);
});

test("participant home offers self-service booth stamping in the ticket tab", () => {
  const home = read("event/[slug]/home/HomeShell.tsx");
  assert.match(home, /activeTab === "stamp" && \(/u);
  assert.match(home, /postGuestCommand\(state\.eventId, "stamp", "booth\.visit", \{ code \}\)/u);
  // A camera app hands over the whole scanned text; the token from ET:BOOTH:
  // on is what the server validates, and the field is unused without a ticket.
  assert.match(home, /const marker = "ET:BOOTH:";/u);
  assert.match(home, /return \(at === -1 \? value : value\.slice\(at\)\)\.trim\(\)/u);
  assert.match(home, /if \(!hasTicket\) return <NeedTicket slug=\{slug\} \/>;/u);
  assert.match(home, /부스에 붙은 QR을 이 화면에서 바로 찍거나, 코드를 복사해 아래에 붙여넣으세요\./u);
  // The participant scans in-app with the shared camera component; the decoded
  // string goes through the same submit as a typed code, and the listener
  // stays outside the render-scoped helpers.
  assert.match(home, /import CameraScan from "\.\.\/\.\.\/\.\.\/CameraScan";/u);
  assert.match(home, /onDetected=\{\(scanned\) => \{\s*setCameraOpen\(false\);\s*void submit\(scanned\);\s*\}\}/su);
  assert.match(home, /manualHint="부스 코드를 직접 입력하세요\."/u);
  const scanner = read("CameraScan.tsx");
  assert.doesNotMatch(scanner, /fetch\(/u, 'the camera never decides anything');
  assert.match(scanner, /jsQR\(image\.data, image\.width, image\.height\)/u);
  assert.match(scanner, /manualHint = "티켓 코드를 직접 입력하세요\."/u);
  const landing = read("event/[slug]/home/AttendeeHomeLanding.tsx");
  assert.match(landing, /export type HomeMenuKey = "qr" \| "notice" \| "lucky" \| "roulette" \| "vote" \| "stamp";/u);
  assert.match(landing, /\{ key: "stamp", label: "부스 인증", category: "Engagement" \}/u);
  assert.match(landing, /\{ key: "vote", label: "순위 투표", category: "Engagement" \}/u);
  const staff = read("staff/StaffEventWork.tsx");
  assert.match(staff, /참가자 홈 &gt; 부스 인증에 코드를 붙여넣게 안내하세요/u);
});

test("the rank vote is named 순위 투표, apart from the poll module", () => {
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.match(draws, /\{ id: "draws-vote", label: "순위 투표" \}/u);
  assert.match(draws, /title=\{`순위 투표 · \$\{state\.voteTotal\}표`\}/u);
  assert.doesNotMatch(draws, /모바일 투표/u);
});
