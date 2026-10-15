'use strict';

// Fastify route boundary contracts: the health route and the public reads
// answer through the boundary with the exact historical shapes, whatever the
// dependencies do. Production wiring is covered by the end-to-end server
// suites (public event, ticket, attendee session, files, evidence photos);
// these pin the boundary itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildHealthApp } = require('../server/fastify/health.ts');
const { buildPublicReadsApp } = require('../server/fastify/public-reads.ts');

function deps(overrides = {}) {
  return {
    getMessaging: () => ({ connected: false, provider: null }),
    getVerificationMode: () => 'mock',
    countOutbox: null,
    includeDevLogin: false,
    ...overrides,
  };
}

async function get(app, url) {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, json: response.json(), headers: response.headers };
}

test('health answers the historical shape without a database', async () => {
  const app = buildHealthApp(deps());
  const { status, json } = await get(app, '/api/health');
  assert.equal(status, 200);
  assert.deepEqual(json, {
    ok: true,
    version: 1,
    messaging: false,
    messagingProvider: null,
    verification: 'mock',
  });
});

test('connected messaging, sender state, and queue depth ride along', async () => {
  const app = buildHealthApp(deps({
    getMessaging: () => ({ connected: true, provider: 'solapi' }),
    getVerificationMode: () => 'solapi',
    countOutbox: async () => 3,
    includeDevLogin: true,
  }));
  const { status, json } = await get(app, '/api/health');
  assert.equal(status, 200);
  assert.equal(json.messaging, true);
  assert.equal(json.messagingProvider, 'solapi');
  assert.equal(json.verification, 'solapi');
  assert.equal(json.outboxPending, 3);
  assert.equal(json.devQuickLogin, true);
});

test('a failing queue count omits the field instead of failing health', async () => {
  const app = buildHealthApp(deps({
    countOutbox: async () => { throw new Error('db down'); },
  }));
  const { status, json } = await get(app, '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(Object.hasOwn(json, 'outboxPending'), false);
});

test('unknown paths stay unknown inside the boundary', async () => {
  const app = buildHealthApp(deps());
  const { status } = await get(app, '/api/nope');
  assert.equal(status, 404);
});

// ---- public reads (server/fastify/public-reads.ts) ----

function publicDeps(overrides = {}) {
  return {
    events: {
      loadPublicEvent: async (slug) => (slug === 'live' ? { event: { slug }, workspace: {} } : null),
      loadTicket: async (slug, token) => (
        token === 'good-token' ? { event: { slug }, workspace: {}, participant: { id: 'p1' } } : null
      ),
      loadSessionTicket: async () => null,
    },
    resolveSession: null,
    readPublicFile: null,
    failureMessage: (error, fallback) => (error && error.status && error.message ? error.message : fallback),
    ...overrides,
  };
}

async function fetched(app, url, options = {}) {
  const response = await app.inject({ method: 'GET', url, ...options });
  let json = null;
  try {
    json = response.json();
  } catch {
    json = null;
  }
  return { status: response.statusCode, json, headers: response.headers, body: response.body };
}

test('public reads answer the historical shapes through the boundary', async () => {
  const app = buildPublicReadsApp(publicDeps());

  const live = await fetched(app, '/api/public/events/live');
  assert.equal(live.status, 200);
  assert.deepEqual(live.json, { event: { slug: 'live' }, workspace: {} });
  assert.equal(live.headers['cache-control'], 'no-store');
  assert.match(String(live.headers['content-type']), /application\/json/);

  const draft = await fetched(app, '/api/public/events/draft');
  assert.equal(draft.status, 404);
  assert.deepEqual(draft.json, { error: '요청한 행사를 찾을 수 없습니다' });

  const unknown = await fetched(app, '/api/public/anything');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: '요청한 API를 찾을 수 없습니다' });

  const extra = await fetched(app, '/api/public/events/live/extra');
  assert.equal(extra.status, 404);
  assert.deepEqual(extra.json, { error: '요청한 API를 찾을 수 없습니다' });

  const root = await fetched(app, '/api/public');
  assert.equal(root.status, 404);
  assert.deepEqual(root.json, { error: '요청한 API를 찾을 수 없습니다' });
  assert.equal(root.headers['cache-control'], 'no-store');
});

test('tickets prefer the bearer and then the same-browser session', async () => {
  const calls = [];
  const deps = publicDeps({
    resolveSession: async (cookie) => {
      calls.push(['session', cookie]);
      return cookie ? { grants: [{ eventId: 'e1', participantId: 'p2' }] } : null;
    },
  });
  deps.events.loadTicket = async (slug, token) => {
    calls.push(['bearer', slug, token]);
    return token === 'good-token' ? { event: { slug }, workspace: {}, participant: { id: 'p1' } } : null;
  };
  deps.events.loadSessionTicket = async (slug, grants) => {
    calls.push(['grant', slug, grants]);
    return { event: { slug }, workspace: {}, participant: { id: 'p2' } };
  };
  const app = buildPublicReadsApp(deps);

  const bearer = await fetched(app, '/api/public/events/live/ticket', { headers: { authorization: 'Bearer good-token' } });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.json.participant.id, 'p1');
  assert.deepEqual(calls, [['bearer', 'live', 'good-token']]);

  calls.length = 0;
  const session = await fetched(app, '/api/public/events/live/ticket', { headers: { cookie: 'eventouch_attendee=abc' } });
  assert.equal(session.status, 200);
  assert.equal(session.json.participant.id, 'p2');
  assert.deepEqual(calls, [
    ['bearer', 'live', ''],
    ['session', 'eventouch_attendee=abc'],
    ['grant', 'live', [{ eventId: 'e1', participantId: 'p2' }]],
  ]);

  const stranger = await fetched(app, '/api/public/events/draft/ticket');
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.json, { error: '티켓 링크를 확인할 수 없습니다' });
});

