'use strict';

// Audit contract for scripts/web-account-recovery-audit.cjs: the recovery
// browser audit must stay a repeatable loopback fixture — shared isolated
// PostgreSQL, mock email only, no hardcoded project paths, credentials, or
// database URLs, no recursive evidence deletion, and a nonzero exit on any
// failed check.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readAudit() {
  return fs.readFileSync(path.join(ROOT, 'scripts', 'web-account-recovery-audit.cjs'), 'utf8');
}

test('account-recovery audit uses the shared loopback fixture and mock mail only', () => {
  const source = readAudit();
  assert.match(source, /require\(['"]\.\/audit-fixture\.cjs['"]\)/);
  assert.match(source, /startAuditFixture/);
  assert.match(source, /require\(['"]\.\/audit-browser\.cjs['"]\)/);
  assert.match(source, /launchBrowser/);
  // No provider, no real delivery: SOLAPI keys are stripped and the loopback
  // fake mail flag is forced before any harness starts.
  assert.match(source, /for \(const key of \['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID', 'SOLAPI_API_HOST'\]\) delete process\.env\[key\]/);
  assert.match(source, /process\.env\.EVENTOUCH_MAIL_MOCK = '1'/);
  // No hardcoded checkout, credentials, or database.
  assert.doesNotMatch(source, /\/home\/|\/Users\/|C:\\/);
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s'"]+/u);
  assert.doesNotMatch(source, /127\.0\.0\.1:\d{4,5}/, 'ports come from the fixture gateway, never literals');
  assert.doesNotMatch(source, /password\s*[:=]\s*['"][^'"]+['"]/i, 'no literal passwords');
  // Evidence is additive: the output directory is created, never wiped, and
  // captures honor an override root with a distinct account-recovery subdir.
  assert.match(source, /prepareCaptureDir\(OUT\)/, 'a fresh private output is required instead of reusing evidence');
  assert.doesNotMatch(source, /mkdirSync\(OUT, \{ recursive: true \}\)/);
  assert.doesNotMatch(source, /rmSync|rmdirSync/);
  assert.match(source, /process\.env\.EVENTOUCH_CAPTURE_ROOT/);
  assert.match(source, /'account-recovery'/);
  // Failures fail the process: every check asserts, the runner exits nonzero.
  assert.match(source, /assert\.ok\(ok, name\)/);
  assert.match(source, /process\.exitCode = 1/);
  assert.match(source, /if \(require\.main === module\)/);
  assert.match(source, /module\.exports = \{ runAccountRecoveryAudit/);
});

test('account-recovery audit keeps tokens and addresses out of its evidence', () => {
  const source = readAudit();
  // The only outbox reads extract the fragment bearer into memory; full
  // links, raw tokens, and account addresses never reach check output or
  // the saved verification.json.
  assert.match(source, /function tokenOf\(link\)/);
  assert.doesNotMatch(source, /check\([^;]*mockOutbox\[0\]/, 'no check carries raw outbox content');
  assert.ok(source.includes('masked address hides the local part'), 'masking is asserted without logging the address');
  // Saved verification entries carry names and pass/fail only.
  assert.match(source, /checks: checks\.map\(\(entry\) => \({ name: entry\.name, ok: entry\.ok }\)\)/);
});

test('account-recovery audit covers the honest and guarded rendered states', () => {
  const source = readAudit();
  for (const needle of [
    '모의 인증 요청을 기록했습니다',
    '복구 메일 요청을 접수했습니다',
    '현재 이메일 발송이 설정되지 않아',
    '요청을 접수하지 못했습니다',
    '인증 상태를 확인하지 못했습니다',
    '내 계정 페이지로 이동하면',
    '연결하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요.',
  ]) {
    assert.ok(source.includes(needle), `audit asserts rendered copy: ${needle}`);
  }
  for (const needle of ['loseFirstResponseFor', 'unroute', 'route.fulfill', 'getByText(/인증됨 ·/)', '#staff-ticket']) {
    assert.ok(source.includes(needle), `audit exercises the path: ${needle}`);
  }
});
