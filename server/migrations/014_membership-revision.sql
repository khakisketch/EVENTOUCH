-- Per-membership revision for the session binding.
--
-- Sessions bind to the MEMBER row's revision, not the org's: a change to
-- someone else's membership must never wedge every other tab in the org.
-- Only a change to the viewer's own row (role/active/permissions) invalidates
-- that viewer's binding and forces an explicit reselect. The org clock
-- (organizations.context_version) stays as a coarse change marker; the
-- authority for a tab's writes is (session revision, member revision).

ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
