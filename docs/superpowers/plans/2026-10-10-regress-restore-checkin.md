# Regression restore (list card) + checkin task-first pass

Updated: 2026-10-10
Branch: `feat/eventouch-postgres`
Base revision: `1f624be`
Status: implemented and verified; human product acceptance pending.

## User-approved scope

Two scoped fixes, NO new design language, NO rebuilds. Preserve everything that already works.

Target routes: `#/console/agency/events` (list) and `#/console/events/map-event/overview` is OUT OF SCOPE except shared-CSS fallout (must not regress) — plus `#/console/events/map-event/checkin` (checkin).
Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

Base source hashes: `operator-experience.js` `8735e8498c433f36d7eb8d47a74fc3cfc4e4a76c63dc5d420f4fc1841e0030c2`, `field.js` (checkin view) to be read live, `console.css` `f11504f22f575359489eb08df17ce32a523b2994742355fdff90cc9724562a84`.

## Invariants and exclusions

- Preserve every route destination, permission gate, search/filter/count/keyboard/create contracts, metric computation, stage semantics (`LIVE` manual — NO logic change), checkin validation/processing logic (`processScan`, desk commands, correction flow), and business rules. No backend/data/auth changes, no event mutation or creation submission, no installs, deployment, push, or merge. Synthetic states in-memory only.
- Checkin LOGIC is frozen: only composition/order/emphasis/copy-trim of the existing panels, tabs, warning, result, and empty/feedback blocks. Do not touch `E.processScan`, scan commands, validation, or `field.js` action handlers.
- Global chrome rule unchanged (route-scoped changes only). Global `E.date` untouched.
- Touch targets ≥44px — on the checkin screen the scan/confirm controls must be LARGE and unmistakable (field use), even while chrome text gets leaner. Density differs per purpose.
- Distinguish before changing: real usability problem vs information-structure problem vs visual polish vs taste. No component swaps on taste alone.

## Brief 1 — list: selective revert to the card (Build decision)

Restore the `bcd19aa^` agency-events card renderer verbatim (name h2, 일정/운영 상태/등록 labeled rows with date+time spans, stage badge, explicit `행사 관리` primary link-button, thumbnail div ONLY when `E.image` returns markup, existing empty/filter/toolbar code unchanged), then trim ONLY dead whitespace (card gap/padding) while keeping hierarchy, balance, and readability. Do NOT re-compact into rows; do NOT drop the time span; do NOT invent placeholder art. Keep the route-scoped agency-events footer hiding and all current contracts (count announcements, reset focus, keyboard order, create entry).

## Brief 2 — checkin: task-first recomposition (Build decision)

Reorder/demote within the existing `E.views.checkin` blocks only: ticket-check/scan work FIRST (camera CTA prominent with immediate access, ticket-code input + name search as visible fallback paths without deep scrolling), `현장 등록` demoted to a clearly separated secondary action (it is a different task: registering NEW people vs checking IN ticketed people — never let it out-emphasize the scan CTA), desk select compact with current mode+desk unmistakable, redundant descriptions trimmed, decorative gaps removed. Keep tabs, `fieldOperationWarning`, `scanResult` success/fail blocks, empty states, and all feedback copy semantics. Verify wrong-ticket/duplicate/failure feedback paths still render their next-action UI (read-only check, no test writes).

## Brief 3 — ops home: HANDS OFF

`assets/js/experience.js` must NOT be touched. Shared-CSS edits for Briefs 1–2 must not regress the ops home (host re-runs its script).

## Acceptance criteria

1. List: card hierarchy + explicit management entry + time info restored; gray thumb appears only with real image markup; first-screen entry speed measured (time-to-first-management-link).
2. Checkin: scan CTA + fallback paths visible in the 390px first screen; 현장등록 visually secondary and separated; desk/mode unmistakable; feedback blocks intact; measured taps to first scan readiness.
3. No overflow at 320/390/768/1024/1280; ≥44px (large on scan path); other routes intact; prep/ended intact; console 0 errors; fixture untouched.
4. Required evidence: before/after captures side by side, scoped diff, focused tests, actual-product browser checks (both screens + first-scan timing), separate design-owned rendered review, full `npm test`. Human acceptance separate.

## Progress

