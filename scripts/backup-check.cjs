'use strict';

// Latest-backup validity + freshness check. Read-only: never creates,
// deletes, uploads, or sends anything.
//
//   node scripts/backup-check.cjs --backup-root /var/backups/eventouch
//   node scripts/backup-check.cjs --backup-root /var/backups/eventouch \
//     --project eventouch --max-age-hours 26 --verify-checksums --json
//
// What it does: finds the newest <root>/<project>-* directory, parses its
// manifest.json, checks the listed database/storage files exist, and reports
// the backup age. With --verify-checksums it also recomputes the SHA-256 of
// the listed files (slow on large dumps, but the only proof the archive is
// still intact). With --max-age-hours a backup older than that fails.
//
// Honest unset: without --max-age-hours freshness is reported as
// "no-policy" — retention policy is undecided, so this tool enforces
// nothing and deletes nothing. Missing backup directory or unreadable
// manifest always fails: that is a fact about the filesystem, not policy.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const HELP = `
사용법:
  node scripts/backup-check.cjs --backup-root <경로> [옵션]

옵션:
  --backup-root <경로>        백업 루트 (필수)
  --project <이름>            백업 디렉터리 접두 (기본: eventouch)
  --max-age-hours <N>         이보다 오래되면 실패 (미지정=미판정·미삭제)
  --verify-checksums          매니페스트 SHA-256을 재계산해 대조
  --json                      JSON으로 출력
  --help
`.trimStart();

function parseArgs(argv) {
  const options = {
    backupRoot: '', project: 'eventouch', maxAgeHours: '',
    verifyChecksums: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--verify-checksums') { options.verifyChecksums = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`알 수 없는 인자: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!Object.hasOwn(options, key)) throw new Error(`알 수 없는 인자: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
    options[key] = value; i += 1;
  }
  return options;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return { ok: true };
  }
  if (!options.backupRoot) throw new Error('--backup-root가 필요합니다 (--help 참고)');
  let maxAgeHours = null;
  if (options.maxAgeHours !== '') {
    maxAgeHours = Number(options.maxAgeHours);
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) throw new Error('--max-age-hours는 0 이상의 숫자여야 합니다');
  }

  const report = { at: new Date().toISOString(), backupRoot: options.backupRoot, ok: false, checks: [] };
  const fail = (name, detail) => {
    report.checks.push({ name, state: 'fail', detail });
    report.ok = false;
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`[fail] ${name}: ${detail}\n`);
    process.exitCode = 1;
    return report;
  };

  let entries;
  try {
    entries = await fsp.readdir(options.backupRoot);
  } catch (error) {
    return fail('backup-root', `unreadable: ${options.backupRoot} (${error.message})`);
  }
  const candidates = [];
  for (const name of entries.sort()) {
    if (name !== options.project && !name.startsWith(`${options.project}-`)) continue;
    let info = null;
    try {
      info = await fsp.lstat(path.join(options.backupRoot, name));
    } catch {
      info = null;
    }
    // A regular file can never be a backup: skip it so stray outputs that
    // share the prefix (logs, reports) cannot shadow the real backup.
    // Unstatable entries and symlinks are kept so the strict validation
    // below still refuses them loudly instead of hiding them.
    if (info && !info.isDirectory() && !info.isSymbolicLink()) continue;
    candidates.push(name);
  }
  if (!candidates.length) {
    return fail('latest-backup', `no backup directory for project '${options.project}' under ${options.backupRoot}`);
  }
  const latest = candidates[candidates.length - 1];
  const directory = path.join(options.backupRoot, latest);
  report.latest = latest;

  let manifest;
  try {
    const directoryInfo = await fsp.lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return fail('latest-backup', 'backup directory must be a real directory, not a symlink');
    const manifestPath = path.join(directory, 'manifest.json');
    const manifestInfo = await fsp.lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) return fail('manifest', 'manifest must be a regular file, not a symlink');
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (error) {
    return fail('manifest', `${latest}/manifest.json unreadable (${error.message})`);
  }
  if (!manifest || manifest.format !== 1) return fail('manifest', 'unsupported backup format');
  report.checks.push({ name: 'manifest', state: 'pass', detail: `format ${manifest.format}, countsStable=${manifest.countsStable !== false}` });

  for (const key of ['database', 'storage']) {
    const entry = manifest[key];
    if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') {
      return fail('manifest-entries', `${latest}/manifest.json missing ${key} entry`);
    }
    if (!entry.file) {
      report.checks.push({ name: `file:${key}`, state: 'report', detail: 'no file recorded (skipped at backup time)' });
      continue;
    }
    // Manifest entries are data, not trust: an absolute path or a `..`
    // segment must never resolve outside the backup directory.
    if (path.isAbsolute(entry.file) || entry.file.split('/').includes('..')) {
      return fail(`file:${key}`, `${entry.file} escapes the backup directory (refused)`);
    }
    if (path.basename(entry.file) !== entry.file) return fail(`file:${key}`, 'backup entries must be files directly inside the backup directory');
    const file = path.join(directory, entry.file);
    // A symlink inside the backup directory can still point outside it
    // (e.g. at a credential file): lstat sees the link itself, stat would
    // follow it. Manifest-listed files are always regular files written by
    // scripts/backup.cjs, so any symlink here is refused outright.
    let link;
    try {
      link = await fsp.lstat(file);
    } catch {
      return fail(`file:${key}`, `${latest}/${entry.file} missing`);
    }
    if (link.isSymbolicLink()) {
      return fail(`file:${key}`, `${entry.file} is a symlink (refused: must be a regular file inside the backup directory)`);
    }
    if (!link.isFile()) return fail(`file:${key}`, `${entry.file} is not a regular file`);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return fail(`file:${key}`, `${latest}/${entry.file} missing`);
    }
    if (Number(stat.size) !== Number(entry.bytes)) {
      return fail(`file:${key}`, `${entry.file} size ${stat.size} != manifest ${entry.bytes}`);
    }
    if (options.verifyChecksums) {
      const digest = await sha256File(file);
      if (digest !== entry.sha256) {
        return fail(`file:${key}`, `${entry.file} checksum mismatch`);
      }
      report.checks.push({ name: `file:${key}`, state: 'pass', detail: `${entry.file} ${stat.size} bytes, sha256 match` });
    } else {
      report.checks.push({ name: `file:${key}`, state: 'pass', detail: `${entry.file} ${stat.size} bytes (checksum not recomputed; use --verify-checksums)` });
    }
  }

  const createdAt = Date.parse(manifest.createdAt || '');
  if (!Number.isFinite(createdAt)) return fail('age', `${latest}/manifest.json has no valid createdAt`);
  const ageHours = Math.round(((Date.now() - createdAt) / 3_600_000) * 10) / 10;
  report.ageHours = ageHours;
  if (maxAgeHours === null) {
    report.checks.push({ name: 'freshness', state: 'report', detail: `age ${ageHours}h, no-policy (retention undecided; nothing enforced, nothing deleted)` });
  } else if (ageHours > maxAgeHours) {
    return fail('freshness', `age ${ageHours}h exceeds max ${maxAgeHours}h`);
  } else {
    report.checks.push({ name: 'freshness', state: 'pass', detail: `age ${ageHours}h within max ${maxAgeHours}h` });
  }

  report.ok = true;
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const check of report.checks) process.stdout.write(`[${check.state}] ${check.name}: ${check.detail}\n`);
    process.stdout.write(`backup-check: OK (${latest}, age ${ageHours}h)\n`);
  }
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[backup-check] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
