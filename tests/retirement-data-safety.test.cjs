'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('retirement workers agree across origins and do not deadlock activation on navigation', () => {
  const worker = fs.readFileSync(path.join(root, 'server/sw.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(root, 'apps/web/public/sw.js'), 'utf8'), worker);
  assert.doesNotMatch(worker, /await\s+client\.navigate/);
  assert.ok(worker.indexOf('await self.registration.unregister()') < worker.indexOf('void client.navigate('));
  assert.doesNotMatch(worker, /\b(?:localStorage|sessionStorage)\s*\./);
});

test('API image prepares private writable volume directories before becoming non-root', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const prepare = dockerfile.indexOf('mkdir -p /data/db /data/storage');
  const dropPrivileges = dockerfile.indexOf('USER node');
  assert.ok(prepare >= 0 && dropPrivileges > prepare);
  assert.match(dockerfile, /chown node:node \/data\/db \/data\/storage/);
  assert.match(dockerfile, /chmod 700 \/data\/db \/data\/storage/);
});
