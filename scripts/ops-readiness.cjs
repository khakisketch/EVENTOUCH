'use strict';

// Operations readiness probe: liveness, readiness (direct + via the web
// rewrite), backup freshness/validity, outbox depth, disk space.
//
//   node scripts/ops-readiness.cjs --api-base http://127.0.0.1:8776
//   node scripts/ops-readiness.cjs --api-base http://127.0.0.1:8776 \
//     --web-base http://127.0.0.1:8777 --backup-root /var/backups/eventouch \
//     --max-backup-age-hours 26 --json
//
// What each check means:
//   - api-health: GET <api-base>/api/health returns ok:true (liveness).
//   - api-readyz: GET <api-base>/api/readyz returns ok:true + db:true.
//   - web-api-readyz (only with --web-base): GET <web-base>/api/readyz. The
//     Next /api/* rewrite is BAKED at build time, so this is the check that
//     proves the running web build actually reaches the running API through
//     its rewrite — the existing baked-rewrite mismatch guard
//     (assertBuiltApiTarget) runs at start time; this one runs any time.
//   - backup (only with --backup-root): the newest <root>/<project>-* dir
//     must contain a readable manifest.json with valid checksums; with
//     --max-backup-age-hours the newest backup must also be fresher than
//     that. Without --max-backup-age-hours freshness is reported as
//     "no-policy" (honest unset: retention is undecided, so nothing is
//     enforced and nothing is deleted here either).
  //   - Public health intentionally omits tenant work counts. A missing count
  //     is unverified, never a successful check of an explicitly set limit.
//     Reported always; fails only past --max-outbox-pending (unset = report).
//   - disk (only with --disk-path, repeatable): free bytes via df; fails
//     only below --min-disk-free-bytes (unset = report).
//
// Output: human lines by default, machine JSON with --json (same object).
// Exit: 0 when every ENFORCED check passes, 1 otherwise. Report-only checks
// never fail the run. This tool never deletes, uploads, restarts, or sends
// anything; alerting belongs to scripts/ops-notify.cjs (log-only runner).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const HELP = `
사용법:
  node scripts/ops-readiness.cjs --api-base <URL> [옵션]

