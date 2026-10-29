'use strict';

// Ops tooling regression: the checks that were verified manually against
// synthetic fixtures in /tmp stay green without a database, a compose
// project, or the network. No shared state, no sends, no deletions.
//
// Covered: manifest absolute-path / path-escape refusal, corrupt JSON,
// unset-age honesty, tamper detection (size + checksum), HTTP stall
// handling, and every CLI's exit-code contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

test('backup count inventory covers additive tables without dropping the original minimum', () => {
  const lib = require('../scripts/backup-lib.cjs');
  const query = lib.countsQuery([...lib.COUNT_TABLES, 'signup_request_attempts', 'attendee_grants']);
  assert.match(query, /FROM "signup_request_attempts"/);
  assert.match(query, /FROM "attendee_grants"/);
  assert.throws(() => lib.countsQuery(['signup_request_attempts']), /필수 테이블/);
  assert.throws(() => lib.countsQuery([...lib.COUNT_TABLES, 'unsafe;DROP TABLE accounts']), /table/);
});

function run(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    input: options.input,
    timeout: 15000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

// Async variant: the parent event loop keeps running, so a child probing an
// in-process fake HTTP server gets its answers. (spawnSync would block the
// loop and deadlock exactly that case.)
function runAsync(script, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} timed out after 15000ms`));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Builds <root>/eventouch-<name>/ with the given files and manifest.
// Overrides replace the default manifest fields.
function makeBackup(root, files, overrides = {}) {
  const directory = path.join(root, 'eventouch-synth');
  fs.mkdirSync(directory, { recursive: true });
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content);
    entries[name] = { bytes: Buffer.byteLength(content), sha256: sha256(content) };
  }
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    source: { project: 'synth', database: 'synth', postgres: '16', migrations: ['001'] },
    counts: {},
    countsStable: true,
    database: { file: 'database.dump', ...(entries['database.dump'] || {}) },
    storage: { file: 'storage.tar.gz', ...(entries['storage.tar.gz'] || {}) },
    ...overrides,
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-ops-tooling-'));
}

test('ops tooling: backup-check accepts a fresh synthetic backup and reports unset age honestly', () => {
  const root = freshRoot();
  try {
    makeBackup(root, { 'database.dump': 'fake-db', 'storage.tar.gz': 'fake-storage' });
    const result = run('backup-check.cjs', ['--backup-root', root, '--project', 'eventouch', '--verify-checksums', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    const freshness = report.checks.find((check) => check.name === 'freshness');
    assert.equal(freshness.state, 'report');
    assert.match(String(freshness.detail), /no-policy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ops tooling: backup-check refuses linked backup directories and linked manifests before reading them', () => {
  const root = freshRoot();
  try {
    const outside = path.join(root, 'outside');
    const actual = makeBackup(outside, { 'database.dump': 'synthetic-db', 'storage.tar.gz': 'synthetic-storage' });
    const linkedRoot = path.join(root, 'linked-root');
    fs.mkdirSync(linkedRoot);
    fs.symlinkSync(actual, path.join(linkedRoot, 'eventouch-linked'));
    const directoryResult = run('backup-check.cjs', ['--backup-root', linkedRoot]);
    assert.equal(directoryResult.status, 1);
    assert.match(directoryResult.stdout, /not a symlink/);
    const manifestRoot = path.join(root, 'manifest-root');
    const directory = path.join(manifestRoot, 'eventouch-linked');
    fs.mkdirSync(directory, { recursive: true });
    fs.symlinkSync(path.join(actual, 'manifest.json'), path.join(directory, 'manifest.json'));
    const manifestResult = run('backup-check.cjs', ['--backup-root', manifestRoot]);
    assert.equal(manifestResult.status, 1);
    assert.match(manifestResult.stdout, /not a symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ops tooling: backup-check refuses absolute and escaping manifest paths', () => {
  const root = freshRoot();
  try {
    const absolute = run('backup-check.cjs', ['--backup-root', root, '--project', 'eventouch']);
    void absolute;
    // Absolute path entry.
    const dirA = path.join(root, 'a');
    makeBackup(dirA, { 'database.dump': 'x', 'storage.tar.gz': 'y' }, {
      storage: { file: '/etc/hostname', bytes: 1, sha256: '0'.repeat(64) },
    });
    const absResult = run('backup-check.cjs', ['--backup-root', dirA, '--project', 'eventouch']);
    assert.equal(absResult.status, 1);
    assert.match(absResult.stdout + absResult.stderr, /escapes the backup directory/);
    // Parent-directory escape entry.
    const dirB = path.join(root, 'b');
    makeBackup(dirB, { 'database.dump': 'x', 'storage.tar.gz': 'y' }, {
      database: { file: '../escape.dump', bytes: 1, sha256: '0'.repeat(64) },
    });
    const escResult = run('backup-check.cjs', ['--backup-root', dirB, '--project', 'eventouch']);
    assert.equal(escResult.status, 1);
    assert.match(escResult.stdout + escResult.stderr, /escapes the backup directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ops tooling: backup-check fails corrupt JSON, missing data, tamper, and stale age', () => {
  const root = freshRoot();
  try {
    // Corrupt manifest JSON.
    const dirBad = path.join(root, 'bad');
    const badDir = makeBackup(dirBad, { 'database.dump': 'x', 'storage.tar.gz': 'y' });
    fs.writeFileSync(path.join(badDir, 'manifest.json'), '{not json');
    assert.equal(run('backup-check.cjs', ['--backup-root', dirBad, '--project', 'eventouch']).status, 1);

    // Missing backup root.
    assert.equal(run('backup-check.cjs', ['--backup-root', path.join(root, 'no-such-dir'), '--project', 'eventouch']).status, 1);

    // Tampered content: appended byte changes the size.
    const dirTamper = path.join(root, 'tamper');
    const tamperDir = makeBackup(dirTamper, { 'database.dump': 'x', 'storage.tar.gz': 'y' });
    fs.appendFileSync(path.join(tamperDir, 'storage.tar.gz'), '!');
    const tamper = run('backup-check.cjs', ['--backup-root', dirTamper, '--project', 'eventouch', '--verify-checksums']);
    assert.equal(tamper.status, 1);
    assert.match(tamper.stdout + tamper.stderr, /size|checksum/);

    // Same-size tamper: only the checksum recomputation catches it.
    const dirSwap = path.join(root, 'swap');
    const swapDir = makeBackup(dirSwap, { 'database.dump': 'x', 'storage.tar.gz': 'y' });
    fs.writeFileSync(path.join(swapDir, 'storage.tar.gz'), 'z');
    const swap = run('backup-check.cjs', ['--backup-root', dirSwap, '--project', 'eventouch', '--verify-checksums']);
    assert.equal(swap.status, 1);
    assert.match(swap.stdout + swap.stderr, /checksum mismatch/);

    // Stale age is enforced only when a max is set.
    const dirOld = path.join(root, 'old');
    makeBackup(dirOld, { 'database.dump': 'x', 'storage.tar.gz': 'y' }, {
      createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    });
    const stale = run('backup-check.cjs', ['--backup-root', dirOld, '--project', 'eventouch', '--max-age-hours', '1']);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout + stale.stderr, /exceeds max/);
    const nopolicy = run('backup-check.cjs', ['--backup-root', dirOld, '--project', 'eventouch', '--json']);
    assert.equal(nopolicy.status, 0, nopolicy.stderr);
    assert.match(nopolicy.stdout, /no-policy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ops tooling: backup-check refuses symlinks that escape the backup directory', () => {
  const root = freshRoot();
  try {
    // Synthetic stand-in only: a plain text file OUTSIDE the backup dir.
    // Never a credential file, never read for its content — the check must
    // refuse the link before following it.
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'synthetic-secret-stand-in');
    const dir = path.join(root, 'link');
    const backupDir = makeBackup(dir, { 'database.dump': 'x' }, {
      storage: { file: 'linked-storage.tar.gz', bytes: 24, sha256: '8'.repeat(64) },
    });
    fs.symlinkSync(outside, path.join(backupDir, 'linked-storage.tar.gz'));
    const refused = run('backup-check.cjs', ['--backup-root', dir, '--project', 'eventouch', '--verify-checksums']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /is a symlink \(refused/);
    // The outside file is untouched and its content never printed.
    assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic-secret-stand-in');
    assert.doesNotMatch(refused.stdout + refused.stderr, /synthetic-secret-stand-in/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ops tooling: backup-check skips stray files sharing the prefix instead of shadowing', () => {
  const root = freshRoot();
  try {
    makeBackup(root, { 'database.dump': 'x', 'storage.tar.gz': 'y' });
    // Stray outputs that share the <project>- prefix must not shadow the
    // real backup directory: a plain file can never be a backup.
    fs.writeFileSync(path.join(root, 'eventouch-synth.log'), 'stray log');
    fs.writeFileSync(path.join(root, 'eventouch-synth-report.json'), '{}');
    const result = run('backup-check.cjs', ['--backup-root', root, '--project', 'eventouch', '--verify-checksums', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /"latest": "eventouch-synth"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('ops tooling: readiness fails unreachable APIs and survives an HTTP stall', async () => {
  const port = await closedPort();
  const unreachable = run('ops-readiness.cjs', ['--api-base', `http://127.0.0.1:${port}`, '--json', '--timeout-ms', '1000']);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stdout, /"ok": false/);

  // A server that accepts and never answers must hit the client timeout,
  // not hang the probe forever.
  const stall = http.createServer(() => {});
  await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve));
  try {
    const stallPort = stall.address().port;
    const stalled = run('ops-readiness.cjs', ['--api-base', `http://127.0.0.1:${stallPort}`, '--timeout-ms', '300']);
    assert.equal(stalled.status, 1);
    assert.match(stalled.stdout + stalled.stderr, /timeout|fail/i);
  } finally {
    stall.close();
  }
});

