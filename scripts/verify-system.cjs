'use strict';

// One reproducible verification run. It never targets the deployed web app:
// browser audits own their API, Next process and synthetic fixture schema.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = [
  'security:audit', 'build', 'test', 'web:console:audit', 'web:system:audit',
  'web:organizations:audit', 'web:organization-roles:audit', 'web:recovery:audit',
  'web:preparation:audit', 'web:signup-retry:audit', 'web:crossrole:audit', 'web:lifecycle:audit',
  'web:account-recovery:audit', 'web:close:audit', 'web:workbench:audit', 'web:roster-retry:audit', 'web:cards:audit',
  'web:import:audit', 'web:hanwool:audit', 'web:theme:audit', 'web:retirement:audit',
  'audit:usability', 'web:audit', 'a11y', 'mobile',
];

function verificationEnvironment(source, captureRoot) {
  const env = { ...source };
  const database = String(source.EVENTOUCH_TEST_DATABASE_URL || '');
  if (!database) throw new Error('EVENTOUCH_TEST_DATABASE_URL에 작업 전용 PostgreSQL URL을 지정하세요. 기존 운영 DB를 사용하지 마세요.');
  const url = new URL(database);
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];
  // node-postgres lets a query-string host override the URL hostname.
  // Reject every non-loopback override, including duplicate host parameters.
  const hosts = [url.hostname, ...url.searchParams.getAll('host')];
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || hosts.some(host => !loopback.includes(host.toLowerCase()))) {
    throw new Error('통합 검증은 loopback의 명시적 작업 전용 PostgreSQL에서만 실행합니다.');
  }
  if (!/(?:test|audit|improv|verify|_web|_mobile|_a11y)/i.test(url.pathname)) {
    throw new Error('DB 이름에서 작업 전용 여부를 확인할 수 없습니다. 별도 test/audit/improve DB를 사용하세요.');
  }
  // Do not inherit real senders, credentials, auto-send flags or owner seeds
  // into synthetic verification. Individual provider tests use local mocks.
  for (const key of Object.keys(env)) {
    if (/^(?:SOLAPI_|MESSAGING_|ADMIN_)/.test(key) || /^EVENTOUCH_(?:MESSAGE_|DEV_|PUBLIC_URL|SMS_MOCK|MAIL_MOCK)/.test(key)) delete env[key];
  }
  env.EVENTOUCH_TEST_DATABASE_URL = database;
  env.EVENTOUCH_A11Y_DATABASE_URL = database;
  env.EVENTOUCH_MOBILE_DATABASE_URL = database;
  env.EVENTOUCH_CAPTURE_ROOT = captureRoot;
  env.EVENTOUCH_SMS_MOCK = '1';
  // Test processes that consult these globals must not reuse a user's data
  // or storage directories, even if the API harness normally supplies its own.
  env.DATA_DIR = path.join(captureRoot, 'runtime', 'data');
  env.STORAGE_DIR = path.join(captureRoot, 'runtime', 'storage');
  env.TMPDIR = path.join(captureRoot, 'runtime', 'tmp');
  // Next loads its own .env files at build time. Pin the baked rewrite to an
  // unreachable loopback port so a deployment URL cannot leak in through
  // those files; each browser fixture binds SSR to its own API at runtime.
  env.EVENTOUCH_API_URL = 'http://127.0.0.1:0';
  env.NODE_ENV = 'production';
  delete env.DATABASE_URL;
  delete env.API_PORT;
  delete env.COOKIE_SECURE;
  delete env.WEB_BASE;
  delete env.ERROR_RECOVERY_PHASE;
  return env;
}

function stepEnvironment(base, script) {
  const env = { ...base, NODE_ENV: script === 'test' ? 'test' : 'production' };
  // Backend tests deliberately exercise both mock and unconfigured transport
  // modes. They opt into the mock themselves; inherited provider credentials
  // have already been removed by verificationEnvironment.
  if (script === 'test') delete env.EVENTOUCH_SMS_MOCK;
  return env;
}

function createCaptureRoot(captureRoot, { privateParent = false } = {}) {
  if (typeof process.getuid !== 'function') throw new Error('캡처 경로 소유자를 확인할 수 없습니다. POSIX 사용자 환경에서 실행하세요.');
  captureRoot = path.resolve(captureRoot);
  if (captureRoot === ROOT || captureRoot.startsWith(`${ROOT}${path.sep}`)) throw new Error('캡처는 저장소 밖의 안전한 디렉터리에 보관하세요.');
  // Never follow a link or rely on a parent another user can rename entries
  // in. A sticky, root-owned directory (normally /tmp) is safe for entries
  // owned by this user; arbitrary shared writable parents are not.
  const parent = path.dirname(captureRoot);
  const parts = parent.split(path.sep).filter(Boolean);
  let current = path.parse(parent).root;
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    const uid = process.getuid();
    const trustedOwner = stat.uid === uid || stat.uid === 0;
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !trustedOwner || ((stat.mode & 0o022) && !stickyRoot)) {
      throw new Error(`안전하지 않은 캡처 상위 경로: ${current}. 링크나 공유 쓰기 경로 대신 본인 소유의 비공개 상위 디렉터리 아래 새 EVENTOUCH_CAPTURE_ROOT를 지정하세요. 기존 증거 권한은 자동 변경하지 않습니다.`);
    }
    if (privateParent && current === parent && (stat.uid !== uid || (stat.mode & 0o077) !== 0 || (stat.mode & 0o300) !== 0o300)) {
      throw new Error(`비공개 캡처 기반 경로가 안전하지 않습니다: ${current}. 본인 소유이며 다른 사용자 접근이 없는 쓰기 가능한 디렉터리를 지정하세요. 기존 권한은 자동 변경하지 않습니다.`);
    }
  }
  try {
    // A fresh root prevents individual audit screenshots from overwriting
    // older evidence, even if that directory has no system report yet.
    fs.mkdirSync(captureRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('기존 검증 증거를 덮어쓰지 않습니다. 존재하지 않는 새 EVENTOUCH_CAPTURE_ROOT를 지정하세요.');
    throw error;
  }
}

