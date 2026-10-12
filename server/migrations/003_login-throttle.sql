-- Login throttling. Two independent scopes so neither a targeted account
-- attack nor a spray across many emails can run unbounded.
CREATE TABLE login_attempts (
  scope text NOT NULL CHECK (scope IN ('account', 'address')),
  key text NOT NULL,
  failures int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  first_failure_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Only rows inside the rolling window matter; older ones are pruned on write.
CREATE INDEX login_attempts_recent_idx ON login_attempts (last_failure_at);

-- An administrative escape hatch. Rate limiting that can lock out the only
-- operator account is an outage, so lockout state must be clearable.
CREATE TABLE login_lockout_overrides (
  key text PRIMARY KEY,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  cleared_by text REFERENCES accounts(id) ON DELETE SET NULL
);