---
version: 1
slug: "apps-web-app-console-events-id-page-tsx"
primary_target: "apps/web/app/console/events/[id]/page.tsx"
related_targets: ["apps/web/app/console/events/[id]/EventOverview.tsx"]
---

# Surface brief: event operations overview (/console/events/[id])

Scope: apps/web/app/console/events/[id]/page.tsx + EventOverview.tsx + overview styles.
Visitor mode: Operate. Audience: agency operators on desktop checking one event's status and next move.

Job: read stage·schedule·venue·intake context, the problems the current data supports, stage-scoped numbers, operations readiness, scheduled current/next program, and how fresh the read is. Proof: live bootstrap + workspace data for this event. Constraints: server authority (event.stage command, idempotent commandId), permission-filtered links only; current tokens and dark-rail shell stay (canon world); same card language as the console home grid. Absent data (staffing attendance, device health, session attendance, targets, revenue) is never implied.

Chosen direction: canon (category standard, current system). No new visual world.
Memorable moment: the page answers "what must happen now so this event finishes well" — data-backed problems with one jump each, metrics that change with the stage, honest "not auto-refreshing" freshness stamp, and results-first framing once the event ends.

## Direction contract

THESIS: This surface is the operator's situation board for one event. It refuses fixed same-for-every-stage KPI grids and any approval-first rule that outranks the stage; context, problems, stage metrics, readiness, schedule, and activity read as distinct cards.
OWN-WORLD: Current tokens only. Recognizable with content removed: dark rail, white cards on ground, pill badges (stage/intake/D-day), tabular numerals, one orange primary per screen.
STORY: The operator sees which client's event this is, what the data says is wrong, which numbers matter at this stage, whether the field setup is registered, what is scheduled next, and can refresh on demand.
FIRST VIEWPORT: Event title + client + schedule line + badges (stage/intake/D-day); participant page open/copy; data-backed problem list; stage-scoped metrics (DRAFT/READY registration set, LIVE attendance set, ENDED/ARCHIVED results set with the report's own entry-rate definition); operations readiness; stage advance as a secondary row; recent in/out with desk names and a last-refresh time.
FORM: Grounded candidate canon (standing exit, user-pinned). Seed key 3a708728.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
