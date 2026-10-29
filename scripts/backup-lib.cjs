'use strict';

// Shared helpers for the backup / restore / rehearsal scripts.
//
// The canonical deployment is docker compose (db + API + web, see
// docs/DEPLOY.md). These helpers talk to the compose db service through
// `docker compose exec`, so they never need the database password on the
// host and never print it. A non-compose backup is supported only when the
// host has pg_dump/pg_restore on PATH.
//
// Scope: database (pg_dump custom format) + STORAGE_DIR (tar.gz) + a
// manifest with checksums, migration versions and row counts. Event files
// are stored with exclusive-create names and are never overwritten, so a
// database snapshot followed by a storage archive is a consistent restore
// point (the archive may contain files created after the snapshot; those are
// unreferenced extras and are harmless).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const FORMAT = 1;
const BACKUP_DB = 'database.dump';
const BACKUP_STORAGE = 'storage.tar.gz';
const MANIFEST = 'manifest.json';

// Key tables whose row counts must survive a restore rehearsal. Missing
// tables fail the backup instead of being silently skipped.
const COUNT_TABLES = [
  'accounts',
  'clients',
  'events',
  'event_workspaces',
  'memberships',
  'staff_assignments',
  'stored_files',
  'checkin_records',
  'tickets',
  'command_receipts',
  'message_outbox',
  'sessions',
  'invitations',
  'organizations',
  'organization_memberships',
  'schema_migrations',
];

function log(message) {
  process.stdout.write(`[backup] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function identifier(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(text)) fail(`${label} 값이 올바르지 않습니다`);
  return text;
}

function parseArgs(argv, defaults) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      if (!Array.isArray(options._)) options._ = [];
      options._.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (name === 'verify' || name === 'force' || name === 'skip-storage') {
      options[name === 'skip-storage' ? 'skipStorage' : name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${argument} 값이 필요합니다`);
    index += 1;
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  return options;
}

function docker(args, { input, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `docker exited with code ${code}`));
    });
  });
}

function compose(project, args, options = {}) {
  return docker(['compose', '-p', project, ...args], options);
}

async function composeDatabaseCredentials(project) {
  const output = await compose(project, [
    'exec', '-T', 'db', 'sh', '-c', 'printf "%s\\n%s\\n" "$POSTGRES_USER" "$POSTGRES_DB"',
  ]);
  const [user, database] = String(output).trim().split('\n');
  if (!user || !database) fail('compose db 서비스에서 POSTGRES_USER/POSTGRES_DB를 읽지 못했습니다');
  return { user: identifier(user, 'POSTGRES_USER'), database: identifier(database, 'POSTGRES_DB') };
}

async function assertComposeDb(project) {
  let services;
  try {
    services = await compose(project, ['ps', '--services', '--filter', 'status=running']);
  } catch (error) {
    fail(`docker compose 프로젝트 '${project}'를 확인하지 못했습니다: ${error.message}`);
  }
  if (!String(services).split(/\s+/).filter(Boolean).includes('db')) {
    fail(`docker compose 프로젝트 '${project}'의 db 서비스가 실행 중이 아닙니다`);
  }
}

async function assertVolume(volume) {
  try {
    await docker(['volume', 'inspect', volume]);
  } catch {
    fail(`볼륨 '${volume}'을 찾을 수 없습니다. --storage-volume 로 지정하세요`);
  }
}

async function readCounts(project, user, database, { tables } = {}) {
  const inventory = await compose(project, [
    'exec', '-T', 'db', 'psql', '-U', user, '-d', database, '-XAt', '-c',
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
  ]);
  const discovered = String(inventory).trim().split('\n').filter(Boolean);
  // Old format-1 backups recorded the original minimum only. Restore all
  // counts they actually recorded; new backups record the full inventory.
  const selected = tables === undefined ? discovered : tables;
  for (const table of selected) {
    if (!discovered.includes(table)) fail(`복원 대상 테이블이 없습니다: ${table}`);
  }
  const query = countsQuery(selected);
  const output = await compose(project, [
    'exec', '-T', 'db', 'psql', '-U', user, '-d', database, '-XAt', '-F', '|', '-c', query,
  ]);
  const counts = {};
  for (const line of String(output).trim().split('\n')) {
    if (!line) continue;
    const [name, value] = line.split('|');
    counts[name] = Number(value);
  }
  return counts;
}

