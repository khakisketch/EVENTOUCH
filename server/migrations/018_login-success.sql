-- Optional account-owned successful password-login timestamps. No address,
-- user agent, session token, or cross-organization visibility is introduced.
-- Recording stays disabled unless an explicit retention period is configured.
CREATE TABLE IF NOT EXISTS account_login_events (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_login_events_account_idx
  ON account_login_events (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS account_login_events_expiry_idx
  ON account_login_events (occurred_at);
