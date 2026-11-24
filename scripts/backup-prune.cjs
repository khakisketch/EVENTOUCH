'use strict';

// Backup retention: "최근 14일 + 최소 7개 유지" (2026-11-24 결정).
//
//   node scripts/backup-prune.cjs --backup-root /var/backups/eventouch
//       -> 무엇을 지울지 출력만 한다 (기본값, 아무것도 지우지 않음)
//   node scripts/backup-prune.cjs --backup-root /var/backups/eventouch --apply --i-understand
//       -> 보존 대상이 아닌 백업 폴더를 실제로 삭제한다
//
// Rules:
//   - Only directories DIRECTLY under --backup-root named
//     <project>-<UTC timestamp as backup-schedule.cjs writes it> that hold a
//     manifest.json (format 1, regular file) count as backups. Anything else
//     (other names, regular files, symlinks, half-written backups without a
//     manifest, other projects) is reported as skipped and never touched.
//   - Kept: the newest --min-keep backups (default 7) AND every backup that
//     is at most --keep-days old (default 14). Only a backup that is both
//     older than --keep-days and outside the newest --min-keep is removed.
//   - Nothing outside the backup root is ever removed: the root is resolved
//     (realpath), a root that is a filesystem top level or the home
//     directory is refused, and each deletion re-checks that the entry is a
//     real directory whose parent is exactly the resolved root.
//   - --apply without --i-understand is refused and deletes nothing.
//   - Offsite copies and encryption are NOT handled here (still undecided).

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_MIN_KEEP = 7;
const DAY_MS = 86_400_000;
// Resolved system locations that are never a backup root themselves (macOS
// resolves /var to /private/var, so the depth rule alone would not catch it).
const SYSTEM_DIRECTORIES = new Set(['/private/var', '/private/etc', '/private/tmp']);

const HELP = `
사용법:
  node scripts/backup-prune.cjs --backup-root <경로> [옵션]

기본은 지울 대상만 출력합니다(아무것도 삭제하지 않음).

옵션:
  --backup-root <경로>   백업 루트 (필수)
  --project <이름>        백업 폴더 접두 (기본: eventouch)
  --keep-days <N>         이 일수 이내 백업은 모두 보존 (기본: ${DEFAULT_KEEP_DAYS})
  --min-keep <N>          가장 최근 N개는 날짜와 상관없이 보존 (기본: ${DEFAULT_MIN_KEEP})
  --apply                 보존 대상이 아닌 백업을 실제로 삭제
  --i-understand          --apply와 함께 있어야 삭제됨(삭제는 되돌릴 수 없음)
  --json                  JSON으로 출력
  --help

백업 형식(<project>-<타임스탬프> 폴더 + manifest.json)이 아닌 항목과
백업 루트 밖의 경로는 절대 지우지 않습니다.
`.trimStart();

function parseArgs(argv) {
  const options = {
    backupRoot: '', project: 'eventouch', keepDays: String(DEFAULT_KEEP_DAYS), minKeep: String(DEFAULT_MIN_KEEP),
    apply: false, iUnderstand: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--i-understand') { options.iUnderstand = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`알 수 없는 인자: ${arg} (--help 참고)`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!['backupRoot', 'project', 'keepDays', 'minKeep'].includes(key)) throw new Error(`알 수 없는 인자: ${arg} (--help 참고)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
    options[key] = value; i += 1;
  }
  return options;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(number) || number < 1) throw new Error(`${label}는 1 이상의 정수여야 합니다`);
  return number;
}

function timestampOf(name, project) {
  const prefix = `${project}-`;
  if (!name.startsWith(prefix)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name.slice(prefix.length));
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  // Reject impossible dates (month 13, day 40) instead of letting Date roll over.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d ||
      at.getUTCHours() !== h || at.getUTCMinutes() !== mi || at.getUTCSeconds() !== s) return null;
  return at.getTime();
}

async function resolveRoot(backupRoot) {
  let real;
  try {
    real = await fsp.realpath(path.resolve(backupRoot));
    const info = await fsp.stat(real);
    if (!info.isDirectory()) throw new Error('디렉터리가 아닙니다');
  } catch (error) {
    throw new Error(`백업 루트를 읽을 수 없습니다: ${backupRoot} (${error.message})`);
  }
  const parsed = path.parse(real);
  // "/", "/var", "C:\" and friends: far too broad to ever be a backup root.
  if (real === parsed.root || path.dirname(real) === parsed.root || SYSTEM_DIRECTORIES.has(real)) {
    throw new Error(`백업 루트가 너무 넓어 거부합니다: ${real}`);
  }
  let home = '';
  try { home = await fsp.realpath(os.homedir()); } catch { home = ''; }
  if (home && real === home) throw new Error('홈 디렉터리는 백업 루트로 쓸 수 없습니다');
  return real;
}

