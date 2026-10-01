# EVENTOUCH Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제품 진입점·단일 행사 상태·권한·업무 완료 흐름을 복구해 대행사가 브라우저만으로 준비~운영~결과를 끝낼 수 있게 한다.

**Architecture:** `window.ETKO` 네임스페이스 유지, 행사별 `ETKO.store/workspaces/activeEventId/role`를 단일 진실로 고정한다. `index.html`이 전 기능 스크립트를 순서대로 로드하고 `ETKO.navigate`가 권한·섹션·렌더를 일괄 게이트한다. 규칙 함수는 한글 `throw Error`로 거절하고 렌더는 한글만 출력한다.

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

- Cross-event leakage (participant/booth/record of event B visible or mutated from event A) — expect strict eventId scoping.
- Double-submit paths (double scan, double vote, double survey, double draw-confirm) — expect idempotent rejection.
- Mode-lock bypass (booth SELF↔STAFF change after visits exist) — expect refusal.
- Snapshot mutation (report numbers changing after later check-ins) — expect immutable copy.
- Silent English leak (raw keys like SELF/STAFF/PENDING rendered to screen) — expect Korean copy only.

---

### Task 1: Shell boot, script wiring, role-gated navigate

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Test: `tests/shell-boot.test.cjs`

**Interfaces:**
- Consumes: `features/agency.js` (`ETKO.store`, `ETKO.canRoute`, `ETKO.switchEvent`, `ETKO.workspace`), `features/results.js`, `i18n/ko.json`.
- Produces: `index.html` loads `app.js` + all `features/*.js` in dependency order; `ETKO.navigate(view)` enforces `ETKO.canRoute(currentRole, view)` except `openParticipantDetail` path; `ETKO.switchEventAndRender(id)` switches + re-syncs; render errors surface to `#app` Korean notice instead of silent catch.

- [ ] **Step 1: Write the failing test**

```js
// tests/shell-boot.test.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');
for (const f of ['features/agency.js','features/registration.js','features/desks.js','features/booths.js','features/engagement.js','features/media.js','features/messaging.js','features/content.js']) {
  assert.match(html, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/shell-boot.test.cjs`
Expected: FAIL (missing 8 feature scripts)

- [ ] **Step 3: Implement `index.html` script order + `app.js` role-gated navigate + `switchEventAndRender`**

