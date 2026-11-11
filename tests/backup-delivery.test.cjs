'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const lib = require('../scripts/backup-lib.cjs');

const counts = Object.fromEntries(lib.COUNT_TABLES.map(name => [name, 0]));
const skippedStorage = { file: null, bytes: 0, sha256: null, files: [] };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-backup-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Run the actual CLI entry points, replacing only external IO boundaries.
// No Docker command, provider, or PostgreSQL connection can run in these tests.
function cli(name, args, mocks = {}) {
  const filename = path.join(__dirname, '..', 'scripts', name);
  const realRequire = createRequire(filename);
  let output = '';
  const processStub = {
    argv: [process.execPath, filename, ...args], env: {}, exitCode: 0,
    stdout: { write: text => { output += text; } },
    stderr: { write: text => { output += text; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    module, exports: module.exports, __dirname: path.dirname(filename),
    process: processStub, URL, AbortController, setTimeout, clearTimeout,
    fetch: async () => Response.json({ ok: true, db: true }),
    ...mocks.globals,
  }, { filename });
  return { run: module.exports.main, output: () => output, process: processStub };
}

function fixture(root, overrides = {}) {
  const directory = path.join(root, 'eventouch-synthetic');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'database.dump'), 'synthetic dump');
  const source = path.join(root, 'storage-source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'synthetic.txt'), 'synthetic storage');
  execFileSync('tar', ['-czf', path.join(directory, 'storage.tar.gz'), '-C', source, '.']);
  const entry = file => {
    const data = fs.readFileSync(path.join(directory, file));
    return { file, bytes: data.length, sha256: digest(data) };
  };
  const manifest = {
    format: 1, createdAt: new Date().toISOString(),
    source: { project: 'source', database: 'source_db', migrations: ['001'] },
    counts: { ...counts, events: 2 }, countsStable: true,
    database: entry('database.dump'),
    storage: { ...entry('storage.tar.gz'), files: [{ path: 'synthetic.txt', sha256: digest('synthetic storage') }] },
    ...overrides,
  };
  const write = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  write();
  return { directory, manifest, write };
}

function restoreHarness(directory, target, { actualCounts, migrations = ['001'], extraArgs = [] } = {}) {
  const state = { replacements: 0, restored: false };
  const database = {
    ...lib,
    assertComposeDb: async () => {},
    composeDatabaseCredentials: async () => ({ user: 'synthetic', database: 'target_db' }),
    compose: async (_project, args) => {
      const sql = args.at(-1);
      if (sql.startsWith('SELECT 1 FROM pg_database')) return '1';
      if (sql.startsWith('SELECT count(*) FROM information_schema.tables')) return '16';
      if (sql.startsWith('DROP DATABASE ')) { state.replacements += 1; return ''; }
      if (args.includes('createdb')) return '';
      throw new Error(`Unexpected synthetic DB command: ${args.join(' ')}`);
    },
    restoreDatabase: async () => { state.restored = true; },
    readCounts: async () => actualCounts || { ...counts, events: 1 },
    readMigrations: async () => migrations,
  };
  const command = cli('restore.cjs', [directory, '--project', 'target', '--storage-dir', target, '--force', ...extraArgs], {
    './backup-lib.cjs': database,
  });
  return { ...command, state };
}

test('restore completes storage after replacing a target when online counts were unstable', async t => {
  const root = temporary(t);
  const { directory } = fixture(root, { countsStable: false });
  const target = path.join(root, 'restored-storage');
  const command = restoreHarness(directory, target);
  await command.run();
  assert.equal(command.state.replacements, 1);
  assert.equal(command.state.restored, true);
  assert.equal(fs.readFileSync(path.join(target, 'synthetic.txt'), 'utf8'), 'synthetic storage');
  assert.match(command.output(), /행 수.*건너|count.*skip/i);
});

test('restore still rejects stable count mismatches and unstable migration mismatches', async t => {
  const root = temporary(t);
  const { directory, manifest, write } = fixture(root);
  await assert.rejects(restoreHarness(directory, path.join(root, 'target-a')).run(), /행 수/);
  manifest.countsStable = false;
  write();
  await assert.rejects(restoreHarness(directory, path.join(root, 'target-b'), { migrations: ['002'] }).run(), /마이그레이션/);
});

