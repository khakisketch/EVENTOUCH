const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../server/store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'etko-store-'));
}

test('store-roundtrip-persists-object', () => {
  const dir = tmpDir();
  const db = store.openStore(dir);
  db.write('users', { u1: { name: '관리자' } });
  assert.deepEqual(db.read('users'), { u1: { name: '관리자' } });
});

test('store-missing-file-reads-empty', () => {
  const db = store.openStore(tmpDir());
  assert.deepEqual(db.read('nope'), {});
});

test('store-update-applies-mutator', () => {
  const dir = tmpDir();
  const db = store.openStore(dir);
  db.write('events', { a: 1 });
  db.update('events', (cur) => ({ ...cur, b: 2 }));
  assert.deepEqual(db.read('events'), { a: 1, b: 2 });
});

test('store-write-leaves-no-tmp', () => {
  const dir = tmpDir();
  const db = store.openStore(dir);
  db.write('users', { u1: 1 });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0);
});
