'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('new UI regression units are discoverable by the default serial test glob', () => {
  for (const name of ['errors', 'moderation', 'organization-integrations', 'organization-invitations', 'organization-selector', 'organizations-staff', 'reads', 'recovery']) {
    const stem = path.join(__dirname, `console-system-improvement-${name}`);
    assert.ok(fs.existsSync(`${stem}.test.cjs`), `${name} belongs to tests/*.test.cjs`);
    assert.equal(fs.existsSync(`${stem}.cjs`), false, `${name} has no duplicate undiscovered suite`);
  }
});

test('organization role audit uses explicit shared test DB validation and cannot silently skip a required probe', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/web-system-improvement-organization-roles.cjs'), 'utf8');
  assert.match(source, /require\(['"]\.\.\/tests\/helpers\/postgres-test\.cjs['"]\)/);
  assert.match(source, /testDatabaseUrl/);
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s'"]+/u, 'no hardcoded task or production DB URL');
  assert.doesNotMatch(source, /skipped:\s*|retryPath = ['"]fallback-navigation|best.effort/iu, 'uncertainty never becomes a passing skipped check');
  assert.match(source, /if \(require\.main === module\)/);
  assert.match(source, /module\.exports = \{ runOrganizationRoleAudit/);
});

test('owner confirmation cannot consume a held activation key after focus moves into review', () => {
  const source = fs.readFileSync(path.join(ROOT, 'apps/web/app/console/console-ui/ConsoleConfirm.tsx'), 'utf8');
  assert.match(source, /confirmRef\.current\?\.focus\(\)/);
  assert.match(source, /event\.repeat && \(event\.key === "Enter" \|\| event\.key === " "\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /onClick=\{onConfirm\}/);
  assert.match(source, /disabled=\{busy\}/);
});
