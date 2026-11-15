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
  assert.match(list, /선택 \{handoffIds\.length\}명/u);
  assert.match(list, /현재 필터 \$\{effectiveSelection\.length\}명 · 이 페이지 \$\{pageSelectedCount\}명/u);
  assert.match(list, /승인·그룹은 현재 필터만, 메시지는 전체 선택/u);
  assert.doesNotMatch(list, /\}명 선택됨 · 전체 \{handoffIds\.length\}명/u, "the ambiguous 전체 label is gone");
  assert.match(list, /hiddenSelectedCount \? ` · 필터 밖 \$\{hiddenSelectedCount\}명`/u, "hidden selection stays visible and its scope is named");
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

test("reward list keeps connection-only gifts in 확인 필요 with their own pill", () => {
  const rewards = read("console/events/[id]/rewards/RewardsWorkspace.tsx");
  assert.match(rewards, /function bucketOf\(reward: Reward\): Bucket/u);
  assert.match(rewards, /reward\.status === "NEEDS_CONNECTION" \? <span className=\{styles\.pill\} data-tone="info">/u);
  assert.match(rewards, /연결 필요/u);
});

test("program draw box points at the quota draw screen and quiz grading names its rule", () => {
  const programs = read("console/events/[id]/programs/ProgramsWorkspace.tsx");
  assert.match(programs, /쿼터·등급·업체 대상 추첨과 경품 연동은\{" "\}\s*<(?:Link|ProductLink) href=\{props\.closeHref\(`\/console\/events\/\$\{encodeURIComponent\(props\.eventId\)\}\/draws`\)\}>추첨<\/(?:Link|ProductLink)> 화면에서 관리합니다/u);
  assert.match(programs, /자동 비교는 앞뒤 공백을 제외한 완전 일치 기준입니다/u);
});

