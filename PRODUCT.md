# EVENTOUCH product boundaries

EVENTOUCH is a Korean-language event operations service for event agencies. The product serves agency owners and managers, assigned field staff, attendees without an app install, and public venue displays.

## Agreed scope

- The agency's workspace is the operator interface. A client-company login portal and unattended attendee self-check-in are excluded from v1; client companies are managed by the agency.
- A single account may belong to several agencies. Roles and access are agency-scoped; an agency owner cannot change a person's global identity or another agency's role. The last active owner cannot be removed.
- Account recovery is performed by the account holder through an email address they verified in advance. An agency owner cannot reset a shared account globally. Manual identity proof for an account without a verified address needs an approved owner and procedure before use.
- There is no offline login or check-in queue. The server must confirm a write before the interface presents it as complete.
- Payment collection, refunds, gift purchases, and agency billing are outside v1. The agency pays its messaging provider; live sends and recipient charges require configured credentials and deliberate operational verification.
- Customer-approved banners and published attendee styles are event data and must survive redesigns and migrations.

Customer proposal differences and acceptance questions belong in [CONTRACT-SCOPE.md](docs/CONTRACT-SCOPE.md). Data, authorization, tenant, and transaction boundaries belong in [ARCHITECTURE.md](docs/ARCHITECTURE.md). Current visual references are in [DESIGN.md](DESIGN.md).
