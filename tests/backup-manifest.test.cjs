'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameCounts, sameHashes, parseArgs } = require('../scripts/backup-lib.cjs');

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