필수:
  --api-base <URL>            API 오리진 (예: http://127.0.0.1:8776)

선택:
  --web-base <URL>            웹 오리진; /api/readyz를 rewrite 경유로 확인
  --backup-root <경로>        백업 루트; 최신 <project>-* 매니페스트 검사
  --project <이름>            백업 디렉터리 접두 (기본: eventouch)
  --max-backup-age-hours <N>  이보다 오래된 최신 백업은 실패 (미지정=미판정)
  --max-outbox-pending <N>    대기 outbox가 이 초과면 실패 (미지정=보고만)
  --disk-path <경로>          (반복 가능) 여유 공간 보고 대상
  --min-disk-free-bytes <N>   이 미만이면 실패 (미지정=보고만)
  --timeout-ms <N>            HTTP 타임아웃 (기본: 8000)
  --json                      JSON으로 출력
  --help
`.trimStart();

function parseArgs(argv) {
  const options = {
    apiBase: '', webBase: '', backupRoot: '', project: 'eventouch',
    maxBackupAgeHours: '', maxOutboxPending: '', diskPaths: [],
    minDiskFreeBytes: '', timeoutMs: '8000', json: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--disk-path') {
      const value = argv[i + 1];
      if (!value) throw new Error('--disk-path 값이 필요합니다');
      options.diskPaths.push(value); i += 1; continue;
    }
    if (!arg.startsWith('--')) throw new Error(`알 수 없는 인자: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!Object.hasOwn(options, key)) throw new Error(`알 수 없는 인자: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
    options[key] = value; i += 1;
  }
  return options;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    // AbortController (not just a resolve race): a stalled server that
    // accepts and never answers must not hold the probe process open on a
    // half-open socket. `Connection: close` likewise releases keep-alive
    // sockets after each answer so the CLI always exits on its exit code.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { redirect: 'manual', signal: controller.signal, headers: { connection: 'close' } }).then(async (response) => {
      clearTimeout(timer);
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      resolve({ ok: true, status: response.status, body });
    }).catch((error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error && error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : error.message });
    });
  });
}

function numberOrNull(value) {
  if (value === '' || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`숫자가 필요합니다: ${value}`);
  return parsed;
}

async function checkBackup(root, project, maxAgeHours) {
  let entries;
  try {
    entries = await fsp.readdir(root);
  } catch (error) {
    return { name: 'backup', state: 'fail', detail: `backup root unreadable: ${root} (${error.message})` };
  }
  const candidates = entries.filter((name) => name === project || name.startsWith(`${project}-`)).sort();
  if (!candidates.length) {
    return { name: 'backup', state: 'fail', detail: `no backup directory for project '${project}' under ${root}` };
  }
  const latest = candidates[candidates.length - 1];
  const directory = path.join(root, latest);
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  } catch (error) {
    return { name: 'backup', state: 'fail', detail: `${latest}/manifest.json unreadable (${error.message})` };
  }
  const createdAt = Date.parse(manifest.createdAt || '');
  if (!Number.isFinite(createdAt)) {
    return { name: 'backup', state: 'fail', detail: `${latest}/manifest.json has no valid createdAt` };
  }
  for (const key of ['database', 'storage']) {
    const entry = manifest[key];
    if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') {
      return { name: 'backup', state: 'fail', detail: `${latest}/manifest.json missing ${key} entry` };
    }
    if (entry.file) {
      const file = path.join(directory, entry.file);
      try {
        await fsp.access(file);
      } catch {
        return { name: 'backup', state: 'fail', detail: `${latest}/${entry.file} missing` };
      }
    }
  }
  const ageHours = (Date.now() - createdAt) / 3_600_000;
  const detail = {
    latest, ageHours: Math.round(ageHours * 10) / 10,
    countsStable: manifest.countsStable !== false,
    format: manifest.format,
  };
  if (maxAgeHours === null) {
    return { name: 'backup', state: 'report', detail: { ...detail, freshness: 'no-policy (retention undecided; nothing enforced, nothing deleted)' } };
  }
  if (ageHours > maxAgeHours) {
    return { name: 'backup', state: 'fail', detail: { ...detail, maxAgeHours, freshness: 'stale' } };
  }
  return { name: 'backup', state: 'pass', detail: { ...detail, maxAgeHours, freshness: 'fresh' } };
}

async function checkDisk(target) {
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '--output=avail,target', target]);
    const line = String(stdout).trim().split('\n').slice(1).find((row) => row.trim());
    if (!line) return { name: `disk:${target}`, state: 'fail', detail: 'df returned no rows' };
    const free = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isFinite(free)) return { name: `disk:${target}`, state: 'fail', detail: 'df output unparseable' };
    return { name: `disk:${target}`, state: 'report', detail: { freeBytes: free } };
  } catch (error) {
    return { name: `disk:${target}`, state: 'fail', detail: `df failed: ${error.message}` };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return { checks: [], ok: true };
  }
  if (!options.apiBase) throw new Error('--api-base가 필요합니다 (--help 참고)');
  const timeoutMs = numberOrNull(options.timeoutMs) ?? 8000;
  const maxAgeHours = numberOrNull(options.maxBackupAgeHours);
  const maxOutbox = numberOrNull(options.maxOutboxPending);
  const minDiskFree = numberOrNull(options.minDiskFreeBytes);
  const apiBase = options.apiBase.replace(/\/+$/, '');

  const checks = [];

  const health = await fetchJson(`${apiBase}/api/health`, timeoutMs);
  if (!health.ok) checks.push({ name: 'api-health', state: 'fail', detail: health.error });
  else if (health.status !== 200 || health.body?.ok !== true) {
    checks.push({ name: 'api-health', state: 'fail', detail: `HTTP ${health.status} ok=${health.body?.ok}` });
  } else {
    checks.push({ name: 'api-health', state: 'pass', detail: { status: health.status } });
  }

  const readyz = await fetchJson(`${apiBase}/api/readyz`, timeoutMs);
  if (!readyz.ok) checks.push({ name: 'api-readyz', state: 'fail', detail: readyz.error });
  else if (readyz.status !== 200 || readyz.body?.ok !== true || readyz.body?.db !== true) {
    checks.push({ name: 'api-readyz', state: 'fail', detail: `HTTP ${readyz.status} body=${JSON.stringify(readyz.body)}` });
  } else {
    checks.push({ name: 'api-readyz', state: 'pass', detail: { db: true } });
  }

  if (options.webBase) {
    const webBase = options.webBase.replace(/\/+$/, '');
    const via = await fetchJson(`${webBase}/api/readyz`, timeoutMs);
    if (!via.ok) checks.push({ name: 'web-api-readyz', state: 'fail', detail: `rewrite path unreachable: ${via.error}` });
    else if (via.status !== 200 || via.body?.ok !== true) {
      checks.push({ name: 'web-api-readyz', state: 'fail', detail: `rewrite path HTTP ${via.status} body=${JSON.stringify(via.body)} (baked rewrite target mismatch?)` });
    } else {
      checks.push({ name: 'web-api-readyz', state: 'pass', detail: { viaRewrite: true } });
    }
  }

  const pending = health.ok && health.body && typeof health.body.outboxPending === 'number'
    ? health.body.outboxPending
    : null;
  if (pending === null) {
    checks.push({ name: 'outbox', state: maxOutbox === null ? 'report' : 'fail', detail: 'queue depth unverified: public health omits tenant activity; use authenticated organization diagnostics' });
  } else if (maxOutbox === null) {
    checks.push({ name: 'outbox', state: 'report', detail: { pending, threshold: 'no-policy (reported only)' } });
  } else if (pending > maxOutbox) {
    checks.push({ name: 'outbox', state: 'fail', detail: { pending, maxOutbox } });
  } else {
    checks.push({ name: 'outbox', state: 'pass', detail: { pending, maxOutbox } });
  }

  if (options.backupRoot) {
    checks.push(await checkBackup(options.backupRoot, options.project, maxAgeHours));
  }

  for (const target of options.diskPaths) {
    const result = await checkDisk(target);
    if (result.state === 'report' && minDiskFree !== null) {
      result.state = result.detail.freeBytes < minDiskFree ? 'fail' : 'pass';
      result.detail.minDiskFreeBytes = minDiskFree;
    } else if (result.state === 'report') {
      result.detail.threshold = 'no-policy (reported only)';
    }
    checks.push(result);
  }

  const ok = checks.every((check) => check.state !== 'fail');
  const report = { at: new Date().toISOString(), apiBase, ok, checks };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const detail = typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail);
      process.stdout.write(`[${check.state}] ${check.name}: ${detail}\n`);
    }
    process.stdout.write(ok ? 'readiness: OK (enforced checks pass)\n' : 'readiness: FAIL\n');
  }
  process.exitCode = ok ? 0 : 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[ops-readiness] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
