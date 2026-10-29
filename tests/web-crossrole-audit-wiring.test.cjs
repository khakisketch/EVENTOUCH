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

test('cross-role audit checks a delayed real roster refresh and waits for each inspector to close', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/web-crossrole-journey-audit.cjs'), 'utf8');
  assert.match(source, /const response = await route\.fetch\(\)/, 'the delayed refresh uses the real API');
  assert.match(source, /await route\.fulfill\(\{ response \}\)/, 'the unchanged real response is released');
  assert.match(source, /waitlist details remain busy while the real refresh response is delayed/);
  assert.match(source, /busy waitlist details reject dismissal/);
  assert.match(source, /async function closeParticipantDetails\(/);
  assert.match(source, /dialog\.getByRole\('button', \{ name: '닫기', exact: true \}\)\.click\(/);
  assert.match(source, /dialog\.waitFor\(\{ state: 'hidden'/);
  for (const name of ['무효 검증 참가자', '감사 참가자 1', '여정 참가자 병', '여정 참가자 무']) {
    assert.ok(source.includes(`closeParticipantDetails(roster, '${name}')`), `${name}: wait for the matching inspector`);
  }
  assert.doesNotMatch(source, /roster\.keyboard\.press\('Escape'\)\.catch\(/, 'do not ignore a failed dismissal');
});
