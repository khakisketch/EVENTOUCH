-- Organization-level client files (logos, registration documents).
--
-- Event files stay event-scoped (event_id set, client_id null). Client files
-- are the reverse: client_id set, event_id null. They belong to the customer
-- record, survive event archival/deletion, and are AGENCY-only on every path.
-- Tenancy later maps clients to organizations; these rows follow their client.

ALTER TABLE stored_files ADD COLUMN client_id text REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE stored_files ALTER COLUMN event_id DROP NOT NULL;

CREATE INDEX stored_files_client_idx ON stored_files (client_id) WHERE client_id IS NOT NULL;
