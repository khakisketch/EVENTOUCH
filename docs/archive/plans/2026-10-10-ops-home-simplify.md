# Ops home simplify (screen responsibilities + dedup)

Updated: 2026-10-10
Branch: `feat/eventouch-postgres`
Base revision: `84a2ddf05b635793d002a035a79f5e2d9c52e50f`
Status: active — design implementation run `3d4c7f92` commissioned (request `b8c9d0e1`).

## User-approved scope

Simplify the event operations home (`E.views.overview` in `assets/js/experience.js`, overview styles in `assets/css/console.css`) by splitting responsibilities across screens instead of adding UI: home answers action → pending work → status → menu, in that order. List selects events, ops home starts work, participants/booth/records screens do deep work. Autonomous routine visual decisions permitted; no new brand identity. The user's text sketch is STRUCTURE reference (layout/wording adapt freely); light EVENTOUCH theme stays.

Target route: `#/console/events/map-event/overview` (fixture `부스 지도 검증 행사`, LIVE).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

Base source hashes: `experience.js` `e3c8d4096b9a7d4379bd759f7d3b9fae73796404433218eb7521e62f9dc62f5e`, `console.css` `c2746c521c25d13d8d364e9b0ce5b46b2fc164490d2543b16e4f408a3eee89f4`, `ui.js` `1274e4de9cb359994505da36111470cabe89e0f8596700993267e8ba7db9cf86`.

## Invariants and exclusions

- Preserve every route destination, permission gate, metric computation (`E.metrics` definitions unchanged), prep/live/ended variants, persisted `event.stage` semantics, and business rules. No backend/data/auth changes, no event mutation during verification, no installs, deployment, push, or merge. Synthetic states in-memory only.
- **Stage meaning (do not re-litigate, NO logic change):** `LIVE` is the manually-activated operational stage (field work open), unrelated to the calendar date. To prevent misreading an 11/15 event as "happening today", the stage badge MUST carry an explicit `운영 단계` label context in the UI (wording free). `server/commands/preparation.js:29,63-78` + `E.stages` direct mapping (`core.js:10`) stay untouched.
- Global chrome rule (unchanged): topbar/footer shared by all event pages — overview-only behavior via route-conditional render or `body:has(.overview-page)` only. Global `E.date` untouched; overview keeps its local short formatter.
- No fake urgency. Touch targets ≥44px; keyboard order; reduced-motion; long-name/empty/loading states.

## New structure (user decisions, mobile order)

0. Slim route-scoped collapsing sticky header (keep existing mechanism): menu + event name.
1. Identity line: date · time · venue + `운영 단계: 진행 중` labeled badge + 접수 chip + subtle 참가자 페이지 link. No repeated H1 name (topbar owns it).
2. `현장 운영` action block (the page's core): ONE primary checkin row (LIVE + permitted; readiness/results variants otherwise; no second checkin exposure) + pending task rows (existing dynamic tasks: 승인/콘텐츠검토/예약메시지…, tappable whole rows, each count shown ONCE, compact empty state). Action-first: the row's verb (체크인 열기 / 확인) leads, not the number.
3. `운영 현황` compact stats (live state): 등록 / 현재 입장 / 누적 입장 — small, tappable (participants / checkin / checks, permission-gated). The old 처리 대기 tile is REMOVED (it duplicated the task rows). Prep/ended metric sets stay as-is.
4. `관리 메뉴`: 참가자 → participants, 부스 운영 → booths (stamp-gated), 운영 기록 → checks. Compact icon tiles.
5. Recent timeline REMOVED from home (destination lives in 운영 기록, 1 tap away). Aggregation/schedule detail stays in the collapsed help disclosure.

First-screen order: action → pending work → status → menu.

## Design consistency (home vs ops, user table)

| 기준 | 행사 목록 홈 | 행사 운영 |
|---|---|---|
| 핵심 목적 | 행사 찾기·선택 | 현장 업무 실행 |
| 가장 중요한 요소 | 행사명·상태·관리 진입 | 체크인·대기 업무 |
| 정보 표현 | 행사별 요약 카드 | 업무 중심 간결한 영역 |
| 강조색 | 새 행사 만들기 | 주요 실행 버튼 |
| 상세 정보 | 행사 관리로 이동 | 전용 관리 화면으로 이동 |

Shared tokens/typography/badges/icons stay common; only layout density differs per purpose.

## Acceptance criteria

1. 390×844 first screen shows identity, 현장 운영 actions, and status without scrolling past the fold for the core; scroll height reported vs 916px current.
2. No checkin duplication (exactly one checkin href), no 처리대기/count duplication per task, no recent section on home, stage badge labeled 운영 단계.
3. No horizontal overflow at 320/390/768/1024/1280; all controls ≥44px; other pages' chrome unchanged; prep/ended variants intact; console 0 errors; fixture untouched.
4. Required evidence: scoped diff, focused tests, actual-product browser checks, separate design-owned rendered review, full `npm test`. Human acceptance separate.

## Progress

1. Scope, invariants, stage-labeling rule, and new structure recorded. Implementation run `3d4c7f92` landed (experience.js +29/-?, console.css net −15: verb-led 현장 운영 block, 3-stat live strip, labeled 운영 단계, renamed 관리 메뉴, recent removed, collapsed help); host verified the diff touches only the two authorized files with routes/permissions/metrics/stage logic untouched.
2. Rendered review `d4d6ab3f` (read-only, source hashes matched): NO open rendered defect — action→pending→status→menu order, single checkin, 3-metric strip, 3-item menu, no recent section, labeled stage, light theme + restrained orange kept. Its after-320.png hash caveat is a reviewer comparison error: the local file re-hashes to the exact supplied digest (`b2133a1d…`, byte-identical, visually verified by host) — not a product issue.
3. Host verification: overview simplify script 0 failures at 320/390/768/1024/1280 (identity without name duplication, labeled stage, 3 live stats, exactly one primary row + one checkin href, all controls ≥44px, no recent section, 운영 기록→checks, attendee link, exact 3-item menu, collapse-or-zero-scroll, non-overview chrome intact on checkin, keyboard order, prep/ended variants); console 0 errors; fixture restored (LIVE, no overlay). Scroll at 390px: 916 → 844px (single viewport, zero scroll). Two script assertions needed correction during verification (collapse premise obsolete on a zero-scroll page; ended heading unified to 현장 운영) — both re-verified green.
4. Full `npm test`: 326 total, 154 pass, 0 fail, 172 skipped (no isolated PostgreSQL test DB — environmental, same as prior slices). The shared-treatment guard test was updated to the approved vocabulary (`organizer overview uses the approved execution-console treatments`; asserts menu-link/live-stat/primary-row + retained E.badge/E.panel/E.icon) — 19/19 pass in that file.
5. Committed as below; captures stay untracked.
