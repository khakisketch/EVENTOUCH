# EVENTOUCH full-swap rebuild spec (2026-10-06, option B)

> User decision: replace the whole product with the delivered OD bundle
> (`493d5d55-*.zip`, source v22). Rollback point: `81d95dd`.
> Prior 5-role product + 463 tests are superseded where they conflict.

## Target
- Frontend = bundle `index.html` + `assets/` verbatim (visual + flows as designed).
- Roles = OPERATOR / STAFF only. AGENCY/MANAGER migrate to OPERATOR;
  CLIENT login removed; DESK/BOOTH accounts become STAFF (per bundle role-model).
- AuthN/Z = server sessions; tenant = single workspace; CLIENT/portal out.
- Persistence = server store holding the bundle's workspace model;
  localStorage becomes offline/cache only.
- Out of scope (unchanged): real SMS/payment providers, NAS mount, public deploy act.

## Stages
- S1: vendor bundle frontend (index.html + assets), boot in browser, record gaps.
- S2: server auth rework (OPERATOR/STAFF, memberships, assignments, invitations).
- S3: domain APIs remapped to bundle commands (registrations, checks, booths,
  programs, moderation, campaigns SIMULATION_ONLY, reports snapshot).
- S4: frontend store adapter → REST; offline queue/idempotency preserved.
- S5: new test suite for new contracts; browser E2E; report.

## Acceptance
- Login→operate→reload works against server; role gates enforced server-side.
- Suite green on new contracts; 4-viewport overflow-free; console JS errors 0.