async function classify(realRoot, name, project) {
  const at = timestampOf(name, project);
  if (at === null) return { name, skipped: '백업 폴더 이름 형식이 아님' };
  const directory = path.join(realRoot, name);
  let info;
  try { info = await fsp.lstat(directory); } catch (error) { return { name, skipped: `확인 불가 (${error.code || error.message})` }; }
  if (info.isSymbolicLink()) return { name, skipped: '심볼릭 링크는 건드리지 않음' };
  if (!info.isDirectory()) return { name, skipped: '폴더가 아님' };
  let manifest;
  try {
    const manifestPath = path.join(directory, 'manifest.json');
    const manifestInfo = await fsp.lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) return { name, skipped: 'manifest.json이 일반 파일이 아님' };
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return { name, skipped: 'manifest.json 없음 또는 읽을 수 없음 (진행 중이거나 백업이 아님)' };
  }
  if (!manifest || manifest.format !== 1) return { name, skipped: '지원하는 백업 형식(format 1)이 아님' };
  return { name, at };
}

// Pure retention decision over classified backups (newest first).
function decide(backups, { now, keepDays, minKeep }) {
  const sorted = [...backups].sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  return sorted.map((backup, index) => {
    const ageDays = (now - backup.at) / DAY_MS;
    const keep = index < minKeep ? 'newest' : ageDays <= keepDays ? 'recent' : null;
    return { name: backup.name, ageDays: Math.round(ageDays * 10) / 10, keep, remove: keep === null };
  });
}

async function plan({ backupRoot, project = 'eventouch', keepDays = DEFAULT_KEEP_DAYS, minKeep = DEFAULT_MIN_KEEP, now = Date.now() }) {
  if (!/^[A-Za-z0-9_-]+$/.test(project)) throw new Error('--project 값이 올바르지 않습니다');
  const realRoot = await resolveRoot(backupRoot);
  const names = (await fsp.readdir(realRoot)).sort();
  const classified = [];
  for (const name of names) {
    // Other projects' folders are not ours to judge; only report what shares
    // the prefix so the output stays about this project.
    if (name !== project && !name.startsWith(`${project}-`)) continue;
    classified.push(await classify(realRoot, name, project));
  }
  const backups = classified.filter((entry) => entry.at !== undefined);
  const skipped = classified.filter((entry) => entry.skipped).map(({ name, skipped }) => ({ name, reason: skipped }));
  const decisions = decide(backups, { now, keepDays, minKeep });
  return {
    root: realRoot, project, keepDays, minKeep,
    keep: decisions.filter((entry) => !entry.remove),
    remove: decisions.filter((entry) => entry.remove),
    skipped,
  };
}

async function removeBackup(realRoot, name) {
  const directory = path.join(realRoot, name);
  // Re-check right before deleting: still a real directory directly under the
  // resolved root, never a symlink swapped in since planning.
  const info = await fsp.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('더 이상 일반 폴더가 아니어서 건드리지 않았습니다');
  const real = await fsp.realpath(directory);
  if (path.dirname(real) !== realRoot || path.basename(real) !== name) throw new Error('백업 루트 밖을 가리켜 건드리지 않았습니다');
  await fsp.rm(real, { recursive: true, force: false });
}

async function apply(result) {
  const removed = [];
  const failed = [];
  for (const entry of result.remove) {
    try {
      await removeBackup(result.root, entry.name);
      removed.push(entry.name);
    } catch (error) {
      failed.push({ name: entry.name, reason: error.message });
    }
  }
  return { removed, failed };
}

async function main(argv = process.argv.slice(2), { now = Date.now() } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return { ok: true };
  }
  if (!options.backupRoot) throw new Error('--backup-root가 필요합니다 (--help 참고)');
  if (options.apply && !options.iUnderstand) {
    throw new Error('삭제하려면 --apply 와 --i-understand 를 함께 지정해야 합니다 (아무것도 삭제하지 않았습니다)');
  }
  const result = await plan({
    backupRoot: options.backupRoot,
    project: options.project,
    keepDays: positiveInteger(options.keepDays, '--keep-days'),
    minKeep: positiveInteger(options.minKeep, '--min-keep'),
    now,
  });
  const applying = options.apply && options.iUnderstand;
  const outcome = applying ? await apply(result) : null;
  const report = {
    mode: applying ? 'apply' : 'dry-run',
    root: result.root, project: result.project, keepDays: result.keepDays, minKeep: result.minKeep,
    keep: result.keep, remove: result.remove, skipped: result.skipped,
    ...(outcome ? { removed: outcome.removed, failed: outcome.failed } : {}),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const out = (line) => process.stdout.write(`${line}\n`);
    out(`[backup-prune] ${applying ? '삭제 실행' : '미리보기(삭제하지 않음)'} root=${result.root} project=${result.project} 보존=최근 ${result.keepDays}일·최소 ${result.minKeep}개`);
    out(`  보존 ${result.keep.length}개: ${result.keep.map((entry) => entry.name).join(', ') || '없음'}`);
    out(`  삭제 대상 ${result.remove.length}개: ${result.remove.map((entry) => `${entry.name} (${entry.ageDays}일 전)`).join(', ') || '없음'}`);
    for (const entry of result.skipped) out(`  건드리지 않음: ${entry.name} — ${entry.reason}`);
    if (outcome) {
      out(`  삭제됨 ${outcome.removed.length}개`);
      for (const entry of outcome.failed) out(`  삭제 실패: ${entry.name} — ${entry.reason}`);
    } else if (result.remove.length) {
      out('  실제로 지우려면 --apply --i-understand 를 붙여 다시 실행하세요.');
    }
  }
  if (outcome && outcome.failed.length) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[backup-prune] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, plan, apply, decide, timestampOf, DEFAULT_KEEP_DAYS, DEFAULT_MIN_KEEP };
