'use strict';

// EVENTOUCH product server: static frontend + /api/*. Node built-ins only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store');
const { createDatabase } = require('./db');
const { createDatabaseAuth } = require('./auth');
const { createAccess } = require('./access');
const { createState } = require('./state');
const { createPublicEvents } = require('./public-events');
const { createParticipantCommands } = require('./commands/participants');
const { createOperationsCommands } = require('./commands/operations');
const { createDomainCommands } = require('./commands/domain');
const { createFileService } = require('./files');
const { handleApi } = require('./api');
const { applySecurityHeaders, failureMessage } = require('./http');
const genericMessaging = require('./messaging');
const solapi = require('./messaging-solapi');
const { drainMessageOutbox } = require('./message-outbox');
const { createAttendeeAccess } = require('./attendees');
const { createVerificationTransport } = require('./verification-transport');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8776);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
const DENIED_FILES = new Set([
  '/dockerfile',
  '/docker-compose.yml',
  '/vercel.json',
  '/.env',
  '/.env.example',
  '/.dockerignore',
]);

// The CSP allows inline scripts only when they carry this response's nonce.
// index.html has exactly two inline bootstrap <script> blocks, so both are
// stamped; external <script src> files are already 'self' and need nothing.
function applyCspNonce(data, nonce) {
  return data
    .toString('utf8')
    .replace(/<script(?![^>]*\bsrc=)([^>]*)>/g, `<script nonce="${nonce}"$1>`);
}

function serveStatic(req, res, nonce) {
  const urlPath = req.url.split('?')[0];
  const lower = urlPath.toLowerCase();
  if (
    DENIED_FILES.has(lower) ||
    DENIED_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix)) ||
    /(^|\/)\.[^/]*$/.test(lower) ||
    lower.endsWith('.env')
  ) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('파일을 찾을 수 없습니다');
    return;
  }
  // The worker must live at the origin root to control every route, but it
  // is authored next to the other server files.
  if (urlPath === '/sw.js') {
    const worker = path.join(__dirname, 'sw.js');
    fs.readFile(worker, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('파일을 찾을 수 없습니다');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      });
      res.end(data);
    });
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
    res.writeHead(200, { 'content-type': type });
    // Only HTML carries the inline bootstrap scripts the CSP nonce protects;
    // CSS/JS/images are already covered by 'self'.
    res.end(type === 'text/html; charset=utf-8' ? applyCspNonce(data, nonce) : data);
  });
}

