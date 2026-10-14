# EVENTOUCH 전체 범위 구축 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OD 리파인(5계층·상태 전이 동작)과 동일한 전체 운영 흐름을 제품 폴더에 바닐라 JS로 구현한다.

**Architecture:** `window.ETKO` 네임스페이스에 행사별 `ETKO.store`를 두고 기능별 `features/*.js`가 순수 규칙을 제공한다.
쓰기는 한글 메시지 `throw Error`로 거절하고, 렌더 함수는 한글만 출력한다. `node --test`로 규칙을 검증한다.

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

### Task 1: Store, roles, agency shell

**Files:**
- Create: `features/agency.js`
- Test: `tests/agency.test.cjs`

**Interfaces:**
- Consumes: `ETKO.sample` (data/sample.json participants for seed event).
- Produces: `ETKO.store = { events:[{id,name,date,venue,status}], workspaces:{[eventId]:workspace}, activeEventId, role }`;
  `ETKO.setRole(role)` (unknown keeps current); `ETKO.canRoute(role, route)->boolean`;
  `ETKO.createEvent({name,date,venue})->{id}` (empty workspace, status PRE, no cloned records);
  `ETKO.switchEvent(id)` (unknown throws `행사를 찾을 수 없습니다`); `ETKO.workspace()` (active workspace or throw).

- [ ] **Step 1: Write the failing test**

```js
// tests/agency.test.cjs
const assert = require('node:assert');
require('../features/agency.js');
assert.throws(() => ETKO.switchEvent('nope'), /행사를 찾을 수 없습니다/);
assert.equal(ETKO.canRoute('VIEWER', 'checkin'), false);
assert.equal(ETKO.canRoute('AGENCY', 'checkin'), true);
// Cross-event isolation: second event starts empty, first event untouched.
const id2 = ETKO.createEvent({ name: '제2행사', date: '2026-11-01', venue: 'B홀' });
ETKO.switchEvent(id2);
assert.deepEqual(ETKO.workspace().participants, []);
ETKO.switchEvent('evt-1');
assert.ok(ETKO.workspace().participants.length > 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agency.test.cjs`
Expected: FAIL (ETKO.switchEvent is not a function)

