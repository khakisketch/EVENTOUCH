'use strict';

// An unexpected failure leaves one stderr line that names the request and the
// error class, and nothing a person typed. Business answers stay silent.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../server/server');
const { openStore } = require('../server/store');
const { buildHealthApp } = require('../server/fastify/health.ts');

const SECRET = 'private-person@example.test 010-1234-5678';
const boom = () => Object.assign(new TypeError(`failed for ${SECRET}`), { code: 'ECONNRESET', detail: SECRET, parameters: [SECRET] });

let mode = 'broken';
const answer = async () => {
  if (mode === 'broken') throw boom();
  if (mode === 'refused') throw Object.assign(new Error(SECRET), { status: 409 });
  return { rows: [], rowCount: 0 };
};
const database = { query: answer, transaction: async (fn) => (mode === 'empty' ? fn({ query: answer }) : answer()) };
const auth = {
  sessionFromCookie: async () => {
    if (mode === 'empty') return null;
    return answer();
  },
  handleAuth: answer,
};

const lines = [];
let server;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-error-log-'));
  server = createHttpServer(openStore(dir), auth, { authorize: answer }, database,
    { storageDir: path.join(dir, 'storage'), env: {}, logWriter: (line) => lines.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { connection: 'close', cookie: 'etko_session=private-cookie', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  await response.text();
  return response;
}

const cases = [
  ['GET', '/api/diagnostics', 500, '/api/diagnostics'],
  ['GET', '/api/readyz', 503, '/api/readyz'],
  ['GET', '/api/public/events/private-slug', 500, '/api/public/events/:slug'],
  ['GET', '/api/console/directory', 500, '/api/console/directory'],
  ['GET', '/api/events', 500, '/api/events'],
  ['POST', '/api/events/private-event/commands', 500, '/api/events/:eventId/commands', { command: 'participant.create', commandId: 'command-0001' }],
  ['POST', '/api/events/private-slug/signup', 500, '/api/events/:eventId/signup', { commandId: 'command-0002', name: SECRET }],
  ['GET', '/api/bootstrap', 500, '/api/bootstrap'],
  ['GET', '/api/events/private-event/desks/private-desk/arrivals', 500, '/api/events/:eventId/desks/:deskId/arrivals'],
  ['GET', '/api/command-receipts/private-command', 500, '/api/command-receipts/:commandId'],
  ['POST', '/api/public/events/private-slug/arrival', 500, '/api/public/events/:slug/:operation', { action: 'view', deskId: 'desk-1' }],
  ['POST', '/api/auth/login', 500, '/api/auth/login', { email: SECRET }],
];

for (const [method, url, status, route, body] of cases) {
  test(`one safe line for an unexpected failure on ${method} ${route}`, async () => {
    mode = 'broken';
    lines.length = 0;
    const response = await call(method, url, body);
    assert.equal(response.status, status);
    assert.equal(lines.length, 1, lines.join(''));
    assert.ok(lines[0].endsWith('\n') && lines[0].indexOf('\n') === lines[0].length - 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      type: 'error', requestId: response.headers.get('x-request-id'), route, name: 'TypeError', code: 'ECONNRESET',
    });
    assert.doesNotMatch(lines[0], /private|010-1234|failed for/);
  });
}

test('business answers are not logged', async () => {
  lines.length = 0;
  mode = 'empty';
  for (const url of ['/api/events', '/api/console/directory', '/api/bootstrap']) {
    assert.equal((await call('GET', url)).status, 401);
  }
  assert.equal((await call('GET', '/api/public/events/missing')).status, 404);
  mode = 'refused';
  // Readiness reports any failure as 503 and a rejected auth handler always as 500.
  for (const [method, url, , , body] of cases.filter(([, url]) => url !== '/api/readyz' && !url.startsWith('/api/auth/'))) {
    const response = await call(method, url, body);
    assert.ok(response.status < 500, `${url} ${response.status}`);
  }
  assert.deepEqual(lines, []);
});

test('an error that escapes a route handler is logged once without its message', async () => {
  const app = buildHealthApp({ getMessaging: () => { throw boom(); }, getVerificationMode: () => 'mock', countOutbox: null, includeDevLogin: false });
  const original = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try { await app.inject({ method: 'GET', url: '/api/health' }); }
  finally { process.stderr.write = original; }
  const errors = captured.filter((line) => line.includes('"type":"error"'));
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /private|010-1234|failed for/);
});
