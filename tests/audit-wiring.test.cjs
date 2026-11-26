'use strict';

// Every browser audit can be run by a command: its own package.json script, a verify step, or
// the extra-audits list. An audit nobody runs goes stale without anyone noticing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { AUDITS } = require('../scripts/web-extra-audits.cjs');
const { SCRIPTS } = require('../scripts/verify-system.cjs');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).scripts || {};

test('every web audit is wired to a command and every listed audit exists', () => {
  const commands = [...Object.values(read('package.json')), ...Object.values(read('apps/web/package.json'))].join(' ');
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((name) => /^web-.*\.cjs$/.test(name) && name !== 'web-extra-audits.cjs');
  const orphans = files.filter((name) => !commands.includes(`scripts/${name}`) && !AUDITS.includes(name.replace(/\.cjs$/, '')));
  assert.deepEqual(orphans, []);
  for (const name of AUDITS) assert.ok(files.includes(`${name}.cjs`), `${name} exists`);
  assert.ok(SCRIPTS.includes('web:extra:audit'), 'the verification run includes the extra audits');
});
