# EVENTOUCH small UI/UX polish — audit contract

Updated: 2026-10-09
Branch: `feat/eventouch-postgres`
Base revision: `8a0a9b1a7e46777d2e288406714423288dd8711a`
Status: approved implementation, rendered review, browser verification, and independent code review complete; human product acceptance remains separate.

## User intent and approved scope

- User wants to improve small inconsistencies such as overly long menus and uneven spacing; user selected **all screen groups** as the first scope.
- Audit the organizer/agency console, event console, field-staff workspace, and app-free attendee screens. Find concrete defects from the rendered product; the user should not need to enumerate them.
- Stay within the existing EVENTOUCH design system in `design-inputs/uiux-audit/shared-system.md`. Preserve brand/tokens, routes, navigation destinations, copy meaning, permissions, data, and behavior unless a finding explicitly needs a user decision.
- User approved the bundled implementation on 2026-10-09: reduce repeated “운영 워크스페이스” context between menu/page, keep mobile “새 행사 만들기” on the right, and fix the oversized desktop attendee hero. No new visual direction, backend/data/auth changes, deployment, merge, or push is authorized.

## Audit acceptance

- Review current source and actual-product renders across 320/390 mobile and desktop, including menu/drawer states, keyboard/focus and relevant empty/error/loading or interaction states where supplied.
- For each finding report: what is wrong, exact surface/screen/state/viewport, user impact, desired result, and whether it is a presentation-only fix within the existing system or a navigation/IA/product decision.
- Distinguish product defects from fixture-only content and prior findings already closed. Return a concrete defect list, not a general score. Read-only: no source writes, Git operations, installs, services, or generated artifact expected.

## Product and source binding

- Product repository and OpenDesign local project both resolve to `/home/ksi/Desktop/SI-Projects/EVENTOUCH/.worktrees/eventouch-postgres`; entry `index.html`. OpenDesign metadata and `get_artifact` confirmed this exact source path; the artifact bundle reported `truncated:false`.
- Actual product capture source: `http://100.116.163.1:46771/` (temporary, tailnet-only; preserve the running fixture and its data).
- Approved shared-system source: `design-inputs/uiux-audit/shared-system.md` SHA256 `d6511fbb846e893ace856ce69c74c13dea1c3ed871b2a0eca6523d5fb9f02105`.
- Current review source hashes: `index.html` `2e84243c01fce8a2408bbbf9a6462568b6b7ecbe1ce4752c3c1ba920d53c03b3`; `assets/css/tokens.css` `eded20af70685549308df3022e20bd68b8ca3d7fd59c61a095c8dfba104eef2b`; `console.css` `11890974ba96560ae89a7dd56947c46ce108021e8163bad9e4ec0fd0ddeed30a`; `handheld.css` `524573983d0a647db93ee2384e959af1abcec7c40e2d6c441e4f38b7712a5888`; `server-presentation.css` `cda0b0239b60304e87ea0cc60934208e533d6f350affb1e6501f907d881372e7`; `operator-experience.js` `0bcd45f2f905ab82cbd0ec1267c35a0c537dd683d0ae18c2ccb2f6cf89f735ae`; `field.js` `2c82527c89b9915c4810c3f43b45f522d9f56a199c7e8bdb86b762a6530e0ba1`; `attendee.js` `2cfef71638f43a3f7f4189b26395fbf55630134d42d0afbc02bfda7f4932f872`; `router.js` `1722bd78a8d28af61c6270dded6bb28f1f9d953e98594d8c0c94ea7d5ca4c484`; `role-model.js` `1759c395027e5b1fcbeda4bdc56570c573feb52d9bb0ab2fea0018ceb8c20aae`.

## Render evidence supplied to the audit

Fresh Playwright captures from the actual product, 2026-10-09:

| Capture | State |
|---|---|
| `design-inputs/uiux-audit/micro-polish-agency-events-1280-2026-10-09.png` | Agency event list, desktop browser viewport (1280px wide) |
| `design-inputs/uiux-audit/micro-polish-agency-drawer-390-2026-10-09.png` | Agency drawer open at 390×844 |
| `design-inputs/uiux-audit/micro-polish-event-menu-full-320-2026-10-09.png` | Event console menu expanded at 320×844 |
| `design-inputs/uiux-audit/micro-polish-event-menu-bottom-320-2026-10-09.png` | Same menu after scrolling the sidebar to its account/logout section |
| `design-inputs/uiux-audit/micro-polish-event-overview-1280-2026-10-09.png` | Event console overview and expanded navigation at 1280×900 |
| `design-inputs/uiux-audit/micro-polish-attendee-home-390-2026-10-09.png` | Public attendee home at 390×844 |
| `design-inputs/uiux-audit/micro-polish-attendee-home-1280-2026-10-09.png` | Public attendee home at 1280×900 |

