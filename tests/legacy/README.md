# Legacy test archive (non-runnable by design)

Files in this directory are **historical references**, not current product acceptance
tests. `npm test` runs `tests/*.test.cjs` (no recursion), so nothing here executes.

- `server-api.cjs`, `server-sync.cjs`, `integration-payments.cjs` — pre-PostgreSQL
  JSON/ETKO characterization. Their original imports (`../app.js`, `../features/*`,
  `../server/*`) intentionally stay unchanged; do not "fix" them, which would
  resurrect retired JSON paths.
- Current coverage lives in `tests/*.test.cjs` (server, adapter, presentation,
  map, invitations) plus the SDD fixture scripts under
  `.superpowers/sdd/2026-10-07-eventouch-postgresql/`.

## Batch archive (2026-10-08)

71 files that characterized the removed v9 static shell (`app.js`, `features/*`,
`styles/*`, `i18n/ko.json`) were moved here from `tests/` so `npm test`
(`tests/*.test.cjs`) no longer reports them. Their imports are intentionally left
broken; do not repair or delete. The labeled attribution and the full file list
live in `docs/superpowers/legacy-test-attribution.md`.
