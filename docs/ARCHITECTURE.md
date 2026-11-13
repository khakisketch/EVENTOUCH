# System, authorization and data boundaries

Source code and tests define implementation behavior. This document owns cross-cutting data, access, and safety commitments; it is not a file map or change history.

## Organization and account boundaries

- An account is one global login identity. Memberships define its role and permissions separately for each agency. Never infer authorization from a submitted organization ID or from a role attached to the global account.
- Every private read, write, file, receipt, invitation, and background task is scoped to the authenticated organization and, where applicable, the event. A stale or revoked organization context is rejected; do not silently switch to another membership. A request and its retry receipt stay bound to the organization that accepted it.
- Existing data belongs to its original agency. Migration must preserve identifiers, relationships, ticket and check-in history, receipts, and file paths and bytes. Credentials and memberships do not transfer to a new agency.
- Agency owners manage only their agency's membership and role. They cannot change a person's global identity, credentials, or another agency's access. The last active owner cannot be demoted or disabled.
- Shared-account recovery is a global identity action. Only the account holder can use an email address they verified in advance. An agency owner cannot reset a shared account. Manual proof for accounts without a verified address needs an approved owner and procedure before use.

## Writes, retries and external effects

- Event writes and organization-wide writes use their respective server command paths. Authorization, current state, idempotency receipt, data change and audit record are committed atomically. Preserve lock and retry ordering; the same command ID returns its recorded result rather than applying the write twice.
- A receipt lookup is read-only and scoped to the original authorized actor and resource. `UNCONFIRMED` is not proof of failure. `APPLIED` proves a database commit, not a provider send or recipient delivery. Do not persist request bodies, contact details, credentials, or bearer links in browser recovery state.
- External messages are dispatched after commit. Keep the send intent recoverable across process restarts, and distinguish queued, provider-accepted, delivered, rejected, and unknown results. An unknown result must not trigger an unverified duplicate send.
- Draft changes remain private to operators. Public responses and files expose only approved, published content. File reads and updates recheck event ownership and access; replacing a reference must not erase its original bytes.

## Identity and public credentials

- Passwords and session, recovery, invitation, and attendee proof tokens are secrets. Store only protected representations where applicable; never place raw values in logs, public projections, or persistent browser storage.
- Ticket QR codes are bearer credentials. Each check-in is decided by the server against current event, ticket, and attendee state. The browser cannot assert a successful check-in while the server result is unknown.
- Public and staff views receive only the data needed for their role. In particular, draft content, private evidence files, cross-agency activity, and unrelated rewards are not public bootstrap data.

## Persistence and retention

- PostgreSQL is the authority when configured. Schema changes are additive and preserve existing user data; JSON fallback is transitional and does not justify resetting old data.
- Supabase is a hosted PostgreSQL deployment, not a replacement authorization or identity layer. Browsers keep using the server API. Private application tables belong in a pre-provisioned schema excluded from the Supabase Data API; do not grant browser roles access or replace server transactions with client-side database writes.
- File metadata and opaque storage keys stay in PostgreSQL. Bytes belong to a separate private storage port, including authorized/public reads, archives and message attachments. A directory backend may use local disk or an operator-mounted NAS without changing file identifiers. Never store a NAS absolute path or public URL as the business file identifier.
- Mounted storage must fail closed when its configured identity is missing. The marker is an availability guard, not proof of mount correctness or hardware durability. The host supervisor and permissions must prevent writes to an unmounted fallback directory. A database transaction is not a distributed transaction with the filesystem. Retain uploaded bytes when the COMMIT outcome is unknown and reconcile the original command receipt before deciding its result.
- Database and uploaded-file storage form one recovery set. Back them up from a consistent point and verify a restore before relying on it. Keep backup material outside the repository with restricted access.
- Retention periods, deletion authority, backup expiry, and deletion exceptions are not approved. Do not add permanent event, account, file, or receipt deletion until those policies are decided and a retry-safe path is designed.
- Public event slugs remain globally unique while they identify public event and ticket URLs. `EVENTOUCH_PUBLIC_URL` is a shared service origin, not a per-agency credential.

## External verification boundary

- Do not send live messages, change a production database, deploy, or alter an existing volume without explicit operational approval. Keep credentials in a private runtime secret store.
- Local and synthetic checks do not prove real-provider delivery, device behavior, screen-reader use, customer acceptance, production recovery, or service capacity. Use the external acceptance input in `ops/acceptance.example.json`, the relevant provider review in [INTEGRATIONS.md](INTEGRATIONS.md), the physical-device list in [../scripts/device-checklist.md](../scripts/device-checklist.md), and deployment/restore procedures in [DEPLOY.md](DEPLOY.md).

Customer commitments and unresolved proposal differences are recorded once in [CONTRACT-SCOPE.md](CONTRACT-SCOPE.md). Product exclusions are in [../PRODUCT.md](../PRODUCT.md); UI behavior and appearance are in [../UX-CONTRACT.md](../UX-CONTRACT.md) and [../DESIGN.md](../DESIGN.md).