- [ ] **Step 3: Implement `features/agency.js`** with `ETKO.store`, seed event `evt-1`
(seed workspace participants as copies of `ETKO.sample` participants plus `everIn:false`, `group:'일반'`;
seed poll/quiz/survey defaults, `boothMode:'SELF'`), roles `AGENCY|MANAGER|CLIENT|STAFF|VIEWER`, route table
(STAFF: overview/participants/checkin/booths/staff/qna/photos; CLIENT/VIEWER read-only subset;
MANAGER all event routes; AGENCY all), `createEvent` (3-field validation, Korean errors, empty workspace),
`switchEvent`, `workspace()`. Also add `ETKO.saveMember({id?,name,email,role})` with email-format validation
for the event-members tab.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agency.test.cjs tests/*.test.cjs`
Expected: all PASS, previous 57 still PASS.

- [ ] **Step 5: Commit**

```bash
git add features/agency.js tests/agency.test.cjs
git commit -m "feat: event store with roles and agency shell"
```

### Task 2: Registration form + signup

**Files:**
- Create: `features/registration.js`
- Test: `tests/registration.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (Task 1); workspace holds `fields`, `participants`, `formVersion`.
- Produces: `ETKO.setFields(fields)` (select needs ≥2 options, name/phone undeletable);
  `ETKO.validateSignup(payload)->{formVersion}` (throws Korean on missing required/invalid select/email);
  `ETKO.register(payload)->participant` (duplicate name+phone throws `이미 등록한 참가자입니다`,
  capacity throws `등록 정원이 마감되었습니다`).

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/registration.js');
assert.throws(() => ETKO.register({ name: '', phone: '' }), /이름/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/registration.test.cjs`
Expected: FAIL (ETKO.register is not a function)

- [ ] **Step 3: Implement `features/registration.js`** with default fields
(name/phone required; company/email/selects optional), validation per spec §3, capacity check, id `p<N>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/registration.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/registration.js tests/registration.test.cjs
git commit -m "feat: registration form config and signup validation"
```

### Task 3: Desk units, history, correction

**Files:**
- Create: `features/desks.js`
- Test: `tests/desks.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()`; workspace holds `units`, `logs`.
- Produces: `ETKO.saveUnit({id?,name,action:'IN'|'OUT',mode:'desk'|'tablet'|'kiosk'})`;
  `ETKO.recordScan({participantId,action,unitId})` (reuses check.scan semantics: duplicate throws `이미 처리되었습니다`,
  stores before/after); `ETKO.correctLog(logId, reason)` (reason 5~200자, only latest log per participant,
  throws Korean otherwise); `ETKO.history()` newest-first.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/desks.js');
assert.throws(() => ETKO.saveUnit({ name: '', action: 'IN', mode: 'desk' }), /데스크 이름/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/desks.test.cjs`
Expected: FAIL (ETKO.saveUnit is not a function)

- [ ] **Step 3: Implement `features/desks.js`** with unit validation, scan recording
(IN sets status IN + everIn, OUT sets registered-equivalent `OUT`), immutable log entries with before/after,
correction restoring beforeState and unshifting a CORRECTION entry.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/desks.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/desks.js tests/desks.test.cjs
git commit -m "feat: desk units with scan history and correction"
```

### Task 4: Booth lifecycle with single-mode lock

**Files:**
- Create: `features/booths.js`
- Test: `tests/booths.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (holds `boothMode:'SELF'|'STAFF'`, `booths`, `visits`); existing `ETKO.nextAction` copy stays consistent.
- Produces: `ETKO.setEventBoothMode(mode, {acknowledge})` (refuses without acknowledge `인증 방향과 적용 범위를 확인하세요`,
  refuses after visits exist `인증 기록이 있는 행사는 방식을 변경할 수 없습니다`);
  `ETKO.saveBooth({id?,name,capacity,limit,status,startsAt?,endsAt?})` (capacity < used refuses);
  `ETKO.setBoothStatus(id, 'OPEN'|'WAITING'|'CLOSED')`; `ETKO.stamp({boothId,participantId,at?})`
  (validates status OPEN, time window, capacity, per-person limit; returns visit);
  `ETKO.boothPayload(eventId, boothId)` returns exactly `` `ET:BOOTH:${eventId}:${boothId}` ``.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/booths.js');
assert.equal(ETKO.boothPayload('evt-1', 'b1'), 'ET:BOOTH:evt-1:b1');
assert.throws(() => ETKO.setEventBoothMode('STAFF', {}), /확인하세요/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/booths.test.cjs`
Expected: FAIL (ETKO.boothPayload is not a function)

- [ ] **Step 3: Implement `features/booths.js`** per spec §3 (Korean errors, reuses `ET:BOOTH` format).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/booths.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/booths.js tests/booths.test.cjs
git commit -m "feat: booth lifecycle with single-mode lock and stamp rules"
```

### Task 5: Polls + quizzes

**Files:**
- Create: `features/engagement.js`
- Test: `tests/engagement.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (holds `poll:{title,options,votes,status}`, `quiz:{title,answer,status,answers}`, participants).
- Produces: `ETKO.setPollStatus('OPEN'|'CLOSED')`; `ETKO.vote(participantId, option)`
  (closed throws `투표가 마감되었습니다`, repeat throws `이미 투표했습니다`);
  `ETKO.pollCounts()->{counts,total}`; `ETKO.setQuizStatus('OPEN'|'CLOSED')`;
  `ETKO.answerQuiz(participantId, answer)` (closed/repeat/empty-200자 검증);
  `ETKO.revealQuiz()` (closes + reveals answer).

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/engagement.js');
ETKO.setPollStatus('OPEN');
assert.throws(() => ETKO.vote('ghost', 0), /참가자를 찾을 수 없습니다/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engagement.test.cjs`
Expected: FAIL (ETKO.setPollStatus is not a function)

- [ ] **Step 3: Implement poll+quiz section of `features/engagement.js`**.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engagement.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/engagement.js tests/engagement.test.cjs
git commit -m "feat: polls and quizzes with single-vote rules"
```

### Task 6: Q&A + lucky draw + survey

**Files:**
- Modify: `features/engagement.js`
- Test: `tests/engagement2.test.cjs`

**Interfaces:**
- Consumes: Task 5 file; workspace holds `qna`, `draw:{phase,result,history,winners}`, `survey:{questions,open}`, `responses`.
- Produces: `ETKO.ask(participantId, question)` (600자); `ETKO.approveQna(id, approved)`;
  `ETKO.selectQna(id)` (unapproved throws `공개 승인한 질문만 선택할 수 있습니다`);
  `ETKO.startDraw()` (pool = IN participants not yet winners; empty throws `추첨 대상이 없습니다`);
  `ETKO.resolveDraw(randomInt?)`; `ETKO.confirmDraw()`;
  `ETKO.submitSurvey(participantId, scores)` (length match + 1~5 integers, repeat throws `이미 평가를 제출했습니다`).

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/engagement.js');
assert.throws(() => ETKO.confirmDraw(), /확정할 당첨 결과/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engagement2.test.cjs`
Expected: FAIL (ETKO.confirmDraw is not a function)

- [ ] **Step 3: Implement Q&A/draw/survey section** (draw uses injectable randomInt for tests).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engagement2.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/engagement.js tests/engagement2.test.cjs
git commit -m "feat: qna approval, lucky draw and survey"
```

### Task 7: Photo review + wall + screen output

**Files:**
- Create: `features/media.js`
- Test: `tests/media.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (holds `photos`, `product:{presentation,media}`).
- Produces: `ETKO.uploadPhoto(participantId, {caption,data})` (data-URL JPEG/PNG/WebP ≤1MB guard by length,
  max 3 stored with data); `ETKO.moderatePhotos(ids, 'APPROVED'|'PENDING'|'HIDDEN')`;
  `ETKO.wallPhotos()` (approved only); `ETKO.setWall({layout:'grid'|'spotlight',seconds:3..60})`;
  `ETKO.setOutput({type:'idle'|'media'|'poll'|'quiz'|'draw'|'photos',assetId?})` (unknown asset throws).

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/media.js');
assert.deepEqual(ETKO.wallPhotos(), []);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/media.test.cjs`
Expected: FAIL (ETKO.wallPhotos is not a function)

- [ ] **Step 3: Implement `features/media.js`** (photo like-toggle optional; keep minimal: upload/moderate/wall/output).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/media.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/media.js tests/media.test.cjs
git commit -m "feat: photo review, photowall and screen output"
```

### Task 8: Campaigns + templates (simulation only)

**Files:**
- Create: `features/messaging.js`
- Test: `tests/messaging.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (holds `templates`, `messages`); `ETKO.campaignReview` semantics.
- Produces: `ETKO.saveTemplate({id?,name,channel,content})`; `ETKO.deleteTemplate(id)`;
  `ETKO.createCampaign({title,channel,target,recipientIds,content,scheduled?})`
  (freezes recipientIds array, validates members exist at submit, sets `status:'DRAFT'|'SCHEDULED'`,
  `delivery:'SIMULATION_ONLY'`, `cost:null`; never claims sending).

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/messaging.js');
assert.throws(() => ETKO.createCampaign({ title: '', channel: 'SMS', target: '전체', recipientIds: [], content: 'hi' }), /발송 대상/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/messaging.test.cjs`
Expected: FAIL (ETKO.createCampaign is not a function)

- [ ] **Step 3: Implement `features/messaging.js`** (target filter: 전체/체크인 참가자/미입장 참가자/선택 참가자).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/messaging.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/messaging.js tests/messaging.test.cjs
git commit -m "feat: messaging campaigns with frozen targets, simulation only"
```

### Task 9: Program, notices, venue, board, participant home

**Files:**
- Create: `features/content.js`
- Test: `tests/content.test.cjs`

**Interfaces:**
- Consumes: `ETKO.workspace()` (holds `program`, `notices`, `venue`, `posts`).
- Produces: `ETKO.saveProgram({id?,title,time,end,location})` (end>start same-day validation);
  `ETKO.deleteProgram(id)`; `ETKO.saveNotice({id?,title,body,pinned?})`;
  `ETKO.saveVenue({name,address?,description?})`; `ETKO.createPost(participantId, body)` (300자);
  `ETKO.homeNow()` returns `{now,next}` program rows for participant home.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/content.js');
assert.throws(() => ETKO.saveProgram({ title: 't', time: '10:00', end: '09:00', location: 'hall' }), /종료는 시작보다/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/content.test.cjs`
Expected: FAIL (ETKO.saveProgram is not a function)

- [ ] **Step 3: Implement `features/content.js`**.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/content.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/content.js tests/content.test.cjs
git commit -m "feat: program, notices, venue, board and home feed"
```

### Task 10: Report snapshot, settings, shell wiring, QA

**Files:**
- Create: `features/results.js`
- Modify: `index.html`, `styles/tokens.css`, `i18n/ko.json`
- Test: `tests/results.test.cjs`, `tests/qa2.test.cjs`

**Interfaces:**
- Consumes: all Tasks 1–9 stores; `ETKO.navigate` (Task 2 of previous plan).
- Produces: `ETKO.eventSummary()->{total,checked,inside,notArrived,rate}`;
  `ETKO.createReport({title,summary})` (deep-frozen snapshot: metrics+approved photos; later check-ins never mutate it);
  `ETKO.updateEvent(patch)` (name/date/venue/status/capacity validation);
  `ETKO.setEventFeatures(features)`; index.html mounts every workspace section behind `ETKO.navigate`
  with Korean labels for all new keys; CSS keeps 44px/52px/focus; qa2 asserts
  320/390/768/1440 contract markers (viewport meta, wrapper scroll, breakpoints), no `data-action="toast"` dead ends,
  no raw `SELF/STAFF/PENDING` in rendered HTML.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert');
require('../features/agency.js'); require('../features/results.js');
assert.throws(() => ETKO.createReport({ title: '' }), /보고서 제목/);
// Snapshot immutability: later state changes never mutate a created report.
const r = ETKO.createReport({ title: '결산', summary: '총평' });
const before = JSON.stringify(r.metrics);
ETKO.workspace().participants.push({ id: 'px', name: '추가', status: 'IN', everIn: true });
assert.equal(JSON.stringify(r.metrics), before);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/results.test.cjs`
Expected: FAIL (ETKO.createReport is not a function)

- [ ] **Step 3: Implement `features/results.js` + wire `index.html`/CSS/ko.json** for all new sections.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/results.test.cjs tests/qa2.test.cjs tests/*.test.cjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add features/results.js index.html styles/tokens.css i18n/ko.json tests/results.test.cjs tests/qa2.test.cjs
git commit -m "feat: report snapshots, settings and full shell wiring with QA"
```
