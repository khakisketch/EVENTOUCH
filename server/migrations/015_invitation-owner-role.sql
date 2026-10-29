-- Invitations may name an org owner.
--
-- Owner invites are how an organization grows new owners without a platform
-- operator: only a current org owner may issue them (server-enforced), they
-- never carry an event scope, and accepting one adds exactly one org
-- membership. The 001 role gate predates that flow; extend it here instead
-- of rewriting history.

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_role_check CHECK (role IN ('MANAGER', 'STAFF', 'AGENCY'));
