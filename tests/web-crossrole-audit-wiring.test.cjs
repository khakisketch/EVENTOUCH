'use strict';

// Keep the cross-role journey available locally and in the same serial,
// isolated browser-audit job as the other product journeys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('cross-role journey is wired into npm and the isolated web audit job', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.equal(pkg.scripts['web:crossrole:audit'], 'node scripts/web-crossrole-journey-audit.cjs');
  assert.ok(fs.existsSync(path.join(root, 'scripts/web-crossrole-journey-audit.cjs')));
  assert.match(ci, /npm run web:crossrole:audit 2>&1 \| ci_tee "\$EVENTOUCH_CI_LOGS\/web-crossrole-audit\.log"/);
  const webJob = ci.slice(ci.indexOf('\n  web:\n'));
  const build = webJob.indexOf('npm --prefix apps/web run build');
  const audit = webJob.indexOf('npm run web:crossrole:audit');
  assert.ok(build >= 0 && audit > build, 'the web job builds before running the journey');
  assert.match(webJob, /set -o pipefail/, 'a failed audit must not be hidden by tee');
  assert.match(webJob, /EVENTOUCH_TEST_DATABASE_URL: postgresql:\/\/[^\s]+@localhost:\d+\/[^\s]+/);
});
