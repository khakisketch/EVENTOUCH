'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertBuiltApiTarget } = require('../scripts/built-api-target.cjs');

test('product start refuses absent or mismatched baked API destinations before starting children', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-build-target-'));
  try {
    assert.throws(() => assertBuiltApiTarget(directory, 'http://127.0.0.1:8776'), /먼저 npm run build/);
    fs.mkdirSync(path.join(directory, '.next'));
    for (const rewrites of [
      [{ source: '/api/:path*', destination: 'http://127.0.0.1:8776/api/:path*' }],
      { beforeFiles: [], afterFiles: [{ source: '/api/:path*', destination: 'http://127.0.0.1:8776/api/:path*' }], fallback: [] },
    ]) {
      fs.writeFileSync(path.join(directory, '.next/routes-manifest.json'), JSON.stringify({ rewrites }));
      assert.doesNotThrow(() => assertBuiltApiTarget(directory, 'http://127.0.0.1:8776/'));
      assert.throws(() => assertBuiltApiTarget(directory, 'http://127.0.0.1:8796'), /API 주소가 실행 설정과 다릅니다/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
