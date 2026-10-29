'use strict';

// Dependency vulnerability gate for the two product lockfiles.
//
//   node scripts/security-audit.cjs
//   node scripts/security-audit.cjs --level high
//   npm run security:audit
//
// Policy (conservative, explicit): the default gate fails on MODERATE and
// above, for BOTH the root lockfile and apps/web. A looser gate is only
// possible by passing --level explicitly, so a weakened threshold always
// shows up in the invoking command / CI diff. `--force` major upgrades are
// never performed here: this gate only reports; remediation stays a
// deliberate lockfile edit (safe `npm audit fix`, never --force).
//
// Scope notes:
//   - Root uses --omit=dev: the shipped API image installs with
//     `npm ci --omit=dev`, so dev-only findings cannot ship. Failing the
//     gate on dev-only findings would block deploys over tooling CVEs.
//   - Web has no dev/prod split worth gating separately (Next ships its
//     whole tree), so the full web tree is audited.
//   - `npm audit` exit status is the verdict: it exits nonzero when findings
//     at or above --audit-level exist. This script propagates that status
//     per lockfile and prints which side failed.

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LEVELS = ['low', 'moderate', 'high', 'critical'];

const HELP = `
사용법:
  node scripts/security-audit.cjs [--level <low|moderate|high|critical>]

기본 게이트: moderate 이상이 하나라도 있으면 실패(루트 omit=dev + web 전체).
완화는 --level 명시로만 가능하며, --force 대형 업그레이드는 여기서 수행하지 않는다.
`.trimStart();

function runAudit(label, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { cwd, stdio: 'inherit' });
    child.on('error', (error) => resolve({ label, ok: false, error: error.message }));
    child.on('close', (code) => resolve({ label, ok: code === 0, code }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  let level = 'moderate';
  const at = argv.indexOf('--level');
  if (at !== -1) {
    level = argv[at + 1] || '';
    if (!LEVELS.includes(level)) {
      process.stderr.write(`[security:audit] FAIL: --level은 ${LEVELS.join('|')} 중 하나여야 합니다 (입력: '${level}')\n`);
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`[security:audit] gate level: ${level} (root --omit=dev + apps/web)\n`);
  const results = [
    await runAudit('root', ['audit', '--omit=dev', `--audit-level=${level}`], ROOT),
    await runAudit('apps/web', ['audit', '--include=dev', `--audit-level=${level}`], path.join(ROOT, 'apps/web')),
  ];
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    for (const result of failed) {
      process.stderr.write(
        `[security:audit] FAIL: ${result.label} lockfile has findings at/above '${level}'`
          + (result.code !== undefined ? ` (npm audit exit ${result.code})` : `: ${result.error}`) + '\n',
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[security:audit] PASS: no findings at/above '${level}' in either lockfile\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[security:audit] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
