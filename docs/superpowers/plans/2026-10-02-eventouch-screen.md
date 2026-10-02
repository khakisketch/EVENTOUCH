# EVENTOUCH Audience Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관객용 출력 화면을 읽기전용 투영으로 제공한다. 송출 중인 프로그램·선택된 질문·공개 사진을 보여주고 조작 요소·연락처를 노출하지 않는다.

**Architecture:** `screen`을 열 번째 셸 섹션으로 추가한다(`VIEWS` 9→10, 레지스트리·내비·게이트·라벨 일괄 확장). `ETKO.renderScreen`은 `stage` 상태·Q&A·사진의 읽기전용 투영이며 기존 `stage.js`·`engagement.js`·`media.js` 규칙을 그대로 읽는다. 쓰기 없음.

**Tech Stack:** 바닐라 HTML/CSS/JS, `node --test` (CommonJS `*.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-eventouch-full-scope-design.md`

## Global Constraints

- All user-facing copy is Korean (html lang="ko").
- Preserve brand values: brand #F35B2C, action #BC3F1B, canvas #FAF8F5.
- Primary touch targets min 44px; field ticket input 52px.
- No real auth/billing/payments/devices; sample data labeled as sample; virtual roles labeled as demo.
- Audience screen exposes no controls, no contacts, no team lists.
- Booth QR identifier is exactly `ET:BOOTH:<eventId>:<boothId>` (public identifier, not an encrypted token).

## Review Focus

- View-count contract drift (tests hardcoding 9 views) — expect intentional 10-view update.
- Control leak (button/input in audience mount) — expect zero interactive elements.
- Contact leak (email/phone/member names outside approved photo authors?) — expect none; photo captions only.
- Stale projection (program change not reflected) — expect render reads live state.
- Silent English leak — expect Korean copy only.

---

### Task 1: Audience shell section (10th view)

**Files:**
- Modify: `index.html`, `app.js`, `features/views.js`, `i18n/ko.json`, `features/agency.js`
- Modify: `tests/nav.test.cjs`, `tests/qa.test.cjs`, `tests/views.test.cjs`
- Test: `tests/screen-section.test.cjs`

**Interfaces:**
- Consumes: registry pattern, `ETKO.navigate` gate.
- Produces: `VIEWS` 10 entries (+`screen`); nav button 화면 출력; section `screen-view` + mount `screen-mount`; registry entry; `ko.json` gains nothing new (`screen` exists); role tables + `allowed` gain `screen` (all roles incl. VIEWER read).

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement sections + VIEWS + registry + gates + update 9-view tests**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add index.html app.js features/views.js features/agency.js tests/
git commit -m "feat: add audience screen section"
```

### Task 2: Audience projection renderer (program + selected Q&A + photos)

**Files:**
- Modify: `features/stage.js` (add `renderScreen`)
- Modify: `index.html` (inline sync: screen branch)
- Test: `tests/screen-ui.test.cjs`

**Interfaces:**
- Consumes: `ETKO.safety`, `ETKO.stageState`, workspace qna/photos.
- Produces: `ETKO.renderScreen(container)` shows program safety title/detail, selected question or 대기 문구, 공개 사진 수; zero `<button|<input|<select|<a` in output; re-render reflects `applyTake` changes.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + shell branch**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/stage.js index.html tests/screen-ui.test.cjs
git commit -m "feat: wire audience projection"
```