test('ops tooling: readiness passes a healthy fake API, rewrite path, and fresh backup', async () => {
  const root = freshRoot();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, outboxPending: 0 }));
    } else if (req.url === '/api/readyz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, db: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    makeBackup(root, { 'database.dump': 'x', 'storage.tar.gz': 'y' });
    const result = await runAsync('ops-readiness.cjs', [
      '--api-base', base, '--web-base', base,
      '--backup-root', root, '--project', 'eventouch', '--max-backup-age-hours', '24',
      '--max-outbox-pending', '5',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    for (const name of ['api-health', 'api-readyz', 'web-api-readyz', 'outbox', 'backup']) {
      const check = report.checks.find((entry) => entry.name === name);
      assert.ok(check, `missing check ${name}`);
      assert.equal(check.state, 'pass', `${name}: ${JSON.stringify(check.detail)}`);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ops tooling: an explicit queue limit cannot pass without a queue measurement', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, db: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const unspecified = await runAsync('ops-readiness.cjs', ['--api-base', base, '--json']);
    assert.equal(unspecified.status, 0);
    assert.equal(JSON.parse(unspecified.stdout).checks.find(item => item.name === 'outbox').state, 'report');
    const required = await runAsync('ops-readiness.cjs', ['--api-base', base, '--max-outbox-pending', '5', '--json']);
    assert.equal(required.status, 1);
    assert.equal(JSON.parse(required.stdout).checks.find(item => item.name === 'outbox').state, 'fail');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('ops tooling: notify stays log-only and honors exit codes', () => {
  const refused = run('ops-notify.cjs', ['--send']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /log-only|REFUSED/);

  const empty = run('ops-notify.cjs', [], { input: '' });
  assert.equal(empty.status, 1);

  const failing = run('ops-notify.cjs', ['--to', 'ops@example.com'], {
    input: JSON.stringify({ ok: false, checks: [{ name: 'api-health', state: 'fail', detail: 'down' }] }),
  });
  assert.equal(failing.status, 2);
  assert.match(failing.stdout, /log-only|외부 전송 없음/);
  assert.match(failing.stdout, /contacted never/);

  const passing = run('ops-notify.cjs', ['--json'], {
    input: JSON.stringify({ ok: true, checks: [{ name: 'api-health', state: 'pass', detail: {} }] }),
  });
  assert.equal(passing.status, 0, passing.stderr);
});

test('ops tooling: schedule wrapper and security gate honor their exit contracts', () => {
  const cron = run('backup-schedule.cjs', ['--print-cron', '--backup-root', '/var/backups/eventouch']);
  assert.equal(cron.status, 0);
  assert.match(cron.stdout, /backup-schedule\.cjs --backup-root/);

  const noRoot = run('backup-schedule.cjs', []);
  assert.equal(noRoot.status, 1);

  const help = run('security-audit.cjs', ['--help']);
  assert.equal(help.status, 0);

  const badLevel = run('security-audit.cjs', ['--level', 'none']);
  assert.equal(badLevel.status, 1);
});
