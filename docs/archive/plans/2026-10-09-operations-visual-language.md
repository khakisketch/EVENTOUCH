# Operations overview visual language pass

Updated: 2026-10-09
Branch: `feat/eventouch-postgres`
Base revision: `b84568f`
Status: active — first implementation run `3ecc7c00` reported success but host verification proved nothing landed (no `clock` key, empty `git diff`, stale mtimes); re-commissioned as run `c0b830d5` with explicit land-verification instructions.

## User-approved scope

Establish a professional B2B operations-console visual language on the event operations overview page (`E.views.overview` in `assets/js/experience.js`, overview styles in `assets/css/console.css`) and implement it in the actual UI. This is NOT a spacing/card-rearrangement task: choose interface patterns fitting each information type so an operator grasps the situation and next action at a glance. Autonomous routine visual decisions permitted; no new brand identity.

Target route: `#/console/events/map-event/overview` (fixture `부스 지도 검증 행사`, LIVE).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

## Invariants and exclusions

- Preserve every route destination (`E.consoleURL`), permission gate (`E.can`/`groupForPage`), metric computation (`E.metrics`), persisted `event.stage` semantics (never derive from date), prep/live/ended variants, and business rules.
- Keep EVENTOUCH brand tokens (`design-inputs/uiux-audit/shared-system.md`) and the orange accent; restrained color elsewhere — do not make everything colorful.
- No meaningless charts or decorative visuals without real data. No backend/data/auth changes, no event mutation during verification, no dependency installs, deployment, push, or merge. Synthetic states stay in-memory only.
- Touch targets ≥44px, readability, long-name/empty/loading behavior preserved.

## Icon system (existing, Lucide-style stroke)

`E.icon(key)` renders a 24×24 stroke SVG (`stroke:currentColor`, width 2, round caps/joins); unknown keys fall back to the `file` icon. Available keys in `assets/js/ui.js` (`paths` map): grid, calendar, people, scan, message, settings, check, arrow, back, plus, close, chart, home, ticket, more, file, building, shield, monitor, logout, menu, pin, play, camera.
- Prefer existing keys. If a needed meaning has no key (e.g. clock, pending bell, in/out), the implementer may add a SMALL number of new paths in the exact same stroke style AND must reference them; never rely on the fallback silently.

## Design brief (from the user request)

1. Metrics: meaningful icon + emphasized number per metric; glanceable, no fake charts.
2. Tasks: visually distinct from plain info cards; pending counts and run actions emphasized.
3. Quick moves: compact icon action menu with clear labels instead of repeated text buttons.
4. Recent activity: timeline form with status icon + well-organized time info instead of a text list.
5. Selective containment: cards/sections/dividers/backgrounds chosen per information type, not a card around everything.
6. Typography: size/weight/color/spacing re-tuned so key numbers and actions surface first.
7. Header: shorter, no repeated info, operating content surfaces faster.

## Acceptance criteria

1. At 390×844 the first screen communicates event status and the next action without reading body text; key numbers/actions lead via type, icon, and restrained accent — verified by captures, not adjectives.
2. No horizontal overflow at 320/390/768/1024/1280; every control ≥44px; keyboard order and details disclosure keep working; prep/live/ended variants intact.
3. Every previously reachable destination remains reachable in ≤ the same tap count; no dropped permission-gated item; stage/date semantics untouched.
4. Required evidence: scoped source diff, focused tests, actual-product browser checks (first-screen contents, tap counts, touch targets, long-name/empty states), separate design-owned rendered review with concrete fixed/open defects, full `npm test`. Human product acceptance stays separate.

## Baseline (previous slice output = this slice input)

- Captures: `design-inputs/uiux-audit/event-operations/after-{320,390,768,1024,1280}.png`, `after-details-390.png`, `after-details-chevron-390.png`.
- 390×844 scroll height 1126px; structure: compact heading + 2×2 metrics + tasks + quick moves + recent + disclosure + help.

## Progress

1. Icon inventory confirmed (24 stroke keys + fallback). Implementation run `3ecc7c00` reported success but host verification proved nothing landed (empty diff, stale mtimes) — recorded as a process lesson: never trust run reports without `git diff` evidence. Re-commissioned as `c0b830d5` with land-verification instructions; landed 3 files (+60/-19): icon metrics, task counts/actions, icon quick menu, status timeline, `clock` icon added.
2. Rendered review `6b8eccb1` (read-only, all hashes matched) found one defect: corrected-activity gear icon reads as configuration. Micro-refinement `cc84db4c` replaced it with a pencil `edit` path; host verified the corrected entries render `M17 3a2.8…` and the timeline screenshot shows pencil/check icons on the rail. No open rendered defect remains.
3. Host verification: overview browser script 0 failures at 320/390/768/1024/1280; icons render for all metrics/tasks/quick links; semantic `<ol>` timeline with `datetime`; task count badge; long-name no-overflow; prep/ended states intact; all routes reachable; console 0 errors; fixture restored (LIVE, no overlay). Scroll at 390px: 1882 → 1241px.
4. Full `npm test` + local commit closeout below.