1. Regression points identified from git history (`bcd19aa^` card) and fresh 390px checkin captures (1513px scroll; scan form at y≈568; 현장등록 primary-shouts at top). Scope and freeze rules recorded. Implementation run `17c0e24d` commissioned.
2. User direction 2026-10-10: avoid over-simplification; ground verification in the saved Mobbin references (`design-inputs/uiux-audit/event-list-redesign/references/`: eventbrite-events-list, posh-event-series, calendly-scheduling-list, user-interviews-project-list, hex-project-table). Host verification will include a pattern comparison (row density, hierarchy, primary-action placement, filter/toolbar compactness) of delivered captures against these references before sign-off; concrete pattern gaps feed refinement.
3. Run `17c0e24d` reported success but implemented in an ISOLATED `/tmp` clone with the patch file left there — unreachable from the host session (`/tmp` is not shared across containers), and it never read the ledger or checkin captures. Nothing landed in the worktree (verified clean). Lesson recorded: briefs must require in-place writes in the folder-backed root plus `git diff` landing proof. Re-commissioned with those constraints.
4. Run `3c8009af` implemented in the exact folder-backed root. Host verified renderer output verbatim against `bcd19aa^`; only the three scoped product files are edited, and `assets/js/experience.js` remains untouched. Focused JS suites pass 13/13; list and checkin browser scripts initially passed; actual images saved under `design-inputs/uiux-audit/{event-list-redesign,event-checkin,event-operations}/`.
5. Actual browser re-runs pass: event list at 320/390/768/1024/1280 (including synthetic long/many/no-image, filters, create focus, empty/permission cases); operations home at 320/390/768/1024/1280; check-in task flow at 320/390/768/1280 with rejected-code feedback and unchanged check count. Current page console inspection: 0 errors, 0 warnings.
6. Measured 390×844 event-list management link is fully visible at y=458–502. Navigation-to-render in the preserved tailnet fixture was 4557ms; DOMContentLoaded 30ms (measurement includes app/auth hydration and is environment-specific).
7. Acceptance gap found in rendered check-in: name-search input is y=813–857 on a 390×844 first screen, so 13px is below the fold. Strengthened `tests/browser/event-checkin-taskflow.js` to require the entire input within the first viewport; it now fails exactly this assertion (previous check was too permissive). Must resolve through design-owned refinement and rerun.
8. Current `npm test`: 326 total, 154 pass, 0 fail, 172 skipped because `EVENTOUCH_TEST_DATABASE_URL` is not configured. Do not create/configure a test DB for this UI-only scope.
9. Independent rendered review `dd98722f` completed with skill `plan-design-review`; it confirmed visual consumption of all requested screenshots, five saved Mobbin references, actual source, contract, and brand brief. It confirmed list card hierarchy/action, list first-screen reach, focus state, zero-results recovery, loaded gray key visual, and ops-home guardrail. It found two check-in defects: camera + ticket submit both primary orange, and name input below fold. Loading/API errors, axe, screen reader, keyboard traversal and physical device remain unverified by rendered audit.
10. Refinement `68aaa5e6` changed only scoped CSS: ticket-submit is neutral/secondary and mobile spacing was reduced. The OD-side renderer was unavailable, so it explicitly did not claim rendered completion. Host browser rerun found the input improved to y=801..845 but still clipped by 1px; strengthened test failed correctly. Current screenshot is `event-checkin/after-390-top.png`.
11. Follow-up refinement `a37aa6d9` adjusted only scoped mobile CSS. Host rerender/taskflow now passes the strict full-input-in-viewport assertion at 390×844; measured bounds: camera y=466..522 (56px), ticket submit y=657..701 (44px, neutral secondary appearance), name input y=773..817 (27px bottom margin), registration y=861..905. 320/390/768/1280 overflow/touch checks pass. Actual 390 capture confirms hierarchy by pixels.
12. Post-refinement verification: event list and ops home browser suites again pass at 320/390/768/1024/1280; list synthetic/keyboard/route/filter cases also pass. Check-in browser taskflow passes at 320/390/768/1280, failure/retry UI appears and check count is unchanged. Focused JS/presentation checks pass 17/17; full npm suite remains 154 pass/0 fail/172 PostgreSQL skips (isolated DB not configured). List/ops browser consoles 0 errors/warnings. Check-in invalid command intentionally exercises failure UI but this static fixture logs one 404 resource response for unavailable /api/events/.../commands; no JS exception is observed, so backend ticket validation itself is not established here.
13. Final independent `plan-design-review` (`39734dad`) consumed fresh actual screen captures, saved Mobbin patterns, source and contracts. It found both prior visual defects resolved and no new material visual defects; it confirmed the 390px input bounds, camera-only orange emphasis, secondary code submit, failure/retry UI and unchanged list/ops captures. It noted check-in focus render was not yet reviewed and backend validation is unverified due the fixture's 404.
14. Host then captured real keyboard traversal at 390px: Tab order hits camera at stop 9, ticket input 11, submit 12, name input 13, new-person 14; each inspected target reported a 3px solid focus outline. Fresh images are `event-checkin/after-focus-camera-390-final.png` and `after-focus-name-390-final.png`. Supplemental independent focus-only review `613f8cc7` found one additional low-level defect: after the empty required-ticket field displays its validation help, the focused name field is y=800..844 and its 3px+offset outline is clipped at the viewport edge. Camera focus and tab order were rated clear.
15. CSS-only follow-up `11afec8c` reduced mobile scan-station padding by 12px. Host rerender: initial name field y=761..805; after empty-ticket validation while name is focused, y=792..836, outline width/offset 3px+3px. Full ring fits to y=842. Attempted another 8px trim in run `61b53c93`, but it made no edit because that run runtime reported the project outside its writable directory. No source change followed. Final independent review `52341426` consumed the latest actual focus screenshot and found no remaining focus defect: ring complete and clearly perceptible, 2px lower margin.
16. Final technical reruns after all successful source edits: `npm test` 326 total / 154 pass / 0 fail / 172 skipped (PostgreSQL isolated test DB env unavailable); focused presentation tests 17/17; JS syntax checks and `git diff --check` pass. Actual list + ops browser scripts pass at 320/390/768/1024/1280; actual check-in taskflow passes at 320/390/768/1280 with first-screen name field, 44px targets, no overflow, rejected-ticket feedback/retry and no successful check-record change. Check-in keyboard traversal at 390 shows visible 3px focus rings on scan/input/submit/name/registration. Independent visual reviews `39734dad` and `52341426` found all scoped visual findings closed; Mobbin references read and compared. Fixture's expected failed command logs a 404 resource response because the commands endpoint is unavailable; backend ticket validation is not verified. No changes to `experience.js`, no commit, push, merge or deployment. Human product acceptance remains separate.
