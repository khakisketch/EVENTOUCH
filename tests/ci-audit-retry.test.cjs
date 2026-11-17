'use strict';

// Every browser-audit gate runs through run_gate in the web job: the gate keeps
// its own log, gets one retry when its first attempt fails, and only a failure
// on both attempts fails the gate. Three parallel shards split the gates
// round-robin; each shard still runs its own gates serially. This pins the
// wiring; the retry never replaces an assertion or a status check.
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

test('the shards split the gates round-robin and reject a missing shard', () => {
  assert.match(audit, /case "\$\{EVENTOUCH_CI_SHARD:\?CI shard is not set\}" in/, 'a missing shard fails instead of running everything');
  assert.match(audit, /1\|2\|3\) ;;/);
  assert.match(audit, /unknown CI shard/, 'an unknown shard fails instead of running nothing');
  assert.match(audit, /GATE_INDEX=\$\(\(GATE_INDEX \+ 1\)\)/);
  assert.match(audit, /\(\( \(GATE_INDEX - 1\) % 3 \)\) -ne \$\(\(EVENTOUCH_CI_SHARD - 1\)\)/, 'gate N runs on shard ((N-1) mod 3) + 1');
});

test('run_gate keeps the gate log, the retry and the pending port in one place', () => {
  assert.match(audit, /"\$@" 2>&1 \| ci_tee "\$EVENTOUCH_CI_LOGS\/\$log\.log" \|\| ci_retry "\$log" "\$@"/, 'retrying gates keep ci_tee before ci_retry');
  assert.match(audit, /"\$@" 2>&1 \| ci_tee "\$EVENTOUCH_CI_LOGS\/\$log\.log" \|\| ci_pending "\$log"/, 'a pending port keeps ci_tee before ci_pending');
});

test('every browser-audit gate runs through run_gate under its own log name', () => {
  const gates = [...audit.matchAll(/^ *run_gate "([^"]+)"( pending)? npm run (\S+)$/gm)];
  assert.ok(gates.length > 100, `expected the full browser suite, saw ${gates.length}`);
  for (const [, log, , script] of gates) {
    assert.equal(log, script.replace(/:/g, '-'), `${script} keeps its own log name`);
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
