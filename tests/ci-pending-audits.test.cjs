'use strict';

// CI audits that still target the screens as they were before the confirmed redesign are marked
// `run_gate "<log>" pending npm run ...`: their failure is reported as a warning and listed in the job
// summary instead of stopping every audit after them. This pins that list. Port an audit to its screen,
// drop the `pending` marker in .github/workflows/ci.yml, and remove its name here so it blocks again;
// a new entry needs a deliberate edit of both files, never a silent one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const audit = ci.slice(ci.indexOf('name: Run the browser audits serially'), ci.indexOf('name: Upload audit logs and captures on failure'));

const PENDING_PORT = [
];

test('only the listed audits are allowed to fail without stopping the web job', () => {
  const marked = [...audit.matchAll(/^ *run_gate "([^"]+)" pending npm run \S+$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(marked, PENDING_PORT);
});

test('a pending audit still runs through its own log and never swallows other failures', () => {
  for (const log of PENDING_PORT) {
    const line = audit.split('\n').find((candidate) => candidate.includes(`run_gate "${log}" pending`));
    assert.match(line, new RegExp(`^\\s*run_gate "${log}" pending npm run \\S\+$`), `${log} keeps run_gate before the pending marker`);
  }
  assert.doesNotMatch(audit, /\|\| true\b/, 'no gate may be turned into a silent pass');
});

test('the pending helper warns and the job summary lists what failed', () => {
  assert.match(audit, /ci_pending_failed=\(\)/);
  assert.match(audit, /ci_pending\(\) \{[\s\S]*?::warning title=Audit pending port::/);
  assert.match(audit, /GITHUB_STEP_SUMMARY/);
});
