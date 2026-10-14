-- Check-in history as explicit rows (expand phase of normalization).
--
-- workspace.checks inside event_workspaces.payload REMAINS the authority for
-- reads; this table is a write-through projection kept in the SAME
-- transaction, so the two cannot drift. It exists so history queries and
-- future API boundaries do not have to load whole workspace payloads.
--
-- The backfill below replays every stored check row once. ON CONFLICT DO
-- NOTHING keeps it safe to re-run by hand if an operator ever needs to.

CREATE TABLE checkin_records (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  action text NOT NULL CHECK (action IN ('IN', 'OUT')),
  desk_id text NOT NULL DEFAULT '',
  actor_id text,
  at timestamptz NOT NULL DEFAULT now(),
  before_inside boolean NOT NULL DEFAULT false,
  before_ever_in boolean NOT NULL DEFAULT false,
  corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checkin_records_event_idx ON checkin_records (event_id, at DESC);
CREATE INDEX checkin_records_participant_idx ON checkin_records (event_id, participant_id);

INSERT INTO checkin_records
  (id, event_id, participant_id, name, action, desk_id, actor_id, at,
   before_inside, before_ever_in, corrected)
SELECT
  c.id,
  w.event_id,
  c."participantId",
  COALESCE(c.name, ''),
  c.action,
  COALESCE(c."deskId", ''),
  NULLIF(c.actor, ''),
  COALESCE(NULLIF(c.at, '')::timestamptz, now()),
  COALESCE((c."before"->>'inside')::boolean, false),
  COALESCE((c."before"->>'everIn')::boolean, false),
  COALESCE(c.corrected, false)
FROM event_workspaces w,
LATERAL jsonb_to_recordset(
  CASE WHEN jsonb_typeof(COALESCE(w.payload->'checks', '[]'::jsonb)) = 'array'
       THEN w.payload->'checks'
       ELSE '[]'::jsonb END
) AS c(
  id text,
  "participantId" text,
  name text,
  action text,
  "deskId" text,
  actor text,
  at text,
  "before" jsonb,
  corrected boolean
)
WHERE c.id IS NOT NULL
  AND c."participantId" IS NOT NULL
  AND c.action IN ('IN', 'OUT')
ON CONFLICT (id) DO NOTHING;
