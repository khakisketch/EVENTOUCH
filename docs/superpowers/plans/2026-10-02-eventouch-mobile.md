# EVENTOUCH Participant Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 참가자 모바일(홈·일정·티켓·신청·스탬프)을 participant 화면에서 열고 완료할 수 있게 한다.

**Architecture:** `ETKO.renderParticipant`가 participant 마운트의 전체 모바일 화면(다음 행동·일정·티켓·신청·스탬프)을 렌더한다. 기존 `renderHome/nextAction`은 유지하고 셸은 `renderParticipant`를 우선 사용한다. 신청·스탬프는 기존 `registration.js`·`booths.js` 규칙 위에 얹는다.

**Tech Stack:** 바닐라 HTML/CSS/JS, `node --test` (CommonJS `*.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-eventouch-full-scope-design.md`

## Global Constraints

- All user-facing copy is Korean (html lang="ko").
- Preserve brand values: brand #F35B2C, action #BC3F1B, canvas #FAF8F5.
- Primary touch targets min 44px; field ticket input 52px.
- No real auth/billing/payments/devices; sample data labeled as sample.
- New rule functions throw `Error` with a Korean message on invalid input.
- Booth QR identifier is exactly `ET:BOOTH:<eventId>:<boothId>`.
- Design note: Mobbin 리서치 1회 수행 — 결과는 마케팅 페이지 위주라 패턴 참고 없이 기존 승인 토큰·컴포넌트로 진행, 브랜드 복사 없음.

## Review Focus

- Wrong participant (stale homeParticipantId after switch) — expect fallback to first participant + cleared id.
- Signup validation bypass (empty required, bad select) — expect Korean refusal naming the field.
- Stamp double-count (same booth over per-person limit) — expect Korean refusal.
- Unwired controls — expect every visible control wired with Korean feedback.
- Contact leak (other participants' emails/phones) — expect only own record shown.

---

### Task 1: Participant home/schedule/ticket renderer

**Files:**
- Modify: `features/booth.js` (add `renderParticipant`, keep `renderHome`)
- Modify: `index.html` (participant branch prefers `renderParticipant`)
- Test: `tests/participant-ui.test.cjs`

**Interfaces:**
- Consumes: `nextAction`, `homeNow`, workspace participants/program, `homeParticipantId`.
- Produces: `ETKO.renderParticipant(container)` — 다음 행동 CTA + 현재/다음 일정 + 내 티켓(이름·권종·코드·상태) + 내 스탬프 수; 대상은 `homeParticipantId` 유효 시 그 참가자, 아니면 첫 참가자; 빈 명단 시 신청 안내.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + shell branch**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/booth.js index.html styles/tokens.css tests/participant-ui.test.cjs
git commit -m "feat: wire participant home and ticket UI"
```

### Task 2: Mobile signup form UI

**Files:**
- Modify: `features/registration.js` (add `renderSignup`)
- Modify: `features/booth.js` (embed in `renderParticipant`)
- Test: `tests/signup-ui.test.cjs`

**Interfaces:**
- Consumes: `formFields`, `register`.
- Produces: `ETKO.renderSignup(container)` — 양식 항목 렌더(필수 표시·select 옵션) + 신청 버튼; 성공 시 등록 완료 한글 + 티켓 코드 표시; 실패 시 항목명 포함 한글 alert.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + embed**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/registration.js features/booth.js tests/signup-ui.test.cjs
git commit -m "feat: wire mobile signup UI"
```

### Task 3: Stamp tour UI (booth list + my stamps + scan entry)

**Files:**
- Modify: `features/booths.js` (add `renderStamps`)
- Modify: `features/booth.js` (embed in `renderParticipant`)
- Test: `tests/stamp-ui.test.cjs`

**Interfaces:**
- Consumes: workspace `booths`/`visits`, `stamp`, `boothPayload`, `homeParticipantId`.
- Produces: `ETKO.renderStamps(container, participantId)` — 부스 목록(상태·남은 수량) + 내 스탬프 수 + QR 입력란과 받기 버튼; 성공·초과·마감·미운영을 한글 alert로 표시.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + embed**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/booths.js features/booth.js index.html styles/tokens.css tests/stamp-ui.test.cjs
git commit -m "feat: wire stamp tour UI"
```
