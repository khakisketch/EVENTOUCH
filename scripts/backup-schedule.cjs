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
//   - NEVER prunes old backups: retention/offsite/encryption policy is
//     undecided, so arbitrary deletion is forbidden. A future retention
//     job needs an explicit keep-count/keep-days policy AND an operator
//     --i-understand flag; this wrapper takes neither.
//   - NEVER uploads offsite or sends notifications; see ops-notify.cjs.

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const HELP = `
사용법:
  node scripts/backup-schedule.cjs --backup-root <경로> [옵션]

옵션:
  --backup-root <경로>   백업 루트 (필수). 타임스탬프 하위 디렉터리 자동 생성
  --project <이름>        compose 프로젝트 (기본: eventouch)
  --verify                백업 후 임시 DB·디렉터리로 복원 리허설
  --check                 백업 후 backup-check.cjs --verify-checksums 실행
  --print-cron            실행 없이 cron 예시 출력
  --help

보존 정책 미정이므로 오래된 백업을 지우지 않는다(삭제 옵션 없음).
오프사이트 업로드·외부 알림은 하지 않는다.
`.trimStart();

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { stdio: 'inherit' });
    child.on('error', (error) => resolve({ ok: false, detail: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, detail: `exit ${code}` }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    backupRoot: '', project: 'eventouch', verify: false, check: false,
    printCron: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--verify') { options.verify = true; continue; }
    if (arg === '--check') { options.check = true; continue; }
    if (arg === '--print-cron') { options.printCron = true; continue; }
    if (arg === '--backup-root' || arg === '--project') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
      options[arg === '--backup-root' ? 'backupRoot' : 'project'] = value; i += 1; continue;
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
      '# 매일 03:10 KST 백업 + 즉시 검사 (보존 삭제 없음, 정책 확정 전까지 수동 정리)\n'
      + `10 3 * * * root /usr/bin/node /opt/eventouch/scripts/backup-schedule.cjs --backup-root ${root} --check >> /var/log/eventouch-backup.log 2>&1\n`,
    );
    return;
  }
  if (!options.backupRoot) throw new Error('--backup-root가 필요합니다 (--help 참고)');

  const out = path.join(options.backupRoot, `${options.project}-${timestamp()}`);
  process.stdout.write(`[backup-schedule] project=${options.project} out=${out}\n`);
  const backupArgs = ['--project', options.project, '--out', out];
  if (options.verify) backupArgs.push('--verify');
  const backed = await runScript('backup.cjs', backupArgs);
  if (!backed.ok) {
    process.stderr.write(`[backup-schedule] FAIL: backup.cjs ${backed.detail}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.check) {
    const checked = await runScript('backup-check.cjs', [
      '--backup-root', options.backupRoot, '--project', options.project, '--verify-checksums',
    ]);
    if (!checked.ok) {
      process.stderr.write(`[backup-schedule] FAIL: backup-check.cjs ${checked.detail}\n`);
      process.exitCode = 1;
      return;
    }
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
