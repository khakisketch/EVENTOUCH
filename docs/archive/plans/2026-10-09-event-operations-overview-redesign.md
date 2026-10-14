# EVENTOUCH event operations overview redesign

Updated: 2026-10-09
Branch: `feat/eventouch-postgres`
Base revision: `5cf509fd0c89dde22d0ab90fa6b3fccb37231c0f`
Status: active — baseline captured; design implementation run `14a34ed5` commissioned (request `7c4e2a1f`).

## User-approved scope

Redesign the event operations detail page (`#/console/events/:eventId/overview`, `E.views.overview` in `assets/js/experience.js`, styles in `assets/css/console.css`) so a field operator can grasp event status and act on pending work from the mobile first screen with far less scrolling. Autonomous routine visual decisions permitted; no new brand direction or subsystem.

Target route: `#/console/events/map-event/overview` (fixture event `부스 지도 검증 행사`, stage LIVE).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

## Invariants and exclusions

- Preserve all existing functionality, routes/destinations (`E.consoleURL`), permission gates (`E.can`, `E.groupForPage`), API/data/auth contracts, persisted `event.stage` semantics (never derive stage from date), and business rules (stage transitions, check-in/booth gating).
- Keep the shared EVENTOUCH tokens/typography in `design-inputs/uiux-audit/shared-system.md`; no competing style system or raw colors.
- Keep sufficient touch targets (≥44px) and readability; do not cram everything into one screen by shrinking.
- No backend/data changes, event mutation/submission during verification, dependency installs, deployment, push, or merge. Synthetic states stay in-memory only.

## Key contracts (for the implementer)

- `E.views.overview` states: `prep` (DRAFT/READY), live (LIVE), `ended` (ENDED/ARCHIVED). Task list, quick links, and primary action (`act`) vary by state — preserve every destination, do not drop gated items, do not duplicate access paths unnecessarily.
- Primary actions: prep → `open-readiness`; LIVE → `checkin`; ENDED → `reports` (all permission-gated via `E.can('settings',true)`).
- Metrics use `E.metrics(w)`: total/checked/inside/pending (+ prep variants). Each metric-box may carry one action link; keep every link target reachable (tapping the metric itself may replace repeated per-metric links).
- Task rows link via `E.consoleURL(p)`; booths link only when `ev.features` includes `stamp`.
- Recent checks show max 5 records with name/time/badge; keep full history reachable elsewhere.
- Helpers: `E.head/E.panel/E.stats/E.detail/E.badge` in `assets/js/ui.js`; stage badge via `overviewStage()`; layout classes `.overview-stack`, `.overview-status-badges`, `.metrics`, `.metric-box`.

## Baseline evidence — 2026-10-09

- 390×844: document scroll height **1882px** (~2.2 viewports). Panels: 행사 정보 252px, 처리할 업무 166px, 빠른 이동 174px, 최근 현장 처리 316px.
- First screen holds only header + event info + top of metric cards; tasks/quick-actions/recent activity all require scrolling.
- Captures: `/tmp/opencode/ops-baseline-390-top.png`, `/tmp/opencode/ops-baseline-390-bottom.png` (promote keepers to `design-inputs/uiux-audit/event-operations/` on rerun).
- Problems confirmed from pixels: repeated event name/status (topbar + page head + info card), verbose date/venue rows, 4 large metric cards each with own link, oversized task/quick-move/recent cards, footer/help occupying operator space.

## Acceptance criteria

1. Mobile 390×844 first screen shows: compact event header (name + stage, no duplication), operations metrics summary, and top pending tasks with actions — without horizontal overflow, all key controls ≥44px.
2. Document scroll height is materially reduced vs 1882px baseline at the same 390×844 viewport with the same fixture data; measure and report before/after.
3. Zero-result/empty task state does not render a large empty card; detail info (date/time/venue) is a short summary with details available on demand; sticky mobile header (if any) never covers content.
4. Quick-move entries are consolidated (no duplicated destinations such as 참가자 페이지 twice); every previously reachable destination remains reachable in ≤ the same number of taps.
5. Tablet/desktop extend the same hierarchy as a balanced dashboard; long event names wrap; empty/loading states stay intentional.
6. Required evidence: source diff limited to overview presentation + renderer composition (no contract changes), focused regression tests, actual-product browser checks at 320/390/768/1024/1280 (first-screen contents, scroll-height delta, tap counts, touch targets, keyboard order), separate design-owned rendered review with concrete fixed/open defects, full `npm test` result. Human product acceptance stays separate.

## Progress

1. Baseline captured and contracts recorded above. Implementation run `14a34ed5` succeeded: edited only `assets/js/experience.js` (overview composition) and `assets/css/console.css` (overview styles); `node --check`, focused presentation tests 19/19, `git diff --check` pass per the run report.
2. Host verification 2026-10-09: `tests/browser/event-operations-overview.js` passes 0 failures at 320/390/768/1024/1280 — topbar keeps the event name, 4 metrics at every width, all controls ≥44px, no horizontal overflow, keyboard reaches overview links, details disclosure expands/collapses, prep (READY) and ended (ENDED) synthetic states keep their tasks, all routes (`/checkin`, `/participants`, `/booths` or `/page`) reachable, fixture restored to LIVE with no overlay.
3. Scroll height at 390×844: **1882px → 1126px (~40% reduction)**. First screen now holds compact heading + 체크인 열기 + 2×2 metrics + 처리할 업무.
4. Next: separate read-only rendered review on the final source/capture snapshot, then full suite + commit.
5. Rendered review `57492dc5` (read-only, all source/capture hashes matched) found two concrete issues: (a) schedule/venue disclosure row had no visible marker; (b) quick-move labels 참가자 페이지 vs 참가자 were hard to tell apart. Refinement run `69ab3cc8` closed both: token-colored rotating chevron on `.overview-details summary::after` (CSS only, 48px target kept) and roster quick-move renamed to 참가자 관리 (matching `clientAccessNames` in `router.js`; route unchanged).
6. Host re-verification after refinement: full overview browser script passes 0 failures at all five widths; chevron verified via stylesheet rule + computed 8px/45°-rotated box + visible ⌄ in `after-details-chevron-390.png`; quick moves read [부스 운영, 참가자 페이지, 참가자 관리] with 참가자 관리 routing to `/participants`; synthetic long event name causes no overflow (390) with topbar pinned; console 0 errors/warnings; fixture restored (single `map-event`, LIVE, no overlay, no synthetic workspaces). Full `npm test`: 326 total, 154 pass, 0 fail, 172 skipped (no isolated PostgreSQL test DB — environmental, same as prior slices).
