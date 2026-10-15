'use strict';

// Fastify route boundary contract: the health route answers through the
// boundary with the exact historical shape, whatever the dependencies do.
// Production wiring is covered by the existing health assertions
// (skeleton, auth, outbox); these pin the boundary itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHealthApp } = require('../server/fastify/health.ts');

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
