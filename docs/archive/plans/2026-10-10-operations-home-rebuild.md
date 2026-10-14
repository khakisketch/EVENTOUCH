# Operations home rebuild (task-execution console)

Updated: 2026-10-10
Branch: `feat/eventouch-postgres`
Base revision: `5f8e1965a44ab4160ce0918f46bbccac3ec662d4`
Status: active — design implementation run `13ab2826` commissioned (request `f6a7b8c9`).

## User-approved scope

Fundamental rebuild of the event operations home (`E.views.overview` in `assets/js/experience.js`, overview styles in `assets/css/console.css`) from a stacked card list into a task-execution console answering three questions on the mobile first screen: (1) current operations status? (2) anything to handle now? (3) fastest path to my work? Autonomous routine visual decisions permitted; no new brand identity. User-supplied mockup is LAYOUT reference only — real light EVENTOUCH theme stays; dark theme must NOT be copied.

Target route: `#/console/events/map-event/overview` (fixture `부스 지도 검증 행사`, LIVE, 5 registered / 1 inside / 1 review pending).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

Base source hashes: `experience.js` `ae7bca6b9aa66df0c87454848ba591947265ecdde4169545ba30c7b74c041567`, `console.css` `cb8af4cb5dfe4898fbf94a78e2b727e1e2516a93d7c8261c40d926e9cd14bf18`, `ui.js` `1274e4de9cb359994505da36111470cabe89e0f8596700993267e8ba7db9cf86`.

## Invariants and exclusions

- Preserve every route destination (`E.consoleURL`: checkin/participants/booths/page/checks/programs/messages/readiness/reports/results/form/notices/desks/audit), every permission gate (`E.can`/`groupForPage`, stamp-gating for booths), metric computation (`E.metrics` in `core.js:23` — total/pending/checked/inside/rate definitions unchanged), prep/live/ended variants, persisted `event.stage` semantics, and business rules.
- **LIVE is manual, not date-derived** (established twice, do not re-litigate): `server/commands/preparation.js:29` STAGES + `:63-78` explicit forward transitions (LIVE requires desks + staff assignment); UI maps `E.stages[ev.stage]` directly (`core.js:10`); no date logic in stage display. The 11/15 + 진행 중 fixture is intentionally activated. NO logic change.
- **Global chrome rule:** topbar/footer in `E.adminShell` (`operator-experience.js:33-34`) are shared by ALL event pages. Overview-only behavior via route-conditional render or `body:has(.overview-page)` selectors only. Other pages keep current chrome.
- Global `E.date` untouched (detail screens rely on it); overview list times use the existing overview-local `overviewTime` short formatter.
- No fake urgency: never render unconfirmed work as emergency alerts. No meaningless charts/decoration without real data. Touch targets ≥44px; keyboard order; reduced-motion; long-name/empty/loading states. No backend/data/auth changes, no event mutation during verification, no installs, deployment, push, or merge. Synthetic states in-memory only.

## New information architecture (Build decision)

Single-scroll console (central After mockup), NOT the tab-bar alternative: tabs would add persistent global chrome across all event pages and duplicate the sidebar — larger scope, higher permission-routing risk. The single scroll answers all three questions with localized changes.

Mobile order (390px target):
0. Slim route-scoped collapsing sticky header (existing mechanism): menu + event name on scroll.
1. Event identity line: date · time · venue one-liner + status chips (stage, 접수) + subtle 참가자 페이지 link. No repeated H1 event name (topbar owns it); keep an accessible compact heading.
2. ONE primary CTA: 체크인 full-width orange when LIVE + permitted; prep→readiness / ended→reports variants; no duplicate checkin exposure anywhere else.
3. Status strip: prominent 현재 입장 (`1/5명` + share) and 처리 대기 (`N건`) — tappable to checkin / first pending-task route (permission-gated); secondary 등록 / 누적 입장 compact, tappable to participants / checks. Real data only.
4. Tasks: tappable whole rows (icon + title + single count + chevron), existing review destinations (programs/participants/messages…); compact one-line empty state.
5. Icon menu (3): 참가자 관리 → participants, 부스 운영 → booths (stamp-gated), 활동 기록 → checks. Attendee page lives ONLY in the header chip, not here.
6. Recent: max 2 compressed rows (`이름 · 상태` + `M/D HH:MM` right, correction marker separate) + 전체 보기 → checks route.
7. Aggregation note + schedule detail collapsed in help disclosure, off the scan path.

Desktop: same hierarchy widened (metrics row, two-column tasks/menu + activity); no separate design language.

## Acceptance criteria

1. 390×844 first screen answers all three questions: status strip + primary CTA + top task visible; measured scroll height reported vs 1241px current.
2. No horizontal overflow at 320/390/768/1024/1280 (360–430 emphasized); all controls ≥44px; thumb-friendly; other pages' chrome unchanged (spot-check checkin + participants).
3. Every destination reachable in ≤ current tap counts (record tap-count table); prep/ended variants intact; console 0 errors; fixture untouched.
4. Required evidence: scoped diff, focused tests, actual-product browser checks, separate design-owned rendered review with fixed/open defects, full `npm test`. Human acceptance separate.

## Baseline (this slice input)

- Captures: `design-inputs/uiux-audit/event-operations/after-{320,390,768,1024,1280}.png`, `after-timeline-390.png`, `after-collapsed-390.png`. 390px scroll height 1241px (from 1882px original).

## Progress

1. Contracts, LIVE evidence, and new IA recorded. Implementation run `13ab2826` landed (experience.js +38, console.css +159/-: identity line, status strip with single checkin-integrated tile, tappable task rows, 3-icon menu, max-2 recent + checks link, collapsed help); host verified the diff touches only the two authorized files with routes/permissions/metrics/stage logic untouched.
2. Rendered review `4c074ba6` (read-only, all hashes matched): NO open rendered defect. First screens answer the three questions; collapsed header stays clear; two-column desktop balanced; checkin integrated in the prominent tile; attendee link in identity without name duplication.
3. Host verification: overview console script 0 failures at 320/390/768/1024/1280 (no name duplication, 4 status values, checkin exactly once, all controls ≥44px, ≤2 recent rows with short times, checks link, attendee link, 3-item quick menu, collapse behavior, non-overview chrome intact on checkin, keyboard order, prep/ended states); console 0 errors; fixture restored (LIVE, no overlay). Scroll at 390px: 1241 → 916px.
4. Full `npm test`: 326 total, 154 pass, 0 fail, 172 skipped (no isolated PostgreSQL test DB — environmental, same as prior slices). One guard test (`organizer overview uses the shared…`) failed because the user-approved rebuild intentionally retires uniform E.head/E.stats/list-item treatments on this page; updated to `organizer overview uses the approved execution-console treatments` asserting the new vocabulary plus retained shared E.badge/E.panel/E.icon — 19/19 pass in that file. Committed as below; captures stay untracked.
