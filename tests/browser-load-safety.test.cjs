'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('browser load rehearsal refuses missing, remote, ambiguous or non-test database URLs before capture', () => {
  const script = path.join(__dirname, '../scripts/browser-load-rehearsal.cjs');
  for (const value of [
    '',
    'postgres://test@remote.example.test/eventouch_test',
    'postgres://test@127.0.0.1/eventouch_production',
    'postgres://test@127.0.0.1/contest_production',
    'postgres://test@127.0.0.1/eventouch_test?host=127.0.0.1&host=remote.example.test',
    'postgres://test@127.0.0.1/eventouch_test?service=production',
  ]) {
    const env = { ...process.env, EVENTOUCH_BROWSER_LOAD_DATABASE_URL: value };
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0, `must reject ${value || 'missing URL'}`);
    assert.doesNotMatch(result.stderr, /\[capture\] output:/, 'refusal precedes creating a capture or fixture');
  }
});
