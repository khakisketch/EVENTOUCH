-- Ticket identity as explicit rows (expand phase of normalization).
--
-- workspace.participants[].ticket REMAINS the authority for reads; this table
-- is a write-through projection kept in the SAME transaction, so the two
-- cannot drift. It exists so revocation/expiry checks and future API
-- boundaries do not have to scan whole workspace payloads.
--
-- ticket_hash is the sha256 hex of the token, always written by live code.
-- It is nullable ONLY for rows backfilled below: SQL migrations cannot hash
-- (no crypto extension may be assumed in shared databases), so pre-006 rows
-- carry identity without a hash until their first mutation re-indexes them.
-- A scripted fill must precede any read-switch to this table.
-- The backfill below replays every stored ticket once. ON CONFLICT DO
-- NOTHING keeps it safe to re-run by hand if an operator ever needs to.

CREATE TABLE tickets (
  participant_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_hash text,
  revoked boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tickets_hash_idx ON tickets (ticket_hash);
CREATE INDEX tickets_event_idx ON tickets (event_id);

INSERT INTO tickets (participant_id, event_id, revoked, expires_at)
SELECT
  p.id,
  w.event_id,
  COALESCE(p.revoked, false),
  NULLIF(p."ticketExpiresAt", '')::timestamptz
FROM event_workspaces w,
LATERAL jsonb_to_recordset(
  CASE WHEN jsonb_typeof(COALESCE(w.payload->'participants', '[]'::jsonb)) = 'array'
       THEN w.payload->'participants'
       ELSE '[]'::jsonb END
) AS p(
  id text,
  ticket text,
  revoked boolean,
  "ticketExpiresAt" text
)
WHERE p.id IS NOT NULL
  AND p.ticket IS NOT NULL
ON CONFLICT (participant_id) DO NOTHING;
