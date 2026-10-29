'use strict';

// Alert runner for ops probe results. LOG-ONLY by design:
//
//   node scripts/ops-readiness.cjs --api-base ... --json | node scripts/ops-notify.cjs
//   node scripts/ops-notify.cjs --input readiness.json --to ops@example.com
//
// Policy (undecided, so nothing really sends):
//   - The only implemented sink is `log`: the would-be alert is printed to
//     stdout with its recipients, and nothing leaves the machine.
//   - `--send` is REFUSED with a nonzero exit until a receiver/transport
//     policy exists (no SMTP/webhook/API delivery is wired on purpose).
//     Claiming "notification sent" from this runner would be false, so the
//     runner says exactly what it did: logged locally.
//   - Recipients given via --to are echoed back as "unconfigured receivers":
//     stored nowhere, contacted never.
//
// When the notification policy (receivers, channel, credentials) is decided,
// that decision must add a real transport here AND change this help text.
// Until then this file is the audit trail that alerting is local-only.

const fs = require('node:fs');

const HELP = `
사용법:
  node scripts/ops-notify.cjs [--input <JSON파일>] [--to <수신처>] [--json]

동작: 표준입력 또는 --input의 readiness JSON을 읽어 FAIL 항목이 있으면
경고문을 stdout에 기록한다(log-only). --send는 정책 미정이므로 거부된다.
수신처·채널·자격증명이 정해지면 그때 실제 전송을 구현한다.
`.trimStart();

async function readAllStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { input: '', to: [], json: false, help: false, send: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--send') { options.send = true; continue; }
    if (arg === '--input' || arg === '--to') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
      if (arg === '--input') options.input = value;
      else options.to.push(value);
      i += 1; continue;
    }
    throw new Error(`알 수 없는 인자: ${arg} (--help 참고)`);
  }
  if (options.help) {
    process.stdout.write(HELP);
    return { delivered: false };
  }
  if (options.send) {
    process.stderr.write(
      '[ops-notify] REFUSED --send: 수신처·채널·자격증명 정책이 미정이므로 실제 전송을 수행하지 않습니다 (log-only 유지)\n',
    );
    process.exitCode = 1;
    return { delivered: false, reason: 'no-transport-policy' };
  }

  const raw = options.input ? fs.readFileSync(options.input, 'utf8') : await readAllStdin();
  if (!raw.trim()) throw new Error('readiness JSON 입력이 없습니다 (--input 또는 stdin)');
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error('readiness JSON을 해석하지 못했습니다');
  }
  const failures = (report.checks || []).filter((check) => check.state === 'fail');
  const result = {
    at: new Date().toISOString(),
    sink: 'log',
    delivered: false,
    ok: report.ok === true && failures.length === 0,
    failures: failures.map((check) => ({ name: check.name, detail: check.detail })),
    unconfiguredReceivers: options.to,
    note: 'log-only: 수신처 정책 미정이라 어디에도 전송하지 않았으며, 수신처를 저장하지도 않았다',
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write('[ops-notify] readiness OK: 전송할 경고 없음 (log-only)\n');
  } else {
    process.stdout.write(`[ops-notify] readiness FAIL: ${failures.length}건 — 아래를 stdout에만 기록 (외부 전송 없음)\n`);
    for (const failure of failures) {
      const detail = typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail);
      process.stdout.write(`  - ${failure.name}: ${detail}\n`);
    }
    if (options.to.length) {
      process.stdout.write(`  (unconfigured receivers, contacted never: ${options.to.join(', ')})\n`);
    }
  }
  process.exitCode = result.ok ? 0 : 2;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[ops-notify] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
