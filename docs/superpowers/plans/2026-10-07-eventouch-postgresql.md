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

- [x] Write tests for DB health, migration idempotency/failure atomicity, transaction commit/rollback, parameterized repository calls, pool close, and PostgreSQL-backed signup persistence across HTTP server restart.
- [x] Run the focused tests and confirm expected failure before implementation.
- [x] Add the single runtime dependency `pg`, migration runner, initial schema, and Compose test/production service definitions without starting production services.
- [x] Start only the approved disposable local PostgreSQL test container and run focused tests.
- [x] Commit as `feat: add PostgreSQL persistence foundation`.

### Task 2: Account authentication, sessions, and server permission checks

**Files:**
- Modify: `server/auth.js`, `server/server.js`, `server/api.js`, `server/migrate.js`, `.env.example`, `docker-compose.yml`, `docs/DEPLOY.md`
- Create: `server/access.js`
- Modify/test: `tests/server-auth.test.cjs`, `tests/server-api.test.cjs`, `tests/server-postgres.test.cjs`, `tests/server-files.test.cjs`, `tests/server-skeleton.test.cjs`

**Interfaces:**
- Consumes: Task 1 database and relational schema.
- Produces: `authenticate(email, password)`, `createSession(accountId)`, `sessionFromCookie(cookieHeader)`, `revokeSession(cookieHeader)`, and `authorize({ account, eventId, command, assignmentId, targetId? })`; target-specific commands require the active assignment's `target_id` to match the request target. Invitation review is `GET /api/auth/invitations/:token`, acceptance is `POST /api/auth/invitations/:token/accept`.
- Persist scrypt hashes and SHA-256 hashes of opaque session/invitation bearer tokens; never persist/log raw session tokens. Roles are exactly `AGENCY`, `MANAGER`, `STAFF`.
- `AGENCY` has organization access, `MANAGER` requires an active event membership, `STAFF` requires a matching active assignment for the specific target and command. Invitation acceptance sets a password; delivery remains manual.
- Preserve `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`; add invitation lookup/acceptance that consumes a valid invitation token once and records a scrypt password hash. Reject unknown/expired/tampered sessions, reused invitations, and disabled accounts in Korean.

- [x] Test wrong credentials, malformed/tampered/expired cookies, disabled accounts, password-hash non-disclosure, and cookie flags.
- [x] Test role × event × assignment authorization, including immediate revocation and mismatched booth targets.
- [x] Implement auth/access and seed the first administrator only from `ADMIN_EMAIL` + `ADMIN_PASSWORD` environment configuration; no default credentials.
- [x] Run focused server auth/API/PostgreSQL tests against PostgreSQL and keep the legacy server health/file tests aligned with the required database startup.
- [x] Commit as `feat: enforce PostgreSQL account and event access`.

Task 2 verification (2026-10-07): the mismatch-target test first returned 201 instead of 403; after adding `targetId` authorization it passed and the assigned booth remained usable. Concurrent check-in consistently lost one update while data was read before async authorization; the new test failed 1/2, then passed after reading state after auth. A controlled upload/auth race also lost a committed check-in (2 instead of 3); it passed after upload metadata is applied to a fresh store read. Independent test-runner `ses_eeb4bacc3ffeaaYbhGvv69U5YI` ran auth/API/PostgreSQL/files/skeleton suites → 61/61 pass and `git diff --check` → clean. The complete suite currently reports 414 tests, 74 pass, 340 fail; remaining failures are from the known legacy test/source mismatch (for example tests importing removed `features/*.js` paths) and planned later frontend-sync work, with no failures in the five Task 2 server suites.

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

- [x] Test agency, manager, and staff projections, no cross-event leakage, hidden drafts, ticket redaction, invalid ticket, and cross-event ticket attempts.
- [x] Implement the projection/public readers and verify response shapes remain consumable by v9 routes.
- [x] Run focused PostgreSQL API tests; commit as `feat: serve role-scoped event state`.

Task 3 verification (2026-10-07): PostgreSQL-backed bootstrap/public API tests were observed red on missing routes; follow-up red tests caught staff event metadata and null-participant draft content exposure before the allowlist fixes. All seven server suites pass 67/67, including agency/manager/staff projection, role impersonation rejection, published-content redaction, and same-event ticket binding. `git diff --check` and `node --check` for the four changed server modules pass. The full suite reports 420 tests, 80 pass, 340 fail; the 340 failures are the known legacy UI/test-source mismatch (e.g. imports from removed `features/*.js`), with no failures in the seven server suites.

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
- Attendee self-update is limited to currently published form field IDs. ENDED/ARCHIVED events reject operator participant writes; an ENDED public event returns a closure response while ARCHIVED remains hidden as not-found.
- Preserve v9 CSV mapping for base contact fields. Imported participants may complete any required published custom answers through ticket self-update; import stays atomic and rejects duplicate/capacity-overflow batches (it does not auto-waitlist overflow even when approval is required).
- Cancellation changes PAID payment rows to REFUND_REQUESTED and projects that state on the participant. A still-PENDING simulated payment remains PENDING on cancellation to match v9; no payment provider side effect is performed.
- Idempotency receipts omit raw ticket values and keep only hashes; replay restores the same token only while it remains current, otherwise returns a conflict.

