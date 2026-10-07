# EVENTOUCH PostgreSQL Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution method already supplied: inline, continuing without per-task approval prompts.

**Goal:** Make the current EVENTOUCH v9 product a real multi-user web system backed by PostgreSQL, with server-enforced identity/permissions and shared event state across organizers, staff, and app-free attendees.

**Architecture:** Keep the existing vanilla frontend and one Node HTTP API service. Use `pg` with a connection pool, numbered SQL migrations, normalized account/session/membership/idempotency tables, and event-scoped JSONB workspaces that preserve v9 data shapes; every mutation is validated and committed in an event-scoped transaction. Frontend `E.run` becomes a server command transport, with local storage limited to the approved offline check-in queue.

**Tech Stack:** Node 24, CommonJS, `node:test`, PostgreSQL 16, `pg` (the only new runtime dependency), existing HTML/CSS/vanilla JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-05-eventouch-product-backend-design.md`

## Global Constraints

- Keep the existing version 9 data shapes, routes, Korean copy, brand tokens, role model, and participant CSV import unless a test exposes a security or consistency defect.
- `pg` is the only approved new runtime dependency; never store DB credentials in Git or logs.
- All business mutations and role/event/assignment checks run on the server; browser state is not authoritative.
- Attendee access remains app-free and account-free; do not add OTP, real messages, payment, or email delivery.
- Use only sanitized demo data in tests and browser checks.
- No production DB connection, deployment, publication, NAS mount, or external delivery.
- PostgreSQL integration verification uses only the approved ephemeral local Docker test service and a disposable database.
- Keep visual source/style changes in OpenDesign; Build owns API contracts, nonvisual wiring, server checks, Git, and functional verification.

## Review Focus

- Concurrent signups at event capacity: exactly one last-place signup succeeds; pin with parallel API requests against PostgreSQL.
- Cross-event and cross-role access: manager/staff cannot read or mutate another event; pin each denied route family.
- Staff reassignment/revocation and invalid targets: stale assignment links stop working immediately; pin after revoke and target deletion.
- Ticket bearer boundaries: attendee APIs expose only the linked event/public data and that participant's own data; test cross-ticket and cross-event attempts.
- Duplicate network retries: same command ID returns the original result without a second registration/check-in/response; pin with repeated and concurrent requests.
- Restart persistence and migration failure: data survives server restart, failed migration does not partially advance schema; pin with integration tests.
- Offline check-in replay: replay preserves command IDs and cannot duplicate scans; pin queued replay and partial-failure tests.

---

### Task 1: PostgreSQL package, migrations, and test harness

**Files:**
- Create: `package.json`, `package-lock.json`, `server/db.js`, `server/migrate.js`, `server/migrations/001_initial.sql`
- Modify: `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- Create/test: `tests/server-postgres.test.cjs`, `tests/helpers/postgres-test.cjs`

**Interfaces:**
- Produces: `createDatabase({ connectionString, PoolClass? }) -> { pool, query(text, values), transaction(fn), migrate(), close() }`.
- `transaction(fn)` checks out one PoolClient, runs BEGIN/COMMIT/ROLLBACK on that client, and always releases it. SQL uses parameterized values. `migrate()` applies numbered migrations transactionally and records applied versions.
- Integration tests read only `EVENTOUCH_TEST_DATABASE_URL`; the helper permits loopback TCP or the task-scoped socket under `/tmp/opencode/eventouch-pg-test-*`, never the application `DATABASE_URL` or a remote host.

- [x] Write tests for DB health, migration idempotency, transaction commit/rollback, parameterized repository calls, and pool close.
- [x] Run the focused tests and confirm expected failure before implementation.
- [x] Add the single runtime dependency `pg`, migration runner, initial schema, and Compose test/production service definitions without starting production services.
- [x] Start only the approved disposable local PostgreSQL test container and run focused tests.
- [x] Commit as `feat: add PostgreSQL persistence foundation`.

### Task 2: Account authentication, sessions, and server permission checks

**Files:**
- Modify: `server/auth.js`, `server/server.js`, `server/api.js`
- Create: `server/access.js`
- Modify/test: `tests/server-auth.test.cjs`, `tests/server-api.test.cjs`