// Discover additive tables too: a migration must not silently fall outside
// restore verification. Keep the original minimum-table requirement intact.
function countsQuery(tables) {
  const names = [...new Set(tables.map(table => identifier(table, 'table')))];
  for (const required of COUNT_TABLES) {
    if (!names.includes(required)) fail(`백업 대상 필수 테이블이 없습니다: ${required}`);
  }
  return names.sort().map(table => `SELECT '${table}' AS name, count(*)::text AS value FROM "${table}"`).join(' UNION ALL ');
}

async function readMigrations(project, user, database) {
  const output = await compose(project, [
    'exec', '-T', 'db', 'psql', '-U', user, '-d', database, '-XAt',
    '-c', 'SELECT version FROM schema_migrations ORDER BY version',
  ]);
  return String(output).trim().split('\n').filter(Boolean);
}

async function databaseVersion(project, user, database) {
  const output = await compose(project, [
    'exec', '-T', 'db', 'psql', '-U', user, '-d', database, '-XAt',
    '-c', 'SHOW server_version',
  ]);
  return String(output).trim();
}

async function dumpDatabase(project, user, database, file) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const child = spawn('docker', [
    'compose', '-p', project, 'exec', '-T', 'db',
    'pg_dump', '-U', user, '-d', database, '-Fc', '--no-owner', '--no-privileges',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 12000) stderr = stderr.slice(-12000); });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  try {
    await pipeline(child.stdout, fs.createWriteStream(file, { mode: 0o600 }));
    const code = await closed;
    if (code !== 0) fail(`pg_dump 실패 (code ${code}): ${stderr.trim()}`);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

async function restoreDatabase(project, user, database, file) {
  const child = spawn('docker', [
    'compose', '-p', project, 'exec', '-T', 'db',
    'pg_restore', '-U', user, '-d', database,
    '--no-owner', '--no-privileges', '--exit-on-error',
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 12000) stderr = stderr.slice(-12000); });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  try {
    await pipeline(fs.createReadStream(file), child.stdin);
    const code = await closed;
    if (code !== 0) fail(`pg_restore 실패 (code ${code}): ${stderr.trim()}`);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

async function storageHashes(volume) {
  const output = await docker([
    'run', '--rm', '-v', `${volume}:/data:ro`, 'postgres:16-alpine',
    'sh', '-c', 'cd /data && find . -type f -print0 | xargs -0 -r sha256sum',
  ]);
  return String(output).trim().split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+\.?\/(.+)$/);
    if (!match) fail(`sha256sum 출력을 해석하지 못했습니다: ${line}`);
    return { path: match[2], sha256: match[1] };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

async function archiveStorage(volume, outDirectory) {
  await docker([
    'run', '--rm',
    '-v', `${volume}:/data:ro`,
    '-v', `${path.resolve(outDirectory)}:/backup`,
    'postgres:16-alpine',
    'tar', '-C', '/data', '-czf', `/backup/${BACKUP_STORAGE}`, '.',
  ]);
  return path.join(outDirectory, BACKUP_STORAGE);
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function statSize(file) {
  const stat = await fsp.stat(file);
  return Number(stat.size);
}

async function readManifest(directory) {
  const file = path.join(directory, MANIFEST);
  let manifest;
  try {
    const directoryInfo = await fsp.lstat(directory);
    const manifestInfo = await fsp.lstat(file);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
      fail('백업 디렉터리와 매니페스트는 심볼릭 링크가 아닌 실제 디렉터리·파일이어야 합니다');
    }
    manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    fail(`매니페스트를 읽지 못했습니다 (${file}): ${error.message}`);
  }
  if (!manifest || manifest.format !== FORMAT) fail(`지원하지 않는 백업 형식입니다: ${manifest && manifest.format}`);
  if (!manifest.source || !Array.isArray(manifest.source.migrations) ||
      !manifest.source.migrations.every(version => typeof version === 'string' && version.length > 0)) {
    fail('매니페스트에 마이그레이션 목록이 없습니다');
  }
  identifier(manifest.source.database, '원본 DB');
  if (!manifest.counts || typeof manifest.counts !== 'object' || Array.isArray(manifest.counts)) fail('매니페스트에 테이블 행 수가 없습니다');
  countsQuery(Object.keys(manifest.counts));
  if (!Object.values(manifest.counts).every(value => Number.isSafeInteger(value) && value >= 0)) fail('매니페스트 행 수가 올바르지 않습니다');
  for (const key of ['database', 'storage']) {
    const entry = manifest[key];
    if (!entry || !entry.file || !entry.sha256) fail(`매니페스트에 ${key} 항목이 없습니다`);
    if (typeof entry.file !== 'string' || path.isAbsolute(entry.file) || path.basename(entry.file) !== entry.file ||
        entry.file === '..' || entry.file === '.' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`매니페스트 ${key} 파일 정보가 올바르지 않습니다`);
  }
  return manifest;
}

async function verifyChecksums(directory, manifest) {
  for (const [label, entry] of [['database', manifest.database], ['storage', manifest.storage]]) {
    const file = path.join(directory, entry.file);
    let stat;
    try {
      stat = await fsp.lstat(file);
    } catch {
      fail(`${label} 파일이 없습니다: ${file}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} 파일은 심볼릭 링크가 아닌 정규 파일이어야 합니다`);
    if (Number(stat.size) !== Number(entry.bytes)) fail(`${label} 파일 크기가 매니페스트와 다릅니다`);
    const digest = await sha256File(file);
    if (digest !== entry.sha256) fail(`${label} 파일 체크섬이 매니페스트와 다릅니다`);
  }
}

async function hashTree(root) {
  const files = [];
  async function walk(current, relative) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, key);
      else if (entry.isFile()) files.push({ path: key, sha256: await sha256File(absolute) });
    }
  }
  await walk(root, '');
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function extractStorage(file, destination) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', file, '-C', destination], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited ${code}`))));
  });
}

