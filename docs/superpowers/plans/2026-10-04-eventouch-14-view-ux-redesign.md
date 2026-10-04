# EVENTOUCH 14-View UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved 14-view EVENTOUCH redesign with a multi-site home, selected-site workspace, clearer form recovery, and independent participant/audience surfaces.

**Architecture:** Refine the existing OpenDesign EVENTOUCH artifact first, then adapt its approved structure to the existing static HTML/CSS/vanilla-JS product. Keep the canonical route registry, render mounts, authorization checks, data store and operation handlers as the production interfaces; changes are limited to navigation placement, markup, presentation and scoped form behavior.

**Tech Stack:** Static HTML, CSS custom properties, vanilla JavaScript, existing Node.js built-in test suite, Local Codex/OpenDesign, and the configured Playwright CLI for rendered verification.

**Spec:** `docs/superpowers/specs/2026-10-04-eventouch-14-view-ux-redesign-design.md`

## Global Constraints

- Preserve the 14 existing route IDs, features, storage/data structure, `ETKO.canRoute`, event switching, and existing write guards.
- Keep check-in and booth in the selected site's `당일 운영`; keep client management in the cross-site area and `agency-team` in the selected-site workspace.
- Keep participant self-service and audience output separate from operator navigation; audience output must render without the operator shell.
- Keep persistent field labels, semantic input types, field-scoped errors/focus recovery, and entered values across rerenders and wizard back/forward.
- Preserve EVENTOUCH, approved colors `#F35B2C`, `#BC3F1B`, `#FAF8F5`, current Warm Operations tokens and fonts; do not introduce another palette or logo.
- Do not add real SMS/Alimtalk delivery, payments, camera/device services, APIs, dependencies, or deployment/publication.
- Verify at 1280px, 768px, 390px and 320px; run `node --test tests/*.test.cjs` after product changes.

## Review Focus

- A role missing access to a workspace route must not reach it through the moved menu; verify existing route guards and layer fallback in Task 2.
- Switching sites must keep the selector, active-site header, participant data and team members in the same workspace; verify Task 2 and the browser journey in Task 5.
- Invalid calendar/time/email/required inputs must identify the exact field, restore focus, and preserve other entered values; verify Tasks 3–4.
- Participant rows must expose only one operable table/card presentation at each breakpoint; verify Task 4 and real viewport checks in Task 5.
- The audience route must not expose operator controls, and scene selection must not bypass the existing four-check TAKE gate; verify Tasks 2 and 4.

---

### Task 1: OpenDesign 14-view design refinement

**Files / artifacts:**
- Refine in OpenDesign project `EVENTOUCH` (`eventouch-a82e`, resolved storage `/app/.od/projects/eventouch-a82e`); preserve existing `eventouch-operations.html` and `eventouch-operations-v2.html`.
- Create a new entry artifact `eventouch-14-view-redesign.html` (and only the supporting files it actually references).
- Use the selected, inspected Mobbin references recorded in the spec: Eventbrite event list/create, Posh event creation flow, User Interviews participant directory, Luma/Meetup mobile check-in, and Slack workspace switching. Pass permitted image files through the project-supported file mechanism and verify they are present before the design run.

**Interfaces:**
- Produces a rendered Local Codex preview and a complete source bundle that covers all 14 existing route IDs and required empty/error/mobile states.
- The artifact is a design source, not production code, user acceptance, or authorization to alter APIs/data or to deploy.

- [x] Verify the existing EVENTOUCH project, entry artifacts and prior `entry_missing` run; do not overwrite or blindly retry that run.
- [x] Start a new refinement run with the approved spec, existing product tokens, exact route IDs, Mobbin pattern intent, responsive states and explicit out-of-scope list.
- [x] Open the rendered artifact preview and inspect desktop hierarchy, mobile staged navigation, form error recovery, participant directory, grouped stage scenes and standalone audience screen.
- [x] Retrieve the complete artifact bundle; record actual required-file hash, omitted/truncated files, preview locator and differences/open decisions in the task ledger.
- [x] Record the design-source result; preserve existing OpenDesign outputs and do not commit machine-local previews or the working-state checkpoint.

