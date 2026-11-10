'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assess, REQUIRED_OBSERVATIONS } = require('../scripts/release-preflight.cjs');
test('configuration alone cannot claim customer, device or delivery acceptance and never exposes secrets', () => {
  const env = { EVENTOUCH_PUBLIC_URL: 'https://events.example.test', COOKIE_SECURE: '1', SOLAPI_API_KEY: 'private-key-sentinel', SOLAPI_API_SECRET: 'secret-sentinel', SOLAPI_SENDER: '0212345678', SOLAPI_KAKAO_PFID: 'fixture-channel', EVENTOUCH_MAIL_TRANSPORT: 'smtp', EVENTOUCH_SMTP_HOST: 'smtp.example.test', EVENTOUCH_SMTP_FROM: 'account@example.test', EVENTOUCH_SMTP_USER: 'private-user', EVENTOUCH_SMTP_PASSWORD: 'private-password', EVENTOUCH_LOGIN_HISTORY_DAYS: '0' };
  const report = assess(env);
  assert.equal(report.ok, false);
  for (const id of REQUIRED_OBSERVATIONS) assert.equal(report.checks.find(c => c.id === id).status, 'pending');
  for (const secret of ['private-key-sentinel', 'secret-sentinel', 'private-user', 'private-password']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(assess({ ...env, EVENTOUCH_PUBLIC_URL: 'http://127.0.0.1:8777' }).checks.find(c => c.id === 'publicOrigin').status, 'pending');
  assert.equal(assess({ ...env, EVENTOUCH_MAIL_MOCK: '1' }).checks.find(c => c.id === 'mailConfiguration').status, 'pending');
});

test('release origin follows ticket link parsing and requires a public HTTPS address', () => {
  const originStatus = EVENTOUCH_PUBLIC_URL => assess({ EVENTOUCH_PUBLIC_URL }).checks.find(check => check.id === 'publicOrigin').status;
  assert.equal(originStatus(' https://events.example.test/eventouch/ '), 'ready');
  for (const url of [
    'https://events.example.test/?preview=1',
    'https://events.example.test/#preview',
    'https://name:password@events.example.test/',
    'http://events.example.test/',
    'https://127.0.0.1/',
    'https://localhost./',
    'https://console.localhost/',
    'https://[::1]/',
    'https://0.0.0.0/',
  ]) assert.equal(originStatus(url), 'pending', url);
});