function verifyBuildId(buildPath, expected) {
  let actual;
  try {
    actual = fs.readFileSync(buildPath, 'utf8').trim();
  } catch {
    throw new Error('검증에 필요한 Next 빌드 ID를 읽을 수 없습니다.');
  }
  if (!actual) throw new Error('검증에 필요한 Next 빌드 ID가 비어 있습니다.');
  if (expected && actual !== expected) throw new Error('검증 도중 Next 빌드가 변경되어 같은 빌드 결과로 기록할 수 없습니다.');
  return actual;
}

function createReportWriter(reportFile) {
  const fd = fs.openSync(reportFile, 'wx', 0o600);
  return {
    save(report) {
      const data = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      fs.ftruncateSync(fd, 0);
      let written = 0;
      while (written < data.length) {
        const count = fs.writeSync(fd, data, written, data.length - written, written);
        if (count === 0) throw new Error('검증 보고서를 기록하지 못했습니다.');
        written += count;
      }
    },
    close() { fs.closeSync(fd); },
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(SCRIPTS, null, 2)}\n`);
    return;
  }
  if (argv.length) throw new Error('사용법: npm run verify:system [-- --list]. DB와 캡처 경로는 환경변수로 지정하세요.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // A private per-user base under sticky /tmp avoids relying on the shared,
  // group-writable /tmp/opencode tree. It remains outside the repository.
  const defaultBase = path.join('/tmp', `eventouch-private-${process.getuid?.() ?? 'user'}`);
  const captureRoot = path.resolve(process.env.EVENTOUCH_CAPTURE_ROOT || path.join(defaultBase, `system-verification-${stamp}`));
  const env = verificationEnvironment(process.env, captureRoot);
  createCaptureRoot(captureRoot, { privateParent: !process.env.EVENTOUCH_CAPTURE_ROOT });
  // The test runner and browsers must not inherit a shared writable TMPDIR.
  // This is inside the newly-created private root and never reuses old data.
  fs.mkdirSync(path.join(captureRoot, 'runtime'), { mode: 0o700 });
  fs.mkdirSync(env.TMPDIR, { mode: 0o700 });
  const reportFile = path.join(captureRoot, 'system-verification.json');
  const buildPath = path.join(ROOT, 'apps/web/.next/BUILD_ID');
  const report = { startedAt: new Date().toISOString(), completedAt: null, ok: false, build: null, steps: [] };
  const writer = createReportWriter(reportFile);
  const save = () => writer.save(report);
  // Browser and audit subprocesses may write screenshots/PDFs directly. A
  // restrictive inherited umask keeps both those files and their nested dirs
  // private even when the invoking shell uses umask 000.
  const previousUmask = process.umask();
  process.umask(previousUmask | 0o077);
  try {
  save();
  for (const script of SCRIPTS) {
    const startedAt = new Date().toISOString();
    if (report.build) {
      try {
        verifyBuildId(buildPath, report.build);
      } catch (error) {
        report.steps.push({ script, startedAt, completedAt: new Date().toISOString(), code: null, signal: null, error: error.message, log: null });
        save();
        process.stderr.write(`[verify:system] 실패: ${script}. ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
    }
    const log = path.join(captureRoot, `${script.replace(/:/g, '-')}.log`);
    const output = fs.createWriteStream(log, { flags: 'wx', mode: 0o600 });
    process.stdout.write(`[verify:system] ${script}\n`);
    const result = await new Promise(resolve => {
      const child = spawn('npm', ['run', script], {
        cwd: ROOT, env: stepEnvironment(env, script),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => output.write(chunk));
      child.stderr.on('data', chunk => output.write(chunk));
      child.on('error', error => resolve({ code: null, signal: null, error: error.message }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    await new Promise(resolve => output.end(resolve));
    if (result.code === 0) {
      try {
        if (script === 'build') report.build = verifyBuildId(buildPath);
        else if (report.build) verifyBuildId(buildPath, report.build);
      } catch (error) {
        result.code = 1;
        result.error = error.message;
      }
    }
    report.steps.push({ script, startedAt, completedAt: new Date().toISOString(), ...result, log });
    save();
    if (result.code !== 0) {
      process.stderr.write(`[verify:system] 실패: ${script}. ${result.error ? `${result.error} ` : ''}원본 로그: ${log}\n`);
      process.exitCode = 1;
      return;
    }
  }
  report.ok = true;
  report.completedAt = new Date().toISOString();
  save();
  process.stdout.write(`[verify:system] 모든 단계 통과: ${reportFile}\n`);
  } finally {
    process.umask(previousUmask);
    writer.close();
  }
}

if (require.main === module) main().catch(error => { process.stderr.write(`[verify:system] ${error.message}\n`); process.exitCode = 1; });
module.exports = { SCRIPTS, verificationEnvironment, stepEnvironment, createCaptureRoot, createReportWriter, verifyBuildId, main };
