'use strict';

// 2026-11-24 backup decision: disk warning at 80%, mail only when configured,
// the scheduler's cron line carries prune + notify. No real mail, no real
// backup folder, no system cron.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const { parseDf } = require('../scripts/disk-usage.cjs');
const notify = require('../scripts/ops-notify.cjs');

function run(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', input: options.input, timeout: 15000, env: options.env || process.env,
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

const failing = { ok: false, checks: [{ name: 'backup', state: 'fail', detail: 'stale' }, { name: 'api', state: 'pass', detail: {} }] };
const SMTP_ENV = {
  EVENTOUCH_OPS_NOTIFY_EMAIL: 'ops@example.test',
  EVENTOUCH_MAIL_TRANSPORT: 'smtp',
  EVENTOUCH_SMTP_HOST: 'smtp.example.test',
  EVENTOUCH_SMTP_PORT: '587',
  EVENTOUCH_SMTP_FROM: 'noreply@example.test',
  EVENTOUCH_SMTP_USER: 'smtp-user',
  EVENTOUCH_SMTP_PASSWORD: 'smtp-secret-value',
};

function fakeTransport(outcome) {
  const sent = [];
  const made = [];
  return {
    sent, made,
    createTransport(options) {
      made.push(options);
      return {
        async sendMail(message) {
          sent.push(message);
          if (outcome === 'throw') throw new Error('535 auth failed for smtp-user smtp-secret-value');
          if (outcome === 'reject') return { accepted: [], rejected: [message.to.address] };
          return { accepted: [message.to.address], rejected: [] };
        },
      };
    },
  };
}

test('df -Pk output is parsed into used percent and free bytes', () => {
  const usage = parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 800000000 111832752 88% /System/Volumes/Data\n');
  assert.equal(usage.usedPercent, 88);
  assert.equal(usage.freeBytes, 111832752 * 1024);
  assert.equal(usage.mount, '/System/Volumes/Data');
  assert.throws(() => parseDf('Filesystem\n'), /no rows/);
});

test('readiness fails a disk path at or above the used-percent limit and exits nonzero', () => {
  const base = ['--api-base', 'http://127.0.0.1:1', '--timeout-ms', '300', '--json'];
  const tripped = run('ops-readiness.cjs', [...base, '--disk-path', __dirname, '--max-disk-used-percent', '1']);
  assert.equal(tripped.status, 1);
  const disk = JSON.parse(tripped.stdout).checks.find((check) => check.name.startsWith('disk:'));
  assert.equal(disk.state, 'fail');
  assert.match(disk.detail.warning, /디스크 사용률/);
  const roomy = run('ops-readiness.cjs', [...base, '--disk-path', __dirname, '--max-disk-used-percent', '100']);
  const okDisk = JSON.parse(roomy.stdout).checks.find((check) => check.name.startsWith('disk:'));
  assert.equal(okDisk.state, 'pass');
  assert.equal(run('ops-readiness.cjs', [...base, '--max-disk-used-percent', '0']).status, 1);
});

test('the default disk limit is 80 percent', () => {
  const result = run('ops-readiness.cjs', ['--api-base', 'http://127.0.0.1:1', '--timeout-ms', '300', '--json', '--disk-path', __dirname]);
  const disk = JSON.parse(result.stdout).checks.find((check) => check.name.startsWith('disk:'));
  assert.equal(disk.detail.maxDiskUsedPercent, 80);
});

test('--send mails the failures only when the recipient and SMTP settings are both present', async () => {
  const transport = fakeTransport('ok');
  const outcome = await notify.sendAlert({
    env: SMTP_ENV, createTransport: transport.createTransport, at: '2026-11-24T00:00:00.000Z',
    failures: [{ name: 'backup', detail: 'stale' }],
  });
  assert.deepEqual(outcome, { sent: true, configured: true });
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to.address, 'ops@example.test');
  assert.match(transport.sent[0].subject, /운영 점검 실패 1건/);
  assert.match(transport.sent[0].text, /backup: stale/);
  assert.equal(transport.made[0].tls.rejectUnauthorized, true);
  assert.ok(!JSON.stringify(transport.sent[0]).includes('smtp-secret-value'), 'credentials never reach the message');
});

