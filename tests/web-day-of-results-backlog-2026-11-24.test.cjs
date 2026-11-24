"use strict";

// Reopened 2026-11-24 (전수 점검 백로그, 담당 R: 당일·결과). No approved composition changes: these are
// flows, copy, states and spacing inside the locked screens. Source contracts only; rendering rides the
// browser audits in scripts/.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const EVENT = path.join(__dirname, "..", "apps", "web", "app", "console", "events", "[id]");
const read = (...parts) => fs.readFileSync(path.join(EVENT, ...parts), "utf8");
const live = read("live", "LivePanes.tsx");
const liveWorkspace = read("live", "LiveWorkspace.tsx");
const liveCss = read("live", "live.module.css");
const rewards = read("rewards", "RewardsWorkspace.tsx");
const reports = read("reports", "ReportsWorkspace.tsx");
const closeFlow = read("reports", "EventCloseFlow.tsx");
const reportsCss = read("reports", "reports.module.css");
const analysis = read("analysis", "PeriodAnalysisWorkspace.tsx");
const photos = read("photos", "EvidencePhotosWorkspace.tsx");
const operations = read("operations", "OperationsWorkspace.tsx");

test("R1/R2 현장 모드 지급은 그 줄에서 먼저 확인하고, 버튼은 줄어들지 않는다", () => {
  assert.match(live, /onClick=\{\(\) => setPendingRewardId\(reward\.id\)\}>지급 처리<\/ProductButton>/u, "the button only opens the confirm");
  assert.match(live, /을\(를\) 지급할까요\? 처리한 뒤에는 취소할 수 없습니다\./u);
  assert.match(live, /confirmLabel="지급 처리하기"/u);
  assert.match(live, /onConfirm=\{\(\) => \{ setPendingRewardId\(null\); onFulfill\(reward\); \}\}/u, "the write happens only after the confirm");
  assert.doesNotMatch(live, /onClick=\{\(\) => onFulfill\(reward\)\}/u);
  assert.match(liveCss, /\.rewardAct\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/su, "long names never squeeze the button to 지..");
  assert.match(liveCss, /\.rewardWho\s*\{[^}]*overflow-wrap:\s*anywhere/su);
});

test("R6 입장 수는 (%)를 등록 옆에, 정원은 뒤에 두고 명단·스태프 화면 링크를 둔다", () => {
  assert.match(liveWorkspace, /등록 \{model\.registered\} \(\{entryPct\}%\)<em>\{model\.capacity \? ` · 정원 \$\{model\.capacity\}` : ""\}<\/em>/u);
  assert.match(liveWorkspace, /\$\{base\}\/participants`\}>명단 보기</u);
  assert.match(liveWorkspace, /href="\/staff"[^>]*>스태프 화면/u);
});

test("R3 보고서: 요약이 비면 작성이, 채워지면 PPTX가 주 행동이고 공유 완료는 보조다", () => {
  assert.match(reports, /const summaryEmpty = Boolean\(detail && !detail\.summary\.trim\(\)\)/u);
  assert.match(reports, /const pptxPrimary = Boolean\(detail && detail\.status === "DRAFT" && !summaryEmpty && !inCloseFlow && publishIntent\?\.id !== detail\.id\)/u);
  assert.match(reports, /variant=\{summaryEmpty \? "primary" : "secondary"\}[\s\S]{0,200}\{summaryEmpty \? "운영 요약 작성" : "내용 편집"\}/u);
  assert.match(reports, /variant=\{pptxPrimary \? "primary" : "ghost"\}[\s\S]{0,200}PPTX로 내보내기/u);
  assert.match(reports, /disabled=\{writeLocked \|\| summaryEmpty \|\| refreshing/u, "공유 완료 is off while the summary is empty");
  assert.match(reports, /운영 요약을 작성하면 공유 완료로 표시할 수 있습니다\./u, "and says why");
  assert.match(reports, /<section data-print-omit>/u, "the empty-summary guidance never reaches paper");
  assert.match(reports, /clone\.querySelectorAll\("\[data-print-omit\]"\)/u);
  assert.doesNotMatch(reports, /운영 요약을 작성해주세요\./u);
});

test("R4 새 보고서는 만들자마자 열리고, 제목 기본값과 색 견본이 있다", () => {
  assert.match(reports, /if \(command === "report\.create"\) \{[\s\S]{0,700}openReport\(data\.report\.id\);/u);
  assert.match(reports, /if \(attempt\.command === "report\.create"\) \{[\s\S]{0,600}openReport\(attempt\.commandId\);/u);
  assert.match(reports, /`\$\{eventName\} 결과 보고서`/u);
  assert.match(reports, /title === defaultTitle &&/u, "an untouched default title does not trip the unsaved-input guard");
  assert.match(reports, /className=\{styles\.colorChip\}/u);
  assert.match(reportsCss, /\.colorChip i\s*\{[^}]*background|\.colorChip i\s*\{/u);
});

test("R5 경품 지급 빈 상태는 맞는 길을 안내하고, 꺼진 기능은 한 번만 말한다", () => {
  assert.match(rewards, /참가자 명단에서 받을 사람을 열고 ‘경품 등록’을 누르세요\./u);
  assert.doesNotMatch(rewards, /참가자 화면에서 참가 확정자에게 경품을 등록하세요/u);
  assert.match(rewards, /\{!state\.featureOn && state\.rewards\.length \? \(/u, "the warning is only for a list that already exists");
  assert.match(rewards, /settings#settings-features`\}>행사 설정에서 켜기/u);
});

