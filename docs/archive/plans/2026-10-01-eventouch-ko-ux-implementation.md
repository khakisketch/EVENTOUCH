# EVENTOUCH KO UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OD 리파인(`eventouch-operations.html`)을 한국어 우선 실제 사용 흐름으로 제품 폴더에 구현한다.

**Architecture:** 단일 정적 앱으로 6개 서피스를 구현한다. 영어 하드코딩을 `i18n/ko.json` 사전으로 교체하고, 체크인·부스·무대 규칙을 테스트 가능한 순수 함수로 분리한다.

**Tech Stack:** Vanilla HTML/CSS/JS, OKLCH Warm Operations tokens, `node --test`

**Spec:** OD project `eventouch-a82e` / `eventouch-operations.html` + `brand-spec.md`; domain reference `EVENTOUCH_UX_Refinement_v5_Preview.html` (QR direction, IN/OUT, SELF/STAFF single-mode, disclosure re-check)

## Global Constraints

- All user-facing copy is Korean (`html lang="ko"`).
- Preserve brand values: brand `#F35B2C`, action `#BC3F1B`, canvas `#FAF8F5`.
- Primary touch targets min 44px; field ticket input 52px.
- No real auth/billing/payments/devices; sample data labeled as sample.
- No silent auto-sync claims; product folder is source of truth.

## Review Focus

- Duplicate IN while an offline IN is queued must not create a second entry; expect warn + no state change.
- Booth badge QR at check-in must be rejected as wrong-kind; expect typed guidance, not generic error.
- Other-event ticket must not check in; expect wrong-event guidance.
- Offline scans queue without marking status; sync applies them once.
- Stage TAKE requires both disclosure checks; Preview change alone must not alter Program.

---

### Task 1: Scaffold, tokens, sample data

**Files:**
- Create: `index.html`
- Create: `styles/tokens.css`
- Create: `data/sample.json`
- Test: `tests/i18n.test.cjs`

**Interfaces:**
- Consumes: OD `brand-spec.md` tokens
- Produces: `window.ETKO` namespace; `fetch('data/sample.json')` shape `{participants:[{id,name,email,ticket,status,code}]}`

- [ ] **Step 1: Write the failing test**

```js
// tests/i18n.test.cjs: ko.json has overview/participants/checkin/booth/home/stage keys, no empty values
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/i18n.test.cjs`
Expected: FAIL with "ko.json not found"

- [ ] **Step 3: Implement scaffold + `i18n/ko.json` + tokens + sample data**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/i18n.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.html styles/tokens.css i18n/ko.json data/sample.json tests/i18n.test.cjs
git commit -m "feat: scaffold ko-first shell with tokens and sample data"
```

### Task 2: App shell, navigation, Korean copy

**Files:**
- Modify: `index.html`
- Create: `app.js`
- Create: `i18n/ko.json`
- Test: `tests/nav.test.cjs`

**Interfaces:**
- Consumes: `window.ETKO`, `i18n/ko.json`
- Produces: `ETKO.navigate(view)`, views `overview|participants|checkin|booth|participant|stage`

- [ ] **Step 1: Write the failing test**

```js
// nav labels equal ko.json values; unknown view keeps current view
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nav.test.cjs`
Expected: FAIL

- [ ] **Step 3: Implement `ETKO.navigate(view)` + `data-view` wiring + `lang="ko"` shell**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/nav.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 3: Participants directory (table + cards)

**Files:**
- Create: `features/participants.js`
- Modify: `index.html`
- Test: `tests/participants.test.cjs`

**Interfaces:**
- Consumes: `ETKO.navigate`, sample participants
- Produces: `ETKO.filterPeople({q,ticket,status})`, selection set preserved across render

- [ ] **Step 1: Write the failing test**

```js
// search by name/email/code; VIP filter; IN filter; empty result copy in Korean
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/participants.test.cjs`
Expected: FAIL

- [ ] **Step 3: Implement table + mobile cards + counts + bulk IN**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/participants.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 4: Check-in desk with typed results + offline queue

**Files:**
- Create: `features/checkin.js`
- Test: `tests/checkin.test.cjs`

**Interfaces:**
- Consumes: `ETKO.filterPeople`
- Produces: `ETKO.scan({code,direction,online,state}) -> {kind:'good'|'warn'|'bad',key}` with keys `success|duplicate|not-in|wrong-kind|wrong-event|not-found|queued`

- [ ] **Step 1: Write the failing test**

```js
// BADGE-14 -> wrong-kind; VIP-7781 -> wrong-event; duplicate IN (incl. queued) -> warn no-op; OUT without IN -> not-in; offline -> queued
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/checkin.test.cjs`
Expected: FAIL

- [ ] **Step 3: Implement direction toggle, result panel, queue list + sync**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/checkin.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 5: Booth mode + participant home next-action

**Files:**
- Create: `features/booth.js`
- Test: `tests/booth.test.cjs`

**Interfaces:**
- Consumes: `ETKO.scan`
- Produces: `ETKO.boothMode: 'SELF'|'STAFF'`, `ETKO.nextAction(status) -> ko copy key`

- [ ] **Step 1: Write the failing test**

```js
// SELF copy asks booth QR scan; STAFF copy asks ticket show; IN flips home CTA
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/booth.test.cjs`
Expected: FAIL

- [ ] **Step 3: Implement event-wide mode switch + home CTA sync**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/booth.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 6: Live control disclosure + stage safety

**Files:**
- Create: `features/stage.js`
- Test: `tests/stage.test.cjs`

**Interfaces:**
- Consumes: `ETKO.navigate`
- Produces: `ETKO.canTake({disclose,confirm}) -> boolean`; `ETKO.safety(mode)` for `BLACK|HOLD|LOGO`

- [ ] **Step 1: Write the failing test**

```js
// TAKE disabled until both disclosure + both confirm checks; BLACK/HOLD/LOGO copy in Korean
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/stage.test.cjs`
Expected: FAIL

- [ ] **Step 3: Implement two-stage dialog + safety outputs + reduced-motion toggle**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/stage.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 7: Responsive + accessibility QA

**Files:**
- Modify: `styles/tokens.css`
- Modify: `index.html`
- Test: `tests/qa.test.cjs`

**Interfaces:**
- Consumes: all views
- Produces: 320/390/1440 no horizontal scroll; visible focus; live regions

- [ ] **Step 1: Write the failing test**

```js
// required aria labels present; focus style token exists; tables scroll inside wrapper only
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/qa.test.cjs`
Expected: FAIL

- [ ] **Step 3: Implement breakpoint fixes + `aria-live` + focus tokens**
- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/qa.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**
