# Operations console density pass (collapsing header + dedup)

Updated: 2026-10-09
Branch: `feat/eventouch-postgres`
Base revision: `afe05e4`
Status: active — design implementation run `2d38a7d3` commissioned (request `a5b6c7d8`).

## User-approved scope

Consolidate the event operations overview (`E.views.overview` in `assets/js/experience.js`, overview styles in `assets/css/console.css`) from a card list into a dense operations console: remove duplicated chrome, collapse the sticky header on scroll, merge metrics with the pending-task action, convert quick moves to a compact icon grid, compress recent activity to 2–3 rows + full-history link. Autonomous routine visual decisions permitted; no new brand identity. User-supplied dark mockups are LAYOUT reference only — the real light EVENTOUCH theme stays.

Target route: `#/console/events/map-event/overview` (fixture `부스 지도 검증 행사`, LIVE).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

## Invariants and exclusions

- Preserve every route destination, permission gate, metric computation, prep/live/ended variants, persisted `event.stage` semantics, and business rules. No backend/data/auth changes, no event mutation during verification, no dependency installs, deployment, push, or merge. Synthetic states stay in-memory only.
- **Global chrome rule:** the topbar (badge + 참가자 페이지 button) and footer in `E.adminShell` (`assets/js/operator-experience.js:33-34`) are shared by ALL event pages. Any hide/collapse behavior for this slice must be scoped to the overview route only (route-conditional render or `body:has(.overview-page)` selectors). Other pages keep current chrome.
- Global `E.date` (full `ko-KR` datetime with seconds, `assets/js/core.js:5`) must stay untouched — detail screens (`checks` table, staff views) rely on it. Overview list times use a NEW overview-local short formatter (`10/8 17:08` style).
- Touch targets ≥44px; keyboard/focus order; reduced-motion respected for the collapsing header; long-name/empty/loading behavior preserved.

## Established facts (do not re-litigate)

- **LIVE is manual, not date-derived.** `server/commands/preparation.js:29` defines `STAGES`; `:63-78` validate explicit forward transitions in the `event.stage` command (LIVE additionally requires desks + staff assignment). UI renders `E.stages[ev.stage]` directly (`core.js:10`); no date comparison exists in stage display. The 11/15 + 진행 중 fixture is intentionally activated. No code change needed.
- **Full-history destination exists:** `E.views.checks` (`assets/js/field.js:30`, 입퇴장 기록, recent 100) at `E.consoleURL('checks')`. “전체 보기 →” links there.
- **Badge precedent:** the checks table already separates action (입장/퇴장 column) from record validity (정정됨/유효 badge). The overview timeline follows the same split: action word + separate correction marker, not one badge for two meanings.
- **Attendee-page label:** quick-menu attendee destination is labeled 참가자용 페이지 (admin vs attendee clarity). The topbar button on OTHER pages keeps its existing label (out of scope).
- Icon keys available (all used keys must exist in the `paths` map): grid, calendar, people, scan, message, settings, check, arrow, back, plus, close, chart, home, ticket, more, file, building, shield, monitor, logout, menu, pin, play, camera, clock, edit. Max 1–2 new paths in the exact stroke style only if unavoidable.

## Brief (user decisions)

1. Topbar 참가자 페이지 button hidden on overview only (duplicate of quick menu); collapsing sticky header on scroll → one line (menu + event name); badge/actions live in body. Must never cover content.
2. Schedule/venue summary line merged into the header area; disclosure card removed. Aggregation note moved to a one-tap help affordance (out of the scan path but still available); EVENTOUCH footer line hidden on overview only.
3. Metrics + top task merged per the user sketch; each pending count shown ONCE per task; task action is secondary (확인 →), single primary action is 체크인 (emphasized in the quick grid).
4. Quick menu: compact icon grid (체크인 primary + 부스 운영 + 참가자 + 참가자용 페이지, permission/stamp-gated as today, no duplicates).
5. Recent: max 2–3 compressed rows (`이름 · 상태` + `M/D HH:MM` right) + 전체 보기 → checks route. Correction marker separate from action word.
6. Metric icons: scan reads as check-in function — reassign so each metric meaning is distinct.

## Acceptance criteria

1. 390×844 first screen shows event identity, metrics, top pending task, and primary 체크인 path with visibly less chrome than the 1241px current state — measured scroll height reported.
2. No horizontal overflow at 320/390/768/1024/1280; all controls ≥44px; other event pages' topbar/footer unchanged (spot-check checkin + participants).
3. All destinations reachable in ≤ current tap counts; prep/ended variants intact; console 0 errors; fixture untouched.
4. Required evidence: scoped diff, focused tests, actual-product browser checks, separate design-owned rendered review with fixed/open defects, full `npm test`. Human acceptance separate.

## Baseline (this slice input)

- Captures: `design-inputs/uiux-audit/event-operations/after-{320,390,768,1024,1280}.png` + `after-timeline-390.png`. 390px scroll height 1241px.

## Progress

1. Facts, scope, and global-chrome constraints recorded. Implementation run `2d38a7d3` landed (experience.js +42/-? , console.css); host verified the diff is overview-scoped with global `E.date`/stage logic untouched.
2. Rendered review `15d057d6` (read-only, hashes matched) found one supported defect: headings can land under the sticky bar on focus/anchor jumps. Micro-refinement `9d2b4eec` added overview-scoped `scroll-margin-top: calc(64px + var(--s3))`; host keyboard test proves focused controls land below the bar (76px margin; focused link at y=543 vs bar bottom 53). Mid-scroll slide-under is inherent sticky behavior, recorded as such — not a defect.
3. Host verification: overview console script 0 failures at 320/390/768/1024/1280 (collapse behavior, overview-only chrome hiding, non-overview chrome intact on checkin, short timeline times, ≤3 rows + checks link, single 체크인 primary, prep/ended states); console 0 errors; fixture restored (LIVE, no overlay). Full `npm test`: 326 total, 154 pass, 0 fail, 172 skipped (no isolated PostgreSQL test DB — environmental).
4. LIVE-is-manual evidence: `server/commands/preparation.js:29,63-78` + `E.stages` direct mapping (`core.js:10`); no date logic in stage display. Reported to the user; no code change.
