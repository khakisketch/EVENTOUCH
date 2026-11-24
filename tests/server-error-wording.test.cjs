'use strict';

// Reopened 2026-11-24 (audit S5): the most common server failures reach the screen
// verbatim, so they must not speak in developer terms. The 409 receipt-reuse
// and 400 command-id messages are single sentences with a next step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(js|ts|cjs|mjs)$/u.test(entry.name) ? [full] : [];
  });
}

test('server messages shown to people avoid request-identifier and system-administrator wording', () => {
  const offenders = [];
  for (const file of sources(path.join(__dirname, '..', 'server'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const term of ['요청 식별자', '요청 ID', '시스템 관리자']) {
      if (text.includes(term)) offenders.push(`${path.relative(path.join(__dirname, '..'), file)}: ${term}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the receipt reuse conflict tells the operator what to do next', () => {
  const text = sources(path.join(__dirname, '..', 'server')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(text, /같은 작업이 이미 다른 내용으로 처리되었습니다\. 화면을 새로 고쳐 결과를 확인하세요/u);
  assert.match(text, /요청을 확인하지 못했습니다\. 화면을 새로 고친 뒤 다시 시도하세요/u);
});