`app.js` keeps `VIEWS` 6-view contract for legacy tests but adds `ETKO.REQUIRE_ROLE_VIEWS` mapping and `ETKO.currentRole()` reading `ETKO.store.role` when present. `navigate` checks `canRoute` when available; denied returns current view. Adds `ETKO.switchEventAndRender(id)` calling `switchEvent` then `syncViews`/`syncParticipantsView` when present.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/shell-boot.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js tests/shell-boot.test.cjs
git commit -m "fix: wire full feature shell with role-gated navigate"
```

### Task 2: Single source of truth (workspace participants + scan)

**Files:**
- Modify: `features/participants.js`
- Modify: `features/checkin.js`
- Modify: `features/desks.js`
- Test: `tests/store-truth.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (owns `participants`), `ETKO.sample` seed only.
- Produces: `ETKO.filterPeople(filters)` defaults to active workspace participants (not sample); `ETKO.scan(opts)` mutates workspace participant when `state` omitted; `ETKO.bulkCheckIn()` sets `everIn=true`; `ETKO.eventSummary()` consistent with directory counts.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/participants.js'); require('../features/checkin.js');
const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
ETKO.switchEvent(id2);
assert.equal(ETKO.peopleCounts().total, 0);
assert.equal(ETKO.filterPeople({}).length, 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/store-truth.test.cjs`
Expected: FAIL (directory still reads sample 5)

- [ ] **Step 3: Implement workspace-first `defaultPeople`, `scan` workspace fallback, `bulkCheckIn` everIn**

`defaultPeople()` returns `ETKO.workspace().participants` when store exists, else sample. `ETKO.scan` when `args.state` omitted builds `{people: workspace.participants, queue: workspace.scanQueue}` and writes back. `bulkCheckIn` sets `p.everIn=true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/store-truth.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/participants.js features/checkin.js features/desks.js tests/store-truth.test.cjs
git commit -m "fix: unify directory and scan on active workspace"
```

### Task 3: Correction, survey, Q&A hardening

**Files:**
- Modify: `features/desks.js`
- Modify: `features/engagement.js`
- Test: `tests/rule-hardening.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` logs/participants/qna/survey/responses.
- Produces: `ETKO.correctLog` clears `everIn` when corrected entry was participant's first IN; `ETKO.submitSurvey` requires `survey.open===true`; `ETKO.approveQna(id,false)` clears `selected` when unapproving selected item.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/desks.js'); require('../features/engagement.js');
ETKO.workspace().survey = { title: '만족도', questions: ['q1'], open: false };
assert.throws(() => ETKO.submitSurvey('p1', [4]), /마감|진행|설문/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/rule-hardening.test.cjs`
Expected: FAIL (closed survey accepts)

- [ ] **Step 3: Implement `correctLog` everIn recompute + survey open gate + Q&A selected clear**

`correctLog`: after restoring `status`, recompute `everIn` = any remaining non-corrected IN log for participant OR initial seed everIn? Simplest: if target.before was never-IN and no other IN logs remain, set `everIn=false`. `submitSurvey`: throw `설문이 마감되었습니다` when `!ws.survey.open`. `approveQna(false)`: when `item.selected` and unapproving, set `selected=false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/rule-hardening.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/desks.js features/engagement.js tests/rule-hardening.test.cjs
git commit -m "fix: harden correction survey and qna rules"
```

### Task 4: Write-command role enforcement

**Files:**
- Modify: `features/agency.js`
- Modify: `features/results.js`
- Test: `tests/role-write.test.cjs`

**Interfaces:**
- Consumes: `ETKO.canRoute`, `ETKO.store.role`.
- Produces: `ETKO.requireWrite(route)` throws `권한을 확인하세요` when `!canRoute(role,route)`; `createReport/saveMember/updateEvent/setEventFeatures` call it; `openParticipantDetail` remains STAFF-reachable exception (no route change).

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/results.js');
ETKO.setRole('VIEWER');
assert.throws(() => ETKO.createReport({ title: 'x' }), /권한/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/role-write.test.cjs`
Expected: FAIL (VIEWER creates report)

- [ ] **Step 3: Implement `requireWrite` + guard report/member/event/settings writes**

Add `ETKO.requireWrite(route)` in agency.js. Call in `saveMember('members')`, `createReport('results')`, `updateEvent('settings')`, `setEventFeatures('settings')`. Keep `canRoute` table untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/role-write.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/agency.js features/results.js tests/role-write.test.cjs
git commit -m "fix: enforce write-command roles"
```

### Task 5: Check-in, booth, participant-home wiring

**Files:**
- Modify: `index.html`
- Modify: `features/booth.js`
- Modify: `features/checkin.js`
- Test: `tests/flow-wiring.test.cjs`

**Interfaces:**
- Consumes: Task 1 shell, Task 2 store, `ETKO.scan`, `ETKO.setEventBoothMode`/`ETKO.setBoothMode`, `ETKO.nextAction`.
- Produces: ticket form submit calls workspace `scan` and renders Korean result + queue; booth toggle calls event mode with acknowledge + lock error surfacing; home CTA navigates to schedule/QR.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');
assert.match(html, /ticket-code/);
assert.match(html, /data-ticket-submit|requestSubmit|ETKO\.scan/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/flow-wiring.test.cjs`
Expected: FAIL (no submit wiring marker)

- [ ] **Step 3: Implement inline shell wiring for ticket submit + booth acknowledge + home CTA**

Add `data-ticket-submit` handler in index.html sync script: reads `#ticket-code`, calls `ETKO.scan({code, direction: ETKO.checkinDirection})`, renders via `renderCheckin`, clears input, focuses. Booth buttons call `setEventBoothMode` when available else `setBoothMode`, surfacing Korean throw in result panel. Home CTA click navigates.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/flow-wiring.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html features/booth.js features/checkin.js tests/flow-wiring.test.cjs
git commit -m "fix: wire checkin booth and home actions"
```

### Task 6: Accessibility and responsive hardening

**Files:**
- Modify: `styles/tokens.css`
- Modify: `index.html`
- Test: `tests/a11y.test.cjs`

**Interfaces:**
- Consumes: shell sections, dialog, switches, form controls.
- Produces: switches min 44px height + accessible names; dialog Esc closes + focus trap + return focus; poll option inputs labeled; no page-level horizontal scroll markers.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
const css = require('node:fs').readFileSync('styles/tokens.css','utf8');
assert.match(css, /\[role="switch"\][\s\S]*?min-height:\s*44px/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/a11y.test.cjs`
Expected: FAIL (switch height 25px)

- [ ] **Step 3: Implement CSS switch size + HTML aria-labels + dialog keyboard handling**

CSS: `[role="switch"]` min-height 44px. index.html: label ticket input already present; add `aria-label` to switches via JS render or static labels; dialog keydown Escape closes, focus first field on open, return focus on close.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/a11y.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add styles/tokens.css index.html tests/a11y.test.cjs
git commit -m "fix: harden a11y switches dialog and labels"
```

### Task 7: Honest QA harness + full verification

**Files:**
- Modify: `tests/qa2.test.cjs`
- Test: `tests/qa2.test.cjs`

**Interfaces:**
- Consumes: `index.html` script list, `app.js`, all features.
- Produces: qa2 loads exactly the scripts listed in `index.html` (no hidden direct loads); boot test asserts workspace-backed mounts render Korean; `node --test tests/*.test.cjs` green.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
// qa2 must derive script list from index.html, not hardcode agency+results only
const fs = require('node:fs');
const html = fs.readFileSync('index.html','utf8');
const listed = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m=>m[1]);
assert.ok(listed.includes('features/engagement.js'));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/qa2.test.cjs`
Expected: FAIL until qa2 rewritten (or PASS if already wired — then strengthen to boot assertion)

- [ ] **Step 3: Implement qa2 script-list-derived loader + boot assertions**

Rewrite `loadShell()` to parse `index.html` script srcs and vm-load them in order, then assert `ETKO.workspace`, `ETKO.vote`, `renderResults` mount Korean.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/qa2.test.cjs
git commit -m "test: make qa harness load real shell scripts"
```
