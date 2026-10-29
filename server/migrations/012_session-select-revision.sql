-- Organization context, step 3: per-session selection revision.
--
-- 011 mapped every row onto an org, but the select flow bound tabs to the
-- ORG's revision (organizations.context_version). Membership edits and tab
-- selections are different facts: a tab selected into A must keep failing
-- closed on A-context writes after the session moves to B, and a stale tab
-- must be deniable without guessing. This adds the session-side fact:
--
-- - sessions.org_select_revision: monotonic per-session counter, bumped by
--   every successful organization.select. The select CASes on it, writes pin
--   against it, and every user-facing contextVersion exposes it — one source
--   of truth across /me, /organizations, select, directory and detail reads.
-- - sessions.org_context_version (011) stays the ORG-side binding snapshot:
--   writes additionally require it to equal the live organizations revision,
--   so membership changes deny stale tabs instead of acting on them.
--
-- No existing column is rewritten; 010/011 checksums are untouched.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS org_select_revision bigint NOT NULL DEFAULT 0;
