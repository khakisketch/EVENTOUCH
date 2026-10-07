# EVENTOUCH Product State

Updated: 2026-10-07

## Product goal

Deliver one responsive event web product and shared PostgreSQL-backed API for organizers, managers, field staff, and app-free attendees. Keep the existing version 9 journeys, role boundaries, brand, and participant CSV import.

## Current milestone

**M1 — Server-authoritative multi-user foundation**

Acceptance: the real product server authenticates operational users, enforces event/assignment permissions on every request, serves authorized shared state from PostgreSQL, and supports the core prepare → attendee signup/ticket → staff check-in flow with transactional/idempotent writes. The same data survives refresh and restart across independent browser sessions.

M1 exit gate: event creation and all operational participant writes must use PostgreSQL as the only authoritative path; no JSON-file fallback may be able to create data that bootstrap/public/ticket reads cannot see. Verify a write through the real product route, read it from an independent role-scoped session and the public ticket route, then restart the HTTP server and read it again. The manager/staff event collection must also remain role-scoped. Human end-to-end acceptance is still required after technical checks.

Status: architecture selected; implementation plan is active. No human end-to-end acceptance or production deployment yet.

## Approved architecture

- One vanilla web frontend + one Node HTTP API service; role-specific responsive views, not three separately deployed products.
- PostgreSQL via `pg`; relational identity/access/session/idempotency records plus event-scoped JSONB workspaces preserving current v9 shapes.
- Public attendees use an event link and bearer ticket link; no app, account, or unapproved OTP.
- SMS/email/payment providers, NAS mounting, production deployment and publication remain out of scope.

## Active workstream

- Plan/ledger: `docs/superpowers/plans/2026-10-07-eventouch-postgresql.md`.
- Current workspace: `.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`, base `86b532d`.
- Original checkout remains on `feat/eventouch-visual-system` with the separate preparation/registration UX work and its untracked design artifacts; do not alter or clean them from this workstream.

## Backlog / later decisions

- SMS OTP or other attendee identity verification; actual messaging and payment integrations.
- NAS/object-storage deployment, production hosting/TLS, data retention policy, and operational monitoring.
- Scaling beyond the initial single service / event-scoped transaction model.