test('readiness refuses unsupported corrupt linked and escaping backup artifacts', async t => {
  const cases = {
    unsupported: ({ manifest }) => { manifest.format = 999; },
    checksum: ({ manifest }) => { manifest.database.sha256 = 'wrong'; },
    'same-size-tamper': ({ directory }) => fs.writeFileSync(path.join(directory, 'database.dump'), 'synthetic Dump'),
    truncated: ({ directory }) => fs.writeFileSync(path.join(directory, 'storage.tar.gz'), ''),
    symlink: ({ directory }) => {
      fs.renameSync(path.join(directory, 'database.dump'), path.join(directory, 'outside.dump'));
      fs.symlinkSync('outside.dump', path.join(directory, 'database.dump'));
    },
    'non-regular': ({ directory }) => {
      fs.rmSync(path.join(directory, 'database.dump'));
      fs.mkdirSync(path.join(directory, 'database.dump'));
    },
    escaping: ({ directory, manifest }) => {
      fs.copyFileSync(path.join(directory, 'database.dump'), path.join(directory, '..', 'outside.dump'));
      manifest.database.file = '../outside.dump';
    },
    absolute: ({ directory, manifest }) => { manifest.database.file = path.join(directory, 'database.dump'); },
    'linked-directory': ({ directory }) => {
      const outside = path.join(path.dirname(directory), 'outside-backup');
      fs.renameSync(directory, outside);
      fs.symlinkSync(outside, directory);
    },
    'linked-manifest': ({ directory }) => {
      fs.renameSync(path.join(directory, 'manifest.json'), path.join(directory, 'outside.json'));
      fs.symlinkSync('outside.json', path.join(directory, 'manifest.json'));
    },
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    await t.test(name, async st => {
      const root = temporary(st);
      const backup = fixture(root);
      corrupt(backup);
      // Do not follow a deliberately linked manifest when writing fixtures.
      if (!name.startsWith('linked-')) backup.write();
      const command = cli('ops-readiness.cjs', ['--api-base', 'http://synthetic.test', '--backup-root', root, '--max-backup-age-hours', '24', '--json']);
      const report = await command.run();
      assert.equal(report.checks.find(check => check.name === 'backup').state, 'fail', name);
      assert.equal(report.ok, false);
      assert.equal(command.process.exitCode, 1);
    });
  }
});

test('readiness bounds a headers-first stalled body and reports timeout rather than HTTP success', async () => {
  let aborted = 0;
  const command = cli('ops-readiness.cjs', ['--api-base', 'http://synthetic.test', '--timeout-ms', '15', '--json'], {
    globals: {
      fetch: async (_url, { signal }) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          signal.addEventListener('abort', () => {
            aborted += 1;
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      }), { headers: { 'content-type': 'application/json' } }),
    },
  });
  let timer;
  try {
    const report = await Promise.race([
      command.run(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('body consumption exceeded the configured timeout')), 250); }),
    ]);
    assert.equal(report.ok, false);
    for (const name of ['api-health', 'api-readyz']) {
      const check = report.checks.find(check => check.name === name);
      assert.equal(check.state, 'fail');
      assert.match(check.detail, /timeout after 15ms/);
    }
    assert.equal(aborted, 2);
  } finally {
    clearTimeout(timer);
  }
});

function hostWriter(out, { skipStorage = false, storageDir = '' } = {}) {
  const queries = [];
  const command = cli('backup.cjs', ['--database-url', 'postgres://synthetic:secret@synthetic.test/url_hint', '--out', out,
    ...(skipStorage ? ['--skip-storage'] : ['--storage-dir', storageDir])], {
    pg: { Pool: class {
      async query(sql) {
        queries.push(sql);
        if (sql.includes('FROM pg_tables')) return { rows: lib.COUNT_TABLES.map(tablename => ({ tablename })) };
        if (sql.includes('count(*)')) return { rows: lib.COUNT_TABLES.map(name => ({ name, value: '0' })) };
        if (sql.includes('FROM schema_migrations')) return { rows: [{ version: '001' }] };
        if (sql === 'SHOW server_version') return { rows: [{ server_version: '16' }] };
        if (/current_database\(\)/i.test(sql)) return { rows: [{ database: 'actual-host-db', current_database: 'actual-host-db' }] };
        throw new Error(`Unexpected synthetic query: ${sql}`);
      }
      async end() {}
    } },
    'node:child_process': {
      execFile(name, args, options, callback) {
        if (typeof options === 'function') callback = options;
        try {
          if (name === 'pg_dump' && args.includes('--version')) callback(null, 'pg_dump 16', '');
          else if (name === 'pg_dump' && args.includes('--file')) {
            fs.writeFileSync(args[args.indexOf('--file') + 1], 'synthetic host dump');
            callback(null, '', '');
          } else if (name === 'tar') {
            execFileSync(name, args);
            callback(null, '', '');
          } else throw new Error(`Unexpected host command: ${name}`);
        } catch (error) { callback(error); }
      },
    },
  });
  return { ...command, queries };
}

