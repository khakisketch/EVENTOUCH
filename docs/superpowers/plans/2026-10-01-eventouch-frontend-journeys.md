# EVENTOUCH Frontend Journeys Implementation Plan (Slice 1: 행사 준비)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 화면·사용 흐름 중심으로 행사 준비 여정(행사 생성 → 설정 → 등록 양식 → 참가 신청 → 명단·티켓)을 브라우저에서 끝까지 완료할 수 있게 한다.

**Architecture:** 화면 정의를 `features/views.js` 레지스트리 한곳에 모아 셸(`index.html` + `app.js`)이 그대로 렌더하도록 전환한다. 업무 규칙은 기존 `features/*.js`를 그대로 사용하고, 여정은 기존 규칙 함수 위에 얹는다. 쓰기는 한글 `throw Error`로 거절하고 렌더는 한글만 출력한다.

**Tech Stack:** 바닐라 HTML/CSS/JS, `node --test` (CommonJS `*.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-eventouch-full-scope-design.md`

## Global Constraints

- All user-facing copy is Korean (html lang="ko").
- Preserve brand values: brand #F35B2C, action #BC3F1B, canvas #FAF8F5.
- Primary touch targets min 44px; field ticket input 52px.
- No real auth/billing/payments/devices; sample data labeled as sample; virtual roles labeled as demo.
- No silent auto-sync claims; product folder is source of truth.
- New rule functions throw `Error` with a Korean message on invalid input; never return English strings to UI.
- Booth QR identifier is exactly `ET:BOOTH:<eventId>:<boothId>` (public identifier, not an encrypted token).
- Queue/offline entries are pending, never success; rejections never queue or mutate.

## Review Focus

- Cross-event leakage (second event shows first event's participants) — expect empty workspace on create.
- Double-submit paths (double register, double scan) — expect Korean rejection without mutation.
- Role bypass (VIEWER writes, STAFF reaching denied views) — expect denial except scoped participant detail.
- Dead-end screens (button with no handler, mount that never renders) — expect every visible control wired.
- Silent English leak (raw keys rendered) — expect Korean copy only.

---

### Task 1: View registry (single definition of screens)

**Files:**
- Create: `features/views.js`
- Modify: `index.html`
- Test: `tests/views.test.cjs`

**Interfaces:**
- Consumes: `ETKO.views` (6-view contract), `i18n/ko.json` labels.
- Produces: `ETKO.viewRegistry()` returns `[{id, section, mount, labelKey}]` for the six shell views in nav order; `ETKO.sectionFor(view)`, `ETKO.mountFor(view)`; `index.html` inline sync reads the registry when present (falls back to its local map).

- [ ] **Step 1: Write the failing test**

```js
// tests/views.test.cjs
const assert = require('node:assert');
require('../features/views.js');
const reg = ETKO.viewRegistry();
assert.deepEqual(reg.map((v) => v.id), ['overview','participants','checkin','booth','participant','stage']);
assert.equal(ETKO.sectionFor('checkin'), 'checkin-view');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/views.test.cjs`
Expected: FAIL (ETKO.viewRegistry is not a function)

- [ ] **Step 3: Implement `features/views.js`** with the six-view registry plus section/mount/labelKey, and `sectionFor`/`mountFor` lookups (unknown returns null, never throws).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/views.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/views.js index.html tests/views.test.cjs
git commit -m "feat: add single view registry for shell screens"
```

### Task 2: Event-setup journey test (create → settings → form → register → roster)

**Files:**
- Test: `tests/journey-setup.test.cjs`

**Interfaces:**
- Consumes: `ETKO.createEvent/switchEvent`, `ETKO.updateEvent`, `ETKO.setFields/validateSignup/register`, `ETKO.peopleCounts/filterPeople`, `ETKO.eventSummary`.
- Produces: pinned journey — new event starts empty, settings patch applies, form v2 validates, duplicate rejected in Korean, roster + summary agree.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
// fresh load omitted for brevity
const id = ETKO.createEvent({ name: '여정행사', date: '2026-11-01', venue: 'B홀' });
ETKO.switchEvent(id);
assert.equal(ETKO.peopleCounts().total, 0);
ETKO.updateEvent({ capacity: 2 });
const p = ETKO.register({ name: '김여정', phone: '010-0000-0001' });
assert.ok(p.id);
assert.throws(() => ETKO.register({ name: '김여정', phone: '010-0000-0001' }), /이미 등록/);
assert.equal(ETKO.eventSummary().total, 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/journey-setup.test.cjs`
Expected: FAIL (missing capacity path or duplicate wording) — if it passes immediately, strengthen with over-capacity rejection.

- [ ] **Step 3: Implement minimal gap fixes only** (no new features; fix what the journey exposes, e.g. capacity enforcement in register if absent).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/journey-setup.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/journey-setup.test.cjs features/*.js
git commit -m "test: pin event-setup journey"
```
