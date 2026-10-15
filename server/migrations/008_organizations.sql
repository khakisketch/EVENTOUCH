-- Organization tenancy, step 1 (additive only).
--
-- These tables exist so later steps have somewhere to go, but nothing reads
-- or writes them yet: every existing query, permission check, and API
-- response is unchanged. Data mapping (which org owns existing rows),
-- scoping, and constraints are later steps in docs/MULTI-TENANCY.md and need
-- their own approval. In particular this migration backfills nothing and
-- adds no column to any existing table.

CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('AGENCY', 'MANAGER', 'STAFF')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);

CREATE INDEX organization_memberships_account_idx
  ON organization_memberships (account_id, org_id);
