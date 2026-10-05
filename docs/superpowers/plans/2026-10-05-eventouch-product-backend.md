# EVENTOUCH 실제품 백엔드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method already supplied: proceed inline without per-task approval prompts; user waived plan review.

**Goal:** Ship a real multi-user EVENTOUCH product: Node API server with auth, shared persistence and file storage, frontend switched to server authority, deploy artifacts ready.

**Architecture:** Dependency-free Node server (`node:http` + `node:crypto` scrypt + atomic JSON file store) serving the existing static frontend. Store interface isolates persistence so Postgres can replace files later. Frontend talks to `/api/*` with cookie sessions; localStorage becomes a check-in offline queue only.

**Tech Stack:** Node 24 built-ins only, existing `node:test` suite, staticperienced vanilla frontend.

**Spec:** `docs/superpowers/specs/2026-10-05-eventouch-product-backend-design.md`

## Global Constraints

- No new runtime dependencies; Node built-ins only.
- Korean UI copy preserved; brand tokens untouched.
- Secrets via env only; never committed, logged, or snapshotted.
- All write APIs verify role server-side mirroring canRoute/requireWrite.
- File writes atomic (tmp + rename); uploads size-capped; no path traversal.
- Existing 14 route IDs, ETKO data shapes (store v1) and feature semantics preserved.

## Review Focus

- Forged/expired session cookie on a write route must be rejected without leaking user existence — test with tampered and expired cookies.
- Two concurrent check-in writes must not lose either record — test back-to-back mutations persist both.
- Oversized file upload must be rejected before buffering unboundedly — test over-limit upload fails fast.
- `../` in a file key must never escape STORAGE_DIR — test traversal key rejected.
- Unknown event ID on any domain route must fail closed in Korean — test per resource.
- Offline check-in queue replay after reconnect must not duplicate entries — test replay dedupe.

---

### Task 1: Atomic file store

