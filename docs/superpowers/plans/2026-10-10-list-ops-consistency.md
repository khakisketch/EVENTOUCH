# List + ops consistency and density pass

Updated: 2026-10-10
Branch: `feat/eventouch-postgres`
Base revision: `a434a37add807c91d8b4b71ec4042c3f18cccd0a`
Status: active — design implementation run `25bd3802` commissioned (request `d0e1f2a3`).

## User-approved scope

Joint pass over the event list (`E.views['agency-events']` in `assets/js/operator-experience.js`) and the event operations home (`E.views.overview` in `assets/js/experience.js`), plus shared presentation in `assets/css/console.css`. Goal: one design system, two purposes — list = find-and-select, ops home = start work. Do NOT gratuitously restyle what already works on the ops home; fix the listed density/consistency defects. Autonomous routine visual decisions permitted; no new brand identity. Light EVENTOUCH theme stays.

Routes: `#/console/agency/events` and `#/console/events/map-event/overview` (fixture `부스 지도 검증 행사`, LIVE, 11/15).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

Base source hashes: `experience.js` `10dd374d732bb9ab423089c39ccea3f89a0733d28a6c5d98bc187d2335ab1f24`, `operator-experience.js` `463f374f619a6717fc88c3d7394aee56c073df199cab0351314d48eef213666e`, `console.css` `02c1db87016e218480fca2415d65e7eb5f251b6ebc0478b824059cfbeef26b11`, `ui.js` `1274e4de9cb359994505da36111470cabe89e0f8596700993267e8ba7db9cf86`, `tokens.css` `eded20af70685549308df3022e20bd68b8ca3d7fd59c61a095c8dfba104eef2b`.

## Invariants and exclusions

- Preserve every route destination, permission gate, search/filter semantics + result count + polite announcements, metric computation, prep/live/ended variants, persisted `event.stage` semantics, creation/management flows, and business rules. No backend/data/auth changes, no event mutation or creation submission during verification, no installs, deployment, push, or merge. Synthetic states in-memory only.
- **Stage meaning (do not re-litigate, NO logic change):** `진행 중` is the manually-activated operational stage (`server/commands/preparation.js:29,63-78`; `E.stages` direct mapping in `core.js:10`), unrelated to the calendar date. Keep the existing `운영 상태` (list) / `운영 단계` (ops) labels; fix only genuinely confusing wording, never the computation.
- **Global chrome rule:** topbar/footer/sidebar in `E.adminShell` are shared by ALL pages. Route-scoped changes only (`body:has(...)` selectors or route-conditional render): the repetitive footer may be hidden on agency-events exactly as already done for overview — other routes keep it. Global `E.date` untouched (overview keeps its local short formatter).
- Thumbnails: `E.image` returns `''` when no source (`ui.js:45`); a configured keyvisual that loads is real data — never fake, hide, or replace it. Density rule is about SIZE/placement (cap small, omit only when absent), not about judging image content. The flat-gray fixture image stays as-is.
- No fake urgency. Touch targets ≥44px; keyboard order + visible focus; reduced-motion; long-name/many-event/empty/loading states.

## Brief (Build decisions)

### A. Event list — compact selectable rows
- One event = one tappable row (whole-row link to its overview): name + one-line summary (date · stage badge · N명) + chevron. No table-like dl, no full-width per-card button (the row IS the management entry; keep an accessible name).
- Keyvisual: cap small (≤56px, right-aligned) and render ONLY when `E.image` returns markup; zero reserved space otherwise. Never invent placeholder art.
- Header/toolbar: slim page head (keep `행사` + 새 행사 만들기 primary), tighten search/select heights/gaps with existing tokens; keep count + reset-focus + empty-state contracts.
- Many-event proof: synthetic 30-event in-memory check for scan height, no overflow, keyboard order, filter behavior. Single-event must not look broken either.
- Footer: hide the repetitive service line on agency-events via the same route-scoped mechanism as overview.

### B. Ops home — targeted refinements only (2A–2E), no rebuild
- 2A: smooth the identity→work flow (spacing/rhythm, no new blocks); keep name-dedup + labeled stage.
- 2B: separate checkin primary from task rows in hierarchy (checkin stays THE primary; tasks slimmer); keep single checkin exposure and verb-led single counts.
- 2C: polish the 3-stat cells (reading order, icon meaning, number/label alignment, padding) so they hold at narrow widths.
- 2D: keep the 3-tile menu; verify icon meaning, label clarity, tile height, touch areas, gaps; structure must extend (wrap/documented pattern), not sprawl, when items grow.
- 2E: keep the collapsed help disclosure; strengthen its affordance so users can find it.

### C. Consistency system (tokens first)
Unify across BOTH screens using existing values only — no new magic numbers: mobile header height/nav; h1/h2/body/muted type ramp; card border/radius/padding (and where cards are NOT needed); button heights + single-primary emphasis; icon size/weight/alignment; badge colors/semantics; page gutters + section gaps; background/content separation; loading/empty/error patterns. Layouts stay purpose-specific (select vs execute).

## Acceptance criteria

1. List: 30-event synthetic list scans fast at 390px (row height + total scroll reported); single-event intact; search/filter/count/reset/keyboard/create-entry contracts green.
2. Ops: first-screen order + single checkin + counts-once + labeled stage intact; 2A–2E refinements visible in captures.
3. Both screens read as one product (type, spacing, cards, buttons, icons, badges, gutters); purpose-specific layouts preserved.
4. No overflow at 320/390/768/1024/1280; ≥44px controls; other routes' chrome intact; prep/ended variants intact; console 0 errors; fixture untouched.
5. Required evidence: scoped diff, focused tests, actual-product browser checks on BOTH screens side by side (selection→execution flow), separate design-owned rendered review, full `npm test`. Human acceptance separate.

## Progress

1. Both screens analyzed (code + side-by-side 390px captures: list 863px scroll with table-card + gray thumb + full-width button; ops 844px zero-scroll console). Implementation run `25bd3802` landed (operator-experience.js list rows + console.css shared-token styling, +27/-35 across 2 files); host verified routes/search/permissions/metrics/stage logic untouched.
2. Rendered review `61ce67d8` (read-only, all source + capture hashes matched): NO open rendered defect — compact selectable list rows, action-first ops hierarchy, consistent tokens with purpose-specific layouts.
3. Host verification: list script 0 failures at 320/390/768/1024/1280 (row contract, 8-event + NEW 30-event synthetic variants, filters/count/reset/keyboard/create-dialog/empty/permission states, selection→overview flow); ops script 0 failures (no regression). Two script assertions needed settle waits (render timing, pre-existing raciness) — same settled states, re-verified green. Console 0 errors; fixture restored.
4. Full `npm test` + local commit closeout below.
