<!-- impeccable:product-schema 1 -->
# EVENTOUCH product boundaries

Platform: web

EVENTOUCH is a Korean-language event operations service for event agencies. The product serves agency owners and managers, assigned field staff, attendees without an app install, and public venue displays.

## Users

- **Agency owners and managers** run events from the console: preparation, live operation, and results.
- **Assigned field staff** work on site, mostly on phones and shared tablets, under time pressure.
- **Attendees** use a mobile web page with no app install: registration, ticket, event menus, and participation programs.
- **Public venue displays** show event content and are display-only.

## Purpose

Let an agency run an event end to end in one place: prepare it, operate it on the day, and report the results. The design center is the agency operator's full flow from preparation through the live event to results. Staff and attendee screens exist to support that flow.

## Positioning

An operations tool for agencies, not a consumer event app and not a client-facing portal. The agency's customers appear as managed records and as attendees, never as console users.

## Operating Context

- Console work happens at a desk, with long sessions and dense information.
- Field work happens standing up, on a phone, with interruptions; a wrong tap has real cost.
- The server must confirm every write before the interface says it is done.

## Capabilities and Constraints

- The agency's workspace is the operator interface. A client-company login portal and unattended attendee self-check-in are excluded from v1; client companies are managed by the agency.
- A single account may belong to several agencies. Roles and access are agency-scoped; an agency owner cannot change a person's global identity or another agency's role. The last active owner cannot be removed.
- Account recovery is performed by the account holder through an email address they verified in advance. An agency owner cannot reset a shared account globally. Manual identity proof for an account without a verified address needs an approved owner and procedure before use.
- There is no offline login or check-in queue. The server must confirm a write before the interface presents it as complete.
- Payment collection, refunds, gift purchases, and agency billing are outside v1. The agency pays its messaging provider; live sends and recipient charges require configured credentials and deliberate operational verification.
- Customer-approved banners and published attendee styles are event data and must survive redesigns and migrations.

## Evidence on Hand

Customer proposal differences and acceptance questions are in [CONTRACT-SCOPE.md](docs/CONTRACT-SCOPE.md). No end-user research or analytics exist in the repository; design decisions rest on the stated owner preferences in [DESIGN.md](DESIGN.md) and on direct review of the running screens.

## Product Principles

- **Priority follows the task.** Show the action the operator must take now before supporting metrics; do not give every control equal weight.
- **One main action per screen.** Quiet utilities stay quiet; status uses color plus shape, and numbers carry context.
- **Recovery stays visible.** Errors, unknown outcomes, and gated actions say what happened and what to do next.
- **No uniform templates.** A pattern proven on one screen is a reference, not a rollout mandate.

Data, authorization, tenant, and transaction boundaries belong in [ARCHITECTURE.md](docs/ARCHITECTURE.md). Current visual references are in [DESIGN.md](DESIGN.md).
