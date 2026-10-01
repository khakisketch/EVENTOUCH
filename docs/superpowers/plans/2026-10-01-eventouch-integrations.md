# EVENTOUCH Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부 연동(인증·메시지·결제·장비)을 설정 기반 provider 구조로 연결하고, 기본값 SIMULATION으로 브라우저 완결 흐름을 유지한다.

**Architecture:** `features/integrations.js`에 provider 레지스트리 + 모드(`SIMULATION` 고정 기본)를 두고, 영역별 어댑터(`auth/messages/payments/devices`)가 동일 인터페이스로 호출된다. 실제 외부 호출은 하지 않고, provider 교체 지점·발송함·주문 상태를 테스트로 고정한다.

**Tech Stack:** 바닐라 HTML/CSS/JS, `node --test` (CommonJS `*.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-eventouch-full-scope-design.md`

## Global Constraints

- All user-facing copy is Korean (html lang="ko").
- Preserve brand values: brand #F35B2C, action #BC3F1B, canvas #FAF8F5.
- Primary touch targets min 44px; field ticket input 52px.
- No real auth/billing/payments/devices calls; simulation labeled; virtual roles labeled as demo.
- New rule functions throw `Error` with a Korean message on invalid input; never return English strings to UI.
- Booth QR identifier is exactly `ET:BOOTH:<eventId>:<boothId>` (public identifier, not an encrypted token).
- Queue/offline entries are pending, never success; rejections never queue or mutate.

## Review Focus

- Provider override leaking into other areas — expect per-area isolation.
- Real-send claims (status SENT, charged payments) — expect SIMULATION_ONLY and null cost.
- Auth role escalation (login granting wider role than member record) — expect member-record match.
- Device payload forgery (hand-written QR accepted) — expect strict format + existence check.
- Silent English leak — expect Korean copy only.

---

### Task 1: Provider registry + mode

**Files:**
- Create: `features/integrations.js`
- Modify: `index.html`
- Test: `tests/integrations.test.cjs`

**Interfaces:**
- Consumes: nothing (standalone).
- Produces: `ETKO.integrationMode()` → `'SIMULATION'`; `ETKO.registerProvider(area, name, impl)` (unknown area throws `연동 영역을 확인하세요`); `ETKO.providerFor(area)` returns registered or built-in simulation provider; areas: `auth|messages|payments|devices`.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/integrations.js');
assert.equal(ETKO.integrationMode(), 'SIMULATION');
assert.throws(() => ETKO.registerProvider('nope', 'x', {}), /연동 영역/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integrations.test.cjs`
Expected: FAIL (ETKO.integrationMode is not a function)

- [ ] **Step 3: Implement `features/integrations.js`** with area table, simulation defaults, per-area provider slots.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/integrations.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/integrations.js index.html tests/integrations.test.cjs
git commit -m "feat: add integration provider registry"
```

### Task 2: Auth adapter (demo sessions, no real backend)

**Files:**
- Modify: `features/integrations.js`
- Test: `tests/integration-auth.test.cjs`

**Interfaces:**
- Consumes: Task 1 registry; `ETKO.saveMember` member records.
- Produces: `ETKO.login({email, role?})` → `{token, role, demo:true}` (unknown email throws `등록된 구성원이 아닙니다`; role mismatch throws `권한을 확인하세요`); `ETKO.logout()` clears session; `ETKO.session()` returns copy or null. Tokens are `DEMO-` prefixed opaque strings, never passwords.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement auth section**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git add features/integrations.js tests/integration-auth.test.cjs
git commit -m "feat: add demo auth sessions"
```

### Task 3: Message sender adapter (outbox, simulation default)

**Files:**
- Modify: `features/integrations.js`
- Test: `tests/integration-messages.test.cjs`

**Interfaces:**
- Consumes: Task 1 registry; workspace templates/campaigns.
- Produces: `ETKO.sendCampaign(campaignId)` → `{status:'QUEUED_SIMULATION', outboxId}` writes immutable outbox entry `{channel, toCount, body, at}`; real provider hook called only when area provider replaced (default never sends).

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement messages section**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git add features/integrations.js tests/integration-messages.test.cjs
git commit -m "feat: add simulated message outbox"
```

### Task 4: Payment adapter (intents, never charged)

**Files:**
- Modify: `features/integrations.js`
- Test: `tests/integration-payments.test.cjs`

**Interfaces:**
- Consumes: Task 1 registry.
- Produces: `ETKO.createPaymentIntent({amount, currency?, description?})` → `{id, status:'SIMULATION_ONLY', amount, charged:false}`; amount must be positive integer else `결제 금액을 확인하세요`; `ETKO.paymentStatus(id)` reads back; unknown id throws `결제 내역을 찾을 수 없습니다`.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement payments section**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git add features/integrations.js tests/integration-payments.test.cjs
git commit -m "feat: add simulated payment intents"
```

### Task 5: Device adapters (QR/camera/printer/LED capability + validation)

**Files:**
- Modify: `features/integrations.js`
- Test: `tests/integration-devices.test.cjs`

**Interfaces:**
- Consumes: Task 1 registry; `ETKO.boothPayload`.
- Produces: `ETKO.parseBoothPayload(text)` → `{eventId, boothId}` or throws `부스 QR을 확인하세요`; `ETKO.deviceCaps()` → `{camera:false, printer:false, led:false, simulated:true}` with Korean labels via `ETKO.deviceLabel(key)`; `ETKO.markPrinted(boothId, format?)` records print confirmation (unknown booth throws `부스를 확인하세요`).

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement devices section**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git add features/integrations.js tests/integration-devices.test.cjs
git commit -m "feat: add device adapters with QR validation"
```

### Task 6: Integration contract doc (what is live vs stubbed)

**Files:**
- Create: `docs/INTEGRATIONS.md`

**Interfaces:**
- Consumes: Tasks 1–5 behavior.
- Produces: Korean doc listing per area: interface, default provider, what a real provider must implement, and explicit non-goals (no credentials in repo, no real sends/charges).

- [ ] **Step 1: Draft doc from implemented interfaces**
- [ ] **Step 2: Verify every named function exists** (`node -e` require check)
- [ ] **Step 3: Commit**

```bash
git add docs/INTEGRATIONS.md
git commit -m "docs: add integration contracts"
```
