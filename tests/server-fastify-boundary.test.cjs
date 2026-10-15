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

// ---- organization-scope REST (server/fastify/organization-rest.ts) ----

const { buildOrganizationRestApp, organizationRestPath } = require('../server/fastify/organization-rest.ts');

function organizationDeps(overrides = {}) {
  return {
    sessionFromCookie: async (cookie) => (cookie === 'session=ok' ? { id: 'agency-1', role: 'AGENCY' } : null),
    loadBootstrap: async () => ({ events: [{ id: 'e1' }], activeEventId: 'e1', memberships: [] }),
    createEvent: async (account, body) => ({
      event: { id: 'e2', slug: body && body.slug },
      replayed: false,
    }),
    saveClient: async () => ({ client: { id: 'c1' }, replayed: false }),
    saveOrgPermissions: async (account, accountId) => ({ account: { id: accountId }, replayed: false }),
    assignMember: async (account, eventId) => ({ membership: { eventId }, replayed: false }),
    failureMessage: (error, fallback) => (error && error.status && error.message ? error.message : fallback),
    ...overrides,
  };
}

async function injected(app, url, options = {}) {
  const response = await app.inject({
    method: options.method || 'GET',
    url,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  let json = null;
  try {
    json = response.json();
  } catch {
    json = null;
  }
  return { status: response.statusCode, json, headers: response.headers };
}

test('the organization boundary owns exactly the organization REST shapes', () => {
  const owns = [
    ['/api/events', 'GET'],
    ['/api/events', 'POST'],
    ['/api/events/', 'POST'],
    ['/api/events//', 'GET'],
    ['/api/clients', 'POST'],
    ['/api/clients/', 'POST'],
    ['/api/accounts/a1/org-permissions', 'POST'],
    ['/api/events/e1/members', 'POST'],
  ];
  for (const [url, method] of owns) {
    assert.equal(organizationRestPath(url, method), true, `${method} ${url} belongs to the boundary`);
  }
  const notOurs = [
    ['/api/events', 'DELETE'],
    ['/api/clients', 'GET'],
    ['/api/clients', 'DELETE'],
    ['/api/events/e1/members', 'GET'],
    ['/api/events/e1/commands', 'POST'],
    ['/api/events/e1/files', 'POST'],
    ['/api/accounts/a1', 'POST'],
    ['/api/accounts/a1/org-permissions', 'GET'],
    ['/api/bootstrap', 'GET'],
    ['/api/public/events/e1', 'GET'],
  ];
  for (const [url, method] of notOurs) {
    assert.equal(organizationRestPath(url, method), false, `${method} ${url} stays elsewhere`);
  }
});

test('the event list reads through the boundary with the legacy session rules', async () => {
  const app = buildOrganizationRestApp(organizationDeps());

  const anonymous = await injected(app, '/api/events');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.json, { error: '로그인이 필요합니다' });
  assert.equal(anonymous.headers['cache-control'], undefined);

  const listed = await injected(app, '/api/events', { headers: { cookie: 'session=ok' } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, { events: [{ id: 'e1' }], activeEventId: 'e1' });
  assert.equal(listed.headers['cache-control'], 'no-store');
});

test('write bodies are read before authentication, exactly like the legacy router', async () => {
  const app = buildOrganizationRestApp(organizationDeps());

  const malformed = await injected(app, '/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: '{oops',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.json, { error: '요청 형식을 확인하세요' });
  assert.equal(malformed.headers['cache-control'], undefined);

  const oversized = await injected(app, '/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: `"${'x'.repeat(1024 * 1024 + 1)}"`,
  });
  assert.equal(oversized.status, 400);
  assert.deepEqual(oversized.json, { error: '요청이 너무 큽니다' });

  // The legacy reader ignored the media type; so does this boundary.
  const noMediaType = await injected(app, '/api/clients', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: JSON.stringify({ commandId: 'client-command-1' }),
  });
  assert.equal(noMediaType.status, 201);
  assert.deepEqual(noMediaType.json, { client: { id: 'c1' } });
});

test('event creation answers 201 and replays 200 through the boundary', async () => {
  let calls = 0;
  const deps = organizationDeps({
    createEvent: async () => {
      calls += 1;
      return calls === 1
        ? { event: { id: 'e9' }, replayed: false }
        : { event: { id: 'e9' }, replayed: true };
    },
  });
  const app = buildOrganizationRestApp(deps);

  const created = await injected(app, '/api/events', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: { commandId: 'event-command-1', name: '행사' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, { event: { id: 'e9' } });
  assert.equal(created.headers['cache-control'], 'no-store');

  const replayed = await injected(app, '/api/events', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: { commandId: 'event-command-1', name: '행사' },
  });
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.json, { event: { id: 'e9' } });
});

test('domain failures keep the legacy status, message and field', async () => {
  const app = buildOrganizationRestApp(organizationDeps({
    saveClient: async () => {
      throw Object.assign(new Error('고객사 이름을 입력하세요'), { status: 400, field: 'name' });
    },
    saveOrgPermissions: async () => {
      throw Object.assign(new Error('조직 권한을 변경할 권한이 없습니다'), { status: 403 });
    },
    assignMember: async () => {
      throw new Error('connection reset by peer');
    },
  }));

  const client = await injected(app, '/api/clients', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: {},
  });
  assert.equal(client.status, 400);
  assert.deepEqual(client.json, { error: '고객사 이름을 입력하세요', field: 'name' });
  assert.equal(client.headers['cache-control'], 'no-store');

  const permissions = await injected(app, '/api/accounts/a1/org-permissions', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: {},
  });
  assert.equal(permissions.status, 403);
  assert.deepEqual(permissions.json, { error: '조직 권한을 변경할 권한이 없습니다' });

  const membership = await injected(app, '/api/events/e1/members', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: {},
  });
  assert.equal(membership.status, 500);
  assert.deepEqual(membership.json, { error: '행사 권한을 저장하지 못했습니다' });
});

test('path ids decode like the legacy segments', async () => {
  const seen = [];
  const app = buildOrganizationRestApp(organizationDeps({
    saveOrgPermissions: async (account, accountId) => {
      seen.push(['permissions', accountId]);
      return { account: { id: accountId }, replayed: false };
    },
    assignMember: async (account, eventId) => {
      seen.push(['member', eventId]);
      return { membership: { eventId }, replayed: false };
    },
  }));

  const permissions = await injected(app, '/api/accounts/a%2Fb/org-permissions', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: {},
  });
  assert.equal(permissions.status, 201);
  assert.deepEqual(permissions.json, { account: { id: 'a/b' } });

  const membership = await injected(app, '/api/events/e%201/members', {
    method: 'POST',
    headers: { cookie: 'session=ok' },
    payload: {},
  });
  assert.equal(membership.status, 201);
  assert.deepEqual(membership.json, { membership: { eventId: 'e 1' } });
  assert.deepEqual(seen, [['permissions', 'a/b'], ['member', 'e 1']]);
});

test('unknown shapes inside the boundary answer the legacy API 404', async () => {
  const app = buildOrganizationRestApp(organizationDeps());
  const missing = await injected(app, '/api/nothing', { method: 'POST', payload: {} });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: '요청한 API를 찾을 수 없습니다' });
});

test('the server delegates the organization REST only in database mode', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert.match(
    source,
    /state && decodablePath\(urlPath\) && organizationRestPath\(urlPath, req\.method\)/u,
    'the boundary takes database-mode, decodable organization requests only'
  );
  assert.match(source, /organizationRestApp\.routing\(req, res\)/u, 'the boundary actually serves the delegated writes');
});
