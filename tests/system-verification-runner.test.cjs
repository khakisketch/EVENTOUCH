'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SCRIPTS, verificationEnvironment, stepEnvironment, createCaptureRoot, createReportWriter, verifyBuildId } = require('../scripts/verify-system.cjs');

test('integrated verification builds first and preserves all serial product gates', () => {
  const build = SCRIPTS.indexOf('build');
  assert.ok(build >= 0 && SCRIPTS.indexOf('test') > build, 'build must run before the test suite');
  assert.equal(new Set(SCRIPTS).size, SCRIPTS.length, 'verification must not run a gate twice');
  const { scripts } = require('../package.json');
  for (const command of SCRIPTS) assert.equal(typeof scripts[command], 'string', `${command} must name a real npm script`);
  for (const command of ['web:console:audit', 'web:system:audit', 'web:organizations:audit', 'web:organization-roles:audit', 'web:recovery:audit', 'web:preparation:audit', 'web:close:audit', 'web:workbench:audit', 'web:roster-retry:audit', 'web:cards:audit', 'a11y', 'mobile', 'audit:usability']) {
    assert.ok(SCRIPTS.includes(command));
  }
  assert.ok(!SCRIPTS.includes('test:raw'));
});

test('integrated verification includes all signup, role, lifecycle and account-recovery journeys after the build', () => {
  const { scripts } = require('../package.json');
  for (const command of ['web:signup-retry:audit', 'web:crossrole:audit', 'web:lifecycle:audit', 'web:account-recovery:audit']) {
    assert.equal(SCRIPTS.filter((entry) => entry === command).length, 1, `${command} must run exactly once`);
    assert.ok(SCRIPTS.indexOf(command) > SCRIPTS.indexOf('build'), `${command} must use the freshly built app`);
    assert.equal(typeof scripts[command], 'string', `${command} must name a real npm script`);
  }
});

test('integrated verification also runs the web audits wired into CI', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
  const audits = [...workflow.matchAll(/^\s*npm run (web:[a-z0-9:-]*audit)\b/gm)].map((match) => match[1]);
  assert.ok(audits.length > 0, 'the CI web audits must be discoverable');
  for (const command of audits) {
    assert.ok(SCRIPTS.includes(command), `${command} is wired into CI but missing from integrated verification`);
    assert.ok(SCRIPTS.indexOf(command) > SCRIPTS.indexOf('build'), `${command} must follow the build`);
  }
});

test('CI includes the lifecycle journey and does not run an unowned Next server', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
  const webJob = workflow.slice(workflow.indexOf('\n  web:\n'));
  assert.match(webJob, /npm run web:lifecycle:audit\b/);
  assert.doesNotMatch(webJob, /WEB_BASE:|127\.0\.0\.1:8777|PORT=8777/);
  assert.match(webJob, /mkdir -p[^\n]*\/tmp\/opencode/, 'CI creates the audit harness temporary directory');
});

test('CI installs Chromium before the browser-backed tests in the serial suite', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
  const testJob = workflow.slice(workflow.indexOf('\n  test:\n'), workflow.indexOf('\n  security:\n'));
  const install = testJob.indexOf('npx playwright install --with-deps chromium');
  const suite = testJob.indexOf('run: npm test');
  assert.ok(install >= 0 && suite > install, 'the test job must install Chromium before npm test');
});

