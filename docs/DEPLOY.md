# Deployment, backup and recovery

`docker-compose.yml`, `docker-compose.managed.yml`, the environment examples, and the scripts define current runtime settings. This document owns operational data safety and acceptance gates.

## Data and secrets

- PostgreSQL and uploaded files are one user-data set. Keep both persistent across restart and upgrade. Do not run `docker compose down -v`, reset a volume, overwrite an existing storage directory, or use a database reset to resolve a migration or permission error.
- Apply additive migrations and verify them against a separate test or restore target before production. Do not treat the transitional JSON store as a reason to discard existing files or records.
- Keep database credentials, admin passwords, provider credentials, backups, and populated acceptance records outside Git. Restrict backup access because it contains attendee data.
- Use the real HTTPS origin and trusted proxy configuration before enabling secure cookies or exposing the service. A local build or readiness check is not production acceptance.

## Managed PostgreSQL and mounted NAS

The default Compose file retains its local PostgreSQL and named volumes. The standalone `docker-compose.managed.yml` profile runs only API and web. It is JSON-formatted YAML so its structure can also be checked without installing a YAML parser. Do not overlay it on the default file or delete the old deployment volumes during a cutover.

Prepare values from [`ops/managed.env.example`](../ops/managed.env.example) in a private environment file. For a persistent backend, use the exact direct endpoint supplied by Supabase when reachable. On an IPv4-only host, use its session pooler if needed. Do not substitute a transaction-pooler endpoint or derive a hostname from the region. Keep a separately configured direct connection for host backup and approved migration work. See [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

- TLS is `verify-full` with hostname and certificate verification. Mount the approved provider CA read-only and ensure the non-root API can read it. Copied URL TLS flags must agree with the configured policy; `require`, `no-verify`, boolean SSL and URL certificate overrides are rejected. Do not disable verification to fix connectivity.
- A database administrator must provision a dedicated backend role and its application schema before startup. Set `DATABASE_SCHEMA` to that existing schema. A missing schema fails rather than creating application tables in `public`. Existing public-schema data is not moved automatically. Startup still runs additive migrations, so this role needs migration privileges in its own schema. A separate migration-only identity is not implemented.
- Keep this schema out of the Supabase Data API and deny `anon`, `authenticated` and `PUBLIC` access. Disable the Data API if the project is backend-only. Do not expose a database password, privileged Supabase key or database URL to the browser. These boundaries require operator verification in the actual project. See [Data API hardening](https://supabase.com/docs/guides/database/hardening-data-api).
- Set the pool budget for all API replicas and workers together. The example value is a starting configuration, not a Supabase capacity claim. No automatic connection retry replays a write or uncertain COMMIT.
- Mount the NAS on the host first. Supply its existing path and an operator-chosen `.eventouch-storage-id` file whose content matches `EVENTOUCH_STORAGE_ID`. The bind has `create_host_path: false`; mounted mode never creates the root or marker. Prepare directory permissions for container UID 1000 without changing existing file ownership automatically.
- Keep the underlying unmounted directory unwritable to the API user and supervise the mount. Marker checks cannot eliminate a mount change between checking and opening a file, prove a NAS protocol's exclusive-create/fsync guarantees, or replace real interruption and recovery tests. Readiness fails when storage is unavailable. Do not publicly serve the NAS path or bypass server file authorization.

Configuration validation does not start containers or contact Supabase:

```bash
docker compose --env-file /private/eventouch/managed.env -f docker-compose.managed.yml config --quiet
```

Production migration, copying existing data/files, deployment and restoring a live system require separate approval. Confirm identifiers, relationships, receipts, file checksums, credentials, mount availability and a rollback point before switching traffic.

## Backup and restore

Back up PostgreSQL and the configured file storage together from a consistent point. Store the output outside the repository with restricted access and create an off-site copy under an approved retention policy.

```bash
npm run backup -- --project eventouch --out /private/backups/eventouch
npm run backup:verify -- --project eventouch --out /private/backups/eventouch-verify
```

Verification restores to a temporary database and compares its recorded table counts, migration state, and file checksums. Before relying on a backup, restore it into a separate, empty Compose project and verify login, an event, an attendee, and file access. Never rehearse recovery against the live project's database or volumes.

The application backup scripts provide snapshot recovery, not point-in-time recovery. Supabase backup/PITR availability depends on the actual service configuration and does not recover NAS bytes. A restored database and files must still match the same approved recovery point. See [Supabase backup scope](https://supabase.com/docs/guides/platform/backups). Backup frequency, retention, encryption, off-site location, and deletion exceptions still need an operational owner and approval.

For managed PostgreSQL, load the approved private environment into the host process, use a compatible `pg_dump` client, stop application writes and workers under the maintenance procedure, and include the same mounted file directory:

```bash
npm run backup -- --database-env DATABASE_DIRECT_URL --storage-dir /mnt/nas/eventouch/storage --out /private/backups/eventouch-managed
```

The host path uses the application's TLS policy, passes credentials through the child environment rather than command arguments, dumps only the current application schema, and records that schema in the manifest. In mounted mode it checks the same storage identity before and after archiving. `--skip-storage` is a database-only diagnostic backup, not a complete recovery set. Old `--database-url` input remains compatible but exposes the caller's URL in their own command line, so use environment selection instead.

The automated `--verify` and Compose restore paths remain for the default public-schema local deployment. They refuse a private-schema backup before mutating a target. Managed recovery must use a separately approved, empty target and a restored file directory, preserving the recorded schema. Verify every recorded table count and migration plus all file checksums, then login, an event, an attendee and authorized/public file access. Synthetic local restore tests do not approve a real Supabase restore, NAS recovery, role/extension transfer or provider failover. Do not use the local Compose backup scheduler unchanged for a managed deployment.

## Release and human acceptance

The automated release check reads evidence; it does not send messages, deploy, or modify a database. Copy [`ops/acceptance.example.json`](../ops/acceptance.example.json) outside the repository and have the named reviewers record only observed results. Run:

```bash
npm run ops:release:check -- --attestation /private/path/acceptance.json
```

A release record requires explicit policy review and actual operator-journey, iOS Safari/camera, Android/camera, screen-reader, printer/reader, email and message-delivery, and customer-acceptance observations. Configuration, a successful build, or synthetic audits do not satisfy those checks. Follow [provider acceptance](INTEGRATIONS.md) and [the physical-device list](../scripts/device-checklist.md).

## Retention and deletion

Retention periods, deletion authority, exceptions, and backup expiry are not approved. Until they are, do not permanently delete events, accounts, receipts, attendee data, or file bytes. `npm run event:purge:review -- --org-id <organization-id> --event-id <event-id>` reports review information only; it does not purge data.
