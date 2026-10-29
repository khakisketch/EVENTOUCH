// Participant roulette legibility + vote-hierarchy behavior contracts (static).
// No browser/DB/server: asserts the source keeps sector-legend-server mapping,
// position-independent helper copy, exact-own vote marking, and untouched
// spin/result mechanics.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const shell = fs.readFileSync(
  path.join(root, "apps/web/app/event/[slug]/home/HomeShell.tsx"),
  "utf8"
);

test("roulette helper copy is position-independent", () => {
  const oddsAt = shell.indexOf("rouletteOddsNote");
  assert.ok(oddsAt >= 0, "odds note block exists");
  const oddsBlock = shell.slice(oddsAt, oddsAt + 800);
  assert.match(oddsBlock, /섹터 안 번호는 경품 목록 번호와 같습니다\./u);
  assert.doesNotMatch(oddsBlock, /아래 목록|위 목록/u);
  // Screen-reader wheel description must not depend on layout direction either.
  assert.doesNotMatch(shell, /아래 경품 목록|위 경품 목록/u);
});

test("wheel shows legend numbers and counter-rotates them against the rotor", () => {
  // No full-label-on-wheel path remains.
  assert.doesNotMatch(shell, /showLabels|labelsFit/u);
  assert.match(shell, /const label = String\(roulettePrizeTier\(prize, index\)\)/u);
  // Legend still carries the full verbatim prize names.
  assert.match(shell, /roulettePrizeName.*prize\.label/u);
  // Sector anchors carry position only; orientation is the rotor
  // counter-rotation, so a stale per-label rotation cannot tilt text again.
  assert.match(shell, /function rouletteLabelPosition\(.*\): \{ x: number; y: number \}/u);
  assert.doesNotMatch(shell, /rotation: centerAngle \+ 90/u);
  assert.match(shell, /const labelRotation = -rotation;/u);
  assert.match(shell, /rotate\(\$\{labelRotation\} \$\{position\.x\} \$\{position\.y\}\)/u);
});

test("spin, winner mapping, reduced motion and result panel are untouched", () => {
  assert.match(shell, /ROULETTE_SPIN_TURNS \* 360 \+ rouletteRestingRotation\(settlingIndex/u);
  assert.match(shell, /rouletteRestingRotation\(resultIndex, prizes\.length\)/u);
  assert.match(shell, /function roulettePrizeIndex\(prizes: RoulettePrize\[\], result: RouletteResult\)/u);
  assert.match(shell, /prefers-reduced-motion/u);
  assert.match(shell, /onTransitionEnd/u);
  assert.match(shell, /내 당첨 경품/u);
  assert.match(shell, /rouletteResultName.*result\.label/u);
  assert.match(shell, /섹터 크기는 당첨 확률을 나타내지 않습니다\./u);
});

test("published vote rows keep full order/counts and mark only stored picks", () => {
  // Sort and shape unchanged: full list, count desc then order asc.
  assert.match(shell, /b\.count - a\.count \|\| a\.team\.order - b\.team\.order/u);
  // Own markers derive exactly from stored picks intersected with teams.
  assert.match(shell, /ownPicks\.map\(\(pick\) => pick\.teamId\)\.filter\(\(teamId\) => teams\.some/u);
  assert.match(shell, /ownTeamIds\?\.has\(team\.id\) === true/u);
  assert.match(shell, /내 선택<\/span>/u);
});

test("vote guidance on the published background uses adaptive ink, never fixed gray", () => {
  const css = fs.readFileSync(
    path.join(root, "apps/web/app/event/[slug]/home/home.module.css"),
    "utf8"
  );
  // Titles follow the adaptive ink (fallback preserves today's rendering);
  // secondary copy follows the adaptive copy. Unconditional muted (#626B78)
  // reads 3.79:1 on the default #B9DEF0 and collapses on dark styles.
  for (const selector of ["\\.voteSubmittedText", "\\.voteStateTitle", "\\.voteTitle"]) {
    assert.match(
      css,
      new RegExp(`${selector}\\s*\\{[^}]*color:\\s*var\\(--home-background-ink,\\s*var\\(--ink\\)\\)`, "u"),
      `${selector} must use adaptive ink`
    );
  }
  for (const selector of ["\\.voteSubmittedNote", "\\.voteStateNote", "\\.voteCount"]) {
    assert.match(
      css,
      new RegExp(`${selector}\\s*\\{[^}]*color:\\s*var\\(--home-background-copy,\\s*#3f5965\\)`, "u"),
      `${selector} must use adaptive copy`
    );
  }
  // Scope guard: the bright result panel keeps its own card-scoped colors.
  // If the container inherited adaptive (white-on-dark) ink, chips and counts
  // inside the light panel would flip to unreadable white-on-light.
  const submittedBlock = css.match(/\.voteSubmitted\s*\{[^}]*\}/u);
  assert.ok(submittedBlock, ".voteSubmitted block exists");
  assert.doesNotMatch(submittedBlock[0], /home-background-(ink|copy)/u);
});

test("home surface ink guarantees the 4.5 floor into the mid-luminance band", () => {
  // Brand-adjacent dark/light first; pure black/white escalation only when
  // neither clears the floor (with margin). Mid-tones like #75828E fall in
  // the gap where both brand candidates sit below 4.5:1.
  assert.match(shell, /contrast\(dark, homeStyle\.backgroundColor\) >= contrast\(light, homeStyle\.backgroundColor\)/u);
  assert.match(shell, /contrast\(ink, homeStyle\.backgroundColor\) < 4\.55/u);
  assert.match(shell, /"#000000"/u);
  assert.match(shell, /"--home-background-copy": ink/u);
});

test("participant guidance/result copy wraps by eojeol, data and banner untouched", () => {
  const css = fs.readFileSync(
    path.join(root, "apps/web/app/event/[slug]/home/home.module.css"),
    "utf8"
  );
  // No mid-syllable breaking anywhere on the participant surface.
  assert.doesNotMatch(css, /word-break:\s*break-all/u);
  const keepAllBlocks = css.match(/[^{}]*\{[^}]*word-break:\s*keep-all[^}]*\}/g) || [];
  assert.ok(keepAllBlocks.length > 0, "at least one keep-all rule exists");
  const guidanceCovered = keepAllBlocks.some(
    (block) => block.includes(".eticketNote") && block.includes(".rouletteOddsNote")
  );
  assert.ok(guidanceCovered, "broken notes (eticket/odds) share the keep-all rule");
  // Customer published banner and prize/team/result/winner data names must not
  // be pulled into the chrome wrapping rule: no content change, only wrapping.
  for (const block of keepAllBlocks) {
    assert.doesNotMatch(
      block,
      /\.eventTitle|\.heroSubtitle|\.roulettePrizeName|\.rouletteResultName|\.teamName|\.luckyWinnerList|\.personalRewardItem/u
    );
  }
});
