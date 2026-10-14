# EVENTOUCH Desk Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현장 데스크(유닛 개설·선택·입퇴장 기록·이력·정정)를 체크인 화면에서 열고 처리하고 복구할 수 있게 한다.

**Architecture:** 체크인 마운트(`renderCheckin`)에 데스크 섹션을 확장한다. 유닛 CRUD·활성 유닛 선택·이력·정정은 기존 `desks.js` 규칙 위에 얹고, 티켓 제출은 활성 유닛이 있으면 `recordScan`, 없으면 `scan`으로 처리한다. 쓰기는 한글 `throw Error`, 렌더는 한글만.

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

- Unit/action mismatch (OUT unit used for IN scan) — expect Korean refusal naming the desk.
- Correction abuse (non-latest, short reason, double correction) — expect Korean refusal.
- Active-unit staleness (unit deleted or event switched) — expect fallback to plain scan.
- Unwired controls — expect every visible control wired with Korean feedback.
- Silent English leak — expect Korean copy only.

---

### Task 1: Desk units UI (list + add + active selection)

**Files:**
- Modify: `features/desks.js` (add `ETKO.activeUnitId` + `ETKO.setActiveUnit`, render helper `ETKO.renderDesks`)
- Modify: `features/checkin.js` (mount desk section)
- Test: `tests/desk-ui.test.cjs`

**Interfaces:**
- Consumes: `saveUnit`, workspace `units`.
- Produces: `ETKO.renderDesks(container)` lists units with 선택 buttons + add form (name/action/mode); `setActiveUnit(id)` validates existence (`데스크를 찾을 수 없습니다`); checkin mount embeds the section; ticket submit prefers `recordScan` with active unit when set.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement renderer + selection + submit preference**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/desks.js features/checkin.js index.html styles/tokens.css tests/desk-ui.test.cjs
git commit -m "feat: wire desk units UI"
```

### Task 2: History + correction UI

**Files:**
- Modify: `features/desks.js` (extend `renderDesks`)
- Test: `tests/desk-history-ui.test.cjs`

**Interfaces:**
- Consumes: `history`, `correctLog`.
- Produces: same mount lists newest-first logs (who/action/desk/corrected) with 정정 buttons opening reason input; valid correction re-renders with restored status; invalid (short reason, non-latest) surfaces Korean `role=alert`.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement history + correction rendering and wiring**
- [ ] **Step 4: Run test to verify it passes** (full suite)
- [ ] **Step 5: Commit**

```bash
git add features/desks.js tests/desk-history-ui.test.cjs
git commit -m "feat: wire desk history and correction UI"
```
