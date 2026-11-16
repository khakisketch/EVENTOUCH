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
  'audit-usability',
  'web-account-recovery-audit',
  'web-archive-preconditions-audit',
  'web-attendance-consistency-audit',
  'web-attendee-visibility-audit',
  'web-booth-mode-review-audit',
  'web-close-audit',
  'web-console-audit',
  'web-crossrole-audit',
  'web-delivery-audit',
  'web-hanwool-audit',
  'web-intake-roster-edit-audit',
  'web-lucky-batches-audit',
  'web-lucky-capacity-audit',
  'web-lucky-range-config-audit',
  'web-message-nav-freshness-audit',
  'web-message-targeting-audit',
  'web-organizations-audit',
  'web-page-publication-context-audit',
  'web-page-visibility-review-audit',
  'web-participation-navigation-audit',
  'web-publication-audit',
  'web-publication-context-audit',
  'web-qa-schedule-audit',
  'web-reviewed-exit-audit',
  'web-reward-cancellation-conflict-audit',
  'web-reward-recovery-audit',
  'web-roulette-conflict-audit',
  'web-roulette-schedule-audit',
  'web-schedule-review-audit',
  'web-signup-retry-audit',
  'web-system-audit',
  'web-theme-audit',
  'web-theme-freshness-audit',
  'web-ticket-postponement-audit',
  'web-verification-uncertain-audit',
  'web-workbench-audit',
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
