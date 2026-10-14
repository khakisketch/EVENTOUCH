---
version: 1
slug: "apps-web-app-console-events-id-page-tsx"
primary_target: "apps/web/app/console/events/[id]/page.tsx"
related_targets: ["apps/web/app/console/events/[id]/EventOverview.tsx"]
---

# Surface brief: event operations overview (/console/events/[id])

Scope: apps/web/app/console/events/[id]/page.tsx + EventOverview.tsx + overview styles.
Visitor mode: Operate. Audience: agency operators on desktop checking one event's status and next move.

Job: read schedule·venue·stage·intake, key numbers, what needs doing now, stage advance, recent in/out. Proof: live bootstrap + workspace data for this event. Constraints: server authority (event.stage command, idempotent commandId), permission-filtered links only; current tokens and dark-rail shell stay (canon world); same card language as the console home grid.

Chosen direction: canon (category standard, current system). No new visual world.
Memorable moment: the page answers "is this event healthy and what is next" — pending-first tasks, inline stage confirm, recent activity with times.

## Direction contract

THESIS: This surface owns "this event, right now". It refuses stacked uniform blocks and the native confirm dialog; state, task, and activity read as distinct cards.
OWN-WORLD: Current tokens only. Recognizable with content removed: dark rail, white cards on ground, pill stage badge, tabular numerals, one orange primary per screen.
STORY: The operator understands the event state at a glance, believes numbers are live server truth, advances stage with an explicit inline confirm, and jumps to participants/messages/operations/settings.
FIRST VIEWPORT: Event title + schedule line; metric cards (registered/pending/inside/entry rate); pending-first task card with one primary; stage card with inline confirm and precondition notes; recent in/out list.
FORM: Grounded candidate canon (standing exit, user-pinned). Seed key 3a708728.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