- [x] Test app-free signup, required consent/custom-field backfill, duplicate signup, capacity boundary with concurrent callers, concurrent same-command retries, ticket expiry/reissue/cancel, CSV import permission/atomicity, and replayed command ID.
- [x] Implement server-side participant rules and return only the resulting participant/ticket projection needed by the caller.
- [x] Run focused concurrency/API tests; commit as `feat: make attendee registration transactional`.

Task 4 verification (2026-10-07): `EVENTOUCH_TEST_DATABASE_URL=postgres://eventouch@localhost/eventouch?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5 node --test tests/server-registration.test.cjs` → 21/21 pass. Independent Test Runner `ses_eeac4e00cffepIuKmnJHMPbRqo` ran `EVENTOUCH_TEST_DATABASE_URL=postgres://eventouch@localhost/eventouch?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5 node --test tests/server-auth.test.cjs tests/server-api.test.cjs tests/server-postgres.test.cjs tests/server-files.test.cjs tests/server-skeleton.test.cjs tests/server-bootstrap.test.cjs tests/server-public-event.test.cjs tests/server-registration.test.cjs` → 91/91 pass, 0 skipped. `node --check` for all changed JavaScript and `git diff --check HEAD^ HEAD` pass. The full `EVENTOUCH_TEST_DATABASE_URL=postgres://eventouch@localhost/eventouch?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5 npm test` reports 444 tests, 99 pass, 345 fail; the failures are non-server UI/theme tests importing absent legacy paths/files (`styles/tokens.css`, `styles/theme.css`, `app.js`, `features/views.js`, and the `store-truth` module), not Task 4 server failures. Read-only branch review `ses_eeada0981ffe5Bho8JsBgF1Guc` prompted the follow-up commit `4ab0f8c`: ended signup closure message, role-scoped manager/staff event collection, migration-failure rollback and HTTP restart persistence tests, eight-way capacity contention, and concurrent same-command retries. Review rulings preserve v9 base-only CSV import with attendee custom-field backfill and PENDING payment state on cancellation; the dual-store convergence gate is recorded for M1 exit. M1 remains open pending Tasks 5–8 and human end-to-end acceptance.

Deferred review minors: numeric-demo fallback remains transitional until Task 7; import overflow remains reject-not-waitlist; several participant guard/operator-ID tests remain queued; staff file denial is Task 8; auth precheck duplication, ticket-ID/timezone limits, onsite consent policy, and event-existence error distinctions remain documented for later verification/product decisions. These do not close M1 or authorize production use.

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
- The existing `GET /api/events` collection returns the PostgreSQL role-scoped event list for MANAGER/STAFF; no client route may rely on JSON-file event/participant writes as authoritative data.
- Server mode is explicit and cannot silently fall back to a writable local demo. Local demo is available only as clearly labeled preview mode and cannot be mistaken for shared operations.
- Preserve existing route IDs, layout/brand, responsive behavior, focus handling, and CSV import. OpenDesign owns visual login/connection copy and rendered review/refinement using actual desktop/mobile and denied/loading states; Build changes only nonvisual transport/wiring. Use the current approved direction, no new visual redesign.

- [ ] Write transport tests for credentials, session bootstrap, server rejection, same-command retry, queue dedupe, and no local write in server mode; exercise event creation and participant writes through PostgreSQL-authoritative routes.
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

- [ ] Test authenticated file access, event permission, size/type/path rejection, metadata persistence, and explicit denial of staff file reads unless an approved assignment contract is added.
- [ ] Run all tests and static checks; use an independent test-runner and reviewer at the verified final revision.
- [ ] Record the test container cleanup, actual commands/results, open findings, and no-production-deployment status; commit as `docs: document PostgreSQL deployment configuration`.

## Execution notes

- M1 exit gate is detailed in `docs/superpowers/product-state.md`: create and mutate through PostgreSQL-only product routes, verify independent role-scoped/bootstrap/public-ticket reads, restart persistence, and obtain human end-to-end acceptance. Tasks 4 review checks do not close the broader M1 milestone.

- Base revision: `86b532d83ac3fa6e18b818936b2dd94f1965bb5d`.
- Isolated workspace: `.worktrees/eventouch-postgres`, branch `feat/eventouch-postgres`.
- The 2026-10-05 JSON/ETKO plan is historical and superseded by this plan; preserve it for history.
- Baseline before changes: `node --test tests/*.test.cjs` → 394 tests, 52 pass, 342 fail. A run after adding Task 1 tests reported 401 tests, 57 pass, 342 fail, 2 PostgreSQL tests skipped. Treat the failures as pre-existing until reconciled against current v9 contracts; do not silently count them as regressions.
- PostgreSQL doc references: Context7 `/websites/node-postgres` for Pool, parameterized queries, and single-client transaction lifecycle.
- Task 1 integration tests passed 7/7 against disposable PostgreSQL 16 with container networking disabled and a task-scoped Unix socket; the container and socket were cleaned up. The host Docker bridge is unavailable, so continue using only this isolated socket setup for local DB verification—never host networking or another project's database.
