---
version: 1
slug: "apps-web-app-console-page-tsx"
primary_target: "apps/web/app/console/page.tsx"
related_targets: ["apps/web/app/console/ConsoleHome.tsx"]
---

# Surface brief: console event home (/console)

Scope: apps/web/app/console/page.tsx + ConsoleHome.tsx (+ console-home CSS module).
Visitor mode: Operate. Audience: agency operators on desktop choosing which event to work on.

Job: see what needs action today and jump into one event. Proof: real bootstrap data (name, schedule, stage, registration/pending/check-in counts). Constraints: server authority, idempotent commands, permission-filtered destinations only; current tokens and dark-rail shell stay (canon world).

Chosen direction: canon (category standard, current system). No new visual world.
Memorable moment: the grid answers "what do I touch next" — every card carries its next action.

## Direction contract

THESIS: This surface owns "which event needs me now". It refuses the endless full-width row list; length is capped by cards, not rows.
OWN-WORLD: Current tokens only (nav #202329, brand #E76D26, paper cards on ground). Recognizable with all content removed: dark rail, pill filters, white cards, one orange primary per screen.
STORY: The operator understands today's load at a glance, believes counts are live server truth, and does the next action (approve, prepare, resume draft) from the card.
FIRST VIEWPORT: Rail left; header (title + count + search + stage filter + new-event primary); default card grid 3-col (attention cards carry action buttons); calendar is a date filter over the same cards, unscheduled strip stays visible.
FORM: Grounded candidate canon (standing exit, user-pinned). Seed key 3a708728.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
