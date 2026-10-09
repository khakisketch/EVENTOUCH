# EVENTOUCH Product State

Updated: 2026-10-09

## Product goal

Deliver one responsive event web product and shared PostgreSQL-backed API for organizers, managers, field staff, and app-free attendees. Keep the existing version 9 journeys, role boundaries, brand, and participant CSV import.

## Current milestone

**M1 — Server-authoritative multi-user foundation**

Acceptance: the real product server authenticates operational users, enforces event/assignment permissions on every request, serves authorized shared state from PostgreSQL, and supports the core prepare → attendee signup/ticket → staff check-in flow with transactional/idempotent writes. The same data survives refresh and restart across independent browser sessions.

M1 exit gate: event creation and all operational participant writes must use PostgreSQL as the only authoritative path; no JSON-file fallback may be able to create data that bootstrap/public/ticket reads cannot see. Verify a write through the real product route, read it from an independent role-scoped session and the public ticket route, then restart the HTTP server and read it again. The manager/staff event collection must also remain role-scoped. Human end-to-end acceptance is still required after technical checks.

Status: PostgreSQL Tasks 1–8 are implemented and committed in the isolated worktree (current HEAD `9c54bcb`). Server/file/map authority, the server-backed client shell, invitations, the booth stamp map and the user-approved payment-simulation removal are committed; the M1 exit-gate checks ran through the real product route (write via real route → independent role/public-ticket reads → same-schema HTTP restart read-back; role-scoped event collection). Final integrated verification on the current revision: full suite 288/288 (0 fail, 0 skip; the former legacy failures are archived under `tests/legacy` with the labeled attribution in `docs/superpowers/legacy-test-attribution.md`), focused server suites green, syntax/diff clean. The approved UI/UX rollout (shared definitions in `design-inputs/uiux-audit/shared-system.md`) completed stages 1/1b (attendee) and 2 (console + login, including the staff field surface and the invite accept page) with per-stage captures and distinct read-only reviews; the approved code-structure cleanup (P1–P3, review ses_ee630851) is complete including the server legacy-cluster split (`a2e0900`) and the script load-order pin (`cd66787`). The OpenDesign boot unit was verified with a real restart cycle (new healthy container, identical mount set, daemon responding). Follow-up workstream (user request 2026-10-08, "일관성·체계적으로 설계"): cross-surface consistency + agency-page systematization — two read-only audits (36567ccb, 253a9939) produced defect lists; the user approved seven direction decisions; implemented as the field workspace redesign (`4e72f1c`: full-width responsive desktop, heading hierarchy, assignment switch, thin scroll boundary), the agency/console fixes (`cc3e38c`: clients empty state, one-event layout, consistent agency labels, conditional team column, integration rows with one badge, sticky mobile topbar with event name), and the retired attendee bottom-nav cleanup (`9c54bcb`); suite 288/288, rendered verifications d80da796 (field) and 209370b5 (agency) with capture-disproven false-positive claims recorded. Awaiting human review of the new results and M1 end-to-end acceptance; no production deployment has occurred.

## Current State (2026-10-09; supersedes the earlier status summary)

- Verified checkout: `/home/ksi/Desktop/SI-Projects/EVENTOUCH/.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`, HEAD `746b929`.
- The focused mobile-admin success-toast repair is committed; actual-fixture normal/edge browser regressions pass at 320/390, and rendered review found no open toast defect. The PostgreSQL-enabled maintained suite passed 322/322 with 0 skips; evidence and the independent Test Runner session are recorded in the active plan.
- M1 human end-to-end acceptance remains pending. Real screen-reader listening and physical-device checks are unperformed. No production deployment, merge, or push occurred.

## Approved architecture

- One vanilla web frontend + one Node HTTP API service; role-specific responsive views, not three separately deployed products.
- PostgreSQL via `pg`; relational identity/access/session/idempotency records plus event-scoped JSONB workspaces preserving current v9 shapes.
- Public attendees use an event link and bearer ticket link; no app, account, or unapproved OTP.
- SMS/email/payment providers, NAS mounting, production deployment and publication remain out of scope.

## Product binding

- Repository/worktree: `/home/ksi/Desktop/SI-Projects/EVENTOUCH/.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`; product entry `index.html`.
- OpenDesign local project: `EVENTOUCH PostgreSQL` (`5601983f-a74b-4199-8c6d-969623f020c6`), verified `metadata.baseDir` points to this exact worktree; entry `index.html`. Design preview: `http://127.0.0.1:7456/api/projects/5601983f-a74b-4199-8c6d-969623f020c6/raw/index.html` (artifact preview only).
- Actual product: `http://100.116.163.1:46771/` (temporary, tailnet-only; existing preserved fixture, do not restart for this task). Fixture launcher: `node .superpowers/sdd/2026-10-07-eventouch-postgresql/serve-existing-fixture.cjs` with its already-prepared environment. Product start script: `npm start`; automated suite: `npm test`.
- Brand source: `design-inputs/uiux-audit/shared-system.md`; no project-level `product-context.md` is present.

