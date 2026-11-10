'use strict';

// The real HTTP server must not inherit an operator's outbound sender when a
// synthetic harness starts. The only listener used here is this loopback fake.
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const helpers = require('./helpers/postgres-api-server.cjs');
const { seedAuditFixture, loadHelpers } = require('../scripts/audit-fixture.cjs');

const test = helpers.databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);
let fake, fakeCalls = 0, fakePort;

before(async () => {
  if (!helpers.databaseUrl) return;
  fake = http.createServer((_req, res) => { fakeCalls += 1; res.writeHead(200); res.end('{}'); });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  fakePort = fake.address().port;
});

after(async () => {
  if (fake) await new Promise(resolve => fake.close(resolve));
});

for (const kind of ['generic', 'solapi']) {
  test(`isolated harness cannot inherit an ambient ${kind} sender`, async () => {
    const values = kind === 'generic'
      ? { EVENTOUCH_MESSAGING_ENDPOINT: `http://127.0.0.1:${fakePort}/send`, EVENTOUCH_MESSAGING_TOKEN: 'fixture-token', EVENTOUCH_MESSAGING_SENDER: '0212345678' }
      : { SOLAPI_API_HOST: `http://127.0.0.1:${fakePort}`, SOLAPI_API_KEY: 'fixture-key', SOLAPI_API_SECRET: 'fixture-secret', SOLAPI_SENDER: '0212345678' };
    const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    let harness;
    const callsBefore = fakeCalls;
    try {
      harness = await helpers.startApiHarness();
      const health = await helpers.requestJson(harness.baseUrl, '/api/health');
      assert.equal(health.json.messaging, false);
      const fixture = await seedAuditFixture(harness, loadHelpers());
      const state = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
      const response = await helpers.requestJson(harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie,
        body: { commandId: `sender-test-${crypto.randomUUID()}`, command: 'message.create',
          payload: { ids: [state.participants[0].id], title: '합성 검증', channel: 'SMS', body: '합성 데이터' } },
      });
      assert.equal(response.status, 201, JSON.stringify(response.json));
      assert.equal(response.json.message.status, 'NEEDS_CONNECTION');
      assert.equal(fakeCalls, callsBefore, 'no request reaches the inherited local fake provider');
    } finally {
      if (harness) await harness.close();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
}
