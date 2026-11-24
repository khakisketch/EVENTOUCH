'use strict';

// Alert runner for ops probe results.
//
//   node scripts/ops-readiness.cjs --api-base ... --json | node scripts/ops-notify.cjs
//   node scripts/ops-readiness.cjs --api-base ... --json | node scripts/ops-notify.cjs --send
//
// Policy (2026-11-24 backup decision):
//   - Default: the would-be alert is printed to stdout and nothing leaves the
//     machine (log-only).
//   - `--send` emails the alert ONLY when BOTH are configured:
//       EVENTOUCH_OPS_NOTIFY_EMAIL   one recipient address
//       the existing SMTP settings read by server/smtp-mail.js
//         (EVENTOUCH_MAIL_TRANSPORT=smtp, EVENTOUCH_SMTP_HOST/PORT/FROM/USER/PASSWORD)
//     With either missing, it stays log-only AND says so on stdout, so a log
//     reader never mistakes "FAIL" for "someone was told".
//   - A readiness report without failures sends nothing.
//   - The mail carries check names and details only: never SMTP credentials,
//     and SMTP errors are reduced to a reason code (they can echo secrets).
//   - Exit code: 0 readiness OK, 2 readiness failed (whether or not the mail
//     went out), 1 usage/input error. A failed mail attempt is printed too.
//   - --to is only echoed back as "unconfigured receivers": mail goes to the
//     environment recipient alone.

const fs = require('node:fs');
const { smtpConfiguration } = require('../server/smtp-mail.js');

const HELP = `
사용법:
  node scripts/ops-notify.cjs [--input <JSON파일>] [--send] [--to <수신처>] [--json]

동작: 표준입력 또는 --input의 readiness JSON을 읽어 FAIL 항목이 있으면
경고문을 stdout에 기록한다(log-only). --send를 주면 환경변수
EVENTOUCH_OPS_NOTIFY_EMAIL 과 기존 SMTP 설정(EVENTOUCH_MAIL_TRANSPORT=smtp,
EVENTOUCH_SMTP_HOST/PORT/FROM/USER/PASSWORD)이 모두 있을 때만 메일을 보낸다.
하나라도 없으면 로그만 남기고 그 사실을 출력한다.
`.trimStart();

async function readAllStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function singleAddress(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/.test(value);
}

function describeDetail(detail) {
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

// Whether a real mail can be sent from this environment, and why not.
function deliveryState(env) {
  const recipient = String(env.EVENTOUCH_OPS_NOTIFY_EMAIL || '').trim();
  if (!recipient) return { ready: false, reason: 'EVENTOUCH_OPS_NOTIFY_EMAIL 이 없습니다' };
  if (!singleAddress(recipient)) return { ready: false, reason: 'EVENTOUCH_OPS_NOTIFY_EMAIL 이 올바른 메일 주소가 아닙니다' };
  const smtp = smtpConfiguration(env);
  if (!smtp) return { ready: false, reason: 'SMTP 설정(EVENTOUCH_MAIL_TRANSPORT=smtp, EVENTOUCH_SMTP_*)이 없거나 올바르지 않습니다' };
  return { ready: true, recipient, smtp };
}

function alertText(failures, at) {
  const lines = [`EVENTOUCH 운영 점검에서 ${failures.length}건이 실패했습니다. (${at})`, ''];
  for (const failure of failures) lines.push(`- ${failure.name}: ${describeDetail(failure.detail)}`);
  lines.push('', '이 메일은 scripts/ops-notify.cjs 가 보냈습니다. 문제가 풀렸는지는 점검을 다시 실행해 확인하세요.');
  return lines.join('\n');
}

// Sends one alert mail. Returns { sent, reason? }; never throws and never
// echoes provider errors (they can contain credentials or addresses).
async function sendAlert({ env, failures, at, createTransport }) {
  const state = deliveryState(env);
  if (!state.ready) return { sent: false, reason: state.reason, configured: false };
  const make = createTransport || require('nodemailer').createTransport;
  try {
    const transport = make({
      host: state.smtp.host, port: state.smtp.port, secure: state.smtp.port === 465,
      requireTLS: state.smtp.port !== 465, auth: { user: state.smtp.user, pass: state.smtp.pass },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    });
    const result = await transport.sendMail({
      from: { name: 'EVENTOUCH', address: state.smtp.from }, to: { address: state.recipient },
      envelope: { from: state.smtp.from, to: [state.recipient] },
      subject: `[EVENTOUCH] 운영 점검 실패 ${failures.length}건`,
      text: alertText(failures, at),
      disableFileAccess: true, disableUrlAccess: true,
    });
    return result && result.accepted && result.accepted.length === 1 && !(result.rejected && result.rejected.length)
      ? { sent: true, configured: true }
      : { sent: false, reason: '메일 서버가 수신을 거부했습니다', configured: true };
  } catch {
    return { sent: false, reason: '메일 서버 연결 또는 발송에 실패했습니다', configured: true };
  }
}

async function main(argv = process.argv.slice(2), { env = process.env, createTransport, stdin } = {}) {
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

  const raw = options.input ? fs.readFileSync(options.input, 'utf8') : (stdin !== undefined ? stdin : await readAllStdin());
  if (!raw.trim()) throw new Error('readiness JSON 입력이 없습니다 (--input 또는 stdin)');
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error('readiness JSON을 해석하지 못했습니다');
  }
  const failures = (report.checks || []).filter((check) => check.state === 'fail');
  const at = new Date().toISOString();
  const ok = report.ok === true && failures.length === 0;
  let mail = { attempted: false, sent: false };
  if (options.send && !ok) {
    const outcome = await sendAlert({ env, failures: failures.map((check) => ({ name: check.name, detail: check.detail })), at, createTransport });
    mail = { attempted: outcome.configured === true, sent: outcome.sent, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  const sink = mail.sent ? 'email' : 'log';
  const result = {
    at,
    sink,
    delivered: mail.sent,
    ok,
    failures: failures.map((check) => ({ name: check.name, detail: check.detail })),
    unconfiguredReceivers: options.to,
    ...(options.send && !ok ? { mail } : {}),
    note: mail.sent
      ? '환경변수에 설정된 수신처로 경고 메일을 보냈다'
      : options.send && !ok
        ? `메일을 보내지 않았다(${mail.reason || '알 수 없음'}): 로그만 기록했다`
        : 'log-only: 어디에도 전송하지 않았으며, 수신처를 저장하지도 않았다',
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ok) {
    process.stdout.write('[ops-notify] readiness OK: 전송할 경고 없음 (log-only)\n');
  } else {
    process.stdout.write(`[ops-notify] readiness FAIL: ${failures.length}건 — ${mail.sent ? '경고 메일을 보냈고 아래에도 기록' : '아래를 stdout에만 기록 (외부 전송 없음)'}\n`);
    for (const failure of failures) {
      process.stdout.write(`  - ${failure.name}: ${describeDetail(failure.detail)}\n`);
    }
    if (options.send) {
      process.stdout.write(mail.sent
        ? '  메일: 발송함 (수신처는 EVENTOUCH_OPS_NOTIFY_EMAIL)\n'
        : `  메일: 보내지 않음 — ${mail.reason}. 로그만 기록했습니다.\n`);
    }
    if (options.to.length) {
      process.stdout.write(`  (unconfigured receivers, contacted never: ${options.to.join(', ')})\n`);
    }
  }
  process.exitCode = ok ? 0 : 2;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[ops-notify] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, sendAlert, deliveryState };