## Active workstream

- Plan/ledger: `docs/superpowers/plans/2026-10-07-eventouch-postgresql.md`.
- Current workspace: `.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`, base `86b532d`.
- UI/UX rollout (user-approved, autonomous): pilot + stage 1/1b (attendee) + stage 2 (console/login/staff/invite) applied the shared definitions (`design-inputs/uiux-audit/shared-system.md`) with per-stage captures and distinct read-only reviews; stage-2 commit `ca8224d`. Evidence and captures stay under `design-inputs/uiux-audit/` (not committed).
- Consistency/systematization follow-up (user-approved 2026-10-08): audits 36567ccb + 253a9939 → seven user-approved decisions → `4e72f1c` (field workspace: full-width responsive desktop ≥900px, mobile phone layout unchanged, assignment switch, thin scrollbar), `cc3e38c` (agency pages: empty state, one-event single column, "운영 워크스페이스" labels, conditional 관리 column, integration rows with one badge, notice placement, sticky mobile topbar with menu + event name), `9c54bcb` (dead attendee bottom-nav removal). Captures `field-*`, `agency2-*`, `cleanup-*` under `design-inputs/uiux-audit/`.
- Code-structure cleanup (review ses_ee630851, user-approved): P1–P3 complete — staff links (`9bdb441`), route-map pin (`f5054fb`), JSON-store isolation + 410 pins (`09a536b`), validators (`dbbe8a4`), dead-view removal (`a0803e2`, `c715da8`), legacy archive (`84cdd91`), load-order pin (`cd66787`), route map doc (`fb324e1`), server legacy-cluster split (`a2e0900`).
- Focused mobile-admin success-toast follow-up (2026-10-09): iteration-6 fixes mobile placement/lifecycle while preserving copy, status semantics, focus, four-second dismissal, routes/data/auth, desktop and attendee behavior. Actual-fixture normal/edge Playwright suites pass at 320/390; rendered review found no open toast defect. Independent `npm test`: 322 total, 150 pass, 0 fail, 172 PostgreSQL tests skipped because isolated `EVENTOUCH_TEST_DATABASE_URL` was unavailable; browser-script syntax and diff checks pass. Details and hashes: `docs/superpowers/plans/2026-10-07-eventouch-postgresql.md`; M1 human acceptance, screen-reader listening, and physical-device checks remain pending/unperformed. No deployment.
- Original checkout remains on `feat/eventouch-visual-system` with the separate preparation/registration UX work and its untracked design artifacts; do not alter or clean them from this workstream.

## Approved next scope — booth stamp map

- User approved a floorplan with existing booth positions and the attendee's server-confirmed QR certification marks/count, not location tracking.
- Explicitly exclude GPS/current location/last-location highlights, navigation, zone drawing and separate location QR. Keep existing stamp/ticket/SELF-STAFF authorization contracts.
- Written design and implementation plan approved: `docs/superpowers/specs/2026-10-07-eventouch-booth-stamp-map-design.md`, `docs/superpowers/plans/2026-10-07-eventouch-booth-stamp-map.md`; inline development requested and executed. File authority, map draft/publication server commands and client data/upload contracts are committed; design-owned map UI, rendered reviews and integrated browser checks are closed for the reviewed states.
- User decision 2026-10-08: the unconnected payment/refund simulation UI is removed (`c92915e`) while stored data and server contracts stay; server-unreachable keeps block+retry (no demo fallback); attendee surfaces were finished with capture review + integrated checks.

## Backlog / later decisions

- SMS OTP or other attendee identity verification; actual messaging and payment integrations.
- NAS/object-storage deployment, production hosting/TLS, data retention policy, and operational monitoring.
- Scaling beyond the initial single service / event-scoped transaction model.
- Legacy frontend/theme tests were archived to `tests/legacy` (71 files, `84cdd91`) with the labeled attribution in `docs/superpowers/legacy-test-attribution.md` instead of being repaired; the maintained suite is green. Any future re-adoption of those legacy modules needs a fresh contract review.
- Before production use, decide the onsite consent-capture policy and verify ticket-ID/date-expiry behavior for long event IDs and non-UTC hosts.
- Keep targeted guard regressions (cancel while inside, self-update phone collision, operator cross-event command-ID reuse) and the explicit Task 8 staff-file denial test in the relevant later verification suites.