test('missing recipient or SMTP settings means no transport is even created', async () => {
  for (const env of [
    { ...SMTP_ENV, EVENTOUCH_OPS_NOTIFY_EMAIL: '' },
    { ...SMTP_ENV, EVENTOUCH_OPS_NOTIFY_EMAIL: 'not-an-address' },
    { ...SMTP_ENV, EVENTOUCH_MAIL_TRANSPORT: '' },
    { ...SMTP_ENV, EVENTOUCH_SMTP_PASSWORD: '' },
    { ...SMTP_ENV, EVENTOUCH_MAIL_MOCK: '1' },
  ]) {
    const transport = fakeTransport('ok');
    const outcome = await notify.sendAlert({ env, createTransport: transport.createTransport, at: 'now', failures: [{ name: 'x', detail: 'y' }] });
    assert.equal(outcome.sent, false);
    assert.equal(outcome.configured, false);
    assert.equal(transport.made.length, 0);
    assert.equal(transport.sent.length, 0);
  }
});

test('provider errors are reduced to a reason without echoing credentials', async () => {
  for (const mode of ['throw', 'reject']) {
    const outcome = await notify.sendAlert({
      env: SMTP_ENV, createTransport: fakeTransport(mode).createTransport, at: 'now', failures: [{ name: 'x', detail: 'y' }],
    });
    assert.equal(outcome.sent, false);
    assert.equal(outcome.configured, true);
    assert.ok(!JSON.stringify(outcome).includes('smtp-secret-value') && !JSON.stringify(outcome).includes('smtp-user'));
  }
});

test('main --send keeps the failing exit code, mails once, and sends nothing for a passing report', async () => {
  const previous = process.exitCode;
  const write = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  try {
    const transport = fakeTransport('ok');
    const result = await notify.main(['--send'], { env: SMTP_ENV, createTransport: transport.createTransport, stdin: JSON.stringify(failing) });
    assert.equal(process.exitCode, 2);
    assert.equal(result.delivered, true);
    assert.equal(transport.sent.length, 1);
    assert.match(captured, /경고 메일을 보냈고/);

    const quiet = fakeTransport('ok');
    const passing = await notify.main(['--send'], { env: SMTP_ENV, createTransport: quiet.createTransport, stdin: JSON.stringify({ ok: true, checks: [] }) });
    assert.equal(process.exitCode, 0);
    assert.equal(passing.delivered, false);
    assert.equal(quiet.sent.length, 0);

    const broken = fakeTransport('throw');
    const failed = await notify.main(['--send'], { env: SMTP_ENV, createTransport: broken.createTransport, stdin: JSON.stringify(failing) });
    assert.equal(process.exitCode, 2);
    assert.equal(failed.delivered, false);
    assert.match(captured, /메일: 보내지 않음/);
    assert.ok(!captured.includes('smtp-secret-value'));
  } finally {
    process.stdout.write = write;
    process.exitCode = previous;
  }
});

test('without --send nothing is mailed even when everything is configured', async () => {
  const previous = process.exitCode;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    const transport = fakeTransport('ok');
    await notify.main([], { env: SMTP_ENV, createTransport: transport.createTransport, stdin: JSON.stringify(failing) });
    assert.equal(transport.made.length, 0);
  } finally {
    process.stdout.write = write;
    process.exitCode = previous;
  }
});

test('the printed cron line includes check, prune and notify, and says what is still undecided', () => {
  const cron = run('backup-schedule.cjs', ['--print-cron', '--backup-root', '/var/backups/eventouch']);
  assert.equal(cron.status, 0);
  assert.match(cron.stdout, /backup-schedule\.cjs --backup-root \/var\/backups\/eventouch --check --prune --notify/);
  assert.match(cron.stdout, /EVENTOUCH_OPS_NOTIFY_EMAIL/);
  assert.match(cron.stdout, /오프사이트 복사·암호화는 아직/);
});

test('the scheduler refuses an invalid disk threshold before running anything', () => {
  const result = run('backup-schedule.cjs', ['--backup-root', '/nonexistent/etko-root', '--max-disk-used-percent', '0']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1~100/);
});

