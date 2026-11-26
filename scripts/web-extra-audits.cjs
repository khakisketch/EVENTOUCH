"use strict";

// Browser audits that have no command of their own. Each runs once with its own capture
// folder; a failure is reported at the end so one broken audit does not hide the rest.
// A new scripts/web-*.cjs belongs in package.json or in this list (tests/audit-wiring.test.cjs).
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { defaultCaptureDir, runStamp } = require('./capture-dir.cjs');

const AUDITS = [
  "web-attendee-first-cookie-race-audit",
  "web-attendee-parallel-recovery-audit",
  "web-booth-conflict-audit",
  "web-booth-schedule-audit",
  "web-booth-schedule-availability-audit",
  "web-consent-change-recovery-audit",
  "web-consent-history-audit",
  "web-consent-publish-receipt-audit",
  "web-console-boundaries",
  "web-customer-ux-audit",
  "web-design-review-audit",
  "web-desk-conflict-audit",
  "web-group-conflict-audit",
  "web-invalid-ticket-identity-audit",
  "web-live-mode-audit",
  "web-message-timezone-audit",
  "web-message-workbench-audit",
  "web-nametag-freshness-audit",
  "web-participant-workbench-audit",
  "web-participation-content-version-audit",
  "web-qa-content-version-audit",
  "web-question-conflict-audit",
  "web-register-partial-response-audit",
  "web-roster-attendance-label-audit",
  "web-round-next-handoff-audit",
  "web-round-next-media-audit",
  "web-settings-conflict-audit",
  "web-settings-features-conflict-audit",
  "web-staff-manual-roster-audit",
  "web-system-improvement-freshness",
  "web-system-improvement-safe4",
  "web-task-first-final-audit",
  "web-task-first-final-journeys",
  "web-task-first-final-states",
  "web-task-flow-audit",
  "web-task-flow-journey-audit",
  "web-venue-arrival-audit",
];

function main() {
  // Each audit creates its own folder below this fresh root.
  const root = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`extra-audits-${runStamp()}`);
  const failed = [];
  for (const name of AUDITS) {
    console.log(`[extra-audits] ${name}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, `${name}.cjs`)], {
      stdio: "inherit", timeout: 600000,
      env: { ...process.env, EVENTOUCH_CAPTURE_ROOT: path.join(root, "extra", name) },
    });
    if (result.status !== 0) failed.push(name);
  }
  if (failed.length) {
    console.error(`[extra-audits] failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  } else console.log(`[extra-audits] ${AUDITS.length} audits passed`);
}

if (require.main === module) main();

module.exports = { AUDITS };
