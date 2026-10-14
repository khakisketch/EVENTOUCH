-- Transactional outbox for message dispatch intent.
--
-- A campaign that reaches SENDING has its send queued here in the SAME
-- transaction that flips the workspace state, so a crash between commit and
-- the provider call can no longer lose the send silently: the row stays
-- PENDING and a later drain replays it. Rows are settled (deleted) once the
-- outcome is recorded in the workspace, so this table only ever holds work
-- that still needs doing. Additive only; no existing data is touched.

CREATE TABLE message_outbox (
  message_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'DONE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_outbox_due_idx ON message_outbox (status, next_attempt_at);
