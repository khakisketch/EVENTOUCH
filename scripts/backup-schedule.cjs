'use strict';

// Scheduled-backup wrapper: one command a cron/systemd timer can run.
//
//   node scripts/backup-schedule.cjs --backup-root /var/backups/eventouch
//   node scripts/backup-schedule.cjs --backup-root /var/backups/eventouch \
//     --project eventouch --verify --check
//
// Behavior:
//   - Builds a timestamped --out dir under --backup-root and delegates to
//     scripts/backup.cjs (compose project DB + file volume, read-only
//     against the source). Failure propagates as a nonzero exit so the
//     scheduler records it; nothing retries or pages from here.
//   - With --check, runs scripts/backup-check.cjs --verify-checksums on the
//     fresh backup right after it completes (failures also exit nonzero).
//   - Prints the equivalent cron line with --print-cron and exits 0 without
//     running anything.
//   - With --prune (after a successful backup AND check), applies the
//     retention decision "최근 14일, 최소 7개 유지" through
//     scripts/backup-prune.cjs --apply --i-understand. A failed backup never
//     prunes. Without --prune nothing is ever deleted.
//   - After the run it checks the backup root's disk usage; 80% or more
//     (--max-disk-used-percent) is a warning and a nonzero exit.
//   - With --notify, any failure above is passed to scripts/ops-notify.cjs
//     --send. That mails only when EVENTOUCH_OPS_NOTIFY_EMAIL and the SMTP
//     settings exist in this process environment, otherwise it logs and says
//     so. Offsite upload and encryption are still undecided and not done here.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { diskUsage, DEFAULT_MAX_USED_PERCENT } = require('./disk-usage.cjs');

const ROOT = path.join(__dirname, '..');

const HELP = `
사용법:
  node scripts/backup-schedule.cjs --backup-root <경로> [옵션]

옵션:
  --backup-root <경로>   백업 루트 (필수). 타임스탬프 하위 디렉터리 자동 생성
  --project <이름>        compose 프로젝트 (기본: eventouch)
  --verify                백업 후 임시 DB·디렉터리로 복원 리허설
  --check                 백업 후 backup-check.cjs --verify-checksums 실행
  --prune                 백업·검사가 성공하면 보존 규칙(최근 14일, 최소 7개)에 따라
                          오래된 백업 삭제 (backup-prune.cjs --apply --i-understand)
  --notify                실패하면 ops-notify.cjs --send 로 알림 (수신처·SMTP 환경이
                          없으면 로그만 남기고 그 사실을 출력)
  --max-disk-used-percent <N>
                          백업 루트 디스크 사용률이 N% 이상이면 경고하고 비영 종료
                          (기본: ${DEFAULT_MAX_USED_PERCENT})
  --print-cron            실행 없이 cron 예시 출력
  --help

--prune 없이는 아무것도 삭제하지 않는다. 오프사이트 업로드·암호화는 아직 없다.
`.trimStart();

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runScript(script, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    child.on('error', (error) => resolve({ ok: false, detail: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, detail: `exit ${code}` }));
    if (input !== undefined) child.stdin.end(input);
  });
}