test("attendee home keeps six Korean task labels without exposing category keys", () => {
  const landing = read("event/[slug]/home/AttendeeHomeLanding.tsx");
  for (const label of ["모바일 티켓", "공지사항", "럭키드로우 번호", "룰렛 이벤트", "순위 투표", "부스 인증"]) {
    assert.ok(landing.includes(`label: "${label}"`), label);
  }
  assert.doesNotMatch(landing, />\{menu\.category\}</u);
  assert.match(landing, /\{menu\.label\}/u);
  assert.match(landing, /NEEDS_TICKET/u);
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
  assert.match(ops, /\{ id: initial\.id, name, action, mode, open: initial\.open,\s*expectedDesk: \{ name: initial\.name, action: initial\.action, mode: initial\.mode, open: initial\.open \}/u);
  assert.match(ops, /if \(directionChanged && confirmDirection\) payload\.confirmDirectionChange = true/u);
  assert.match(ops, /disabled=\{busy \|\| blocked \|\| Boolean\(conflict\) \|\| !name\.trim\(\) \|\| !\["IN", "OUT"\]\.includes\(action\) \|\| !\["desk", "tablet"\]\.includes\(mode\) \|\| \(directionChanged && !confirmDirection\)\}/u);
  assert.match(ops, /입장·퇴장 방향을 바꾸면 기존 기록과 섞일 수 있습니다\. 확인했습니다\./u);
});

test("settings offers no payment controls: this product does not process payments", () => {
  const settings = read("console/events/[id]/settings/SettingsWorkspace.tsx");
  // The price field is gone from the screen (the server value stays preserved
  // in saves); with no price input there is no price explanation either.
  assert.doesNotMatch(settings, /id="set-price"/u);
  assert.doesNotMatch(settings, /Number\(basics\.price\) > 0 \?/u);
  assert.doesNotMatch(settings, /참가비 \(원\)/u);
  // The payment toggle is gone from the feature screen (server id stays for
  // API compatibility); the group no longer advertises a payment feature.
  assert.doesNotMatch(settings, /\{ id: "payment", label: "결제" \}/u);
  assert.doesNotMatch(settings, /label: "유료·경품"/u);
  assert.match(settings, /label: "경품", ids: \["reward"\]/u);
});

test("participant home offers self-service booth stamping in the ticket tab", () => {
  const home = read("event/[slug]/home/HomeShell.tsx");
  assert.match(home, /!enabled\.has\("stamp"\) \? \["stamp" as const\]/u);
  assert.match(home, /activeTab === "stamp" && !state\.unavailable\.includes\(activeTab\) && \(\s*<StampTab/su);
  assert.match(home, /state\.unavailable\.includes\(activeTab\)[\s\S]*?현재 이 행사에서 제공하지 않습니다/u);
  assert.match(home, /postGuestCommand\(state\.eventId, "stamp", "booth\.visit", \{ code \}\)/u);
  // A camera app hands over the whole scanned text; the token from ET:BOOTH:
  // on is what the server validates, and the field is unused without a ticket.
  assert.match(home, /const marker = "ET:BOOTH:";/u);
  assert.match(home, /return \(at === -1 \? value : value\.slice\(at\)\)\.trim\(\)/u);
  assert.match(home, /if \(!hasTicket\) return <NeedTicket slug=\{slug\} \/>;/u);
  assert.match(home, /부스 QR을 이 화면에서 찍거나 코드를 복사해 입력하세요\./u);
  // The participant scans in-app with the shared camera component; the decoded
  // string goes through the same submit as a typed code, and the listener
  // stays outside the render-scoped helpers. The scanner (and its decoder)
  // loads lazily only when opened: no static import, ssr off, rendered only
  // while cameraOpen.
  assert.match(home, /import dynamic from "next\/dynamic";/u);
  assert.match(home, /const CameraScan = dynamic\(\(\) => import\("\.\.\/\.\.\/\.\.\/CameraScan"\), \{\s*ssr: false,\s*\}\);/su);
  assert.doesNotMatch(home, /import CameraScan from/u, "the scanner is never in the home bundle");
  assert.match(home, /\{cameraOpen \? \(\s*<CameraScan/u);
  assert.match(home, /onDetected=\{\(scanned\) => \{\s*setCameraOpen\(false\);\s*void submit\(scanned\);\s*\}\}/su);
  assert.match(home, /manualHint="부스 코드를 직접 입력하세요\."/u);
  const scanner = read("CameraScan.tsx");
  assert.doesNotMatch(scanner, /fetch\(/u, 'the camera never decides anything');
  // The decoder is lazy too: jsQR loads only when a scan actually starts,
  // never in the route bundle; the camera stays decode-only either way.
  assert.doesNotMatch(scanner, /from ["']jsqr["']/u, 'no static decoder import');
  assert.doesNotMatch(scanner, /import ["']jsqr["']/u);
  assert.match(scanner, /await import\("jsqr"\)/u);
  assert.match(scanner, /manualHint = "티켓 코드를 직접 입력하세요\."/u);
  const landing = read("event/[slug]/home/AttendeeHomeLanding.tsx");
  assert.match(landing, /export type HomeMenuKey = "qr" \| "application" \| "notice" \| "lucky" \| "roulette" \| "vote" \| "stamp";/u);
  assert.match(landing, /\{ key: "stamp", label: "부스 인증", category: "Engagement" \}/u);
  assert.match(landing, /\{ key: "vote", label: "순위 투표", category: "Engagement" \}/u);
  const staff = read("staff/StaffEventWork.tsx");
  assert.match(staff, /참가자 홈 &gt; 부스 인증에서 카메라로 바로 인증하도록 안내/u);
});

test("the rank vote is named 순위 투표, apart from the poll module", () => {
  const draws = read("console/events/[id]/draws/DrawsWorkspace.tsx");
  assert.match(draws, /key: "vote", type: "vote"[^}]*name: "순위 투표"/u);
  assert.match(draws, /<h2 className=\{styles\.stageTitle\}>순위 투표<\/h2>/u);
  assert.match(draws, /unit: "표"/u);
  assert.doesNotMatch(draws, /모바일 투표/u);
});