function createHttpServer(store, auth, access, database, { storageDir } = {}) {
  const state = database ? createState(database) : null;
  const publicEvents = database ? createPublicEvents(database) : null;
  const participantCommands = database ? createParticipantCommands(database) : null;
  const operationsCommands = database ? createOperationsCommands(database) : null;
  // Which provider is active is decided by what is configured. Solapi is the
  // production path; the generic provider stays for tests and for any vendor
  // reachable through a translation shim. Absent credentials leave every
  // campaign in its recorded, non-sending state.
  const messaging = genericMessaging.activeProvider();
  const messagingStatus = genericMessaging.activeMessagingState();
  const domainCommands = database ? createDomainCommands(database, { messaging }) : null;
  const files = database ? createFileService(database, { storageDir }) : null;
  // Attendee verification transport: Solapi when credentials exist, explicit
  // mock (EVENTOUCH_SMS_MOCK=1) for development/tests/demo, honest 503
  // otherwise. Verification codes are never returned to HTTP clients.
  const verificationTransport = createVerificationTransport();
  const attendeeAccess = database ? createAttendeeAccess(database, { transport: verificationTransport }) : null;
  // First Fastify increment: /api/health is served through the route
  // boundary (server/fastify/health.ts). Same shape, same headers — the
  // security wrapper above already ran, Fastify only fills the body.
  const { buildHealthApp } = require('./fastify/health.ts');
  const healthApp = buildHealthApp({
    getMessaging: () => ({
      connected: messagingStatus.connected,
      provider: messagingStatus.provider || null,
    }),
    getVerificationMode: () => verificationTransport.state().mode,
    countOutbox: database
      ? async () => {
          try {
            const result = await database.query(
              `SELECT COUNT(*)::int AS pending FROM message_outbox
               WHERE status IN ('PENDING', 'SENDING') AND next_attempt_at <= now()`
            );
            return result.rows[0].pending;
          } catch {
            return null;
          }
        }
      : null,
    includeDevLogin: Boolean(process.env.EVENTOUCH_DEV_QUICK_LOGIN),
  });
  const healthReady = healthApp.ready();
  // Second Fastify increment: public reads (server/fastify/public-reads.ts).
  // Only GET requests under /api/public delegate; verification codes and
  // guest photo uploads keep using the legacy router until their slice moves.
  const { buildPublicReadsApp } = require('./fastify/public-reads.ts');
  const publicReadsApp = buildPublicReadsApp({
    events: publicEvents,
    resolveSession: attendeeAccess ? (cookie) => attendeeAccess.resolveSession(cookie) : null,
    readPublicFile: files ? (input) => files.readPublic(input) : null,
    failureMessage,
  });
  const publicReadsReady = publicReadsApp.ready();
  return http.createServer((req, res) => {
    // One security-header wrapper per response. Every path below — static,
    // /api/*, /api/auth/*, 404, 405, 500 — therefore carries the same policy
    // without each call site having to remember it.
    const nonce = applySecurityHeaders(res);
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/health') {
      healthReady.then(
        () => healthApp.routing(req, res),
        () => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '상태를 확인할 수 없습니다' }));
        }
      );
      return;
    }
    if ((urlPath === '/api/public' || urlPath.startsWith('/api/public/')) && req.method === 'GET') {
      publicReadsReady.then(
        () => publicReadsApp.routing(req, res),
        () => sendJson(res, 500, { error: '요청을 처리하지 못했습니다' })
      );
      return;
    }
    if (urlPath === '/api/' || urlPath.startsWith('/api/')) {
      if (urlPath.startsWith('/api/auth/')) {
        auth.handleAuth(req, res, urlPath).catch(() => {
          sendJson(res, 500, { error: '요청을 처리하지 못했습니다' });
        });
        return;
      }
      handleApi(req, res, store, urlPath, {
        auth,
        access,
        state,
        publicEvents,
        participantCommands,
        operationsCommands,
        domainCommands,
        files,
        attendeeAccess,
        database,
      }).catch(() => {
        sendJson(res, 500, { error: '요청을 처리하지 못했습니다' });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('지원하지 않는 방법입니다');
      return;
    }
    serveStatic(req, res, nonce);
  });
}

async function startServer() {
  const database = createDatabase();
  try {
    await database.migrate();
    const auth = createDatabaseAuth(database);
    const access = createAccess(database);
    const seedStatus = await auth.seedAdmin();
    if (seedStatus === 'unconfigured') {
      process.stderr.write('[eventouch] administrator is not configured; login is disabled\n');
    }
    const store = openStore(process.env.DATA_DIR || path.join(ROOT, 'data', 'server'));
    const server = createHttpServer(store, auth, access, database);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, () => {
        server.removeListener('error', reject);
        process.stdout.write(`eventouch server on ${PORT}\n`);
        resolve();
      });
    });
    // Replay dispatch intents queued before a previous shutdown (crash
    // between commit and provider call). Fire-and-forget by design: a drain
    // failure must not take down boot, and leftovers are retried next boot.
    drainMessageOutbox(database, genericMessaging.activeProvider()).then(
      (result) => {
        if (result && (result.dispatched || result.settled)) {
          process.stdout.write(
            `[eventouch] outbox drain: dispatched=${result.dispatched} settled=${result.settled}\n`
          );
        }
      },
      (error) => {
        process.stderr.write('[eventouch] outbox drain failed: ' + (error && error.message) + '\n');
      }
    );
    return { server, database };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    const code = error && error.code ? ` (${error.code})` : '';
    process.stderr.write(`[eventouch] startup failed${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = { startServer, createHttpServer };