// End-to-end scheduler run in a temp copy of the scripts with a stub
// backup.cjs/backup-check.cjs: no docker, no real backup, no real mail.
function schedulerSandbox({ backupExit = 0 } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-sched-'));
  fs.mkdirSync(path.join(base, 'scripts'));
  fs.mkdirSync(path.join(base, 'server'));
  fs.copyFileSync(path.join(__dirname, '..', 'server', 'smtp-mail.js'), path.join(base, 'server', 'smtp-mail.js'));
  // nodemailer is only required lazily on a real send; the sandbox has none.
  for (const file of ['backup-schedule.cjs', 'disk-usage.cjs', 'backup-prune.cjs', 'ops-notify.cjs']) {
    fs.copyFileSync(path.join(SCRIPTS, file), path.join(base, 'scripts', file));
  }
  fs.writeFileSync(path.join(base, 'scripts', 'backup.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
const out = process.argv[process.argv.indexOf('--out') + 1];
if (${backupExit} !== 0) process.exit(${backupExit});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString() }));
`);
  fs.writeFileSync(path.join(base, 'scripts', 'backup-check.cjs'), 'process.exit(0);\n');
  const root = path.join(base, 'var', 'backups');
  fs.mkdirSync(root, { recursive: true });
  const DAY = 86_400_000;
  const make = (daysAgo) => {
    const name = `eventouch-${new Date(Date.now() - daysAgo * DAY).toISOString().replace(/[:.]/g, '-')}`;
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'manifest.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString() }));
    return name;
  };
  const seeded = [1, 2, 3, 4, 5, 6, 7, 8].map(make);
  const old = make(60);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^EVENTOUCH_(OPS_NOTIFY|SMTP|MAIL)/.test(key)));
  const result = (args) => {
    const out = spawnSync(process.execPath, [path.join(base, 'scripts', 'backup-schedule.cjs'), '--backup-root', root, ...args], { encoding: 'utf8', timeout: 30000, env });
    return { status: out.status, stdout: String(out.stdout), stderr: String(out.stderr) };
  };
  return { base, root, seeded, old, result, exists: (name) => fs.existsSync(path.join(root, name)), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('scheduler --prune removes only expired backups after a successful backup and check', () => {
  const box = schedulerSandbox();
  try {
    const run1 = box.result(['--check', '--prune', '--max-disk-used-percent', '100']);
    assert.equal(run1.status, 0, run1.stdout + run1.stderr);
    assert.ok(!box.exists(box.old), 'the expired backup is pruned');
    for (const name of box.seeded) assert.ok(box.exists(name), name);
    assert.match(run1.stdout, /\[backup-schedule\] OK/);
  } finally { box.cleanup(); }
});

test('scheduler without --prune never deletes', () => {
  const box = schedulerSandbox();
  try {
    assert.equal(box.result(['--check', '--max-disk-used-percent', '100']).status, 0);
    assert.ok(box.exists(box.old));
  } finally { box.cleanup(); }
});

test('a failed backup never prunes, exits nonzero, and --notify stays log-only without mail settings', () => {
  const box = schedulerSandbox({ backupExit: 3 });
  try {
    const failed = box.result(['--check', '--prune', '--notify', '--max-disk-used-percent', '100']);
    assert.equal(failed.status, 1);
    assert.ok(box.exists(box.old), 'history is untouched after a failed night');
    assert.match(failed.stdout, /readiness FAIL/);
    assert.match(failed.stdout, /메일: 보내지 않음/);
    assert.match(failed.stdout, /backup: backup\.cjs exit 3/);
  } finally { box.cleanup(); }
});

test('a full disk is a warning with a nonzero exit even when the backup itself worked', () => {
  const box = schedulerSandbox();
  try {
    const warned = box.result(['--check', '--notify', '--max-disk-used-percent', '1']);
    assert.equal(warned.status, 1);
    assert.match(warned.stderr, /백업 디스크 사용률/);
    assert.match(warned.stdout, /backup-disk/);
  } finally { box.cleanup(); }
});
