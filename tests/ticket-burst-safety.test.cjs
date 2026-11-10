'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.join(__dirname, '../scripts/ticket-burst-rehearsal.cjs');
for (const [name, value, expected] of [
  ['missing URL', '', /dedicated loopback PostgreSQL test database/],
  ['remote database', 'postgres://localhost.example.invalid/eventouch_test', /loopback-only/],
  ['host override', 'postgres://127.0.0.1/eventouch_test?host=remote.example.invalid', /loopback-only/],
  ['other URL parameters', 'postgres://127.0.0.1/eventouch_test?sslmode=require', /query parameters are not permitted/],
  ['non-test name', 'postgres://127.0.0.1/eventouch', /database name must identify a test database/],
]) {
  test(`ticket burst refuses ${name} before starting`, () => {
    const child = spawnSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, EVENTOUCH_LOAD_DATABASE_URL: value },
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, expected);
    assert.doesNotMatch(child.stderr, /\[capture\]/);
  });
}