async function tempDirectory(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function sameCounts(expected, actual) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences = [];
  for (const key of keys) {
    if (Number(expected[key]) !== Number(actual[key])) {
      differences.push(`${key}: ${expected[key] ?? '(missing)'} -> ${actual[key] ?? '(missing)'}`);
    }
  }
  return differences;
}

function sameHashes(expected, actual) {
  const differences = [];
  const expectedMap = new Map(expected.map((file) => [file.path, file.sha256]));
  const actualMap = new Map(actual.map((file) => [file.path, file.sha256]));
  for (const [file, digest] of expectedMap) {
    if (!actualMap.has(file)) differences.push(`missing: ${file}`);
    else if (actualMap.get(file) !== digest) differences.push(`changed: ${file}`);
  }
  for (const file of actualMap.keys()) {
    if (!expectedMap.has(file)) differences.push(`extra: ${file}`);
  }
  return differences.sort();
}

module.exports = {
  FORMAT,
  BACKUP_DB,
  BACKUP_STORAGE,
  MANIFEST,
  COUNT_TABLES,
  countsQuery,
  log,
  fail,
  identifier,
  parseArgs,
  compose,
  composeDatabaseCredentials,
  assertComposeDb,
  assertVolume,
  readCounts,
  readMigrations,
  databaseVersion,
  dumpDatabase,
  restoreDatabase,
  storageHashes,
  archiveStorage,
  sha256File,
  statSize,
  readManifest,
  verifyChecksums,
  hashTree,
  extractStorage,
  tempDirectory,
  sameCounts,
  sameHashes,
};