test("R1 경품 확인 문구는 반말체가 아니다", () => {
  assert.doesNotMatch(rewards, /처리한다|취소한다/u);
  assert.match(rewards, /"처리하기" : "경품 취소하기"/u);
});

test("R7 기간 분석: 끝난 행사는 행사 전체가 기본이고 범례·집계 기준이 제목 아래로 내려온다", () => {
  assert.match(analysis, /\["ENDED", "ARCHIVED"\]\.includes\(data\.stage\)/u);
  assert.match(analysis, /chosenPreset \?\? \(finished \? "all" : "last7"\)/u);
  assert.match(analysis, /날마다 입장한 사람을 더한 값/u);
  assert.doesNotMatch(analysis, /하루 한 번씩 더한 값/u);
  assert.doesNotMatch(analysis, /InfoIcon/u, "a lone i glyph read as a letter");
  assert.match(analysis, /<ConsoleSection\s+headingId="period-daily-title"\s+title="일별 신청·입장"\s+heading="rule"\s*>\s*\{\/\*[\s\S]{0,300}<div className=\{styles\.cardTools\}>/u);
});

test("R8 마감 안내는 거친 말을 풀어 쓰고, 보고서가 없으면 만들기를 안내한다", () => {
  for (const source of [reports, closeFlow]) {
    assert.doesNotMatch(source, /동결|마감 지도|전제/u);
  }
  assert.match(reports, /closeReport \? "보고서 검토·확정하기"\s*:\s*state\.reports\.length \? "마감 보고서 선택·검토하기" : "마감 보고서 만들기"/u);
  assert.match(closeFlow, /확정\(수정 잠금\)/u);
});

test("R9 PPTX: 행사 이름이 든 파일명, 완료 알림, 비어서 빠진 항목 안내", () => {
  assert.match(reports, /_결과보고서_v\$\{version\}\.\$\{extension\}/u);
  assert.match(reports, /replace\(\/\[\\\\\/:\*\?"<>\|\\u0000-\\u001f\]\/gu, " "\)/u, "file-system characters are dropped");
  assert.match(reports, /PPTX를 내려받았습니다 · \$\{slideCount\}장/u);
  assert.match(reports, /내용이 없어 빠진 항목: /u);
  for (const section of ["programs", "survey", "photos"]) assert.match(reports, new RegExp(`report\\.sections\\.includes\\("${section}"\\) && !`, "u"));
});

test("R10 현장 사진: 사진 선택과 올리기가 다른 말이고, 올리기 바가 고정되며, 내부 용어가 없다", () => {
  assert.match(photos, />사진 선택<\/ProductButton>/u);
  assert.match(photos, /\$\{selectedJobs\.length\}장 올리기/u);
  assert.doesNotMatch(photos, /선택한 사진 올리기|업로드 처리 내역|업로드 요청 ID/u);
  assert.match(photos, /올리는 중 · \$\{Math\.max\(0, runTotal - activeJobs\)\} \/ \$\{runTotal\}장/u, "progress shows done / total");
  assert.match(photos, /\$\{sectionLabel\(historySections\[0\]\)\} 사진/u);
  const css = read("photos", "evidence-photos.module.css");
  assert.match(css, /\.previewActions\s*\{[^}]*position:\s*sticky/su);
  assert.match(css, /\.galleryTime\s*\{[^}]*white-space:\s*nowrap/su, "the time pill stays on one line");
});

test("R11 경품 목록: 탭은 줄바꿈하고 선물 코드는 한 줄 말줄임에 복사가 있다", () => {
  assert.match(rewards, /ariaLabel="상태별 보기"\s+fit="wrap"/u);
  assert.match(rewards, /styles\.codeText/u);
  assert.match(rewards, /경품 코드 복사/u);
  const css = read("rewards", "rewards.module.css");
  assert.match(css, /\.codeText\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/su);
});

test("R12 결과 분석: 누적 입장률 타일에 굵은 검정 테두리가 없고 0명 그룹은 숨는다", () => {
  assert.doesNotMatch(reportsCss, /box-shadow:\s*inset 0 0 0 2px var\(--ink\)/u);
  assert.match(reportsCss, /\.analysisBox \.metricLead \{[^}]*border: 1px solid var\(--line\)/su);
  assert.match(reports, /state\.groups\.filter\(\(group\) => group\.count > 0\)/u);
  assert.match(reports, /groupChart\.filter\(\(segment\) => segment\.count > 0\)/u);
});

test("R13 배치도 이미지는 거절하지 않고 줄여서 올린다", () => {
  assert.match(operations, /import \{ fitImage \} from "..\/..\/..\/..\/..\/lib\/image-fit"/u);
  assert.match(operations, /const fitted = await fitImage\(file\);/u);
  assert.doesNotMatch(operations, /file\.size > 600000/u);
  assert.match(operations, /배치도를 자동으로 줄여 올렸습니다\./u);
});
