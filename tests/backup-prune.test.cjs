'use strict';

// scripts/backup-prune.cjs: retention "최근 14일, 최소 7개". Uses real temp
// directories only; never touches a real backup folder.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup-prune.cjs');
const DAY = 86_400_000;

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 15000 });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function stamp(at) {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-prune-'));
  const root = path.join(base, 'var', 'backups');
  fs.mkdirSync(root, { recursive: true });
  return { base, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function makeBackup(root, daysAgo, { project = 'eventouch', manifest = { format: 1 } } = {}) {
  const name = `${project}-${stamp(Date.now() - daysAgo * DAY)}`;
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), ...manifest }));
  fs.writeFileSync(path.join(dir, 'database.dump'), 'x');
  return name;
}

const exists = (root, name) => fs.existsSync(path.join(root, name));

test('older than 14 days AND outside the newest 7 is removed; everything else stays', () => {
  const box = sandbox();
  try {
    const recent = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((days) => makeBackup(box.root, days));
    const old = [20, 30, 40].map((days) => makeBackup(box.root, days));
    const result = run(['--backup-root', box.root, '--apply', '--i-understand', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'apply');
    assert.deepEqual([...report.removed].sort(), [...old].sort());
    for (const name of recent) assert.ok(exists(box.root, name), `${name} stays`);
    for (const name of old) assert.ok(!exists(box.root, name), `${name} is gone`);
  } finally { box.cleanup(); }
});

test('at least 7 backups stay even when every one is older than 14 days', () => {
  const box = sandbox();
  try {
    const few = [30, 31, 32, 33, 34].map((days) => makeBackup(box.root, days));
    assert.equal(run(['--backup-root', box.root, '--apply', '--i-understand']).status, 0);
    for (const name of few) assert.ok(exists(box.root, name));

    const more = [35, 36, 37, 38].map((days) => makeBackup(box.root, days));
    const result = run(['--backup-root', box.root, '--apply', '--i-understand', '--json']);
    const report = JSON.parse(result.stdout);
    assert.equal(report.keep.length, 7);
    assert.deepEqual([...report.removed].sort(), [more[2], more[3]].sort());
    assert.ok(exists(box.root, few[0]) && exists(box.root, more[1]));
  } finally { box.cleanup(); }
});

test('the default run only prints what it would delete', () => {
  const box = sandbox();
  try {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) makeBackup(box.root, days);
    const old = makeBackup(box.root, 60);
    const result = run(['--backup-root', box.root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /미리보기/);
    assert.ok(result.stdout.includes(old));
    assert.ok(exists(box.root, old), 'dry run deletes nothing');
    // --i-understand alone is still a dry run.
    assert.equal(run(['--backup-root', box.root, '--i-understand']).status, 0);
    assert.ok(exists(box.root, old));
  } finally { box.cleanup(); }
});

test('--apply without --i-understand is refused and deletes nothing', () => {
  const box = sandbox();
  try {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) makeBackup(box.root, days);
    const old = makeBackup(box.root, 60);
    const result = run(['--backup-root', box.root, '--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--i-understand/);
    assert.ok(exists(box.root, old));
  } finally { box.cleanup(); }
});

test('anything that is not a backup is never touched', () => {
  const box = sandbox();
  try {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) makeBackup(box.root, days);
    const notes = path.join(box.root, 'eventouch-notes');
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, 'keep.txt'), 'hand-written');
    const halfWritten = makeBackup(box.root, 90, { manifest: null });
    const wrongFormat = makeBackup(box.root, 91, { manifest: { format: 2 } });
    const otherProject = makeBackup(box.root, 92, { project: 'staging' });
    const stray = path.join(box.root, `eventouch-${stamp(Date.now() - 95 * DAY)}.log`);
    fs.writeFileSync(stray, 'log');
    fs.writeFileSync(path.join(box.root, 'README'), 'x');
    const result = run(['--backup-root', box.root, '--apply', '--i-understand', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.removed, []);
    for (const name of [halfWritten, wrongFormat, otherProject]) assert.ok(exists(box.root, name), name);
    assert.ok(fs.existsSync(path.join(notes, 'keep.txt')) && fs.existsSync(stray));
    const skipped = report.skipped.map((entry) => entry.name);
    assert.ok(skipped.includes('eventouch-notes') && skipped.includes(halfWritten) && skipped.includes(wrongFormat));
    assert.ok(!skipped.includes(otherProject), 'other projects are not even considered');
  } finally { box.cleanup(); }
});

