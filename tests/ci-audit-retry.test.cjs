'use strict';

// Every browser-audit gate in the web job gets one retry when its first attempt fails.
// Both attempts append to the gate's own log, and only a failure on both attempts fails
// the gate. This pins the wiring; the retry never replaces an assertion or a status check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const audit = ci.slice(ci.indexOf('name: Run the browser audits serially'), ci.indexOf('name: Upload audit logs and captures on failure'));

test('the retry helper appends to the gate log, gets a fresh capture root, and fails only when the second attempt fails', () => {
  assert.match(audit, /ci_retry\(\) \{\n\s+local name="\$1"\n\s+local log=[^\n]+\n\s+shift\n/);
  assert.match(audit, /local retry_root="\$EVENTOUCH_CI_CAPTURES\/retry-\$name"/, 'the second attempt has its own captures folder');
  assert.match(audit, /mkdir -m 700 "\$retry_root"/);
  assert.match(audit, /EVENTOUCH_CAPTURE_ROOT="\$retry_root" "\$@" 2>&1 \| ci_tee "\$log"/, 'both attempts append to the same gate log');
  assert.doesNotMatch(audit, /\|\|\s*true\b/, 'no gate may be turned into a silent pass');
});

test('every browser-audit gate retries its own log, under the same name', () => {
  const gates = [...audit.matchAll(/npm run ((?:web|audit):\S+) 2>&1 \| ci_tee "\$EVENTOUCH_CI_LOGS\/([^"/]+)\.log"( \|\| ci_retry "([^"]+)" npm run (\S+))?/g)];
  assert.ok(gates.length > 100, `expected the full browser suite, saw ${gates.length}`);
  for (const [, script, log, retry, retryName, retryScript] of gates) {
    assert.ok(retry, `${log} has a retry`);
    assert.equal(retryName, log, `${log} retries under its own log name`);
    assert.equal(retryScript, script, `${log} retries the same script`);
  }
});

test('database migration is not an audit and is never retried', () => {
  assert.match(audit, /npm run db:migrate 2>&1 \| ci_tee "\$EVENTOUCH_CI_LOGS\/db-migrate\.log"\n/);
  assert.doesNotMatch(audit, /ci_retry "db-migrate"/);
});

test('the job summary lists audits that were retried', () => {
  assert.match(audit, /ci_retried=\(\)/);
  assert.match(audit, /Audits retried once/);
  assert.match(audit, /\$\{ci_retried\[@\]\}/);
});