**Interfaces:**
- Consumes: Task 1 database and relational schema.
- Produces: `authenticate(email, password)`, `createSession(accountId)`, `sessionFromCookie(cookieHeader)`, `revokeSession(cookieHeader)`, and `authorize({ account, eventId, command, assignmentId })`.
- Persist scrypt hashes and SHA-256 hashes of opaque session/invitation bearer tokens; never persist/log raw session tokens. Roles are exactly `AGENCY`, `MANAGER`, `STAFF`.
- `AGENCY` has organization access, `MANAGER` requires an active event membership, `STAFF` requires a matching active assignment for the specific target and command. Invitation acceptance sets a password; delivery remains manual.
- Preserve `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`; add invitation lookup/acceptance that consumes a valid invitation token once and records a scrypt password hash. Reject unknown/expired/tampered sessions, reused invitations, and disabled accounts in Korean.

- [ ] Test wrong credentials, malformed/tampered/expired cookies, disabled accounts, password-hash non-disclosure, and cookie flags.
- [ ] Test role × event × assignment authorization, including immediate revocation.
- [ ] Implement auth/access and seed the first administrator only from environment configuration.
- [ ] Run focused server auth tests against PostgreSQL; commit as `feat: enforce PostgreSQL account and event access`.

### Task 3: Authorized bootstrap and app-free attendee read APIs

**Files:**
- Create: `server/state.js`, `server/public-events.js`
- Modify: `server/api.js`, `server/server.js`
- Create/test: `tests/server-bootstrap.test.cjs`, `tests/server-public-event.test.cjs`

**Interfaces:**
- Consumes: Task 1 repositories and Task 2 identity/access.
- Produces: `loadBootstrap(account) -> v9 state projection`, `loadPublicEvent(slug)`, and `loadTicket(eventSlug, ticketToken)`.
- `GET /api/bootstrap` returns only organization data allowed by the current account and only authorized events/workspaces. Public event routes return published attendee-visible data; ticket routes return only the participant represented by that high-entropy ticket.
- Do not accept a browser-supplied role, account ID, workspace, or entire state as authorization evidence.

- [ ] Test agency, manager, and staff projections, no cross-event leakage, hidden drafts, ticket redaction, invalid ticket, and cross-event ticket attempts.
- [ ] Implement the projection/public readers and verify response shapes remain consumable by v9 routes.
- [ ] Run focused PostgreSQL API tests; commit as `feat: serve role-scoped event state`.

### Task 4: Transactional attendee registration and ticket lifecycle

**Files:**
- Create: `server/commands/participants.js`
- Modify: `server/api.js`, `server/state.js`
- Create/test: `tests/server-registration.test.cjs`

**Interfaces:**
- Consumes: Task 1 event/workspace transaction; Task 2 guest/account access; Task 3 published form projection.
- Produces: `POST /api/events/:slug/signup`, plus authenticated participant create/update/status/import and attendee self-service commands through `POST /api/events/:eventId/commands`.
- Validate published form version, visible consent, duplicate participant rules, capacity/waitlist, cancellation, ticket expiry/revocation, idempotency command ID, and server-generated ticket secrets inside the locked event transaction.
- Preserve CSV import as an authenticated operator workflow; importing alone must not manufacture attendee consent.

- [ ] Test app-free signup, required consent, duplicate signup, capacity boundary, parallel final-slot signup, ticket expiry/reissue/cancel, CSV import permission, and replayed command ID.
- [ ] Implement server-side participant rules and return only the resulting participant/ticket projection needed by the caller.
- [ ] Run focused concurrency/API tests; commit as `feat: make attendee registration transactional`.

### Task 5: Staff assignment and check-in command family

**Files:**
- Create: `server/commands/operations.js`
- Modify: `server/api.js`, `server/access.js`
- Create/test: `tests/server-operations.test.cjs`

**Interfaces:**
- Consumes: Task 1 event transaction; Task 2 role/assignment access; Task 4 participant records.
- Produces: server commands for desk setup/open state, staff assignment/revocation, check-in/out, correction with reason, booth configuration/visit, and idempotent offline replay.
- Every staff command checks active event, stage, role, exact assignment target, payment/ticket state, duplicate/re-entry rules, and actor identity on the server.

- [ ] Test desk/booth assignment boundaries, inactive/revoked links, duplicate scans, re-entry, correction audit, payment gate, and concurrent scan replay.
- [ ] Implement transaction-backed operations and retain existing history/audit shape.
- [ ] Run focused API tests; commit as `feat: enforce assigned staff operations`.

