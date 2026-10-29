'use strict';

// The web job must run its browser audits under a fresh, owner-private,
// per-job evidence root and convey the exact paths to the failure upload
// without weakening any product gate. This runs without CI services
// (no PostgreSQL, no network, no GitHub runner): it parses the workflow
// YAML as text and replays the directory semantics with plain shell tools.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');

function webJob() {
  const ci = fs.readFileSync(workflowPath, 'utf8');
  const start = ci.indexOf('\n  web:\n');
  assert.ok(start >= 0, 'the web job must exist');
  return ci.slice(start);
}

const EXPECTED_GATES = [
  'npm run db:migrate',
  'npm run web:audit',
  'npm run web:console:audit',
  'npm run web:system:audit',
  'npm run web:organizations:audit',
  'npm run web:organization-roles:audit',
  'npm run web:recovery:audit',
  'npm run web:import:audit',
  'npm run web:hanwool:audit',
  'npm run web:theme:audit',
  'npm run web:retirement:audit',
  'npm run web:preparation:audit',
  'npm run web:signup-retry:audit',
  'npm run web:crossrole:audit',
  'npm run web:lifecycle:audit',
  'npm run web:account-recovery:audit',
  'npm run web:close:audit',
  'npm run web:workbench:audit',
  'npm run web:cards:audit',
  'npm run audit:usability',
];

test('web job creates one fresh owner-private evidence root per run', () => {
  const web = webJob();
  const createAt = web.indexOf('name: Create fresh private evidence root');
  const auditAt = web.indexOf('name: Run the browser audits serially');
  const uploadAt = web.indexOf('name: Upload audit logs and captures on failure');
  assert.ok(createAt >= 0 && auditAt > createAt && uploadAt > auditAt, 'evidence root, audits and upload must run in that order');
  const create = web.slice(createAt, auditAt);
  assert.match(create, /mktemp -d/, 'consecutive runs must get distinct directories');
  assert.match(create, /umask 077/, 'the root must stay private even under a permissive runner umask');
  assert.match(create, /mkdir -m 700/, 'logs and captures must be owner-private');
  assert.match(create, /chmod 700/, 'the root and its children must be owner-private');
  assert.match(create, /EVENTOUCH_CI_EVIDENCE_ROOT=.*>> "\$GITHUB_ENV"/, 'the root path must be conveyed exactly');
  assert.match(create, /EVENTOUCH_CI_LOGS=.*>> "\$GITHUB_ENV"/, 'the logs path must be conveyed exactly');
  assert.match(create, /EVENTOUCH_CI_CAPTURES=.*>> "\$GITHUB_ENV"/, 'the captures path must be conveyed exactly');
  assert.doesNotMatch(create, /\/tmp\/eventouch-ci-logs/, 'no fixed shared logs directory');
  assert.doesNotMatch(create, /\/tmp\/eventouch-ci-captures/, 'no fixed shared captures directory');
});