Existing actual-product staff captures, unchanged staff source since their verification: `design-inputs/uiux-audit/field-desktop-1280.png`, `field-mobile-390.png`, `stage2-staff-1280.png`, and `stage2-staff-390.png`; evidence/measurement context: `field-workspace-verification.md` and `consistency-audit-console-field.md`.

## Initial observations to validate, not assume

- At 320×844, expanding all three event-navigation groups produces an `aside.sidebar` scroll height of 1135px against an 844px viewport; account/logout is below the initial view but appears after scrolling. The browser snapshot shows a scrollable sidebar; the screenshots do not show a persistent scrollbar. Determine whether this creates a genuine wayfinding/access problem before proposing any accordion or information-architecture change.
- The fixture's public event hero image is a loaded flat gray image (320×200 natural dimensions), not a failed request. Treat the appearance as fixture content unless the source reveals a product-level empty-image treatment problem.
- Initial browser console had the fixture's unauthenticated `/api/auth/me` 401 and missing favicon 404; these are known baseline messages, not presumed visual defects.

## Progress

- Project binding, source bundle, prior relevant audit records, current screenshots, and source hashes verified. Recheck at HEAD `8a0a9b1` confirms all listed source hashes unchanged. OpenDesign `get_project` resolves to this exact worktree; `list_files` confirms the current source and every listed fresh/staff screenshot exists in that project. No matching-project run is active. No product source or domain data changed; the prepared test quick-login created an ephemeral auth session for read-only inspection.
- The read-only OpenDesign reviewer confirmed it read all ten listed source files plus the shared-system document and visually inspected all eleven requested screenshots; it returned a text-only, evidence-backed audit. The project-bound automatic refine procedure was attached despite the read-only request, but the handoff created no artifact and did not claim a source edit. OpenDesign file mtimes after the run and the post-run Git status/diff confirm source remained unchanged. The expected repository integration guides were not present at the instructed paths; no unverified procedure was assumed.

## Audit result and independent checks

One confirmed presentation defect, A-01 — attendee home on desktop (`#/event/map-event/home`, 1280×900): the 320×200 key visual renders at x=80, y=236.8, width=1120, height=700 (bottom=936.8); the primary “참가 신청” button is at y=960.8–1004.8, entirely below the initial viewport. The live 390×844 rendering remains proportionate (image 358×223.75; button y=521.5–565.5) with no horizontal overflow. At 320px the attendee page also has no horizontal overflow and its primary action is 44px high. The gray appearance is fixture content; the finding is the desktop sizing/action placement, not image loading.

Source basis: `assets/js/operator-experience.js` `E.mobileHome()` emitted the attendee hero as `.mobile-hero` with an unconstrained image between summary and action. `assets/css/server-presentation.css` already defined a desktop `.attendee-home-hero` composition and 420px image max-height, but that styling was not applied to this markup. The user approved using this existing desktop treatment while preserving the mobile stack, image ratio, copy, route, and action behavior.

Other audited evidence: the event-side drawer at 320×844 scrolls (content height 1135px in an 844px viewport) and its paired scrolled capture shows account/logout reachable; no evidence justifies changing its navigation hierarchy. The agency menu at 320 opens with focus inside, sets `aria-expanded=true` and makes main content inert; Escape closes it, restores focus to the menu button, sets `aria-expanded=false`, and clears inert. The event checks tab strip at 390 has clientWidth=scrollWidth=358 with all four labels visible and page width 390; the prior clipping issue is not reproduced. Organizer/event captures and existing source-aligned field-staff captures show no other actionable visual defect in the states reviewed.

Limitations: the current owner test account has no field-staff assignment, so direct 320px staff navigation shows the expected unassigned-state message; no 320px staff capture was obtained. Existing field 390/1280 actual-product captures were reviewed. Screen-reader listening, physical-device testing, and uncaptured loading/empty/error states were not performed. No tests were run because no code changed.

