-- Shared-SaaS organization isolation, step 2 (additive, legacy-mapped).
--
-- 008 created organizations/organization_memberships but nothing reads them.
-- This migration adds the columns the server authority needs and maps every
-- pre-existing row onto one legacy organization, without touching any existing
-- id, payload, ticket, check-in, receipt, file bytes or paths:
--
-- - organizations.context_version: bumped whenever an org membership changes,
--   so stale tabs (old context) are denied instead of writing blindly.
-- - organization_memberships.active + permissions: per-org role truth.
--   accounts.role/active/org_permissions stay as the global identity record
--   but are no longer the write authority (server reads memberships).
-- - sessions.org_id + org_context_version: the server-verified selected org.
-- - clients/org_id, events/org_id, invitations/org_id, command_receipts/org_id:
--   explicit ownership predicates. Children (workspaces, memberships,
--   assignments, tickets, check-ins, files, outbox) resolve ownership through
--   their parent event/client, so no child bytes are rewritten here.
--
-- Slug uniqueness stays global (events.slug UNIQUE untouched): the slug only
-- locates the event, then the org predicate decides visibility.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS context_version bigint NOT NULL DEFAULT 0;

ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS org_context_version bigint NOT NULL DEFAULT 0;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE command_receipts
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL;

-- Legacy organization owns every pre-existing row. The id is stable so later
-- steps and tests can name it without probing.
INSERT INTO organizations (id, name)
VALUES ('org-legacy', '기존 조직')
ON CONFLICT (id) DO NOTHING;

UPDATE clients SET org_id = 'org-legacy' WHERE org_id IS NULL;
UPDATE events SET org_id = 'org-legacy' WHERE org_id IS NULL;
UPDATE invitations SET org_id = 'org-legacy' WHERE org_id IS NULL;

-- Receipts for event commands follow their event; org-level receipts
-- (event_id NULL) belong to the legacy org.
UPDATE command_receipts r SET org_id = e.org_id
  FROM events e WHERE r.org_id IS NULL AND r.event_id = e.id;
UPDATE command_receipts SET org_id = 'org-legacy'
  WHERE org_id IS NULL;

-- Every existing account keeps working in the legacy org with the same role,
-- active flag and org permissions it had globally. No account is widened:
-- the membership copies exactly what the account row already carried.
INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
SELECT 'org-legacy', id, role, active, COALESCE(org_permissions, '[]'::jsonb)
  FROM accounts
ON CONFLICT (org_id, account_id) DO NOTHING;

-- Existing sessions select the legacy org so single-org clients keep working
-- without sending an org context. Multi-membership sessions must select
-- explicitly (server denies, never silently falls back).
UPDATE sessions SET org_id = 'org-legacy' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS events_org_idx ON events (org_id);
CREATE INDEX IF NOT EXISTS clients_org_idx ON clients (org_id);
CREATE INDEX IF NOT EXISTS invitations_org_idx ON invitations (org_id);
CREATE INDEX IF NOT EXISTS command_receipts_org_idx ON command_receipts (org_id);
CREATE INDEX IF NOT EXISTS organization_memberships_active_idx
  ON organization_memberships (org_id, active);