### Task 6: Preparation, content, engagement, and result commands

**Files:**
- Create: `server/commands/preparation.js`, `server/commands/engagement.js`, `server/commands/content-results.js`
- Modify: `server/api.js`
- Create/test: `tests/server-domain-commands.test.cjs`

**Interfaces:**
- Consumes: shared command transaction/authorization and v9 event workspace.
- Produces: existing v9 command families for event preparation/settings, notices/programs/venue/branding, polls/quizzes/Q&A/draw/survey/photo/board, messages in simulation-only mode, reports, and file metadata transitions.
- Enforce feature gates, forward-only stage rules, one response per eligible participant, moderation, immutable published report snapshots, and no real message/payment side effects.

- [ ] Test representative validation and permission cases for every command family, including closed/archived states, duplicate responses, draft visibility, report snapshot immutability, and SIMULATION_ONLY sends.
- [ ] Implement the server command families without trusting front-end-only checks.
- [ ] Run the full API domain tests; commit as `feat: add server-authoritative event commands`.

### Task 7: Frontend server authority adapter

**Files:**
- Create: `assets/js/server-sync.js`
- Modify: `assets/js/store.js`, `assets/js/router.js`, `assets/js/registration.js`, `index.html`
- Modify/test: focused current-v9 browser/runtime tests under `tests/`

**Interfaces:**
- Consumes: Tasks 2–6 routes.
- Produces: `ET.remote.get/post`, bootstrap hydration, credential login/logout, server command transport preserving `E.run(name, payload)` and command IDs, public attendee fetch, offline check-in outbox replay, and visible connection/error states.
- Server mode is explicit and cannot silently fall back to a writable local demo. Local demo is available only as clearly labeled preview mode and cannot be mistaken for shared operations.
- Preserve existing route IDs, layout/brand, responsive behavior, focus handling, and CSV import. OpenDesign owns visual login/connection copy and rendered review/refinement using actual desktop/mobile and denied/loading states; Build changes only nonvisual transport/wiring. Use the current approved direction, no new visual redesign.

- [ ] Write transport tests for credentials, session bootstrap, server rejection, same-command retry, queue dedupe, and no local write in server mode.
- [ ] Run red tests, implement nonvisual adapter/wiring, commission compact OpenDesign copy/state refinement plus distinct rendered review, then run all current-v9 tests.
- [ ] Verify in a browser at 1280px and 390px: login, assigned staff scan flow, attendee signup/ticket, refresh persistence, permission denial, and no console/network errors.
- [ ] Commit as `feat: connect EVENTOUCH to shared server state`.

### Task 8: File APIs, deploy artifacts, and closeout

**Files:**
- Modify: `server/api.js`, `server/server.js`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- Create/update: `.env.example`, `docs/DEPLOY.md`, `tests/server-files.test.cjs`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: file upload/download under `STORAGE_DIR` with allowlist and size/path limits; Compose PostgreSQL + API service with health dependency and named local volume; documented env/TLS/backup/NAS configuration only (no mount or deployment performed).

- [ ] Test authenticated file access, event permission, size/type/path rejection, and metadata persistence.
- [ ] Run all tests and static checks; use an independent test-runner and reviewer at the verified final revision.
- [ ] Record the test container cleanup, actual commands/results, open findings, and no-production-deployment status; commit as `docs: document PostgreSQL deployment configuration`.

## Execution notes

- Base revision: `86b532d83ac3fa6e18b818936b2dd94f1965bb5d`.
- Isolated workspace: `.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`.
- The 2026-10-05 JSON/ETKO plan is historical and superseded by this plan; preserve it for history.
- Baseline before changes: `node --test tests/*.test.cjs` → 394 tests, 52 pass, 342 fail. A run after adding Task 1 tests reported 401 tests, 57 pass, 342 fail, 2 PostgreSQL tests skipped. Treat the failures as pre-existing until reconciled against current v9 contracts; do not silently count them as regressions.
- PostgreSQL doc references: Context7 `/websites/node-postgres` for Pool, parameterized queries, and single-client transaction lifecycle.
- Task 1 integration tests passed 7/7 against disposable PostgreSQL 16 with container networking disabled and a task-scoped Unix socket; the container and socket were cleaned up. The host Docker bridge is unavailable, so continue using only this isolated socket setup for local DB verification—never host networking or another project's database.
