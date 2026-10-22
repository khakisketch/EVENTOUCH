#!/usr/bin/env bash
# Starts the EVENTOUCH product (API + Next sole UI, supervised) against its
# own preview database. Safe to re-run: idempotent, never reseeds or resets
# existing data — migrate/seed on boot only ensure the admin exists.
#
#   bash scripts/serve-demo.sh                 # API 8776 + web 8777, 데모 DB
#   PORT=8899 bash scripts/serve-demo.sh       # 다른 API 포트
#   WEB_PORT=8898 bash scripts/serve-demo.sh   # 다른 웹 포트
#   DATABASE_URL='postgres://…' bash scripts/serve-demo.sh   # 다른 DB
#
# Attendee verification codes use the mock SMS transport here
# (EVENTOUCH_SMS_MOCK=1): codes are written to the server log only, never to
# HTTP responses. Real sends need Solapi credentials (docs/INTEGRATIONS.md)
# and EVENTOUCH_SMS_MOCK unset.
#
# An occupied API or web port is an explicit error (nonzero exit), not a
# silent "already running": reusing an unknown listener would hide which
# build is actually answering.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-${PORT:-8776}}"
WEB_PORT="${WEB_PORT:-8777}"
DATABASE_URL="${DATABASE_URL:-postgres://eventouch@localhost/eventouch_preview?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@eventouch.demo}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Eventouch2026!}"
RUN_DIR="${RUN_DIR:-/tmp/opencode/eventouch-preview}"

cd "$ROOT"

for spec in "$API_PORT:API" "$WEB_PORT:web"; do
  port="${spec%%:*}"
  name="${spec##*:}"
  if ss -ltn 2>/dev/null | grep -q ":$port "; then
    echo "error: $name port $port is already in use — refusing to reuse an unknown listener." >&2
    echo "check: curl -s http://localhost:$port/api/health" >&2
    echo "stop the owner or set ${name}_PORT explicitly." >&2
    exit 1
  fi
done

if [[ ! -x apps/web/node_modules/next/dist/bin/next ]]; then
  echo "error: apps/web is not installed. Run: npm run setup" >&2
  exit 1
fi

mkdir -p "$RUN_DIR"

echo "starting product: API $API_PORT + web $WEB_PORT (database preserved, no reseed)."
API_PORT="$API_PORT" \
WEB_PORT="$WEB_PORT" \
DATABASE_URL="$DATABASE_URL" \
ADMIN_EMAIL="$ADMIN_EMAIL" \
ADMIN_NAME="${ADMIN_NAME:-운영사 관리자}" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
DATA_DIR="$RUN_DIR/data" \
STORAGE_DIR="$RUN_DIR/storage" \
EVENTOUCH_SMS_MOCK="${EVENTOUCH_SMS_MOCK:-1}" \
EVENTOUCH_DEV_QUICK_LOGIN="$ADMIN_EMAIL" \
exec node scripts/dev-supervisor.cjs
