'use strict';

// EVENTOUCH product server: static frontend + /api/*. Node built-ins only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store');
const { handleAuth, ensureSeed } = require('./auth');
const { handleApi } = require('./api');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8776);
const store = openStore(process.env.DATA_DIR || path.join(ROOT, 'data', 'server'));
ensureSeed(store);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function notFoundApi(res) {
  sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
}

const DENIED_PREFIXES = ['/server/', '/data/server/', '/data/storage/', '/.git/', '/node_modules/'];

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const lower = urlPath.toLowerCase();
  if (
    DENIED_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix)) ||
    /(^|\/)\.[^/]*$/.test(lower) ||
    lower.endsWith('.env')
  ) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('파일을 찾을 수 없습니다');
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('경로를 확인하세요');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('파일을 찾을 수 없습니다');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/api/health') {
    sendJson(res, 200, { ok: true, version: 1 });
    return;
  }
  if (urlPath === '/api/' || urlPath.startsWith('/api/')) {
    if (urlPath.startsWith('/api/auth/')) {
      handleAuth(req, res, store, urlPath).catch(() => {
        sendJson(res, 500, { error: '요청을 처리하지 못했습니다' });
      });
      return;
    }
    handleApi(req, res, store, urlPath).catch(() => {
      sendJson(res, 500, { error: '요청을 처리하지 못했습니다' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('지원하지 않는 방법입니다');
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  process.stdout.write(`eventouch server on ${PORT}\n`);
});
