# EVENTOUCH preparation and participant-registration UX

## Objective and scope

Clarify what operators should find under the event-level **준비** group, how preparation completion is communicated, and make manual one-person registration less repetitive. Preserve existing product behavior and approved visual language. Do not remove the participant-import path, alter backend/API/auth/data/permissions, deploy, publish, or merge to `master`.

The current importer accepts CSV; its UI says XLSX must be saved as CSV first. This work preserves that existing import path and does not imply native XLSX support.

## Product binding

- Repository/worktree: `/home/ksi/Desktop/SI-Projects/EVENTOUCH`, branch `feat/eventouch-visual-system`, base revision `86b532d83ac3fa6e18b818936b2dd94f1965bb5d`.
- OpenDesign project: `EVENTOUCH`, folder-backed at the same repository path, canonical entry `index.html`.
- Brand/tokens: `assets/css/tokens.css`; no attached design system.
- Product preview: `http://100.116.163.1:8766/index.html` (tailnet-only, temporary).
- Relevant source: `assets/js/operator-experience.js`, `assets/js/experience.js`, `assets/js/console.js`, `assets/js/role-model.js`, `assets/js/registration.js`, `assets/css/console.css`, `assets/css/handheld.css`, and `assets/css/tokens.css`.

## Invariants

- Preserve all existing route IDs, feature behavior, data shapes, capacity/waitlist/duplicate/payment semantics, role checks, product name and brand.
- Keep existing import screen and behavior available; do not replace manual entry with import.
- Preserve accessibility, visible focus, 44px touch targets and responsive behavior. Do not add real external integrations or dependencies.
- Only sanitized demo records may be used in rendered review; no real attendee PII.

## Baseline observations

- Sidebar group `준비` currently contains participant management, participant page, programs and messages.
- Separate readiness checklist has seven items: event basics, venue guide, registration form, attendee guidance, program, registration desk and staff assignment. It displays `done / total`, progress, per-row status and a `확인` action.
- The manual registration dialog captures one person at a time (name, phone, optional email/company, group and consent-confirmation checkbox) and closes after a successful save.
- Existing axe observations: roster 0 violations plus one incomplete table-wrapper check; registration dialog 2 moderate landmark findings; readiness checklist 0 violations. Empty submission focuses name and shows inline errors. Mobile dialog content scrolls; its footer is below the initial viewport.
- Read-only audit at `86b532d` confirmed a false-green risk: checklist text promises schedule/capacity, venue name/address, and entry guidance/contact, while the checks only test name+date, venue name, and any published notice. The readiness route is also mapped to the overview/operations nav group, so the readiness page appears under the wrong active section.
- The manual consent checkbox asks for confirmation without showing the event's actual consent text; it is optional and unchecked submission stores `null`. The open dialog also produced two moderate duplicate banner/contentinfo landmark findings. The `처리 중…` state and success toast exist in source but were not captured. Preserve duplicate-phone rejection, capacity/waitlist, payment status, registration permissions, inline errors/focus, CSV import and the consent data contract unless a user-approved direction explicitly changes presentation only.
- Captures used for the audit are temporarily stored in `.od-review/eventouch-registration/`; they are task-owned and must not be committed as product assets.

## Design stages and status

| Stage | Skill / inputs | Status / evidence |
|---|---|---|
| Existing-screen read-only audit | OpenDesign `plan-design-review`; actual product source plus `.od-review/eventouch-registration/*` captures at 1280/390, including empty/error/focus and readiness states | Completed at `86b532d`; run `cbb9b0f3-e8c3-4898-be4c-4aba70636ba2` succeeded with no artifact (expected for read-only). The inner review states it inspected all seven named screenshots and the specified source; working tree confirms no product-source diff. Findings recorded above. |
| Direction options | OpenDesign local execution; 2–3 lightweight options after audit; preserve current brand and routes | Audit complete. OpenDesign's interactive brief card is awaiting user choices. Recommended: cross-platform (desktop + mobile), connected flows (preparation + manual registration), polished UI. After confirmation, keep option output separate from canonical product `index.html`; user selects one direction before implementation. |
| Implementation + design review | OpenDesign owns UI source/styles and rendered critique/refinement; Build owns functional integration/tests/Git | Not started; requires user's direction choice. |
| Final verification | Independent test-runner for final suite; agent-browser on actual product preview across desktop/mobile, changed flows, errors/focus/accessibility | Not started. |

## Selected Mobbin references

The following reference screenshots were visually inspected and copied into the linked project so the local design run can read them. Borrow interaction/hierarchy only, never copy product copy or brand assets.

- Sweatpals add-attendees panel: https://mobbin.com/screens/538d9fe7-d5b4-4092-b170-fa8b072b33df — `.od-review/eventouch-registration/references/sweatpals-add-attendees.jpg` (repeatable attendee entry).
- Navan traveler picker: https://mobbin.com/screens/dad4ec56-86a2-4235-bc5b-66807cd97549 — `.od-review/eventouch-registration/references/navan-traveler-chips.jpg` (selected-person chip and search state).
- Luma people-import choice: https://mobbin.com/screens/9d5fc02b-4d4a-4cfe-b4f3-f8e483b5e852 — `.od-review/eventouch-registration/references/luma-add-people-manual-or-csv.jpg` (manual entry remains visible beside CSV import).

## Direction/acceptance gate

No full visual implementation until the user chooses among the 2–3 direction options. The selected option must make the purpose and contents of **준비** explicit, show completion in an understandable way, and improve the manual-registration task without reducing access to import. First-screen action, desktop/mobile scroll depth, empty/error/loading, keyboard/focus and accessibility states must be verifiable. Keep the separate existing audit backlog out of this slice until this acceptance is met.

## Existing audit backlog (after this slice)

- Overview history link target; misleading filtered empty states; check-in result-cap disclosure; participant-web venue/schedule empty states.
- Lower priority: duplicate check-in action, status/CRM presentation.

## Verification log

- Baseline revision: `86b532d`; product preview browsed without roster mutation.
- Screenshots: `.od-review/eventouch-registration/list-desktop-1280.png`, `dialog-default-1280.png`, `list-390.png`, `dialog-default-390.png`, `dialog-required-error-focus-390.png`, `readiness-desktop-1280.png`, `readiness-mobile-390.png`; Mobbin references are under `.od-review/eventouch-registration/references/`.
- The current UI was reviewed at 1280px and 390px. axe results and limitations are recorded above; browser emulation is not real-device or screen-reader verification.
