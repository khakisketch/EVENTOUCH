# Deployment, backup and recovery

`docker-compose.yml`, `.env.example`, and the scripts define current runtime settings. This document owns operational data safety and acceptance gates.

## Data and secrets

- PostgreSQL and uploaded files are one user-data set. Keep both persistent across restart and upgrade. Do not run `docker compose down -v`, reset a volume, overwrite an existing storage directory, or use a database reset to resolve a migration or permission error.
- Apply additive migrations and verify them against a separate test or restore target before production. Do not treat the transitional JSON store as a reason to discard existing files or records.
- Keep database credentials, admin passwords, provider credentials, backups, and populated acceptance records outside Git. Restrict backup access because it contains attendee data.
- Use the real HTTPS origin and trusted proxy configuration before enabling secure cookies or exposing the service. A local build or readiness check is not production acceptance.

## Backup and restore

Back up PostgreSQL and the configured file storage together from a consistent point. Store the output outside the repository with restricted access and create an off-site copy under an approved retention policy.

```bash
npm run backup -- --project eventouch --out /private/backups/eventouch
npm run backup:verify -- --project eventouch --out /private/backups/eventouch-verify
```

Verification restores to a temporary database and compares its recorded table counts, migration state, and file checksums. Before relying on a backup, restore it into a separate, empty Compose project and verify login, an event, an attendee, and file access. Never rehearse recovery against the live project's database or volumes.

There is no point-in-time recovery. Recovery can only return to the last usable backup. Backup frequency, retention, encryption, off-site location, and deletion exceptions still need an operational owner and approval.

## Release and human acceptance

The automated release check reads evidence; it does not send messages, deploy, or modify a database. Copy [`ops/acceptance.example.json`](../ops/acceptance.example.json) outside the repository and have the named reviewers record only observed results. Run:

```bash
npm run ops:release:check -- --attestation /private/path/acceptance.json
```

A release record requires explicit policy review and actual operator-journey, iOS Safari/camera, Android/camera, screen-reader, printer/reader, email and message-delivery, and customer-acceptance observations. Configuration, a successful build, or synthetic audits do not satisfy those checks. Follow [provider acceptance](INTEGRATIONS.md) and [the physical-device list](../scripts/device-checklist.md).

## Retention and deletion

Retention periods, deletion authority, exceptions, and backup expiry are not approved. Until they are, do not permanently delete events, accounts, receipts, attendee data, or file bytes. `npm run event:purge:review -- --org-id <organization-id> --event-id <event-id>` reports review information only; it does not purge data.
