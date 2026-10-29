-- Self-service account recovery by verified email (additive only).
--
-- User decision (2026-10-27, "이메일+수동 예외"): a signed-in holder first
-- proves mailbox ownership of their own stored address; only that proven
-- address may later receive recovery links. Locked accounts with no proven
-- channel stay on the separately decided manual process (not built here).
--
-- Existing accounts.email / invitation acceptance NEVER counts as verified:
-- invitation links are bearer-delivered without mailbox proof, so every row
-- starts unverified (NULL) and only an explicit verify confirm sets it.
--
-- - accounts.email_verified_email / email_verified_at: the normalized address
--   proven by a consumed VERIFY proof, and when. Recovery sends only when
--   lower(accounts.email) still equals this value.
-- - account_email_proofs: one-time high-entropy bearer proofs (VERIFY or
--   RECOVER). Only sha256 hashes are stored; raw tokens travel in the email
--   link and the confirm POST body only, never in logs or health output.
--   Confirmation rechecks expiration and consumption under row locks in one
--   transaction, so concurrent confirms serialize and only one can win.
-- - login_attempts scope widening: recovery abuse counters reuse the login
--   throttle table with new scopes ('recovery-email', 'recovery-address').
--   Widening only ADDS values; existing login/security readers are unchanged
--   (the security overview filters scope='account' only). On an old schema
--   without the widened check the server degrades to proof-table caps.
--
-- No data is rewritten, no column is dropped, no existing meaning changes.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email_verified_email text;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS account_email_proofs (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('VERIFY', 'RECOVER')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_email_proofs_account_idx
  ON account_email_proofs (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS account_email_proofs_expiry_idx
  ON account_email_proofs (expires_at);

-- Widen the throttle scope allow-list for recovery abuse counters. The name
-- follows PostgreSQL's implicit {table}_{column}_check convention for the
-- inline CHECK declared in 003_login-throttle.sql.
ALTER TABLE login_attempts DROP CONSTRAINT IF EXISTS login_attempts_scope_check;

ALTER TABLE login_attempts
  ADD CONSTRAINT login_attempts_scope_check
  CHECK (scope IN ('account', 'address', 'recovery-email', 'recovery-address'));
