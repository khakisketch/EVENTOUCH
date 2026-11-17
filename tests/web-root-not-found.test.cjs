'use strict';

// An unknown address must not fall to the English framework 404.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the root has a Korean not-found page with a way back', () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/not-found.tsx'), 'utf8');
  assert.match(source, /페이지를 찾을 수 없습니다/u);
  assert.match(source, /href="\/"/u);
  assert.match(source, /id="main-content"/u, 'the skip link target exists');
});
