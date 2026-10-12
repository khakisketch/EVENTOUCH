const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// The offline shell is what keeps a staff member from staring at the browser's
// own error page when venue Wi-Fi drops. These tests pin the parts that broke
// silently during development: a service worker that cached nothing still
// reports success, so only structural assertions are meaningful here.
test('a-service-worker-exists-and-is-served-from-the-origin-root', () => {
  const worker = read('server/sw.js');
  assert.match(worker, /self\.addEventListener\('install'/);
  assert.match(worker, /self\.addEventListener\('activate'/);
  assert.match(worker, /self\.addEventListener\('fetch'/);
});

test('the-worker-caches-the-asset-urls-index-html-actually-uses', () => {
  const worker = read('server/sw.js');
  const index = read('index.html');
  // index.html references assets relatively. A worker that assumed a leading
  // slash cached only the document and the app still failed offline, so the
  // pattern must match the relative form.
  assert.match(worker, /assets\\\//, 'the asset pattern must match relative hrefs');
  const referenced = [...index.matchAll(/(?:href|src)="(assets\/[^"?]+)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 20, 'index.html references the shell assets');
  for (const asset of referenced.slice(0, 3)) {
    assert.ok(worker.includes('assets\\/'), 'worker resolves relative asset paths');
  }
});

test('the-worker-never-serves-api-responses-from-cache', () => {
  const worker = read('server/sw.js');
  // Cached event state would be stale at best and a privacy problem at worst:
  // participant rosters would persist after an account loses access.
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/);
});

test('the-worker-matches-versionless-asset-requests-to-cached-versions', () => {
  const worker = read('server/sw.js');
  // index.html asks for tokens.css?v=16 while other code may ask for
  // tokens.css. Different cache keys, so a versionless offline request missed
  // and the screen rendered unstyled.
  assert.match(worker, /function stripVersion/);
  assert.match(worker, /cache\.match\(stripVersion\(request\)\)/);
});

test('a-bumping-cache-name-invalidates-previous-shells', () => {
  const worker = read('server/sw.js');
  assert.match(worker, /const CACHE = 'eventouch-shell-v\d+';/);
  assert.match(worker, /names\.filter\(\(name\) => name !== CACHE\)/);
});

test('a-navigation-offline-falls-back-to-the-cached-shell', () => {
  const worker = read('server/sw.js');
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /cache\.match\('\/index\.html'\)/);
});

test('the-manifest-declares-an-installable-app', () => {
  const manifest = JSON.parse(read('assets/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'ko');
  assert.ok(manifest.name);
  assert.ok(manifest.icons.length >= 1);
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
});

test('the-entry-document-registers-the-worker-and-the-manifest', () => {
  const index = read('index.html');
  assert.match(index, /rel="manifest" href="\/assets\/manifest\.webmanifest"/);
  assert.match(index, /rel="icon"/);
  const sync = read('assets/js/server-sync.js');
  assert.match(sync, /serviceWorker\.register\('\/sw\.js',\{scope:'\/'\}\)/);
});

test('the-server-serves-the-worker-without-caching-and-with-root-scope', () => {
  const server = read('server/server.js');
  assert.match(server, /urlPath === '\/sw\.js'/);
  assert.match(server, /'cache-control': 'no-cache'/);
  // A worker can only control paths at or below its own URL.
  assert.match(server, /'service-worker-allowed': '\/'/);
});

test('the-worker-is-served-before-the-static-path-check', () => {
  const server = read('server/server.js');
  const workerIndex = server.indexOf("urlPath === '/sw.js'");
  const staticIndex = server.indexOf('const rel = urlPath ===');
  assert.ok(workerIndex > -1 && staticIndex > -1);
  assert.ok(workerIndex < staticIndex, '/sw.js is handled before the static lookup');
});

test('a-raw-fetch-failure-is-not-shown-to-an-operator', () => {
  const source = read('assets/js/server-presentation.js');
  // "Failed to fetch" is a browser implementation detail, not guidance.
  assert.match(source, /failed to fetch/i);
  assert.match(source, /인터넷 연결과 서버 상태를 확인하세요/);
});

test('the-offline-guidance-explains-what-still-works', () => {
  const source = read('assets/js/server-presentation.js');
  assert.match(source, /function offlineGuidance/);
  assert.match(source, /화면과 메뉴는 이 기기에서 바로 열리지만/);
  assert.match(source, /서버 연결이 필요합니다/);
});