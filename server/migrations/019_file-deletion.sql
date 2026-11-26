-- A participant deletion removes that person's uploaded files, not just their
-- metadata. The row stays so an id still resolves and an idempotent retry finds
-- it, but serving stops the moment deleted_at is set, and the background purge
-- unlinks the bytes once and records bytes_purged_at.
--
-- Two steps rather than one because bytes live outside the database: the
-- transaction marks, the job removes. A crash between them leaves a marked row,
-- which the next job run picks up, so nothing personal is served in the meantime.

ALTER TABLE stored_files ADD COLUMN deleted_at timestamptz;
ALTER TABLE stored_files ADD COLUMN bytes_purged_at timestamptz;

CREATE INDEX stored_files_pending_purge_idx
  ON stored_files (deleted_at)
  WHERE deleted_at IS NOT NULL AND bytes_purged_at IS NULL;
