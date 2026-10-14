# EVENTOUCH Content Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 행사 콘텐츠(프로그램·공지·행사장·게시판)와 메시지(템플릿·캠페인·발송함)를 브라우저 화면에서 작성·관리·확인할 수 있게 한다.

**Architecture:** `content`·`messages`를 여덟·아홉 번째 셸 섹션으로 추가한다(`VIEWS` 7→9, 레지스트리·내비·게이트·라벨 일괄 확장). 렌더러는 기존 `content.js`·`messaging.js`·`integrations.js` 규칙 위에 얹고 상태 변경마다 마운트를 다시 렌더한다. 쓰기는 한글 `throw Error`, 렌더는 한글만.

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

- View-count contract drift (tests hardcoding 7 views) — expect intentional 9-view update.
- Unwired controls — expect every visible control wired with Korean feedback.
- Role bypass (CLIENT/VIEWER writes, STAFF sending) — expect requireWrite denial.
- Campaign double-send (same campaign queued twice) — expect each send recorded, never SENT.
- Silent English leak — expect Korean copy only.

---

### Task 1: Content + messages shell sections (8th/9th views)

**Files:**
- Modify: `index.html`, `app.js`, `features/views.js`, `i18n/ko.json`
- Modify: `tests/nav.test.cjs`, `tests/qa.test.cjs`, `tests/views.test.cjs`
- Test: `tests/content-section.test.cjs`

**Interfaces:**
- Consumes: registry pattern, `ETKO.navigate` gate.
- Produces: `VIEWS` 9 entries (+`content`, +`messages`); nav buttons 콘텐츠/메시지; sections `content-view`/`messages-view` + mounts gated behind navigate; registry entries; `ko.json` gains `content: 콘텐츠` (`messages` exists); role tables + `allowed` gain both routes (STAFF: content visible? no — field only; CLIENT/VIEWER: read-only both).

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement sections + VIEWS + registry + ko.json + gates + update 7-view tests**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add index.html app.js features/views.js features/agency.js i18n/ko.json tests/
git commit -m "feat: add content and messages shell sections"
```

### Task 2: Content management UI (program/notice/venue/board)

**Files:**
- Modify: `features/content.js` (add `renderContent`)
- Modify: `index.html` (inline sync: content branch)
- Test: `tests/content-ui.test.cjs`

**Interfaces:**
- Consumes: `saveProgram/deleteProgram`, `saveNotice`, `saveVenue`, `createPost`, workspace slices.
- Produces: `ETKO.renderContent(container)` with program add/delete (title/time/end/location + validation errors), notice publish, venue save, board list; all buttons wired (`data-program-add/del`, `data-notice-add`, `data-venue-save`), errors as Korean `role=alert`, 44px targets.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + shell branch**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/content.js index.html styles/tokens.css tests/content-ui.test.cjs
git commit -m "feat: wire content management UI"
```

### Task 3: Messaging UI (templates/campaign compose/outbox/send)

**Files:**
- Modify: `features/messaging.js` (add `renderMessaging`)
- Modify: `index.html` (inline sync: messages branch)
- Test: `tests/messaging-ui.test.cjs`

**Interfaces:**
- Consumes: `saveTemplate/deleteTemplate`, `createCampaign`, `sendCampaign/outbox` (integrations.js).
- Produces: `ETKO.renderMessaging(container)` with template save, campaign compose (title/channel/target/content → draft/schedule), campaign list with 발송 buttons, outbox list with SIMULATION_ONLY marking; denial + validation as Korean alerts; 44px targets.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + shell branch**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/messaging.js index.html styles/tokens.css tests/messaging-ui.test.cjs
git commit -m "feat: wire messaging UI"
```
