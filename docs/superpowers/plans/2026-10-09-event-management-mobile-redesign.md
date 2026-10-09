# EVENTOUCH event management list redesign

Updated: 2026-10-09
Branch: `feat/eventouch-postgres`
Base revision: `0b1e628213661823e4691709665294af6ba2aa49`
Status: technically complete for the authorized slice — source, responsive browser checks, final rendered review, full available suite, and independent code review are reconciled. Human product acceptance remains separate.

## User-approved scope

Redesign the existing agency event-list screen mobile-first so an operator can understand event status and reach management quickly with less scrolling. Preserve EVENTOUCH's current brand, tokens, routes, roles/permissions, API/data/auth contracts, and operational behavior. Keep ordinary design choices autonomous; no new visual direction or new subsystem.

Target: `#/console/agency/events` (`E.views['agency-events']`) in `assets/js/operator-experience.js`; presentation in `assets/css/console.css`; canonical product entry `index.html`. Product and OpenDesign project are both bound to `/home/ksi/Desktop/SI-Projects/EVENTOUCH/.worktrees/eventouch-postgres`, project `EVENTOUCH PostgreSQL`, entry `index.html`. Actual product URL is temporary and tailnet-only: `http://100.116.163.1:46771/`.

## Invariants and exclusions

- Do not alter event creation, search/filter semantics, management destinations, or authorization checks.
- Do not change API contracts, data model, persisted event values, permission policy, workflow transitions, or stage/date business rules.
- `event.stage` is the explicit operational workflow stage; it is stored separately from the scheduled `event.date`. Present these as distinct concepts; do not infer or write stage from calendar date.
- Keep the shared EVENTOUCH palette/type/spacing/status tokens in `design-inputs/uiux-audit/shared-system.md`; do not introduce a competing style or raw component colors.
- Improve the event-list card/list composition, search/filter density, explanatory copy, image treatment, empty/no-results handling, and mobile/tablet/desktop presentation only.
- Preserve pre-existing untracked `.od-skills/`, `design-inputs/`, and `index.html.artifact.json`; do not overwrite or clean prior captures.
- No installation, container/service restart, production data write, deployment, push, or merge.

## Acceptance criteria

At 320×844 and 390×844, the first screen exposes the page title/create action, usable search and status filter, and the first event's name, scheduled date/time, operational stage, registration count, and management action without horizontal overflow. The main event action remains at least 44×44px; a low-information image cannot dominate the event card or push its primary action out of the first viewport.

At 768/1024/1280px, the same content hierarchy remains legible and balanced; one-event and many-event layouts are both natural. Long event names wrap without covering metadata/actions. No-image and loaded-image states remain intentional and compact.

Search by event/customer and stage filtering preserve current results and routes. The count reflects the visible result set. A no-match state is distinct from having no events in the user's scope and provides a clear way to reset active filters. The true empty list, permission-limited view, create action, keyboard/focus states, and loading/error states must remain understandable; unavailable live states may use clearly labeled synthetic fixtures, never production data changes.

For the observed `2026-11-15` + `LIVE` record, show schedule and operational workflow stage as separate concepts. The stage remains server-authoritative and can still gate operational actions; no date-based status rule is introduced.

Required evidence: test-first regression coverage; actual-product browser checks at 320/390/768/1024/1280, search/filter/no-result behavior, event management navigation and create entry point, focus/touch targets, text/image edge cases, and no horizontal overflow; separate design-owned rendered review/refinement with concrete defect closure; full project test suite and independent code review. Human product acceptance and external delivery remain separate.

## Baseline investigation — 2026-10-09

