'use strict';
const fs = require('node:fs');
const path = require('node:path');

function assertBuiltApiTarget(appDirectory, expectedBase) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(appDirectory, '.next/routes-manifest.json'), 'utf8')); }
  catch { throw new Error('새 앱 빌드를 찾을 수 없습니다. 먼저 npm run build를 실행하세요.'); }
  const value = manifest.rewrites;
  const rewrites = Array.isArray(value) ? value : ['beforeFiles', 'afterFiles', 'fallback'].flatMap((key) => Array.isArray(value?.[key]) ? value[key] : []);
  const configured = rewrites.find((rewrite) => rewrite.source === '/api/:path*')?.destination;
  const expected = `${String(expectedBase).replace(/\/+$/, '')}/api/:path*`;
  if (configured !== expected) {
    throw new Error('새 앱 빌드의 API 주소가 실행 설정과 다릅니다. 같은 EVENTOUCH_API_URL 또는 API_PORT로 npm run build를 다시 실행하세요.');
  }
}
module.exports = { assertBuiltApiTarget };
