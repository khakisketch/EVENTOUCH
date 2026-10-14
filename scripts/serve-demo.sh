#!/usr/bin/env bash
# Starts EVENTOUCH in server mode against its own preview database.
# Safe to re-run: idempotent except for the port being taken.
#
#   bash scripts/serve-demo.sh                 # 8776, 기본 데모 DB
#   PORT=8899 bash scripts/serve-demo.sh       # 다른 포트
#   DATABASE_URL='postgres://…' bash scripts/serve-demo.sh   # 다른 DB
#
# 시안·캡처 폴더에 의존하지 않는다. 이 스크립트 하나로 데모 서버를 다시 띄운다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8776}"
DATABASE_URL="${DATABASE_URL:-postgres://eventouch@localhost/eventouch_preview?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@eventouch.demo}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Eventouch2026!}"
RUN_DIR="${RUN_DIR:-/tmp/opencode/eventouch-preview}"

cd "$ROOT"
if ss -ltn | grep -q ":$PORT "; then
  echo "port $PORT is already in use — EVENTOUCH may already be running."
  echo "check: curl -s http://localhost:$PORT/api/health"
  exit 0
fi

mkdir -p "$RUN_DIR"
PORT="$PORT" \
DATABASE_URL="$DATABASE_URL" \
ADMIN_EMAIL="$ADMIN_EMAIL" \
ADMIN_NAME="${ADMIN_NAME:-운영사 관리자}" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
DATA_DIR="$RUN_DIR/data" \
STORAGE_DIR="$RUN_DIR/storage" \
EVENTOUCH_DEV_QUICK_LOGIN="$ADMIN_EMAIL" \
node server/server.js > "$RUN_DIR/server.log" 2>&1 &

sleep 2
echo "started. log: $RUN_DIR/server.log"
curl -s "http://localhost:$PORT/api/health" || true
echo
echo "open http://localhost:$PORT/  (또는 http://100.116.163.1:$PORT/)"
echo "계정: $ADMIN_EMAIL / $ADMIN_PASSWORD  (또는 로그인 화면의 '빠른 로그인')"