test('host backup records the connected database and roundtrips into strict readers and explicit target restore', async t => {
  const root = temporary(t);
  const source = path.join(root, 'host-storage');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'host.txt'), 'synthetic host file');
  const directory = path.join(root, 'eventouch-host');
  await hostWriter(directory, { storageDir: source }).run();
  const written = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(written.source.database, 'actual-host-db');
  assert.doesNotMatch(JSON.stringify(written), /secret|postgres:\/\//);
  const manifest = await lib.readManifest(directory);
  await lib.verifyChecksums(directory, manifest);
  const restore = restoreHarness(directory, path.join(root, 'host-restored'), { actualCounts: counts, extraArgs: ['--database', 'target_db'] });
  await restore.run();
  assert.equal(fs.readFileSync(path.join(root, 'host-restored', 'host.txt'), 'utf8'), 'synthetic host file');
});

test('legacy host manifests remain readable with an explicit safe restore database', async t => {
  const root = temporary(t);
  const { directory } = fixture(root, { source: { project: null, database: '(database-url)', migrations: ['001'] } });
  await lib.readManifest(directory);
  const command = restoreHarness(directory, path.join(root, 'legacy-restored'), { actualCounts: { ...counts, events: 2 }, extraArgs: ['--database', 'target_db'] });
  await command.run();
  assert.equal(command.state.restored, true);
  const noOverride = restoreHarness(directory, path.join(root, 'no-override'));
  await assert.rejects(noOverride.run(), /대상 DB/);
  assert.equal(noOverride.state.replacements, 0);
});

test('DB-only backups roundtrip through both writers checksum checking readiness and restore', async t => {
  for (const mode of ['host', 'compose']) {
    await t.test(mode, async st => {
      const root = temporary(st);
      const directory = path.join(root, 'eventouch-db-only');
      if (mode === 'host') await hostWriter(directory, { skipStorage: true }).run();
      else {
        const command = cli('backup.cjs', ['--out', directory, '--skip-storage'], {
          './backup-lib.cjs': {
            ...lib, assertComposeDb: async () => {},
            composeDatabaseCredentials: async () => ({ user: 'synthetic', database: 'synthetic' }),
            readCounts: async () => counts, readMigrations: async () => ['001'], databaseVersion: async () => '16',
            dumpDatabase: async (_project, _user, _database, file) => fs.writeFileSync(file, 'synthetic compose dump'),
          },
        });
        await command.run();
      }
      const manifest = await lib.readManifest(directory);
      assert.deepEqual(manifest.storage, skippedStorage);
      await lib.verifyChecksums(directory, manifest);
      const check = cli('backup-check.cjs', ['--backup-root', root, '--verify-checksums', '--json']);
      assert.equal((await check.run()).ok, true, check.output());
      const readiness = cli('ops-readiness.cjs', ['--api-base', 'http://synthetic.test', '--backup-root', root, '--max-backup-age-hours', '24', '--json']);
      assert.equal((await readiness.run()).checks.find(check => check.name === 'backup').state, 'pass');
      const storage = path.join(root, 'untouched-storage');
      fs.mkdirSync(storage);
      fs.writeFileSync(path.join(storage, 'keep.txt'), 'keep synthetic content');
      await restoreHarness(directory, storage, { actualCounts: counts, extraArgs: ['--database', 'target_db'] }).run();
      assert.deepEqual(fs.readdirSync(storage), ['keep.txt']);
      assert.equal(fs.readFileSync(path.join(storage, 'keep.txt'), 'utf8'), 'keep synthetic content');
      fs.appendFileSync(path.join(directory, 'database.dump'), '!');
      await assert.rejects(lib.verifyChecksums(directory, manifest), /크기|체크섬/);
      const corrupt = restoreHarness(directory, storage, { actualCounts: counts });
      await assert.rejects(corrupt.run(), /크기|체크섬/);
      assert.equal(corrupt.state.replacements, 0);
    });
  }
});

test('only the explicit skipped-storage representation can omit an archive and the database is never optional', async t => {
  const root = temporary(t);
  const backup = fixture(root);
  for (const storage of [undefined, {}, { ...skippedStorage, bytes: 1 }, { ...skippedStorage, files: [{ path: 'lost.txt' }] },
    { ...skippedStorage, sha256: '0'.repeat(64) }, { ...skippedStorage, file: '' }, { file: '', bytes: 0, sha256: '', files: [] }, { file: 'storage.tar.gz', bytes: 0, sha256: null }]) {
    backup.manifest.storage = storage;
    backup.write();
    await assert.rejects(lib.readManifest(backup.directory));
    const check = cli('backup-check.cjs', ['--backup-root', root, '--json']);
    assert.equal((await check.run()).ok, false, JSON.stringify(storage));
  }
  backup.manifest.storage = skippedStorage;
  backup.manifest.database = skippedStorage;
  backup.write();
  await assert.rejects(lib.readManifest(backup.directory));
  assert.equal((await cli('backup-check.cjs', ['--backup-root', root, '--json']).run()).ok, false);
});