- Actual product opened at `#/console/agency/events` using the prepared development quick-login; no event data was submitted or changed. Current server fixture shows one event, `부스 지도 검증 행사`, scheduled `2026-11-15 09:00–17:00`, stage `LIVE`, and 5 registered participants.
- At 390px, the event card is 358×362px; its key visual is a successfully loaded 320×200 image rendered 324×121.5 and visibly flat gray. The card's CTA is below that low-information image. At 1280px the card spans 968×601px and the same image is approximately 918px wide.
- Search and state filter each take a full 358px row at 390px; the explanatory page sentence and team/permission note consume additional vertical space. Searching for a nonexistent event displays the misleading true-empty copy “담당 행사가 없습니다 / 조직 구성원에게 행사 접근 권한을 요청하세요.” while the count says zero.
- Frontend source maps the badge directly from `E.stages[x.stage]`; it does not calculate stage from date. `experience.js` and `server/commands/preparation.js` define explicit stage transitions; `LIVE` gates check-in/booth work. The visible date/stage difference is therefore stored operational state, not a date-rendering bug. Preserve that rule and label the concepts distinctly.
- Baseline screenshots: `design-inputs/uiux-audit/event-list-redesign/before-{320,390,1280}.png` and `before-no-results-390.png`.
- Baseline SHA256: `operator-experience.js` `c120804761eb21757a68d25d409267de1c0285767a95f1f535abf3d328b2767b`; `console.css` `6b57aa5836673c58392611b3a238f5095b88357f295ba3da570c00cac1c23fad`; `tokens.css` `eded20af70685549308df3022e20bd68b8ca3d7fd59c61a095c8dfba104eef2b`; `index.html` `2e84243c01fce8a2408bbbf9a6462568b6b7ecbe1ce4752c3c1ba920d53c03b3`.
- Existing product tests and stage-transition tests are under `tests/agency-shell-presentation.test.cjs`, `tests/server-api.test.cjs`, and `tests/server-domain-commands.test.cjs`; no relevant UI code has changed for this task yet.

## Reference research

Mobbin screens were visually inspected; patterns inform hierarchy and density only, not copied brand/copy/assets:

