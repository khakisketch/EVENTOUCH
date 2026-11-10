'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findSmsTextIssue } = require('../apps/web/lib/sms-text-validation.cjs');

test('reports the UTF-16 offset of four-byte characters without changing the text', () => {
  for (const symbol of ['😀', '🎉', '𠀀']) {
    const text = `행사 ${symbol} 안내`;
    assert.deepEqual(findSmsTextIssue(text), { kind: 'supplementary', index: 3 });
    assert.equal(text, `행사 ${symbol} 안내`);
  }
  assert.deepEqual(findSmsTextIssue('🎉안내'), { kind: 'supplementary', index: 0 });
});

test('rejects non-printing C0/C1 controls but preserves LF and CRLF', () => {
  for (const character of ['\x00', '\t', '\x0b', '\x0c', '\r', '\x1b', '\x7f', '\x85', '\x9f']) {
    const text = `안내${character}본문`;
    assert.deepEqual(findSmsTextIssue(text), { kind: 'control', index: 2 });
    assert.equal(text, `안내${character}본문`);
  }
  assert.equal(findSmsTextIssue('첫 줄\n둘째 줄\r\n셋째 줄'), null);
});

test('keeps ordinary Korean and documented symbol examples without claiming EUC-KR coverage', () => {
  for (const text of ['', '파트너 행사 안내 123', '♥ ♡ ★ ☆', '✓ ✔ ☑ ⇨ © ™ ®', '{{이름}}님, 환영합니다.', '똠 힣']) {
    assert.equal(findSmsTextIssue(text), null, text);
  }
});

test('rejects malformed UTF-16 instead of sending a substituted replacement character', () => {
  assert.deepEqual(findSmsTextIssue('가\ud800나'), { kind: 'invalid_unicode', index: 1 });
  assert.deepEqual(findSmsTextIssue('가\udc00나'), { kind: 'invalid_unicode', index: 1 });
  assert.deepEqual(findSmsTextIssue('\ud800'), { kind: 'invalid_unicode', index: 0 });
});