test('audit step uses only the conveyed paths and keeps every gate', () => {
  const web = webJob();
  const auditAt = web.indexOf('name: Run the browser audits serially');
  const uploadAt = web.indexOf('name: Upload audit logs and captures on failure');
  const audit = web.slice(auditAt, uploadAt);
  assert.match(audit, /EVENTOUCH_CAPTURE_ROOT:\s*\$\{\{\s*env\.EVENTOUCH_CI_CAPTURES\s*\}\}/, 'captures must be the conveyed per-job path');
  assert.match(audit, /: "\$\{EVENTOUCH_CI_LOGS:\?/, 'a missing evidence root must fail instead of falling back');
  assert.match(audit, /: "\$\{EVENTOUCH_CI_CAPTURES:\?/, 'a missing captures path must fail instead of falling back');
  assert.ok(audit.indexOf('umask 077') >= 0 && audit.indexOf('umask 077') < audit.indexOf('tee "$EVENTOUCH_CI_LOGS/'), 'logs must stay private');
  assert.match(audit, /ci_tee\(\) \{/, 'each log write must go through the append helper');
  assert.match(audit, /set -o noclobber/, 'log reservation must be exclusive');
  const reservation = audit.match(/for log in ([^\n]+); do/);
  assert.ok(reservation, 'all log names must be reserved before the first producer');
  assert.match(audit, /tee -a "\$dest"/, 'reserved logs must only ever be appended to');
  assert.doesNotMatch(audit, /\| tee "\$EVENTOUCH_CI_LOGS\//, 'no gate may use truncating tee');
  const teeUses = [...audit.matchAll(/\|\s*ci_tee "\$EVENTOUCH_CI_LOGS\/[^"]+"/g)];
  assert.equal(teeUses.length, EXPECTED_GATES.length, 'every gate must write through ci_tee');
  assert.match(audit, /set -o pipefail/, 'a failed audit must not be hidden by tee');
  const expectedLogs = EXPECTED_GATES.map((gate) => `${gate.replace(/^npm run /, '').replace(/:/g, '-')}.log`).sort();
  const targets = [...audit.matchAll(/ci_tee "\$EVENTOUCH_CI_LOGS\/([^"/]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(targets, expectedLogs, 'ci_tee must cover precisely one log per gate, in gate order');
  assert.deepEqual(reservation[1].trim().split(/\s+/).map(name => `${name}.log`).sort(), expectedLogs, 'the preflight must reserve every gate log');
  assert.ok(audit.indexOf('set +o noclobber') < audit.indexOf('npm run db:migrate'), 'reservation must complete before any gate starts');
  assert.doesNotMatch(audit, /\/tmp\/eventouch-ci-logs/, 'audits must not write to a fixed shared directory');
  assert.doesNotMatch(audit, /\/tmp\/eventouch-ci-captures/, 'audits must not capture to a fixed shared directory');
  assert.doesNotMatch(audit, /mkdir -m 700 \/tmp\/eventouch-ci/, 'the audit step must not re-derive the root');
  const build = web.indexOf('npm --prefix apps/web run build');
  for (const gate of EXPECTED_GATES) {
    const at = audit.indexOf(gate);
    assert.ok(at >= 0, `${gate} must stay wired into the web job`);
    assert.ok(build >= 0 && build < auditAt + at, `${gate} must run after the build`);
  }
  const ordered = EXPECTED_GATES.map((gate) => audit.indexOf(gate));
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered, 'gates must keep their serial order');
});

test('failure upload receives exactly the conveyed per-job paths', () => {
  const web = webJob();
  const uploadAt = web.indexOf('name: Upload audit logs and captures on failure');
  const upload = web.slice(uploadAt);
  assert.match(upload, /if:\s*failure\(\)/, 'evidence uploads only on failure');
  assert.match(upload, /\$\{\{\s*env\.EVENTOUCH_CI_LOGS\s*\}\}/, 'the upload must receive the exact logs path');
  assert.match(upload, /\$\{\{\s*env\.EVENTOUCH_CI_CAPTURES\s*\}\}/, 'the upload must receive the exact captures path');
  assert.doesNotMatch(upload, /\/tmp\/eventouch-ci-logs/, 'the upload must not reference a fixed shared directory');
  assert.doesNotMatch(upload, /\/tmp\/eventouch-ci-captures/, 'the upload must not reference a fixed shared directory');
  assert.match(upload, /retention-days:\s*7/, 'failure evidence retention must stay at 7 days');
});

function makeEvidenceRoot() {
  const run = spawnSync('/bin/sh', ['-c', 'umask 077; root="$(mktemp -d "$1-XXXXXX")"; chmod 700 "$root"; mkdir -m 700 "$root/logs" "$root/captures"; chmod 700 "$root" "$root/logs" "$root/captures"; printf "%s" "$root";', 'sh', path.join(os.tmpdir(), 'eventouch-ci-evidence')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test('consecutive isolated runs stay private and preserve preexisting evidence', () => {
  const first = makeEvidenceRoot();
  const second = makeEvidenceRoot();
  try {
    assert.notEqual(first, second, 'consecutive runs must not share a root');
    for (const dir of [first, second, path.join(first, 'logs'), path.join(first, 'captures'), path.join(second, 'logs'), path.join(second, 'captures')]) {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${dir} must be owner-private`);
    }
    // Tee-style log writes under umask 077 stay owner-private too.
    const log = spawnSync('/bin/sh', ['-c', 'umask 077; printf evidence > "$1"; chmod 600 "$1" 2>/dev/null || true;', 'sh', path.join(first, 'logs', 'web-audit.log')], { encoding: 'utf8' });
    assert.equal(log.status, 0, log.stderr);
    assert.equal(fs.statSync(path.join(first, 'logs', 'web-audit.log')).mode & 0o777, 0o600);
    // Preexisting evidence is never silently reused: recreating an occupied
    // logs directory fails and the sentinel survives.
    fs.writeFileSync(path.join(first, 'captures', 'sentinel.txt'), 'preserve', { mode: 0o600 });
    const reuse = spawnSync('/bin/sh', ['-c', 'mkdir -m 700 "$1/logs" "$1/captures";', 'sh', first], { encoding: 'utf8' });
    assert.notEqual(reuse.status, 0, 'reusing an occupied evidence root must fail');
    assert.equal(fs.readFileSync(path.join(first, 'captures', 'sentinel.txt'), 'utf8'), 'preserve');
    assert.equal(fs.readFileSync(path.join(first, 'logs', 'web-audit.log'), 'utf8'), 'evidence');
    assert.ok(!fs.existsSync(path.join(second, 'logs', 'web-audit.log')), 'the second run must not see the first run evidence');
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('actual workflow creates and conveys two distinct private evidence roots', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-ci-root-workflow-'));
  try {
    const web = webJob();
    const create = web.slice(web.indexOf('name: Create fresh private evidence root'), web.indexOf('name: Run the browser audits serially'));
    const script = create.split('run: |\n')[1].split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n')
      .replace('/tmp/eventouch-ci-evidence-XXXXXX', path.join(parent, 'job-XXXXXX'));
    assert.match(script, /mktemp -d/);
    const run = name => {
      const envFile = path.join(parent, name); fs.writeFileSync(envFile, '');
      const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { env: { ...process.env, GITHUB_ENV: envFile }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    };
    const first = run('env1'), second = run('env2');
    assert.notEqual(first.EVENTOUCH_CI_EVIDENCE_ROOT, second.EVENTOUCH_CI_EVIDENCE_ROOT);
    for (const item of [first, second]) {
      assert.equal(item.EVENTOUCH_CI_LOGS, path.join(item.EVENTOUCH_CI_EVIDENCE_ROOT, 'logs'));
      assert.equal(item.EVENTOUCH_CI_CAPTURES, path.join(item.EVENTOUCH_CI_EVIDENCE_ROOT, 'captures'));
      for (const dir of [item.EVENTOUCH_CI_EVIDENCE_ROOT, item.EVENTOUCH_CI_LOGS, item.EVENTOUCH_CI_CAPTURES]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
    fs.writeFileSync(path.join(first.EVENTOUCH_CI_CAPTURES, 'sentinel'), 'preserve', { mode: 0o600 });
    assert.equal(fs.readFileSync(path.join(first.EVENTOUCH_CI_CAPTURES, 'sentinel'), 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(second.EVENTOUCH_CI_CAPTURES), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('actual workflow refuses existing evidence before gates and preserves failed logs', () => {
  const web = webJob();
  const audit = web.slice(web.indexOf('name: Run the browser audits serially'), web.indexOf('name: Upload audit logs and captures on failure'));
  const script = audit.split('run: |\n')[1].split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  assert.match(script, /npm run db:migrate/);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-ci-tee-test-'));
  try {
    const bin = path.join(parent, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "$2" >> "$GATE_MARKER"\necho "synthetic $2"\n[ "$2" = "$FAIL_GATE" ] && exit 23\nexit 0\n', { mode: 0o700 });
    const run = (name, existing, failGate) => {
      const root = path.join(parent, name), logs = path.join(root, 'logs'), captures = path.join(root, 'captures');
      fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(logs, { mode: 0o700 }); fs.mkdirSync(captures, { mode: 0o700 });
      const marker = path.join(root, 'gate-marker');
      if (existing) fs.writeFileSync(path.join(logs, 'web-audit.log'), 'sentinel-evidence', { mode: 0o600 });
      const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, EVENTOUCH_CI_LOGS: logs, EVENTOUCH_CI_CAPTURES: captures, GATE_MARKER: marker, FAIL_GATE: failGate || '' };
      const invoke = () => spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { env, encoding: 'utf8' });
      return { logs, marker, invoke };
    };
    const occupied = run('occupied', true);
    assert.notEqual(occupied.invoke().status, 0);
    assert.equal(fs.readFileSync(path.join(occupied.logs, 'web-audit.log'), 'utf8'), 'sentinel-evidence');
    assert.equal(fs.existsSync(occupied.marker), false, 'existing evidence must prevent every gate-side effect');
    const linked = run('linked', false);
    const linkTarget = path.join(parent, 'must-not-be-created');
    fs.symlinkSync(linkTarget, path.join(linked.logs, 'web-audit.log'));
    assert.notEqual(linked.invoke().status, 0, 'a pre-existing dangling log link must fail closed');
    assert.equal(fs.existsSync(linkTarget), false);
    assert.equal(fs.existsSync(linked.marker), false, 'a log link must prevent every gate-side effect');
    const failed = run('failed', false, 'db:migrate');
    assert.equal(failed.invoke().status, 23, 'failing producer must remain a failure through tee');
    const log = path.join(failed.logs, 'db-migrate.log');
    assert.equal(fs.readFileSync(log, 'utf8'), 'synthetic db:migrate\n');
    assert.equal(fs.statSync(log).mode & 0o777, 0o600);
    const markerBefore = fs.readFileSync(failed.marker, 'utf8');
    assert.notEqual(failed.invoke().status, 0, 'a same-root retry must fail');
    assert.equal(fs.readFileSync(log, 'utf8'), 'synthetic db:migrate\n');
    assert.equal(fs.readFileSync(failed.marker, 'utf8'), markerBefore, 'retry must not start a gate');
    const success = run('success', false);
    assert.equal(success.invoke().status, 0);
    assert.deepEqual(fs.readFileSync(success.marker, 'utf8').trim().split('\n'), EXPECTED_GATES.map(gate => gate.replace('npm run ', '')));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
