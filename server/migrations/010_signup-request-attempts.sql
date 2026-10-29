-- Short-lived abuse-control counters, not command receipts or participant data.
-- The raw address and request key are never stored here. Existing receipts
-- remain authoritative and must not be purged with these counters.
CREATE TABLE signup_request_attempts (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  command_hash text NOT NULL,
  address_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, command_hash)
);
CREATE INDEX signup_request_attempts_window_idx ON signup_request_attempts (event_id, attempted_at);
CREATE INDEX signup_request_attempts_expiry_idx ON signup_request_attempts (attempted_at);
