'use strict';

const fs = require('node:fs');

// Session limits for the running API's pool only. Migrations, backup, restore
// and maintenance scripts may run long on purpose and never ask for them.
// Defaults and their reasoning: docs/DEPLOY.md.
const API_SESSION_LIMITS = [
  ['statement_timeout', 'EVENTOUCH_DB_STATEMENT_TIMEOUT_MS', 15000],
  ['idle_in_transaction_session_timeout', 'EVENTOUCH_DB_IDLE_TRANSACTION_TIMEOUT_MS', 30000],
];

function apiSessionLimits(env = process.env) {
  return Object.fromEntries(API_SESSION_LIMITS.map(([option, name, fallback]) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1000 || value > 600000) {
      throw new Error(`${name}는 1000~600000 정수(밀리초)여야 합니다`);
    }
    return [option, value];
  }));
}

// Keep driver URL parsing from weakening the explicitly selected TLS policy.
function databaseConnectionOptions({ connectionString, env = process.env, apiLimits = false } = {}) {
  const value = connectionString || env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL을 설정하세요');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('DATABASE_URL 형식을 확인하세요'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL은 PostgreSQL 주소여야 합니다');
  const tls = [...url.searchParams.keys()].filter(key => /^(ssl|uselibpqcompat)/i.test(key));
  if (tls.some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1) {
    throw new Error('DATABASE_SSL_MODE와 DATABASE_SSL_CA_FILE로 TLS를 설정하세요');
  }
  const urlMode = url.searchParams.get('sslmode');
  const mode = env.DATABASE_SSL_MODE || env.PGSSLMODE || urlMode || 'disable';
  if (!['disable', 'verify-full'].includes(mode) || (urlMode && urlMode !== mode)) {
    throw new Error('DATABASE_SSL_MODE는 disable 또는 verify-full이어야 하며 URL과 같아야 합니다');
  }
  url.searchParams.delete('sslmode');
  let ssl = false;
  const caFile = env.DATABASE_SSL_CA_FILE || env.PGSSLROOTCERT;
  if (mode === 'verify-full') {
    ssl = { rejectUnauthorized: true };
    if (caFile) {
      try { ssl.ca = fs.readFileSync(caFile, 'utf8'); }
      catch { throw new Error('DATABASE_SSL_CA_FILE을 읽을 수 없습니다'); }
      if (!ssl.ca.trim()) throw new Error('DATABASE_SSL_CA_FILE이 비어 있습니다');
    }
  } else if (caFile) {
    throw new Error('DATABASE_SSL_CA_FILE에는 verify-full TLS가 필요합니다');
  }
  const max = Number(env.PGPOOL_MAX || 10);
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('PGPOOL_MAX는 1~50 정수여야 합니다');
  const options = {
    connectionString: url.toString(), ssl, max,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    ...(apiLimits ? apiSessionLimits(env) : {}),
  };
  if (env.DATABASE_SCHEMA) {
    const schema = env.DATABASE_SCHEMA;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_') || schema === 'information_schema' || url.searchParams.has('options')) {
      throw new Error('DATABASE_SCHEMA와 URL search_path 설정을 확인하세요');
    }
    options.options = `-c search_path=${schema}`;
  }
  return options;
}

module.exports = { apiSessionLimits, databaseConnectionOptions };