test('cross-role and lifecycle audits keep their evidence in separate directories', () => {
  const crossrole = fs.readFileSync(path.join(__dirname, '..', 'scripts/web-crossrole-journey-audit.cjs'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(__dirname, '..', 'scripts/web-lifecycle-ui-audit.cjs'), 'utf8');
  const crossroleDir = crossrole.match(/const OUT = path\.join\(captureRoot, '([^']+)'\)/);
  const lifecycleDir = lifecycle.match(/const OUT = path\.join\(captureRoot, '([^']+)'\)/);
  assert.ok(crossroleDir && lifecycleDir, 'each journey must namespace its captures under the shared root');
  assert.notEqual(crossroleDir[1], lifecycleDir[1]);
});

test('verification refuses to reuse a capture directory even without a previous report', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-verification-test-'));
  try {
    const fresh = path.join(parent, 'fresh');
    createCaptureRoot(fresh);
    fs.writeFileSync(path.join(fresh, 'existing-capture.txt'), 'preserve');
    assert.throws(() => createCaptureRoot(fresh), /기존 검증 증거/);
    assert.equal(fs.readFileSync(path.join(fresh, 'existing-capture.txt'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('capture root remains private under permissive umask and rejects unsafe parents and links', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-private-test-'));
  const old = process.umask(0);
  try {
    const fresh = path.join(parent, 'private', 'run');
    createCaptureRoot(fresh);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700);
    const shared = path.join(parent, 'shared');
    fs.mkdirSync(shared, { mode: 0o775 });
    assert.throws(() => createCaptureRoot(path.join(shared, 'run')), /안전하지 않은 캡처 상위 경로/);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o775);
    const link = path.join(parent, 'link');
    fs.symlinkSync(path.dirname(fresh), link);
    assert.throws(() => createCaptureRoot(path.join(link, 'run2')), /안전하지 않은 캡처 상위 경로/);
    const finalLink = path.join(parent, 'final-link');
    fs.symlinkSync(fresh, finalLink);
    assert.throws(() => createCaptureRoot(finalLink), /기존 검증 증거/);
    assert.equal(fs.lstatSync(finalLink).isSymbolicLink(), true);
    const publicBase = path.join(parent, 'public-base');
    fs.mkdirSync(publicBase, { mode: 0o755 });
    assert.throws(() => createCaptureRoot(path.join(publicBase, 'run'), { privateParent: true }), /비공개 캡처 기반/);
    assert.equal(fs.statSync(publicBase).mode & 0o777, 0o755);
    createCaptureRoot(path.join(path.dirname(fresh), 'run2'), { privateParent: true });
    // os.tmpdir() can be the current user's private per-run TMPDIR. Exercise
    // the unowned-parent branch against the actual root-owned sticky /tmp
    // instead, without creating or changing anything there.
    const systemTmp = '/tmp';
    const tmpStat = fs.lstatSync(systemTmp);
    if (process.getuid?.() !== 0 && tmpStat.isDirectory() && tmpStat.uid === 0 && (tmpStat.mode & 0o1000)) {
      assert.throws(() => createCaptureRoot(path.join(systemTmp, `eventouch-unowned-${process.pid}`), { privateParent: true }), /비공개 캡처 기반/);
    }
    assert.throws(() => createCaptureRoot(path.join(__dirname, 'not-a-capture')), /저장소 밖/);
  } finally {
    process.umask(old);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('failed verification writes private report and log even with permissive umask', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-runner-test-'));
  try {
    const bin = path.join(parent, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n/bin/mkdir "$EVENTOUCH_CAPTURE_ROOT/nested"\necho synthetic > "$EVENTOUCH_CAPTURE_ROOT/nested/capture.png"\necho synthetic-failure\nexit 1\n', { mode: 0o700 });
    const out = path.join(parent, 'run');
    const script = path.join(__dirname, '..', 'scripts', 'verify-system.cjs');
    const run = spawnSync('/bin/sh', ['-c', 'umask 000; exec "$1" "$2"', 'test', process.execPath, script], {
      env: { ...process.env, PATH: bin, EVENTOUCH_CAPTURE_ROOT: out, EVENTOUCH_TEST_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/eventouch_test' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(out, 'system-verification.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(out, 'security-audit.log')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(out, 'nested')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(out, 'nested/capture.png')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(out, 'runtime/tmp')).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(path.join(out, 'security-audit.log'), 'utf8'), /synthetic-failure/);
    const restored = spawnSync(process.execPath, ['-e', `process.umask(0); require(process.argv[1]).main([]).then(() => console.log('restored=' + process.umask().toString(8)));`, script], {
      env: { ...process.env, PATH: bin, EVENTOUCH_CAPTURE_ROOT: path.join(parent, 'run-restored'), EVENTOUCH_TEST_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/eventouch_test' },
      encoding: 'utf8',
    });
    assert.equal(restored.status, 1, restored.stderr);
    assert.match(restored.stdout, /restored=0/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('CI creates fresh private audit logs before invoking its tee pipelines', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const createAt = ci.indexOf('name: Create fresh private evidence root');
  const start = ci.indexOf('name: Run the browser audits serially');
  const finish = ci.indexOf('name: Upload audit logs', start);
  assert.ok(createAt >= 0 && start > createAt && finish > start);
  const create = ci.slice(createAt, start);
  assert.match(create, /mktemp -d/, 'each run must mint a fresh evidence root');
  assert.match(create, /umask 077/);
  assert.match(create, /mkdir -m 700/);
  assert.match(create, /GITHUB_ENV/, 'exact paths must be conveyed to later steps');
  const audit = ci.slice(start, finish);
  assert.match(audit, /EVENTOUCH_CAPTURE_ROOT:\s*\$\{\{\s*env\.EVENTOUCH_CI_CAPTURES\s*\}\}/);
  assert.ok(audit.indexOf('umask 077') >= 0 && audit.indexOf('umask 077') < audit.indexOf('tee "$EVENTOUCH_CI_LOGS/'));
  assert.doesNotMatch(audit, /\/tmp\/eventouch-ci-logs/);
  assert.doesNotMatch(audit, /\/tmp\/eventouch-ci-captures/);
});

test('competing verification roots have one winner and preserve its evidence', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-race-test-'));
  try {
    const root = path.join(parent, 'run');
    const modulePath = path.join(__dirname, '..', 'scripts', 'verify-system.cjs');
    const code = `const fs=require('node:fs'); const {createCaptureRoot}=require(process.argv[1]); try { createCaptureRoot(process.argv[2]); fs.writeFileSync(process.argv[2]+'/winner', 'preserve', {flag:'wx',mode:0o600}); } catch (e) { process.exitCode=1; }`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code, modulePath, root], { stdio: 'ignore' });
      child.on('error', reject); child.on('close', resolve);
    });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.sort(), [0, 1]);
    assert.equal(fs.readFileSync(path.join(root, 'winner'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('report creation is exclusive and later saves do not follow replacement links', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-report-test-'));
  try {
    const target = path.join(parent, 'target');
    const report = path.join(parent, 'report');
    fs.writeFileSync(target, 'preserve');
    fs.symlinkSync(target, report);
    assert.throws(() => createReportWriter(report), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
    fs.unlinkSync(report);
    const writer = createReportWriter(report);
    try {
      writer.save({ first: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), { first: true });
      writer.save({ ok: 1 });
      assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), { ok: 1 });
      fs.unlinkSync(report);
      fs.symlinkSync(target, report);
      writer.save({ second: true });
    } finally { writer.close(); }
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('capture owner validation fails closed if POSIX ownership is unavailable', () => {
  const oldGetuid = process.getuid;
  try {
    process.getuid = undefined;
    assert.throws(() => createCaptureRoot(path.join(os.tmpdir(), 'must-not-create')), /소유자를 확인할 수 없습니다/);
  } finally { process.getuid = oldGetuid; }
});

test('verification refuses to report one build when the build changes or vanishes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-build-id-test-'));
  try {
    const file = path.join(parent, 'BUILD_ID');
    fs.writeFileSync(file, 'first-build\n');
    assert.equal(verifyBuildId(file), 'first-build');
    assert.equal(verifyBuildId(file, 'first-build'), 'first-build');
    fs.writeFileSync(file, 'second-build\n');
    assert.throws(() => verifyBuildId(file, 'first-build'), /빌드가 변경/);
    fs.unlinkSync(file);
    assert.throws(() => verifyBuildId(file, 'first-build'), /빌드 ID/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('the full test suite can exercise no-provider behavior while browser audits stay mocked', () => {
  const base = verificationEnvironment({
    EVENTOUCH_TEST_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/eventouch_test',
    SOLAPI_API_KEY: 'do-not-inherit', SOLAPI_API_SECRET: 'do-not-inherit', SOLAPI_SENDER: 'do-not-inherit',
  }, '/tmp/opencode/synthetic');
  const tests = stepEnvironment(base, 'test');
  assert.equal(tests.NODE_ENV, 'test');
  assert.equal(tests.EVENTOUCH_SMS_MOCK, undefined, 'individual tests choose mock or no-provider mode');
  assert.equal(tests.SOLAPI_API_KEY, undefined);
  assert.equal(tests.SOLAPI_API_SECRET, undefined);
  assert.equal(tests.SOLAPI_SENDER, undefined);
  const browser = stepEnvironment(base, 'web:lifecycle:audit');
  assert.equal(browser.NODE_ENV, 'production');
  assert.equal(browser.EVENTOUCH_SMS_MOCK, '1');
  assert.equal(base.EVENTOUCH_SMS_MOCK, '1', 'test preparation must not mutate the browser environment');
});

test('verification cannot silently fall back to a deployment database or sender', () => {
  assert.throws(() => verificationEnvironment({}, '/tmp/opencode/synthetic'), /작업 전용/);
  assert.throws(() => verificationEnvironment({ EVENTOUCH_TEST_DATABASE_URL: 'postgres://x:x@external.example.test/eventouch_test' }, '/tmp/opencode/synthetic'), /loopback/);
  assert.throws(() => verificationEnvironment({ EVENTOUCH_TEST_DATABASE_URL: 'postgres://x:x@127.0.0.1/eventouch_test?host=external.example.test' }, '/tmp/opencode/synthetic'), /loopback/);
  assert.throws(() => verificationEnvironment({ EVENTOUCH_TEST_DATABASE_URL: 'postgres://x:x@127.0.0.1/eventouch_test?host=127.0.0.1&host=external.example.test' }, '/tmp/opencode/synthetic'), /loopback/);
  assert.throws(() => verificationEnvironment({ EVENTOUCH_TEST_DATABASE_URL: 'postgres://x:x@127.0.0.1/eventouch' }, '/tmp/opencode/synthetic'), /DB 이름/);
  const env = verificationEnvironment({
    EVENTOUCH_TEST_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/eventouch_test',
    DATABASE_URL: 'protected', SOLAPI_API_KEY: 'do-not-inherit', SOLAPI_API_HOST: 'https://provider.example.test', ADMIN_PASSWORD: 'do-not-inherit',
    EVENTOUCH_PUBLIC_URL: 'https://public.example.test', EVENTOUCH_MESSAGE_MAINTENANCE: '1', EVENTOUCH_MAIL_MOCK: '1',
    EVENTOUCH_API_URL: 'https://production.example.test', API_PORT: '9999',
    DATA_DIR: '/protected/data', STORAGE_DIR: '/protected/storage', TMPDIR: '/tmp/opencode', COOKIE_SECURE: '1',
    EVENTOUCH_MESSAGE_AUTO_SEND_DUE: '1', EVENTOUCH_DEV_QUICK_LOGIN: 'do-not-inherit', WEB_BASE: 'protected', ERROR_RECOVERY_PHASE: 'baseline',
  }, '/tmp/opencode/synthetic');
  assert.equal(env.SOLAPI_API_KEY, undefined);
  assert.equal(env.SOLAPI_API_HOST, undefined);
  assert.equal(env.EVENTOUCH_PUBLIC_URL, undefined);
  // Next may load .env.production during a build; a fixed unreachable
  // loopback target must take precedence over any deployment rewrite.
  assert.equal(env.EVENTOUCH_API_URL, 'http://127.0.0.1:0');
  assert.equal(env.API_PORT, undefined);
  assert.equal(env.COOKIE_SECURE, undefined);
  assert.equal(env.DATA_DIR, '/tmp/opencode/synthetic/runtime/data');
  assert.equal(env.STORAGE_DIR, '/tmp/opencode/synthetic/runtime/storage');
  assert.equal(env.TMPDIR, '/tmp/opencode/synthetic/runtime/tmp');
  assert.equal(env.EVENTOUCH_MAIL_MOCK, undefined);
  assert.equal(env.EVENTOUCH_MESSAGE_MAINTENANCE, undefined);
  assert.equal(env.ADMIN_PASSWORD, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.WEB_BASE, undefined);
  assert.equal(env.ERROR_RECOVERY_PHASE, undefined);
  assert.equal(env.EVENTOUCH_MESSAGE_AUTO_SEND_DUE, undefined);
  assert.equal(env.EVENTOUCH_SMS_MOCK, '1');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.EVENTOUCH_A11Y_DATABASE_URL, env.EVENTOUCH_TEST_DATABASE_URL);
});