test('a symlink that looks like an old backup is skipped and its target survives', () => {
  const box = sandbox();
  try {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) makeBackup(box.root, days);
    const outside = path.join(box.base, 'precious');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify({ format: 1 }));
    fs.writeFileSync(path.join(outside, 'data.txt'), 'do not delete');
    const link = `eventouch-${stamp(Date.now() - 80 * DAY)}`;
    fs.symlinkSync(outside, path.join(box.root, link));
    const result = run(['--backup-root', box.root, '--apply', '--i-understand', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).removed, []);
    assert.ok(fs.existsSync(path.join(outside, 'data.txt')));
    assert.ok(fs.lstatSync(path.join(box.root, link)).isSymbolicLink());
  } finally { box.cleanup(); }
});

test('an entry swapped for a symlink after planning is refused at delete time', async () => {
  const box = sandbox();
  try {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) makeBackup(box.root, days);
    const old = makeBackup(box.root, 60);
    const { plan, apply } = require('../scripts/backup-prune.cjs');
    const result = await plan({ backupRoot: box.root });
    assert.deepEqual(result.remove.map((entry) => entry.name), [old]);
    const outside = path.join(box.base, 'precious');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'data.txt'), 'do not delete');
    fs.rmSync(path.join(box.root, old), { recursive: true });
    fs.symlinkSync(outside, path.join(box.root, old));
    const outcome = await apply(result);
    assert.deepEqual(outcome.removed, []);
    assert.equal(outcome.failed.length, 1);
    assert.ok(fs.existsSync(path.join(outside, 'data.txt')));
  } finally { box.cleanup(); }
});

test('only direct children of the backup root are ever candidates', () => {
  const box = sandbox();
  try {
    for (const days of [1, 2, 3, 4, 5, 6, 7]) makeBackup(box.root, days);
    const nestedParent = path.join(box.root, 'archive');
    fs.mkdirSync(nestedParent);
    const nested = makeBackup(nestedParent, 100);
    const sibling = makeBackup(box.base, 100);
    const result = run(['--backup-root', box.root, '--apply', '--i-understand']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(exists(nestedParent, nested));
    assert.ok(exists(box.base, sibling));
  } finally { box.cleanup(); }
});

test('roots that are too broad or missing are refused', () => {
  for (const root of ['/', '/var', os.homedir()]) {
    const result = run(['--backup-root', root, '--apply', '--i-understand']);
    assert.equal(result.status, 1, root);
    assert.match(result.stderr, /너무 넓어|홈 디렉터리/, root);
  }
  const missing = run(['--backup-root', path.join(os.tmpdir(), 'etko-prune-does-not-exist')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /백업 루트를 읽을 수 없습니다/);
  assert.equal(run([]).status, 1);
});

test('invalid numbers, project names and impossible dates are rejected', () => {
  const box = sandbox();
  try {
    assert.equal(run(['--backup-root', box.root, '--keep-days', '0']).status, 1);
    assert.equal(run(['--backup-root', box.root, '--min-keep', 'abc']).status, 1);
    assert.equal(run(['--backup-root', box.root, '--project', '../x']).status, 1);
    const { timestampOf } = require('../scripts/backup-prune.cjs');
    assert.equal(timestampOf('eventouch-2026-13-40T25-61-61-000Z', 'eventouch'), null);
    assert.ok(Number.isFinite(timestampOf('eventouch-2026-11-24T03-10-00-000Z', 'eventouch')));
  } finally { box.cleanup(); }
});

test('keep-days and min-keep can be tightened by the operator', () => {
  const box = sandbox();
  try {
    const names = [1, 2, 3, 4, 5].map((days) => makeBackup(box.root, days));
    const result = run(['--backup-root', box.root, '--keep-days', '2', '--min-keep', '2', '--apply', '--i-understand', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual([...JSON.parse(result.stdout).removed].sort(), [names[2], names[3], names[4]].sort());
  } finally { box.cleanup(); }
});
