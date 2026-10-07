# EVENTOUCH Product State

Updated: 2026-10-07

## Product goal

Deliver one responsive event web product and shared PostgreSQL-backed API for organizers, managers, field staff, and app-free attendees. Keep the existing version 9 journeys, role boundaries, brand, and participant CSV import.

## Current milestone

**M1 — Server-authoritative multi-user foundation**

Acceptance: the real product server authenticates operational users, enforces event/assignment permissions on every request, serves authorized shared state from PostgreSQL, and supports the core prepare → attendee signup/ticket → staff check-in flow with transactional/idempotent writes. The same data survives refresh and restart across independent browser sessions.

M1 exit gate: event creation and all operational participant writes must use PostgreSQL as the only authoritative path; no JSON-file fallback may be able to create data that bootstrap/public/ticket reads cannot see. Verify a write through the real product route, read it from an independent role-scoped session and the public ticket route, then restart the HTTP server and read it again. The manager/staff event collection must also remain role-scoped. Human end-to-end acceptance is still required after technical checks.

Status: PostgreSQL Tasks 1–6 are implemented and independently verified through `6bf0e56` in the isolated worktree. Task 7 is in progress with uncommitted server adapter/event creation/API retirement changes; an initial real-browser agency login → create → reload flow passed. M1 remains open pending complete Tasks 7–8, cross-role/public-ticket/restart verification, rendered design review, and human end-to-end acceptance. No production deployment has occurred.

## Approved architecture

- One vanilla web frontend + one Node HTTP API service; role-specific responsive views, not three separately deployed products.
- PostgreSQL via `pg`; relational identity/access/session/idempotency records plus event-scoped JSONB workspaces preserving current v9 shapes.
- Public attendees use an event link and bearer ticket link; no app, account, or unapproved OTP.
- SMS/email/payment providers, NAS mounting, production deployment and publication remain out of scope.

## Active workstream

- Plan/ledger: `docs/superpowers/plans/2026-10-07-eventouch-postgresql.md`.
- Current workspace: `.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`, base `86b532d`.
- Original checkout remains on `feat/eventouch-visual-system` with the separate preparation/registration UX work and its untracked design artifacts; do not alter or clean them from this workstream.

## Approved next scope — booth stamp map

- User approved a floorplan with existing booth positions and the attendee's server-confirmed QR certification marks/count, not location tracking.
- Explicitly exclude GPS/current location/last-location highlights, navigation, zone drawing and separate location QR. Keep existing stamp/ticket/SELF-STAFF authorization contracts.
- Written design and implementation plan approved: `docs/superpowers/specs/2026-10-07-eventouch-booth-stamp-map-design.md`, `docs/superpowers/plans/2026-10-07-eventouch-booth-stamp-map.md`; inline development requested. File authority, map draft/publication server commands and client data/upload contracts are implemented but uncommitted under verification. Design-owned map UI generation is active; actual rendered review and integrated browser checks remain required. No map completion or human acceptance claimed. Reuse Task8 event-file storage, not a competing file store.
- Payment/refund exclusion was discussed separately; no removal has been implemented, and approving the map does not authorize data deletion.

## Backlog / later decisions

- SMS OTP or other attendee identity verification; actual messaging and payment integrations.
- NAS/object-storage deployment, production hosting/TLS, data retention policy, and operational monitoring.
- Scaling beyond the initial single service / event-scoped transaction model.
- Reconcile the remaining frontend/theme tests against the current v9 source tree during Task 7; the independent full-suite run currently reports missing legacy UI paths/modules.
- Before production use, decide the onsite consent-capture policy and verify ticket-ID/date-expiry behavior for long event IDs and non-UTC hosts.
- Keep targeted guard regressions (cancel while inside, self-update phone collision, operator cross-event command-ID reuse) and the explicit Task 8 staff-file denial test in the relevant later verification suites.
