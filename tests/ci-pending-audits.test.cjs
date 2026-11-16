'use strict';

// CI audits that still target the screens as they were before the confirmed redesign are marked
// `|| ci_pending "<log>"`: their failure is reported as a warning and listed in the job summary
// instead of stopping every audit after them. This pins that list. Port an audit to its screen,
// delete its suffix in .github/workflows/ci.yml, and remove its name here so it blocks again;
// a new entry needs a deliberate edit of both files, never a silent one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const audit = ci.slice(ci.indexOf('name: Run the browser audits serially'), ci.indexOf('name: Upload audit logs and captures on failure'));

const PENDING_PORT = [
  'web-console-audit',
];

test('only the listed audits are allowed to fail without stopping the web job', () => {
  const marked = [...audit.matchAll(/\|\| ci_pending "([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(marked, PENDING_PORT);
});

test('a pending audit still runs through its own log and never swallows other failures', () => {
  for (const log of PENDING_PORT) {
    const line = audit.split('\n').find((candidate) => candidate.includes(`ci_pending "${log}"`));
    assert.match(line, new RegExp(`\\| ci_tee "\\$EVENTOUCH_CI_LOGS/${log}\\.log" \\|\\| ci_pending "${log}"\\s*$`), `${log} keeps ci_tee before the pending marker`);
  }
  assert.doesNotMatch(audit, /\|\| true\b/, 'no gate may be turned into a silent pass');
});

test('the pending helper warns and the job summary lists what failed', () => {
  assert.match(audit, /ci_pending_failed=\(\)/);
  assert.match(audit, /ci_pending\(\) \{[\s\S]*?::warning title=Audit pending port::/);
  assert.match(audit, /GITHUB_STEP_SUMMARY/);
});
