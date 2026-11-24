'use strict';

// /account/password: the holder's own password change. Source contract only;
// the server rules (throttle, receipts, session revocation) are covered by
// tests/server-account-password-change.test.cjs against PostgreSQL.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../apps/web/app/account/password');
const page = fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8');
const form = fs.readFileSync(path.join(dir, 'PasswordChange.tsx'), 'utf8');

test('the page opts into the shared account frame', () => {
  assert.match(page, /styles\.entry/u);
  assert.match(page, /비밀번호 변경/u);
});

test('the form asks for current, new and confirmation and posts one idempotent command', () => {
  for (const label of ['현재 비밀번호', '새 비밀번호', '새 비밀번호 확인']) assert.ok(form.includes(label), label);
  assert.match(form, /autoComplete="current-password"/u);
  assert.equal((form.match(/autoComplete="new-password"/gu) || []).length, 2);
  assert.match(form, /fetch\("\/api\/auth\/password"/u);
  assert.match(form, /commandId: commandRef\.current/u);
  assert.match(form, /minLength=\{MIN\}/u);
  assert.match(form, /const MIN = 8;/u);
  assert.match(form, /const MAX = 200;/u);
});

test('passwords never leave component state', () => {
  assert.doesNotMatch(form, /localStorage|sessionStorage|indexedDB|document\.cookie|console\./u);
  assert.doesNotMatch(form, /searchParams|location\.(?:search|hash)/u);
});

test('an unknown result is retried with the same command and a server refusal starts a new one', () => {
  assert.match(form, /같은 입력으로 다시 시도/u);
  assert.match(form, /commandRef\.current = ""/u);
});

test('the success message states that other logins end', () => {
  assert.match(form, /다른 로그인/u);
});