Independent completion verification at HEAD `8a0a9b1`: `git status --short --branch` shows only existing/untracked `.od-skills/`, `design-inputs/`, `index.html.artifact.json` and this untracked task ledger; `git diff --check` and `git diff --stat` return no tracked changes. Rechecked product source hashes match the inputs listed above. Live Playwright measurements above are from the actual temporary fixture. No data, auth, source, service, deployment, or Git state was changed.

## Approved bounded visual-polish design and acceptance

1. Agency/organizer pages (`events`, `clients`, `team`, `integrations`): keep “운영 워크스페이스” as the desktop navigation context in the sidebar. On desktop, hide the redundant agency topbar breadcrumb; on mobile, where the sidebar is hidden, retain that context in the topbar. Remove the repeated page-head eyebrow from these screens while retaining the EVENTOUCH brand descriptor. Event-specific breadcrumbs remain unchanged.
2. Agency events page: its “새 행사 만들기” is already right-aligned on desktop. At 320/390 mobile, keep it on the right side of the title row where it fits, rather than as a left-aligned action below the description. Preserve 44px target height, wrap safely if needed, and scope this exception to this action (do not change the shared mobile-header rule globally).
3. Public attendee home: at desktop widths, apply the existing two-column attendee-hero treatment and 420px image cap to the current server-mode markup so the key visual no longer pushes the primary action below the first viewport. Preserve the current mobile stack and image ratio.

Invariants: keep current palette/tokens, route destinations, permissions, content meaning, and action behavior; no new visual direction. Expected UI files: `assets/js/ui.js`, `assets/js/operator-experience.js`, `assets/js/role-model.js`, `assets/css/console.css`, and `assets/css/server-presentation.css`; no backend/data/auth changes. Acceptance: each desktop agency screen has one clear workspace context in the sidebar; mobile has one in the topbar; no repeated page eyebrow. At 320/390 the new-event button is right-aligned beside the title without clipping/horizontal overflow; desktop remains right-aligned. At 1280×900 the attendee primary action is visible without scrolling past a full-width image; 390 and 320 attendee layouts retain the current single-column order and have no horizontal overflow. Add regression tests first and observe them fail before design edits. Require actual-product browser verification, design-owned rendered review/refinement, and before/after captures at target viewports.

Approval state: approved by user (“세가지모두진행해”). Implementation and technical verification are complete; human acceptance remains separate.

## Test-first and design preflight — 2026-10-09

- Baseline revision: `8a0a9b1a7e46777d2e288406714423288dd8711a`; target worktree and OpenDesign `resolvedDir` both `/home/ksi/Desktop/SI-Projects/EVENTOUCH/.worktrees/eventouch-postgres`. No matching project run is active.
- Baseline source SHA256: `ui.js` `9da6ec64c630b279403cd6d3d1b76f54303bf16bfae312f6d74f087b899904c9`; `operator-experience.js` `0bcd45f2f905ab82cbd0ec1267c35a0c537dd683d0ae18c2ccb2f6cf89f735ae`; `role-model.js` `1759c395027e5b1fcbeda4bdc56570c573feb52d9bb0ab2fea0018ceb8c20aae`; `console.css` `11890974ba96560ae89a7dd56947c46ce108021e8163bad9e4ec0fd0ddeed30a`; `server-presentation.css` `cda0b0239b60304e87ea0cc60934208e533d6f350affb1e6501f907d881372e7`; shared system `d6511fbb846e893ace856ce69c74c13dea1c3ed871b2a0eca6523d5fb9f02105`.
- RED evidence: `node --test tests/agency-shell-presentation.test.cjs tests/attendee-browser-presentation.test.cjs` reports 24 tests, 19 pass and 5 expected failures: four agency eyebrow repetitions and the server attendee override not using the existing desktop hero. Product sources remain unchanged.
- Actual product browser baseline at `http://100.116.163.1:46771/` (temporary, tailnet-only): 1280px agency views showed three workspace labels; 390/320px showed two; the event-create action was below/left of the heading on mobile; attendee hero at 1280×900 was 1120×700 and the primary action ended at y=1004.8. The 390/320 attendee stack was proportionate and overflow-free. Baseline captures are `design-inputs/uiux-audit/micro-polish-before-*.png`; the 390px clients capture shows the real empty state. Initial unauthenticated `/api/auth/me` 401 and `favicon.ico` 404 matched the recorded fixture baseline; quick login did not submit product data.
- OpenDesign read access was verified for all five target files, the shared-system spec, and actual screenshots; project metadata points directly to the product worktree. A hidden dot-file write probe was rejected by the daemon upload endpoint; a normal temporary file under `design-inputs/uiux-audit/` then succeeded via write/read/list and was deleted. Thus direct project write access is confirmed, while hidden-path writes are not assumed. No other file or data changed.
- Design stage: OpenDesign local execution used `impeccable-design-polish`; the distinct `web-design-guidelines` review read actual before/after captures and the shared-system contract. No new direction, token, or external reference was introduced.
- Direct-source implementation completed in the existing folder-backed product worktree (OpenDesign run `05d844d1-37c7-45bf-93a4-c470307bdd2c`, writeback `in-place`). It modified only the five expected UI source files. Its own browser was unavailable, so actual-product renders were captured and verified in the host Playwright browser.