**Files:**
- Create: `server/store.js`
- Test: `tests/server-store.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `openStore(dataDir)` → `{ read(name)`, `write(name, value)`, `update(name, fn) }`; collections as plain JSON objects; tmp+rename atomicity; missing file reads as `{}`.

- [ ] **Step 1: Write failing tests** in `tests/server-store.test.cjs`: `store-roundtrip-persists-object`, `store-missing-file-reads-empty`, `store-update-applies-mutator`, `store-write-leaves-no-tmp`.
- [ ] **Step 2: Run** `node --test tests/server-store.test.cjs` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `openStore(dataDir)` in `server/store.js` with `fs.readFileSync`/`writeFileSync` + rename; `update` reads, applies, writes.
- [ ] **Step 4: Run** `node --test tests/server-store.test.cjs` — Expected: PASS.
- [ ] **Step 5: Commit** as `feat: add atomic file store`.

### Task 2: Server skeleton, static files, health

**Files:**
- Create: `server/server.js`
- Test: `tests/server-skeleton.test.cjs`

**Interfaces:**
- Consumes: nothing (static only).
- Produces: `PORT` env (default `8776`); serves repo-root static with correct content types; `GET /api/health` → `{ ok: true, version: 1 }`; unknown `/api/*` → 404 JSON Korean.

- [ ] **Step 1: Write failing tests**: `health-returns-ok`, `static-serves-index`, `unknown-api-404-korean`. Spawn server on ephemeral port via `PORT=0`? Use fixed test port `18776` to keep assertions exact.
- [ ] **Step 2: Run** `node --test tests/server-skeleton.test.cjs` — Expected: FAIL.
- [ ] **Step 3: Implement** `server/server.js` with `node:http`, safe path join (reject `..`), minimal mime map.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** as `feat: add static server skeleton`.

### Task 3: Auth with roles and sessions

**Files:**
- Create: `server/auth.js`
- Modify: `server/server.js` (mount `/api/auth/*`, cookie parse, session attach)
- Test: `tests/server-auth.test.cjs`

**Interfaces:**
- Consumes: `openStore` from Task 1.
- Produces: `hashPassword(pw)`, `verifyPassword(pw, hash)` (scrypt), `createSession(store, userId)`, `sessionFromCookie(store, header)`; users collection `{ id, name, role, scope, hash }`; roles `AGENCY/MANAGER/CLIENT/STAFF/VIEWER`; seed admin from `ADMIN_PASSWORD` env (dev default flagged); `POST /api/auth/login|logout`, `GET /api/auth/me`; 401 Korean on bad credentials/session.

- [ ] **Step 1: Write failing tests**: `login-seeds-admin-and-sets-cookie`, `login-rejects-bad-password-korean`, `me-needs-session`, `logout-clears-session`, `tampered-cookie-rejected`, `expired-session-rejected`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `server/auth.js`; wire into server with `SESSION_TTL_HOURS` env (default 12).
- [ ] **Step 4: Run full auth tests** — Expected: PASS.
- [ ] **Step 5: Commit** as `feat: add session auth with roles`.

### Task 4: Domain APIs mirroring ETKO semantics

**Files:**
- Create: `server/api.js`
- Modify: `server/server.js` (mount `/api/*` behind session + `requireRole`)
- Test: `tests/server-api.test.cjs`

**Interfaces:**
- Consumes: store + session attach from Tasks 1–3.
- Produces: events CRUD + status forward-only (PRE→LIVE→END, Korean errors), participants CRUD + ticket/duplicate/capacity rules, checkin scan outcomes + correction with reason 5–200자, booths SELF|STAFF lock + quantity rules, engagement transitions (poll/quiz/qna/draw/survey/photo), content/messages (draft/reserve save, SIMULATION_ONLY send), results read-only + reports snapshot; STAFF/VIEWER gates mirror `requireWrite`; unknown IDs fail closed Korean.

- [ ] **Step 1: Write failing tests** per resource (one test per rule above, ≥14 tests).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `server/api.js` reusing store v1 shapes; seed from `data/sample.json` on first boot.
- [ ] **Step 4: Run** — Expected: PASS, plus `node --test tests/server-*.test.cjs`.
- [ ] **Step 5: Commit** as `feat: add domain APIs`.

### Task 5: File storage API

**Files:**
- Modify: `server/api.js` (`POST /api/files`, `GET /api/files/:key`), `server/server.js` (body cap)
- Test: `tests/server-files.test.cjs`

**Interfaces:**
- Consumes: session attach; `STORAGE_DIR` env (default `<repo>/data/storage`).
- Produces: multipart-free raw octet upload with `?name=` + content-type allowlist (png/jpeg/webp/pdf/json), 8MB cap, key = `<eventId>/<uuid>-<basename>`; traversal rejected; download sets content type; metadata recorded in store.

- [ ] **Step 1: Write failing tests**: `upload-roundtrip`, `upload-rejects-oversize`, `upload-rejects-traversal`, `download-needs-session`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** with streaming write + byte counting (fail fast).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** as `feat: add file storage API`.

### Task 6: Frontend server authority adapter

**Files:**
- Create: `features/server-sync.js`
- Modify: `app.js` (boot: try session/me, fall back to local demo with banner), `features/checkin.js` (offline queue replay with dedupe)
- Test: `tests/server-sync.test.cjs` + existing suite

**Interfaces:**
- Consumes: Tasks 3–5 endpoints.
- Produces: `ETKO.remote` (`get/post`, cookie sessions); server authoritative store; login view wiring to `/api/auth/login`; offline check-in queue in localStorage replayed once with server dedupe; demo banner when unreachable.

- [ ] **Step 1: Write failing tests**: `adapter-attaches-session`, `queue-replay-dedupes`, `unreachable-keeps-demo`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** adapter + minimal boot/login wiring; no route/brand changes.
- [ ] **Step 4: Run** full suite `node --test tests/*.test.cjs` — Expected: PASS.
- [ ] **Step 5: Browser verify** login→operate flow at 1280/390, console clean.
- [ ] **Step 6: Commit** as `feat: switch frontend to server authority`.

### Task 7: Deploy artifacts and final verification

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `vercel.json`, `.env.example`, `docs/DEPLOY.md`
- Test: existing suite + fresh reviewer + test-runner

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: container runs on `PORT`; compose mounts `./data` + `STORAGE_DIR` (NAS path documented, not mounted here); Vercel serves static with `/api/*` rewrite to central host (placeholder host, documented); no secrets in files.

- [ ] **Step 1: Write artifacts** (Dockerfile node:24-alpine, compose, vercel rewrite, env example, deploy doc with NAS mount + TLS checklist).
- [ ] **Step 2: Run** `node --test tests/*.test.cjs` — Expected: PASS.
- [ ] **Step 3: Independent test-runner** full suite + fresh reviewer of backend range.
- [ ] **Step 4: Commit** as `docs: add deploy artifacts`.
