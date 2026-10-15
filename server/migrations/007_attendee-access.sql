-- Attendee verification and browser sessions (slice 7a).
--
-- Participants stay in event_workspaces.payload (JSONB authority); these
-- tables only hold short-lived verification challenges, single-use signup
-- grants, and opaque browser-session references. Secrets are NEVER stored
-- here: only sha256 hashes of codes, grants and session tokens. The mock
-- SMS transport keeps plaintext codes in process memory only (tests/dev),
-- never in these rows.
--
-- Challenges rate-limit themselves: cooldowns and daily caps are computed
-- from created_at, so no extra counter table can drift.

CREATE TABLE attendee_challenges (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phone text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('ENROLL', 'RECOVER')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  send_state text NOT NULL DEFAULT 'SENT' CHECK (send_state IN ('SENT', 'MOCK', 'FAILED')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attendee_challenges_phone_idx
  ON attendee_challenges (event_id, phone, created_at DESC);
CREATE INDEX attendee_challenges_expiry_idx
  ON attendee_challenges (expires_at);

-- Single-use signup grants issued after a successful ENROLL confirm.
-- The presented secret's hash is the lookup key; the row is consumed
-- atomically (consumed_at set once) before the participant is created.
CREATE TABLE attendee_grants (
  token_hash text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phone text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('ENROLL')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attendee_grants_event_idx ON attendee_grants (event_id);

-- Browser sessions: one opaque token per browser (cookie), holding per-event
-- grants. A grant never authenticates anything by itself; reads resolve the
-- participant from the workspace and recheck active/cancelled/revoked state.
CREATE TABLE attendee_sessions (
  token_hash text PRIMARY KEY,
  grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attendee_sessions_expiry_idx ON attendee_sessions (expires_at);