| Reference | Pattern to consider | Image file |
| --- | --- | --- |
| [Eventbrite event list](https://mobbin.com/screens/839e9d79-bec7-4c55-9d58-6641950fc6d4) | Search/filter, create action, concise date/name/attendance/status row and overflow actions | `design-inputs/uiux-audit/event-list-redesign/references/eventbrite-events-list.webp` |
| [Posh event series](https://mobbin.com/screens/3fad44f7-7615-425b-accb-68cd6e60007b) | Repeated events with date, name, stage, counts and compact action affordances | `design-inputs/uiux-audit/event-list-redesign/references/posh-event-series.webp` |
| [Calendly scheduling list](https://mobbin.com/screens/a3e4dd3f-b2d9-401f-9be3-b1e43865b4c1) | Compact search/filter toolbar and skimmable records with direct actions | `design-inputs/uiux-audit/event-list-redesign/references/calendly-scheduling-list.webp` |
| [User Interviews projects](https://mobbin.com/screens/4352aba8-3335-44c3-8da7-9dee62aeecf3) | Status grouping with key counts and prominent next action | `design-inputs/uiux-audit/event-list-redesign/references/user-interviews-project-list.webp` |
| [Hex projects table](https://mobbin.com/screens/301409ca-c27b-4fa6-9b28-d1014d9babe0) | Dense tabular metadata hierarchy for many records | `design-inputs/uiux-audit/event-list-redesign/references/hex-project-table.webp` |

## Read-only rendered audit — 2026-10-09

Audit run `a2463a44-cdc9-4df9-833a-806e977d695c` (`web-design-guidelines`) succeeded. Its final report explicitly says it made no project-file/product-data writes or product mutation/API calls. The reviewer confirms it read `references-and-brief.md`, `operator-experience.js`, `console.css`, `tokens.css`, `shared-system.md`, all four actual screenshots, and all five Mobbin WebPs. It could not open the external Mobbin pages; local reference images were visually inspected and are sufficient for pattern-only research. The source/capture/image input-read receipts are explicit.

Concrete defects to resolve:

| ID / severity | Screen/state | Confirmed defect and operator impact | Desired result |
| --- | --- | --- | --- |
| E1 / high | One event, 320/390/1280 | Flat-gray key visual is loaded, not a loading failure; it occupies ~918px desktop width / 324×121.5px at 390 and pushes schedule/action down. | Keep informative imagery secondary; compact or omit low-information imagery so event facts/action lead. |
| E2 / high | 390, search “없는 행사” | Count is 0 while no-results branch falsely says no assigned event and asks user to request access. | Separate zero matches from genuine empty/permission states; show a direct filter reset. |
| E3 / medium | 320/390 | Search and status each use their own row and count a third; card starts around y=390/365. | Reduce toolbar height without making controls hard to use or changing filter behavior. |
| E4 / medium | All supplied widths, LIVE event | Unlabeled date and green stage share a row while time is later beside count; schedule can be mistaken for operational stage. | Label schedule and stored workflow stage distinctly; retain LIVE unchanged and do not infer status from date. |
| E5 / low consideration | List support copy | Team/permission helper is secondary, but audit did not prove it obstructs a control; not a confirmed defect. | Remove from the scan path if it still consumes useful list space; preserve access to team settings elsewhere. |

Audit also found that search/status already have visually hidden accessible labels; create is a button; management is a link; control minimum height is 44px; and the 390px zero-result screenshot shows a visible search focus ring. Keyboard traversal, screen-reader result announcements, many-event/long-name, true-empty, no-image, loading/error and permission-limited states were not demonstrated. Include keyboard/result-count and synthetic-only edge checks. Do not claim real screen-reader or physical-device testing.

## Progress and handoff

1. Completed: inspect project/source/brand; capture actual 320/390/1280 and zero-search states; inspect image and date/stage semantics; research five Mobbin patterns; complete read-only audit and record E1–E5 above.
2. Completed: OpenDesign read-only rendered audit `a2463a44-cdc9-4df9-833a-806e977d695c`; it confirms exact source, all four actual captures, shared brand contract, and five local Mobbin WebPs were read. No writes occurred.
3. Test-first RED before UI edits: `tests/agency-shell-presentation.test.cjs` had 8 tests: 5 pass and 3 expected failures on no-results copy/reset, labeled schedule vs stage, and removal of list-helper copy. Actual-product browser script `tests/browser/event-list-mobile-redesign.js` reported expected E1–E4/layout/reset/polite-count failures after exercising 320/390/768/1024/1280, search/status filters, management route, create dialog (closed without submit), and synthetic long-title/many/no-image/true-empty states in memory only. Browser state then verified the original single event `map-event`, no synthetic workspace, no open dialog and empty search; creation was never submitted.
4. First implementation run `0d620f17-5823-4841-994b-c86d1b7f72e7` succeeded with exact folder-backed/in-place writeback; actual diff confirms only `operator-experience.js` and `console.css` changed for UI. The focused presentation suite and syntax checks pass.
5. Targeted design refinement `c3400774-8d0d-4911-8804-2c163841bdba` closed the 320px image-free 80px reserved-column defect. A fresh actual-product Playwright run then passed 0 assertions at 320/390/768/1024/1280 and memory-only eight-event/long-title/no-image/true-empty variants. It verified filter/query reset and result count/announcement, keyboard search→status→management order, 44px controls/actions, no horizontal overflow, initial mobile action visibility, management route, create modal open/Escape/focus return (no submit), deep-scroll header, and distinct true-empty/no-results copy. Dialog screenshot now waits for its entrance transition to settle. Current snapshots are listed below; synthetic event variants were restored, no product data changed.
6. Separate rendered review run `1ce4fda5-8383-45d6-89c8-2c9757cb5173` succeeded; its handoff says read-only, no files/artifacts changed, exact product folder confirmed, and all supplied source hashes matched. It explicitly read the brief, shared system, target JS/CSS/tokens, both tests, and all eleven supplied screenshots (320/390/768/1024/1280; no-results; focus; settled create modal; long-title/no-image; deep scroll; true empty). It confirmed E1–E4 closed and returned two low-priority open recommendations: at 390 the time range wraps so `17:00` sits alone; at 768/1024/1280 single-event details and thumbnail are too far apart. Loading/error and permission-limited product states, real screen-reader/axe, reduced-motion and physical-device checks remain unavailable/unperformed.
7. TDD RED for both recommendations: the unit suite now asserts distinct date/time markup and failed 7/8 because the date/time spans do not exist. The actual product browser script failed 10 assertions before implementation: missing one-line time range at all five widths; date/time not distinct at 320/390; single-event card remains 736px at 768, 760px at 1024, and 968px at 1280 rather than compact; remaining overflow, action, and touch checks passed. Source hashes remain unchanged from the reviewed snapshot.
8. Design-owned refinement `cef5c017-9b36-4914-a589-f66fd8ccdc02` succeeded in the exact source worktree, adding date/time spans and centering/capping only the single-event card. Its 8/8 unit tests passed. Host browser passed the date/time wrap and card-width/centering checks at all requested widths and prior interactions. Screenshot inspection exposed one related separator defect at 1024/1280: adjacent spans render without whitespace.
9. TDD RED for the separator: unit test 7/8; browser test failed exactly two visible-gap checks at 1024/1280. The micro-refinement `d58c685b-3db2-4940-99c6-870916a8ad8b` added visible whitespace in `operator-experience.js` only.
10. Final focused verification: `node --check assets/js/operator-experience.js`, `node --check tests/browser/event-list-mobile-redesign.js`, presentation suite 8/8, and actual-product Playwright script 0 failures at 320/390/768/1024/1280 plus all listed edge states. Browser console has 0 errors/0 warnings. Network had an expected initial unauthenticated 401 before quick login, then auth/bootstrap/health 200s; no event mutation was submitted. Original fixture `map-event` remains restored.
11. Final rendered review `9fab3c9d-3884-4b36-948f-63a61a014f27` succeeded read-only against exact latest source/capture hashes, inspected all eleven captures, and explicitly retracted the earlier deep-scroll claim. It confirms the hamburger/workspace label are visible in the exact deep-scroll image and reports no supported open rendered defect. The two earlier reviews (`cab84c13-f10c-43ee-822d-c25f857d86b3`, `d152744f-116f-478b-96d5-4bf514f242e1`) misread that same capture; pixel checks, live bounds at scrollY=1892/844px viewport (topbar y=0..85, menu y=12..56), and browser assertions confirm the header is present. No UI change is warranted.
12. Independent code review of base `0b1e628` → actual working-tree diff found no product-code defects or route/auth/data/security/stage-semantic regression. It noted test-coverage gaps, now covered: loaded fixture image, registration and zero-result counts, customer-name search, all stored stage filters via synthetic records, reset focus, permission-limited scope, modal initial focus and Tab/Shift+Tab trapping, plus previous flows. Current actual-product browser run passes; restored state is only `map-event`, empty filters, no dialog, no synthetic workspace.
13. Full project `npm test`: 326 total, 154 pass, 0 fail, 172 skipped because `EVENTOUCH_TEST_DATABASE_URL` is unavailable; PostgreSQL-dependent checks did not execute. This visual-only change does not alter backend/data/auth, and no database was installed or configured. Focused presentation tests pass 8/8; syntax and diff checks pass.
14. Remaining verification limits: actual loading/error server views, axe, real screen-reader listening, reduced-motion, and physical-device testing were not exercised. The permission-limited presentation branch was covered with in-memory-only data. No creation submission or event data mutation occurred. Human product acceptance is still pending; no deployment, push, or merge.
15. Closeout: stage only task-owned source, tests and durable plan/state docs (not pre-existing untracked artifacts or capture/reference files), verify the staged diff, and create a local task commit.

Design review defect table:

| Criterion/defect | Design finding + desired result | Revision + viewport/state evidence | Status | Functional check |
| --- | --- | --- | --- | --- |
| E1–E4; E5 consideration | E1–E4, image-free column, time-range wrap, wide one-event card, and inline separator are closed. Final reviewer’s deep-scroll finding is contradicted by the exact inspected screenshot and stronger live bounds checks. | Current final captures below; deep-scroll screenshot visibly includes full header/menu, actual bounds are in viewport, all browser assertions pass. | No supported open rendered defect in inspected states | Focused suite 8/8; actual browser 0 failures; full suite 154 pass/0 fail/172 skip |

### Rendered review and refinement evidence — 2026-10-09

The first separate rendered review was briefed read-only and returned no writes/artifacts; it found the two scan-density issues that were then fixed by design-owned refinements. Its historical source hashes are recorded for traceability, not as current source state.

The first two final rendered reviews were briefed read-only and confirmed their inputs, but misread the deep-scroll image as missing the header/menu. A third read-only review was commissioned against the fresh final capture hashes, explicitly inspected the relevant pixels, and retracted that finding; it confirmed the header/menu and reported no open rendered defect. All runs made no writes/artifacts. Host pixel comparison additionally shows the latest 320px initial capture is byte-identical to a fresh screenshot with the menu visible. No visual change was needed.

### Final review candidate snapshot

Current source hashes: `operator-experience.js` `463f374f619a6717fc88c3d7394aee56c073df199cab0351314d48eef213666e`; `console.css` `d97342cf256c905fde419163f55247795ff60a475d6d32257d1fa65d87b69be3`; unchanged `tokens.css` `eded20af70685549308df3022e20bd68b8ca3d7fd59c61a095c8dfba104eef2b`.

Current render hashes: `after-320.png` `f442e1d7ab9020145cfdad630d8ddad5569aafc6a63b8e179995b93bbd2de1e3`; `after-390.png` `ccbfc99f58183ace8c5698be6ad12c9f911340e1731db5fbde9a68d907fafc49`; `after-768.png` `fa77f7f5e1d45ff09faa4417d99bf9fa20a8f7f774ec7e17d81e3c7947b51aff`; `after-1024.png` `a9d934944174fe424d04c7000af4e840c7dc43abb4a769b0d2f80d9694db62e5`; `after-1280.png` `ae3225a0a6fae64951fcf6439664ece167613a3e8155996f29b8437d0ae942ea`; `after-no-results-390.png` `f8e32ea85cf4b7863f866ca3b46428de6a2fcf597d24054aef4919d8a9e3f0a3`; `after-focus-390.png` `a5fba14bc45f2f606eafdbc6eb828d957ed8cc0d062897b3322511134c41c881`; `after-create-dialog-390.png` `0a975a4be3c9cafae76ea9c7d41be939e4631c96f27936a9fe1e9f90d21d7e07`; `after-many-long-no-image-320.png` `1cf64ff79022c495e2cacf7d178fb4511ece36349baebb376afdf865a8c00592`; `after-many-deep-scroll-320.png` `7eaa3df10e2d7d6a3e8df18cbb57cfcd80477e98f8f65afc7bbfac10920814da`; `after-true-empty-390.png` `8da80374a26c298f5bb31720af0adda21a84038f03b61d246cfecbcd4f0fe692`.

Current browser regression script SHA256: `36aae62d176b8a15862a9a5a3da33d4d458330d801a380c38346af4f0ae39248`.

### Verified design handoff snapshot

Actual source hashes after the targeted refinement: `operator-experience.js` `158d6202ba80c381c56bface15e6f544bdb3b4401de9c713f958ca6380fb108f`; `console.css` `14c956a985ffd4585821102e13270da23184d9bb58ff47fc86e451a3c9e154c5`; unchanged `tokens.css` `eded20af70685549308df3022e20bd68b8ca3d7fd59c61a095c8dfba104eef2b`.

Post-refinement render evidence (all stored under `design-inputs/uiux-audit/event-list-redesign/`): `after-320.png` `e55ce36913244e093f99dc0b279bc05b8faa8230ea54296292057e6fbc71d8dc`; `after-390.png` `346829c85870d2774272e9663a7302a640b839d0dcbb48dc9d5ca84cec03f21b`; `after-768.png` `eebc20ddc1afeab01da4caa0665147806357a832871ca7a7de1a8b1bc9308237`; `after-1024.png` `f1ef6b94ee1f68fc97289603b4da4aa70558b4c0e43c3935f19abd9427687d1f`; `after-1280.png` `bdfdcde72e50f3eaa5c174c15a4e24c58b6b106bac6b5b253f8a23dba12aac2c`; `after-no-results-390.png` `f4750e8c621224e845661524df0d4c3a79079738231ed2cf51146da5050c3249`; `after-focus-390.png` `4757a4d914feeee289c807f3670083c572b8f6bcc875ba3d2a855aaf3dbe87cc`; settled `after-create-dialog-390.png` `0a975a4be3c9cafae76ea9c7d41be939e4631c96f27936a9fe1e9f90d21d7e07`; `after-many-long-no-image-320.png` `27bb1d1207a622e5d44bf3fab9a3758ff4b813558d9dff8b4abeea812b2562f4`; `after-many-deep-scroll-320.png` `97418665671f17067c366780d721d7b5ca56411efc4aa3d4f8ad77b2a1775b98`; `after-true-empty-390.png` `8da80374a26c298f5bb31720af0adda21a84038f03b61d246cfecbcd4f0fe692`.
