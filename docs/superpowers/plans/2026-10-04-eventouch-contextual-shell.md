# EVENTOUCH Contextual Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 14-item top pill strip with an accessible five-layer operations shell while preserving the existing product routes and renderers.

**Architecture:** `features/views.js` owns the canonical route-to-layer metadata. `app.js` owns layer selection, permission-aware active navigation, and the active-event selector using existing event-switch APIs. `index.html` supplies the shell markup; `styles/theme.css` adapts it across desktop and mobile without replacing view mounts.

**Tech Stack:** Static HTML, CSS custom properties, vanilla JavaScript, Node.js built-in test runner, existing `agent-browser` CLI for rendered checks.

**Spec:** `docs/superpowers/specs/2026-10-04-eventouch-contextual-shell-design.md`

## Global Constraints

- Keep the existing 14 route IDs, view renderers, role checks, and data model.
- Use five layers only: `agency`, `event`, `onsite`, `participant`, `screen`.
- Preserve brand values `#F35B2C`, `#BC3F1B`, and `#FAF8F5`, existing fonts, and the Warm Operations tokens.
- At 800px and below, use a five-item layer selector and one horizontally scrollable second-level menu; keep primary targets at least 44px.
- Do not add real service integrations, new dependencies, new logo assets, or a competing visual system.

## Review Focus

- A role that cannot access a layer must not appear to switch into that layer; the current authorized view and layer remain active.
- A role with partial access to a layer must land on the first accessible route if that layer's default route is denied.
- Extended/unknown routes must not erase the last valid contextual layer or alter existing `ETKO.navigate` guard semantics.
- An event name containing HTML characters must be rendered as option text, not interpreted as markup.
- A narrow 320px viewport must keep the five layer controls and second-level menu usable without page-level horizontal overflow.

---

### Task 1: Route-layer model and navigation state

**Files:**
- Modify: `features/views.js`
- Modify: `app.js`
- Test: `tests/views.test.cjs`
- Test: `tests/nav.test.cjs`

**Interfaces:**
- Produces `ETKO.layerRegistry()`, returning fresh entries `{ id, label, defaultView, views }` for the five layers in design order.
- Produces `ETKO.layerForView(view)`, returning the canonical layer ID or `null`.
- Produces `ETKO.selectLayer(layerId)`, selecting the default accessible route (or first accessible route) via existing `ETKO.navigate`; unknown/fully denied layers leave state unchanged.
- Produces `ETKO.syncShellContext(doc)`, updating the active-event select from `ETKO.store.events` using escaped option markup and setting its selected value to `activeEventId`.
- Preserves `ETKO.wireNav(doc)`'s return value as the number of wired canonical `[data-view]` links.

- [x] **Step 1: Write failing view-layer registry tests**
  - Assert all five layer IDs, labels, defaults, and route arrays exactly match the spec.
  - Assert all 14 canonical routes map to the expected layer; unknown routes map to `null`.
- [x] **Step 2: Run the view tests and verify RED**
  - Run: `node --test tests/views.test.cjs`
  - Expected: fail because the layer registry API does not exist.
- [x] **Step 3: Implement the layer registry in `features/views.js`**
  - Keep canonical view section/mount lookup behavior unchanged.
  - Return defensive copies from the new registry.
- [x] **Step 4: Run the view tests and verify GREEN**
  - Run: `node --test tests/views.test.cjs`
  - Expected: all view registry tests pass.
- [x] **Step 5: Write failing router tests**
  - Assert `selectLayer('onsite')` navigates to `checkin` by default.
  - Assert a denied default chooses the first allowed route, and a fully denied/unknown layer leaves `currentView` and `currentLayer` unchanged.
  - Assert `syncShellContext` escapes event names and selects `activeEventId`.
- [x] **Step 6: Run router tests and verify RED**
  - Run: `node --test tests/nav.test.cjs`
  - Expected: fail because the selector/context APIs and layer-aware router behavior do not exist.
- [x] **Step 7: Implement layer-aware paint, selection, and event-context wiring in `app.js`**
  - Keep `ETKO.navigate` authorization and existing unknown-route behavior intact.
  - Update layer tabs, groups, breadcrumb, and accessible nav links when a canonical route changes.
  - Bind the event select to `ETKO.switchEventAndRender`; refresh options on focus and after successful switching.
- [x] **Step 8: Run router tests and verify GREEN**
  - Run: `node --test tests/nav.test.cjs`
  - Expected: all navigation tests pass.
- [ ] **Step 9: Commit Task 1**
  - Commit message: `feat: add contextual navigation model`

Task 1 RED/GREEN evidence: `node --test tests/views.test.cjs` failed first with the missing `layerRegistry`; it then passed 3/3. Router tests first failed on missing layer state/context APIs (and exposed a legacy DOM stub that lacked `querySelector`); after implementation and stub-compatibility handling, `node --test tests/nav.test.cjs tests/views.test.cjs` passed 14/14. The full regression suite passed 343/343 before the Task 1 commit.

### Task 2: Responsive product shell

**Files:**
- Modify: `index.html`
- Modify: `styles/theme.css`
- Modify: `tests/nav.test.cjs`

**Interfaces:**
- Consumes Task 1's `[data-layer]`, `[data-nav-layer]`, `[data-shell-nav-item]`, `[data-event-context]`, and shell-context update behavior.
- Preserves all existing `#app` view sections, mounts, event handlers, and script ordering.

- [ ] **Step 1: Write failing shell markup tests**
  - Assert the 14 route links are in the five correct groups, five layer controls exist, a working event selector exists, and the old flat top-level strip is absent.
  - Assert responsive CSS defines the 800px mobile transformation, horizontal second-level scrolling, 44px controls, and visible keyboard focus.
- [ ] **Step 2: Run the shell tests and verify RED**
  - Run: `node --test tests/nav.test.cjs`
  - Expected: fail because the current HTML is still a flat top navigation and lacks the contextual shell.
- [ ] **Step 3: Implement the shell markup in `index.html`**
  - Add the desktop sidebar, event selector, five layer tabs, grouped route links, breadcrumb topbar, and responsive mobile menu.
  - Keep every existing view section and script dependency in place.
- [ ] **Step 4: Implement shell and responsive styles in `styles/theme.css`**
  - Use existing tokens and brand colors; do not add a second palette.
  - Desktop: persistent sidebar + full-width content workspace. Mobile: compact header, five-column layer selector, scrollable second-level links, full-width main content.
- [ ] **Step 5: Run focused and full tests**
  - Run: `node --test tests/nav.test.cjs tests/views.test.cjs`
  - Expected: all focused tests pass.
  - Run: `node --test tests/*.test.cjs`
  - Expected: full suite passes with no regressions.
- [ ] **Step 6: Verify rendered flows at 1280, 768, 390, and 320px**
  - Verify layer selection and route navigation for all five layers, active-event switching, role-denied navigation, `?view=screen`, page overflow, minimum navigation target size, and browser console/network failures.
  - Expected: all 14 routes remain reachable to authorized roles; no page-level horizontal overflow; mobile secondary nav scrolls within its own container; existing event data/rendering remains functional.
- [ ] **Step 7: Commit Task 2 and record evidence**
  - Commit message: `feat: replace flat navigation with contextual shell`
  - Update this ledger with commit and test/browser evidence before integration.