**Verified design source (2026-10-04):** Separate artifact `eventouch-14-view-redesign.html`, SHA256 `d429499c7cc41d525df64af28f520836cd9ead7fa4f3dc8faa998572425ed611`, complete one-file bundle (87,355 bytes; no truncation/skips), rendered at [Local OpenDesign preview](http://127.0.0.1:7456/api/projects/eventouch-a82e/raw/eventouch-14-view-redesign.html). The latest run reported `deliverableValid=false` / `entry_not_touched` because project metadata intentionally continues to point at the preserved `eventouch-operations.html`; this is retained as a validator caveat, not represented as a valid project-entry handoff. Independent browser inspection of the exact separate artifact confirmed all 14 routes, the no-filter event list, field-level create error, mobile site selector (44px at 390/320 with no horizontal overflow), `?view=screen` with no operator chrome/control in rendered or accessibility output, and the six groups/28 scene concepts. Source still contains dormant screen-exit markup, but it is zero-sized/inaccessible in the standalone audience route. Product integration uses canonical scene metadata and Korean labels rather than the mockup's alternate narrative group names.

### Task 2: Route grouping, contextual navigation and standalone audience screen

**Files:**
- Modify: `features/views.js`
- Modify: `app.js`
- Modify: `index.html`
- Modify: `i18n/ko.json`
- Modify: `styles/theme.css`
- Test: `tests/views.test.cjs`, `tests/nav.test.cjs`, `tests/screen-section.test.cjs`, `tests/theme.test.cjs`

**Interfaces:**
- Preserve `ETKO.views`, the 14 canonical route IDs, `ETKO.navigate`, `ETKO.canRoute`, `ETKO.selectLayer`, `ETKO.syncShellContext`, and all section/mount IDs.
- Organize `agency-home`, `agency-events`, `agency-clients` under `전체 현장`; organize `overview`, `agency-team`, `participants`, `content`, `messages`, `checkin`, `booth`, `engage`, and `stage` under the selected-site workspace, with explicit `준비` and `당일 운영` subgroups. Keep `participant` and `screen` separate.
- In the selected-site workspace, persistently show the current event name/date/status and a return path to `전체 현장`; keep the existing event selector/switch behavior.
- Mobile navigation must expose `전체 현장 → 선택 현장 → 준비/당일 운영` as staged context while retaining a visible active-site selector and 44px targets.

- [x] **Step 1: Write failing route/group tests.** Assert the exact 14 IDs map once to the new groups; `agency-team` is event-scoped, and check-in/booth are in `당일 운영`.
- [x] **Step 2: Run `node --test tests/views.test.cjs tests/nav.test.cjs` and verify RED** because the registry and HTML still use the five old group mapping.
- [x] **Step 3: Implement the registry, shell markup and Korean labels** without changing section/mount IDs or role tables.
- [x] **Step 4: Run the focused navigation tests and verify GREEN**, including denied/partial role access, event selector sync, and route ID preservation.
- [x] **Step 5: Write failing standalone-screen tests.** Assert `?view=screen` marks a dedicated screen mode, hides the operator sidebar/topbar, and gives the audience mount the viewport; keep the stage link target unchanged.
- [x] **Step 6: Run screen tests and verify RED; implement the screen-mode class and responsive full-screen styles using existing product tokens.**
- [x] **Step 7: Run `node --test tests/views.test.cjs tests/nav.test.cjs tests/screen-section.test.cjs tests/theme.test.cjs` and verify GREEN.**
- [x] **Step 8: Commit Task 2** as `feat: restructure event workspace navigation` after `git diff --check`.

### Task 3: Event, client and team forms with field-scoped validation

**Files:**
- Modify: `features/agency.js`
- Modify: `features/agency-ui.js`
- Modify: `styles/theme.css`
- Modify: `tests/agency.test.cjs`
- Modify: `tests/agency-console.test.cjs`
- Modify: `tests/theme.test.cjs`

**Interfaces:**
- Keep event/client/member data APIs and write permissions. Enforce a real `YYYY-MM-DD` calendar date at event creation; do not rewrite existing event records.
- Preserve the three-step event wizard and its feature choices. Keep draft data in `ETKO.agencyUi`; keep errors scoped to the active agency view and identify the failing field.
- Use `type="date"` for event date and `type="email"` for client/member email; associate errors with their controls using `aria-invalid` and `aria-describedby`, and focus the invalid control after a failed action.

- [x] **Step 1: Write failing data tests** for invalid calendar dates (`2026-02-30`, malformed strings) and valid leap/non-leap dates; write failing UI tests for field-level errors, focus, client/team email semantics, and no event-wizard error leakage into clients.
- [x] **Step 2: Run the focused tests and verify RED** on current nonempty-only date validation and shared `lastAgencyError` rendering.
- [x] **Step 3: Implement strict event-date validation and per-view/per-field agency form state**; capture wizard values before validation and retain them through back/forward navigation and rerender.
- [x] **Step 4: Implement semantic client/team inputs and inline error/focus restoration** without changing `saveClient`, `saveMember`, event IDs or role behavior.
- [x] **Step 5: Run `node --test tests/agency-console.test.cjs` plus the new focused tests and verify GREEN.**
- [x] **Step 6: Commit Task 3** as `feat: improve event and team form validation` after `git diff --check`.

### Task 4: Semantic controls and form recovery across view renderers

**Files:**
- Modify: `features/content.js`, `features/messaging.js`, `features/registration.js`, `features/booth.js`, `features/booths.js`, `features/desks.js`, `features/checkin.js`, `index.html`, and `styles/theme.css` as required by the generated artifact.
- Modify tests: `tests/content-ui.test.cjs`, `tests/messaging-ui.test.cjs`, `tests/participant-ui.test.cjs`, `tests/registration.test.cjs`, `tests/signup-ui.test.cjs`, `tests/booths.test.cjs`, `tests/booth-manage.test.cjs`, `tests/desk-ui.test.cjs`, `tests/desk-history-ui.test.cjs`, and `tests/nav.test.cjs`.

**Interfaces:**
- Keep every existing data function, route, feature, persistence wrapper and simulation boundary; this task changes presentation and form recovery only.
- Use `type="time"` for program times; `textarea` for notice/template/campaign bodies; semantic email/tel/number inputs for existing email, phone and quantity data; retain appropriate autocomplete/inputmode hints.
- Keep persistent visible labels on existing controls, associate field errors with their controls, focus the first invalid field after a failed action, and preserve draft values through validation rerenders.
- Do not add camera/device functionality; keep ticket/QR entry and simulation behavior as-is.

- [x] **Step 1: Write failing renderer tests** for program `time` controls, message/notice `textarea`s, persistent labels, and dynamic signup email/phone field types.
- [x] **Step 2: Run the renderer tests and verify RED** on current text-only inputs and missing visible labels.
- [x] **Step 3: Implement only the required semantic control markup** in content, messaging and signup/lookup renderers; preserve existing field IDs and stored payloads.
- [x] **Step 4: Write failing error-recovery tests** for a rejected program, notice, campaign, ticket lookup and booth quantity; assert the error targets the relevant field and the entered non-invalid values survive rerender.
- [x] **Step 5: Run the focused form tests and verify RED** against the existing whole-screen alert and cleared values.
- [x] **Step 6: Implement view-scoped form draft/error state and first-invalid focus** in the owning renderers; use semantic quantity inputs without changing scan or booth data rules. No manual ticket-code input exists in the current check-in UI, so existing file/camera and desk intake remain unchanged.
- [x] **Step 7: Run `node --test tests/content-ui.test.cjs tests/messaging-ui.test.cjs tests/participant-ui.test.cjs tests/registration.test.cjs tests/signup-ui.test.cjs tests/booths.test.cjs tests/booth-manage.test.cjs tests/desk-ui.test.cjs tests/desk-history-ui.test.cjs tests/nav.test.cjs` and verify GREEN; full-suite result is recorded in the task ledger.**
- [x] **Step 8: Commit Task 4** as `feat: improve form controls and recovery` after `git diff --check`.

### Task 5: Workspace overview, participant directory and day-of operations

**Files:**
- Modify: `features/agency-ui.js`, `features/participants.js`, `features/engagement.js`, `features/checkin.js`, `features/booth.js`, `features/booths.js`, `features/stage.js`, `features/scenes.js`, `index.html`, and `styles/theme.css` as required by the generated artifact.
- Modify tests: `tests/agency-console.test.cjs`, `tests/participant-ui.test.cjs`, `tests/engage-ui.test.cjs`, `tests/engage-ui2.test.cjs`, `tests/checkin.test.cjs`, `tests/booth-manage.test.cjs`, and `tests/stage.test.cjs`.

**Interfaces:**
- Keep all existing screen mounts, list/status mutations, sample data and operation permission guards.
- The overview exposes existing check-in/booth routes as quick actions; participant directory keeps selection/detail/bulk intake; engagement surfaces remain tied to existing event data.
- Directory table is the only visible presentation at desktop widths; cards are the only visible presentation at mobile widths.
- Render all 28 existing scenes under their six existing `SCENES[].group` values; do not rename/remove scenes or relax stage disclosure/confirmation checks.

- [x] **Step 1: Write failing UI tests** for quick actions from the selected-site overview, one visible participant representation at each breakpoint, engagement sections/status cues, check-in online/offline and scan-result context, booth self/staff mode distinction, and six named scene groups containing all 28 IDs.
- [x] **Step 2: Run focused tests and verify RED** against current overview, duplicated participant markup, ungrouped scene list and operation renderers.
- [x] **Step 3: Implement the small overview and day-of composition changes** from the inspected design artifact while preserving current operation handlers.
- [x] **Step 4: Implement breakpoint-specific directory visibility and grouped scene rendering from existing metadata**; keep TAKE disabled until all four checks pass.
- [x] **Step 5: Run `node --test tests/agency-console.test.cjs tests/participant-ui.test.cjs tests/engage-ui.test.cjs tests/engage-ui2.test.cjs tests/checkin.test.cjs tests/booth-manage.test.cjs tests/stage.test.cjs` and verify GREEN (61/61).**
- [x] **Step 6: Commit Task 5** as `feat: clarify workspace and day-of operations` after `git diff --check` (`5b715fb`).

### Task 6: Full regression and browser verification

**Files:**
- Update this plan and `.opencode/working-state.md` with verified revision, design snapshot, implementation differences and evidence.
- Modify production/tests only for defects reproduced within this task's approved acceptance criteria.

**Interfaces:**
- Use the existing branch `feat/eventouch-contextual-shell`; do not merge to `master`, publish, or deploy.
- Keep the local product preview separate from the OpenDesign preview; label each link accurately.

- [x] Run `node --test tests/*.test.cjs` and record the actual pass/fail count; use the independent test-runner role for the final closeout run.
- [x] Use the configured browser against the actual worktree preview at 1280px, 768px, 390px and 320px; verify no page-level horizontal overflow and inspect console/network failures.
- [x] Exercise whole-site → selected-site navigation, event switching and data isolation, existing role filtering, event wizard invalid/corrected/back navigation, field error locality, one participant presentation per viewport, scene grouping/TAKE safety, check-in/booth entry points, and `?view=screen` without operator chrome.
- [x] Verify a successful local form mutation survives reload where the current persistence layer supports it; restore any temporary test data after the check.
- [x] Run `git diff --check`, review the complete task diff/status and update the ledger/checkpoint. User visual acceptance and public deployment remain unclaimed.
- [x] Commit the final verification record as `docs: record eventouch redesign verification` because it contains task-owned durable evidence.

**Task 6 closeout (2026-10-04):** Product source revision `8eec099803f4421560bc325e643248a3f76d9786`; independent test-runner session `ses_ef9d13503ffe5nyRTr6LFjHXs6` ran `node --test tests/*.test.cjs` → 388/388 pass, 0 failures, exit 0. A fresh Playwright session against the actual worktree preview [EVENTOUCH local preview](http://100.116.163.1:8766/index.html) exercised all 13 operator/self-service routes via visible navigation and the separate `?view=screen` route, then swept all 14 route IDs at 1280/768/390/320: no route mismatches or horizontal overflow. Desktop participant table/cards were `block/none`; mobile `none/grid`; direct screen mode hid sidebar/topbar. Console reported 0 errors/warnings; visible sample/locale requests returned 200. Earlier workflow checks on this same source line exercised overview quick actions, event creation invalid/corrected/back flow and focus/value preservation, event switching and data isolation, reload persistence/restoration, STAFF denial, Viewer quick-action filtering, and four-check TAKE safety across six scene groups/28 scenes. Final reviewer session `ses_ef9dadb31ffe5zRsAqVbTq9a0d` reviewed the whole branch and re-reviewed `a33df1c..8eec099`: no Critical/Important issues remain; two non-blocking Minor notes are deferred below in the task ledger. `git diff --check` passed; only untracked `.playwright-cli/` browser captures remain and are intentionally not part of the deliverable. No merge, publish, or deploy performed; user visual acceptance remains theirs.
