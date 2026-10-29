'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameCounts, sameHashes, parseArgs } = require('../scripts/backup-lib.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COUNT_TABLES, readManifest, verifyChecksums } = require('../scripts/backup-lib.cjs');

test('backup rehearsal compares every recorded table count', () => {
  assert.deepEqual(sameCounts({ events: 2, tickets: 4 }, { events: 2, tickets: 4 }), []);
  assert.deepEqual(
    sameCounts({ events: 2, tickets: 4 }, { events: 2, tickets: 3 }),
    ['tickets: 4 -> 3'],
  );
  assert.deepEqual(
    sameCounts({ events: 2 }, { events: 2, stored_files: 1 }),
    ['stored_files: (missing) -> 1'],
  );
});

test('backup rehearsal catches missing, changed and extra files', () => {
  const expected = [
    { path: 'file-a', sha256: 'a'.repeat(64) },
    { path: 'file-b', sha256: 'b'.repeat(64) },
  ];
  assert.deepEqual(sameHashes(expected, expected), []);
  assert.deepEqual(
    sameHashes(expected, [
      { path: 'file-a', sha256: 'c'.repeat(64) },
      { path: 'file-c', sha256: 'd'.repeat(64) },
    ]),
    ['changed: file-a', 'extra: file-c', 'missing: file-b'],
  );
});

test('restore accepts a positional backup directory', () => {
  const options = parseArgs(
    ['/tmp/eventouch-backup', '--project', 'eventouch-restore', '--force'],
    { project: '', force: false },
  );
  assert.deepEqual(options._, ['/tmp/eventouch-backup']);
  assert.equal(options.project, 'eventouch-restore');
  assert.equal(options.force, true);
});

test('restore validates the entire manifest before any database mutation is possible', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-manifest-guard-'));
  const good = {
    format: 1, source: { database: 'synthetic', migrations: ['001_initial.sql'] },
    counts: Object.fromEntries(COUNT_TABLES.map(table => [table, 0])),
    database: { file: 'database.dump', bytes: 0, sha256: '0'.repeat(64) },
    storage: { file: 'storage.tar.gz', bytes: 0, sha256: '0'.repeat(64) },
  };
  const write = value => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(value));
  try {
    write(good);
    assert.deepEqual(await readManifest(root), good);
    for (const invalid of [
      { ...good, counts: undefined },
      { ...good, counts: { events: 0 } },
      { ...good, counts: { ...good.counts, events: -1 } },
      { ...good, source: { database: 'synthetic' } },
      { ...good, database: { ...good.database, file: '../outside.dump' } },
      { ...good, storage: { ...good.storage, file: '/absolute/storage.tar.gz' } },
    ]) {
      write(invalid);
      await assert.rejects(readManifest(root));
    }
    write(good);
    const outside = path.join(root, 'synthetic-outside');
    fs.writeFileSync(outside, 'synthetic only');
    fs.symlinkSync(outside, path.join(root, 'database.dump'));
    await assert.rejects(verifyChecksums(root, good), /정규 파일/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
