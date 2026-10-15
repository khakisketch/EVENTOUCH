---
version: 1
slug: "apps-web-app-console-page-tsx"
primary_target: "apps/web/app/console/page.tsx"
related_targets: ["apps/web/app/console/ConsoleHome.tsx"]
---

# Surface brief: console event home (/console)

Scope: apps/web/app/console/page.tsx + ConsoleHome.tsx (+ console-home CSS module).
Visitor mode: Operate. Audience: agency operators on desktop choosing which event to work on.

Job: find the right event by stage, schedule, name, client, or venue; scan its operating context and open its event home. Proof: real bootstrap data (name, schedule, stage, registration/pending/check-in counts). Constraints: server authority, idempotent commands, permission-filtered destinations only; current tokens and dark-rail shell stay (canon world).

Chosen direction: canon (category standard, current system). No new visual world.
Memorable moment: D-day, date, and unit-backed counts make the right event recognizable before one click opens its event home.

## Direction contract

THESIS: This surface helps an operator identify and enter the right event. It refuses stage-specific card CTAs that send users past the shared event home.
OWN-WORLD: Current tokens only (nav #202329, brand #E76D26, paper cards on ground). Keep the dark rail and white event cards; use one compact stage selector, the existing card/calendar switch, and one orange create-event primary.
STORY: The operator scans D-day, date, title, client/venue, stage, and clearly labeled participant counts, then opens that event. The stage selector and all-fields search narrow the directory; the calendar filters the same cards by date.
FIRST VIEWPORT: Rail left; header (title + new-event primary); one toolbar with stage selector and option counts, card/calendar switch, and search across event name/client/venue; visible result count; responsive 3-column card grid. Each card puts D-day left, date and a decorative arrow right, time below on the content side, then event identity, stage, and three unit-backed metrics. One link covers the entire card and opens the event home. Calendar uses the same cards; undated events remain in a separate section.
FORM: Canon extension, not a new visual world: native stage select, all-fields search, and one whole-card event-home link replace chip/action clutter. Seed key 3a708728.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
