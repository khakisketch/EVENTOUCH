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

Back up PostgreSQL and the configured file storage together from a consistent point. Store the output outside the repository with restricted access. An off-site copy is still undecided (see the policy below).

```bash
npm run backup -- --project eventouch --out /private/backups/eventouch
npm run backup:verify -- --project eventouch --out /private/backups/eventouch-verify
```

Verification restores to a temporary database and compares its recorded table counts, migration state, and file checksums. Before relying on a backup, restore it into a separate, empty Compose project and verify login, an event, an attendee, and file access. Never rehearse recovery against the live project's database or volumes.

The application backup scripts provide snapshot recovery, not point-in-time recovery. Supabase backup/PITR availability depends on the actual service configuration and does not recover NAS bytes. A restored database and files must still match the same approved recovery point. See [Supabase backup scope](https://supabase.com/docs/guides/platform/backups). Backup frequency, encryption, off-site location, and deletion exceptions still need an operational owner and approval. Retention and alerts are decided below.

For managed PostgreSQL, load the approved private environment into the host process, use a compatible `pg_dump` client, stop application writes and workers under the maintenance procedure, and include the same mounted file directory:

```bash
npm run backup -- --database-env DATABASE_DIRECT_URL --storage-dir /mnt/nas/eventouch/storage --out /private/backups/eventouch-managed
```

The host path uses the application's TLS policy, passes credentials through the child environment rather than command arguments, dumps only the current application schema, and records that schema in the manifest. In mounted mode it checks the same storage identity before and after archiving. `--skip-storage` is a database-only diagnostic backup, not a complete recovery set. Old `--database-url` input remains compatible but exposes the caller's URL in their own command line, so use environment selection instead.

The automated `--verify` and Compose restore paths remain for the default public-schema local deployment. They refuse a private-schema backup before mutating a target. Managed recovery must use a separately approved, empty target and a restored file directory, preserving the recorded schema. Verify every recorded table count and migration plus all file checksums, then login, an event, an attendee and authorized/public file access. Synthetic local restore tests do not approve a real Supabase restore, NAS recovery, role/extension transfer or provider failover. Do not use the local Compose backup scheduler unchanged for a managed deployment.

### Backup retention, disk warning and alerts (decided 2026-11-24)

- **Retention: the last 14 days, and never fewer than the newest 7.** `scripts/backup-prune.cjs` removes only backups that are both older than 14 days and outside the newest 7 (`--keep-days`, `--min-keep` can only be set to 1 or more). By default it prints what it would delete and deletes nothing. Deletion needs `--apply --i-understand` together. It touches only direct children of `--backup-root` named `<project>-<timestamp>` that hold a `manifest.json` with `format: 1`; other names, files, symlinks, half-written backups and other projects are listed as skipped and never removed. A root that is a filesystem top level, a system directory or the home directory is refused.
- **Scheduler.** `node scripts/backup-schedule.cjs --backup-root <root> --check --prune --notify` takes the backup, verifies it, prunes only after both succeeded (a failed night never shrinks the history), then checks the backup disk. `--print-cron` prints the cron line; this repository never installs it. A cron line is a deployment action for the operator.
- **Disk warning at 80% used.** The scheduler checks the backup root (`--max-disk-used-percent`, default 80) and `scripts/ops-readiness.cjs --disk-path <path>` fails at the same limit. Both exit nonzero.
- **Alerts.** `scripts/ops-notify.cjs --send` mails the failures only when `EVENTOUCH_OPS_NOTIFY_EMAIL` and the SMTP settings read by `server/smtp-mail.js` (`EVENTOUCH_MAIL_TRANSPORT=smtp`, `EVENTOUCH_SMTP_HOST/PORT/FROM/USER/PASSWORD`) are all present in the environment of that process. Otherwise it only logs, and the output states that no mail was sent. The mail carries check names and details, never credentials. Configuration alone does not prove an inbox received it; confirm one real alert before relying on it.
- **Still undecided:** off-site copy, backup encryption, and who is accountable for acting on an alert.

## Sessions and password changes

- A sign-in lasts `SESSION_TTL_HOURS` (default 12) and is renewed while in use, but never past `SESSION_MAX_DAYS` (default 14) from the moment of sign-in. After that the person signs in again. Existing sessions older than the limit stop working when this ships.
- `/account/password` lets a signed-in person change their own password (current password, new password, confirmation). Success ends every other session of that account and keeps the one that made the change. Wrong current passwords count against the same limits as sign-in, under separate counters, so guessing here cannot lock the sign-in form.

## Release and human acceptance

The automated release check reads evidence; it does not send messages, deploy, or modify a database. Copy [`ops/acceptance.example.json`](../ops/acceptance.example.json) outside the repository and have the named reviewers record only observed results. Run:

```bash
npm run ops:release:check -- --attestation /private/path/acceptance.json
```

A release record requires explicit policy review and actual operator-journey, iOS Safari/camera, Android/camera, screen-reader, printer/reader, email and message-delivery, and customer-acceptance observations. Configuration, a successful build, or synthetic audits do not satisfy those checks. Follow [provider acceptance](INTEGRATIONS.md) and [the physical-device list](../scripts/device-checklist.md).

## Retention and deletion

Backup expiry is decided above (14 days, newest 7 kept). Retention periods for event, account, receipt, attendee and file data, deletion authority and exceptions are not approved. Until they are, do not permanently delete events, accounts, receipts, attendee data, or file bytes. `npm run event:purge:review -- --org-id <organization-id> --event-id <event-id>` reports review information only; it does not purge data.

## 배포 전 점검 (2026-11-20 사고 기록)
- 호스트 디스크 여유가 5GB 아래이면 `docker build`가 Docker VM 디스크를 늘리지 못해 VM 파일시스템이 읽기 전용이 되고 컨테이너가 멈춘다. 배포 전에 `df -h`로 여유를 확인한다.
- 서버 이미지는 `Dockerfile`의 COPY 목록에 있는 `apps/web/lib/*.cjs`만 포함한다. 서버가 새로 `require`하는 공용 모듈은 `Dockerfile`과 `.github/workflows/ci.yml`의 복사 목록에 함께 추가한다. 빠지면 API가 `MODULE_NOT_FOUND`로 재시작을 반복한다.
- 데이터 안전: `docker compose -p <project> up -d --build --no-deps <service>`로 바꾸는 서비스만 교체하고 볼륨은 건드리지 않는다. 교체 전에 `pg_dump` 백업을 받는다.