// Failure report in the shape ops-notify.cjs reads (ops-readiness JSON).
function failureReport(failures) {
  return JSON.stringify({
    at: new Date().toISOString(),
    ok: false,
    checks: failures.map(({ name, detail }) => ({ name, state: 'fail', detail })),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    backupRoot: '', project: 'eventouch', verify: false, check: false,
    prune: false, notify: false, maxDiskUsedPercent: String(DEFAULT_MAX_USED_PERCENT),
    printCron: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--verify') { options.verify = true; continue; }
    if (arg === '--check') { options.check = true; continue; }
    if (arg === '--print-cron') { options.printCron = true; continue; }
    if (arg === '--prune') { options.prune = true; continue; }
    if (arg === '--notify') { options.notify = true; continue; }
    if (arg === '--backup-root' || arg === '--project' || arg === '--max-disk-used-percent') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
      const key = { '--backup-root': 'backupRoot', '--project': 'project', '--max-disk-used-percent': 'maxDiskUsedPercent' }[arg];
      options[key] = value; i += 1; continue;
    }
    throw new Error(`알 수 없는 인자: ${arg} (--help 참고)`);
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.printCron) {
    const root = options.backupRoot || '/var/backups/eventouch';
    process.stdout.write(
      '# 매일 03:10 백업 + 즉시 검사 + 보존 정리(최근 14일·최소 7개) + 디스크 80% 경고 + 실패 알림\n'
      + '# 알림 메일은 이 cron 환경에 EVENTOUCH_OPS_NOTIFY_EMAIL 과 SMTP 설정(EVENTOUCH_MAIL_TRANSPORT=smtp, EVENTOUCH_SMTP_*)이\n'
      + '# 모두 있을 때만 나가고, 없으면 로그만 남깁니다. 오프사이트 복사·암호화는 아직 정해지지 않았습니다.\n'
      + `10 3 * * * root /usr/bin/node /opt/eventouch/scripts/backup-schedule.cjs --backup-root ${root} --check --prune --notify >> /var/log/eventouch-backup.log 2>&1\n`,
    );
    return;
  }
  if (!options.backupRoot) throw new Error('--backup-root가 필요합니다 (--help 참고)');

  const maxDiskUsed = Number(options.maxDiskUsedPercent);
  if (!Number.isFinite(maxDiskUsed) || maxDiskUsed < 1 || maxDiskUsed > 100) throw new Error('--max-disk-used-percent는 1~100 사이여야 합니다');

  const out = path.join(options.backupRoot, `${options.project}-${timestamp()}`);
  process.stdout.write(`[backup-schedule] project=${options.project} out=${out}\n`);
  const failures = [];
  const backupArgs = ['--project', options.project, '--out', out];
  if (options.verify) backupArgs.push('--verify');
  const backed = await runScript('backup.cjs', backupArgs);
  if (!backed.ok) {
    process.stderr.write(`[backup-schedule] FAIL: backup.cjs ${backed.detail}\n`);
    failures.push({ name: 'backup', detail: `backup.cjs ${backed.detail}` });
  }
  if (!failures.length && options.check) {
    const checked = await runScript('backup-check.cjs', [
      '--backup-root', options.backupRoot, '--project', options.project, '--verify-checksums',
    ]);
    if (!checked.ok) {
      process.stderr.write(`[backup-schedule] FAIL: backup-check.cjs ${checked.detail}\n`);
      failures.push({ name: 'backup-check', detail: `backup-check.cjs ${checked.detail}` });
    }
  }
  // Retention only ever runs behind a backup that was just written (and
  // checked, when --check is on): a failed night never shrinks the history.
  if (!failures.length && options.prune) {
    const pruned = await runScript('backup-prune.cjs', [
      '--backup-root', options.backupRoot, '--project', options.project, '--apply', '--i-understand',
    ]);
    if (!pruned.ok) {
      process.stderr.write(`[backup-schedule] FAIL: backup-prune.cjs ${pruned.detail}\n`);
      failures.push({ name: 'backup-prune', detail: `backup-prune.cjs ${pruned.detail}` });
    }
  }
  try {
    const usage = await diskUsage(options.backupRoot);
    process.stdout.write(`[backup-schedule] disk ${usage.mount} used ${usage.usedPercent}% (warn at ${maxDiskUsed}%)\n`);
    if (usage.usedPercent >= maxDiskUsed) {
      const detail = `백업 디스크 사용률 ${usage.usedPercent}%가 ${maxDiskUsed}% 이상입니다 (${options.backupRoot})`;
      process.stderr.write(`[backup-schedule] WARN: ${detail}\n`);
      failures.push({ name: 'backup-disk', detail });
    }
  } catch (error) {
    const detail = `디스크 사용률을 확인하지 못했습니다 (${error.message})`;
    process.stderr.write(`[backup-schedule] WARN: ${detail}\n`);
    failures.push({ name: 'backup-disk', detail });
  }
  if (failures.length) {
    if (options.notify) {
      // ops-notify exits 2 for "readiness failed"; that is expected here and
      // the scheduler's own nonzero exit below is what the cron log records.
      await runScript('ops-notify.cjs', ['--send'], failureReport(failures));
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[backup-schedule] OK: ${out}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[backup-schedule] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