test('a failing session read never replaces the bearer answer', async () => {
  const app = buildPublicReadsApp(publicDeps({
    resolveSession: async () => {
      throw new Error('session store down');
    },
  }));
  const response = await fetched(app, '/api/public/events/live/ticket', { headers: { cookie: 'x=1' } });
  assert.equal(response.status, 404);
  assert.deepEqual(response.json, { error: '티켓 링크를 확인할 수 없습니다' });
});

test('malformed percent-encoding keeps the legacy branch answers', async () => {
  const app = buildPublicReadsApp(publicDeps({
    readPublicFile: async () => {
      throw Object.assign(new Error('파일을 찾을 수 없습니다'), { status: 404 });
    },
  }));

  const event = await fetched(app, '/api/public/events/%ZZ');
  assert.equal(event.status, 404);
  assert.deepEqual(event.json, { error: '요청한 행사를 찾을 수 없습니다' });
  assert.equal(event.headers['cache-control'], 'no-store');

  const ticket = await fetched(app, '/api/public/events/%ZZ/ticket');
  assert.equal(ticket.status, 404);
  assert.deepEqual(ticket.json, { error: '요청한 행사를 찾을 수 없습니다' });

  const file = await fetched(app, '/api/public/events/live/files/a%ZZb');
  assert.equal(file.status, 404);
  assert.deepEqual(file.json, { error: '파일을 찾을 수 없습니다' });

  const other = await fetched(app, '/api/public/%ZZ');
  assert.equal(other.status, 404);
  assert.deepEqual(other.json, { error: '요청한 API를 찾을 수 없습니다' });
});

test('public file reads stream bytes with the stored metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-public-read-'));
  const absolutePath = path.join(dir, 'evidence.bin');
  fs.writeFileSync(absolutePath, 'stream-bytes');
  try {
    const app = buildPublicReadsApp(publicDeps({
      readPublicFile: async () => ({ absolutePath, type: 'image/png', size: 12 }),
    }));
    const response = await app.inject({ method: 'GET', url: '/api/public/events/live/files/file-1' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'stream-bytes');
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['content-length'], '12');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing files keep the legacy status and message rules', async () => {
  const known = buildPublicReadsApp(publicDeps({
    readPublicFile: async () => {
      throw Object.assign(new Error('파일을 찾을 수 없습니다'), { status: 404 });
    },
  }));
  const notFound = await fetched(known, '/api/public/events/live/files/file-1');
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.json, { error: '파일을 찾을 수 없습니다' });

  const broken = buildPublicReadsApp(publicDeps({
    readPublicFile: async () => {
      throw new Error('disk error with internals');
    },
  }));
  const hidden = await fetched(broken, '/api/public/events/live/files/file-1');
  assert.equal(hidden.status, 500);
  assert.deepEqual(hidden.json, { error: '파일을 읽지 못했습니다' });
});

test('reader failures keep the legacy error mapping', async () => {
  const explicit = buildPublicReadsApp(publicDeps({
    events: {
      loadPublicEvent: async () => {
        throw Object.assign(new Error('행사를 읽지 못했습니다'), { status: 503 });
      },
      loadTicket: async () => null,
      loadSessionTicket: async () => null,
    },
  }));
  const mapped = await fetched(explicit, '/api/public/events/live');
  assert.equal(mapped.status, 503);
  assert.deepEqual(mapped.json, { error: '행사를 읽지 못했습니다' });

  const unexpected = buildPublicReadsApp(publicDeps({
    events: {
      loadPublicEvent: async () => {
        throw new Error('connection reset by peer');
      },
      loadTicket: async () => null,
      loadSessionTicket: async () => null,
    },
  }));
  const generic = await fetched(unexpected, '/api/public/events/live');
  assert.equal(generic.status, 500);
  assert.deepEqual(generic.json, { error: '요청을 처리하지 못했습니다' });
});

test('without a database every public read answers 503', async () => {
  const app = buildPublicReadsApp(publicDeps({ events: null, readPublicFile: null }));
  const paths = [
    '/api/public',
    '/api/public/events/live',
    '/api/public/events/live/ticket',
    '/api/public/events/live/files/file-1',
    '/api/public/%ZZ',
    '/api/public/nothing',
  ];
  for (const url of paths) {
    const response = await fetched(app, url);
    assert.equal(response.status, 503, url);
    assert.deepEqual(response.json, { error: '데이터베이스를 사용할 수 없습니다' }, url);
    assert.equal(response.headers['cache-control'], 'no-store', url);
  }
});

test('the server delegates exactly the public GETs to this boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert.match(
    source,
    /urlPath === '\/api\/public' \|\| urlPath\.startsWith\('\/api\/public\/'\)\) && req\.method === 'GET'/u,
    'only GET requests under /api/public take the Fastify path'
  );
  assert.match(source, /publicReadsApp\.routing\(req, res\)/u, 'the boundary actually serves the delegated reads');
});