## Implementation and verification — 2026-10-09

- Agency workspace context is unique by viewport: desktop keeps the sidebar caption and hides the redundant topbar label; mobile keeps the topbar label and the four agency page-head eyebrows are removed. Only the agency-events header gets the mobile title/action row exception. Attendee home uses the existing capped desktop two-column system, while DOM/CSS retain the mobile details → image → action stack.
- Exact production UI files changed: `assets/js/ui.js`, `assets/js/operator-experience.js`, `assets/js/role-model.js`, `assets/css/console.css`, and `assets/css/server-presentation.css`. No API, server, auth, data, route, permission, dependency, or token files changed.
- Focused Node tests: `node --test tests/agency-shell-presentation.test.cjs tests/attendee-browser-presentation.test.cjs` — 24/24 pass. Full `npm test` — 323 tests, 151 pass, 0 fail, 172 skipped because the isolated `EVENTOUCH_TEST_DATABASE_URL` was unavailable; PostgreSQL cases were not exercised in that run.
- Syntax checks for the three modified JavaScript sources and browser script passed; `git diff --check` passed. Independent code review found no production defect. Review gaps were closed by preserving/asserting the fifth `E.head` class argument, asserting attendee two-column/one-column rendered geometry, and checking the primary CTA route/form without submitting. One optional test-only null guard was not added: this fixture check waits for the real loaded key visual and current markup always supplies the summary/action.
- Independent browser verification (self) first exposed that a new column assertion selected the outer `.mobile-hero` wrapper instead of the inner grid. The script now prefers `.attendee-home-hero`; the final run passed the rendered 2-column desktop and 1-column mobile assertions. No production change was needed for this test-only defect.
- Actual product Playwright against the preserved tailnet-only fixture passed `tests/browser/eventouch-ui-micro-polish.js` (`__micro_polish=verify`). It checked 320/390/1280 agency and attendee layouts, exactly one workspace label on events/clients/team/integrations, mobile title/button alignment and 44px target, attendee desktop two-column composition + ≤420px image + first-viewport CTA, mobile one-column order + image ratio + no overflow, drawer Escape/focus return, create-dialog Escape/focus return, attendee keyboard focus, and CTA navigation into the visible registration form (no form submission/data write). The final browser console reported no errors/warnings; observed API/auth/bootstrap/public-event reads returned 200.
- Render captures: `micro-polish-after-*.png` contains all requested 1280/390/320 screens plus empty clients, open drawer/dialog, and focus states; final run also wrote `micro-polish-verify-*.png`. A create-dialog screenshot taken immediately on visibility looked translucent because it captured the entrance animation. The settled 390×844 capture (`micro-polish-verify-agency-new-event-dialog-390-settled.png`) was inspected by a second design review; steady-state modal is opaque and legible, so this candidate was closed as capture timing, not a product defect.
- Separate design review (`web-design-guidelines`, run `032ea88b-8c76-4883-8ca4-d681a16de846`) inspected the source, all 16 after captures, and all 12 before captures; it found no confirmed defects in the approved changes. Focused follow-up (`391c2226-3f76-47de-9b3d-dd95ddc5e609`) confirmed the settled modal candidate closed. Both runs were read-only and left product UI files unchanged.
- Limitations: the live fixture had no explicit loading/error screen to capture; the current account has no 320px staff assignment; real screen-reader listening and physical-device testing were not performed. These do not block the three approved refinements. Human end-to-end product acceptance remains pending. No deployment, merge, or push occurred.
