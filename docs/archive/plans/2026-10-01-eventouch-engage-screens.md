# EVENTOUCH Engage Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 참여 기능(투표·퀴즈·Q&A·추첨·만족도·사진검토)을 브라우저 화면에서 열고 처리하고 결과를 확인할 수 있게 한다.

**Architecture:** `engage`를 일곱 번째 셸 섹션으로 추가한다(`VIEWS` 6→7, 레지스트리·내비·동기화 일괄 확장). 참여 렌더러는 `features/engagement.js` + `features/media.js` 규칙 위에 얹고, 상태 변경마다 마운트를 다시 렌더한다. 쓰기는 한글 `throw Error`, 렌더는 한글만.

**Tech Stack:** 바닐라 HTML/CSS/JS, `node --test` (CommonJS `*.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-eventouch-full-scope-design.md`

## Global Constraints

- All user-facing copy is Korean (html lang="ko").
- Preserve brand values: brand #F35B2C, action #BC3F1B, canvas #FAF8F5.
- Primary touch targets min 44px; field ticket input 52px.
- No real auth/billing/payments/devices; sample data labeled as sample; virtual roles labeled as demo.
- New rule functions throw `Error` with a Korean message on invalid input; never return English strings to UI.
- Booth QR identifier is exactly `ET:BOOTH:<eventId>:<boothId>` (public identifier, not an encrypted token).
- Queue/offline entries are pending, never success; rejections never queue or mutate.

## Review Focus

- Six-view contract drift (tests hardcoding 6 views) — expect intentional 7-view update with reasons.
- Unwired controls (visible button, no handler) — expect every control wired or removed.
- Role bypass (STAFF/CLIENT reaching engage writes) — expect requireWrite denial.
- Double-submit (double vote/answer/survey/draw-confirm via UI) — expect rule rejection surfaced in Korean.
- Silent English leak — expect Korean copy only.

---

### Task 1: Engage shell section (7th view)

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `features/views.js`
- Modify: `i18n/ko.json`
- Modify: `tests/nav.test.cjs`, `tests/qa.test.cjs`, `tests/views.test.cjs`
- Test: `tests/engage-section.test.cjs`

**Interfaces:**
- Consumes: registry pattern (Task 1 of journeys plan), `ETKO.navigate` gate.
- Produces: `VIEWS` 7 entries with `engage`; nav button `참여`; section `engage-view` + mount `engage-mount` gated behind navigate; registry 7th entry `{id:'engage', section:'engage-view', mount:'engage-mount', labelKey:'engage'}`; `ko.json` gains `engage: 참여`.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement section + VIEWS + registry + ko.json + update 6-view tests**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add index.html app.js features/views.js i18n/ko.json tests/
git commit -m "feat: add engage shell section"
```

### Task 2: Poll + quiz management UI

**Files:**
- Modify: `features/engagement.js` (add `renderEngagement` mount renderer)
- Modify: `index.html` (inline sync: engage branch)
- Test: `tests/engage-ui.test.cjs`

**Interfaces:**
- Consumes: `setPollStatus/vote/pollCounts`, `setQuizStatus/answerQuiz/revealQuiz`, workspace poll/quiz.
- Produces: `ETKO.renderEngagement(container)` shows poll open/close + options + counts and quiz status + answer + reveal, all buttons wired (`data-poll-open/close`, `data-quiz-reveal`, option buttons), errors surface Korean inline, 44px targets.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + shell branch**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/engagement.js index.html styles/tokens.css tests/engage-ui.test.cjs
git commit -m "feat: wire poll and quiz management UI"
```

### Task 3: Q&A + draw + survey + photo moderation UI

**Files:**
- Modify: `features/engagement.js`, `features/media.js` (extend renderers)
- Modify: `index.html` (inline sync)
- Test: `tests/engage-ui2.test.cjs`

**Interfaces:**
- Consumes: `ask/approveQna/selectQna`, `startDraw/resolveDraw/confirmDraw`, `submitSurvey`, `uploadPhoto/moderatePhotos/wallPhotos`.
- Produces: same mount renders Q&A pending list with 승인/무대 buttons, draw start/confirm with winner display, survey open toggle + response count, photo pending list with 공개/숨김 buttons; every action re-renders with Korean feedback.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderers + shell branch**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/engagement.js features/media.js index.html styles/tokens.css tests/engage-ui2.test.cjs
git commit -m "feat: wire qna draw survey and photo UI"
```
