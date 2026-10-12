const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMessagingProvider, providerConfig, messagingState, dispatchCampaign } = require('../server/messaging');

// A stand-in for a real provider. It records every request so the tests can
// assert the exact body, and it can be told to fail, time out or reject a
// single recipient — the cases that decide whether a campaign is reported
// honestly.
function startMockProvider() {
  const requests = [];
  let behaviour = 'accept';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (err) {}
      requests.push({ headers: req.headers, body: parsed });

      if (behaviour === 'hang') return; // never respond
      if (behaviour === 'reject') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '잘못된 수신번호입니다' }));
        return;
      }
      if (behaviour === 'server-error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'provider exploded' }));
        return;
      }
      if (behaviour === 'per-recipient' && parsed && parsed.to === '010-0000-0000') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '수신 거부' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: 'provider-msg-' + requests.length }));
    });
  });
  return {
    server,
    requests,
    setBehaviour: (value) => { behaviour = value; },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let mock;
let endpoint;

// The mock is stateful by design; reset it so tests do not depend on order.
function resetMock() {
  mock.setBehaviour('accept');
  mock.requests.length = 0;
}

before(async () => {
  mock = startMockProvider();
  const port = await mock.listen();
  endpoint = `http://127.0.0.1:${port}/send`;
});

after(async () => {
  if (mock) await mock.close();
});

test('no-provider-is-configured-by-default', () => {
  const config = providerConfig({});
  assert.equal(config.configured, false);
  assert.equal(messagingState({}).connected, false);
});

test('an-endpoint-without-a-token-is-not-a-working-provider', () => {
  // Half-configured must not look connected, or a campaign would be marked
  // SENT while nothing could actually authenticate.
  assert.equal(providerConfig({ EVENTOUCH_MESSAGING_ENDPOINT: endpoint }).configured, false);
  assert.equal(providerConfig({ EVENTOUCH_MESSAGING_TOKEN: 'token' }).configured, false);
  assert.equal(providerConfig({ EVENTOUCH_MESSAGING_ENDPOINT: endpoint, EVENTOUCH_MESSAGING_TOKEN: 't' }).configured, true);
});

test('an-unconfigured-provider-reports-not-configured-and-sends-nothing', async () => {
  const provider = createMessagingProvider(providerConfig({}));
  const result = await provider.send({ channel: 'SMS', to: '010-1234-5678', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'NOT_CONFIGURED');
  assert.equal(mock.requests.length, 0, 'nothing left the server');
});

test('a-configured-provider-posts-the-normalised-body-with-its-token', async () => {
  resetMock();
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 'secret-token',
    EVENTOUCH_MESSAGING_SENDER: '0212345678',
  }));

  const result = await provider.send({ channel: 'ALIMTALK', to: '010-1234-5678', text: '안내입니다', reference: 'msg-1:p-1' });
  assert.equal(result.delivered, true);
  assert.equal(result.providerId, 'provider-msg-1');

  const request = mock.requests[0];
  assert.equal(request.headers.authorization, 'Bearer secret-token');
  assert.deepEqual(request.body, {
    from: '0212345678',
    to: '010-1234-5678',
    text: '안내입니다',
    channel: 'ALIMTALK',
    reference: 'msg-1:p-1',
  });
});

test('a-recipient-without-an-address-is-not-sent', async () => {
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 'secret-token',
  }));
  resetMock();
  const before = mock.requests.length;
  const result = await provider.send({ channel: 'SMS', to: '', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'NO_RECIPIENT');
  assert.equal(mock.requests.length, before);
});

test('a-provider-rejection-is-never-reported-as-delivered', async () => {
  resetMock();
  mock.setBehaviour('reject');
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 'secret-token',
  }));
  const result = await provider.send({ channel: 'SMS', to: '010-1234-5678', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'PROVIDER_REJECTED');
  assert.match(result.error, /잘못된 수신번호/);
});

test('a-provider-server-error-is-a-failure-not-a-success', async () => {
  resetMock();
  mock.setBehaviour('server-error');
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 'secret-token',
  }));
  const result = await provider.send({ channel: 'SMS', to: '010-1234-5678', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'PROVIDER_REJECTED');
});

test('ok-false-with-a-200-is-still-a-failure', async () => {
  resetMock();
  // A provider that answers 200 with ok:false must not be read as success.
  mock.setBehaviour('per-recipient');
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 'secret-token',
  }));
  const result = await provider.send({ channel: 'SMS', to: '010-0000-0000', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.match(result.error, /수신 거부/);
});

test('a-hanging-provider-times-out-instead-of-blocking-forever', async () => {
  resetMock();
  mock.setBehaviour('hang');
  const provider = createMessagingProvider(
    providerConfig({ EVENTOUCH_MESSAGING_ENDPOINT: endpoint, EVENTOUCH_MESSAGING_TOKEN: 't' }),
    { timeoutMs: 300 }
  );
  const started = Date.now();
  const result = await provider.send({ channel: 'SMS', to: '010-1234-5678', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'TIMEOUT');
  assert.ok(Date.now() - started < 3000, 'the timeout is honoured');
});

test('no-transport-is-reported-distinctly-from-a-provider-failure', async () => {
  const provider = createMessagingProvider(
    providerConfig({ EVENTOUCH_MESSAGING_ENDPOINT: endpoint, EVENTOUCH_MESSAGING_TOKEN: 't' }),
    { fetchImpl: null }
  );
  const result = await provider.send({ channel: 'SMS', to: '010-1234-5678', text: 'hi' });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'NO_TRANSPORT');
});

// --- write-back -------------------------------------------------------------

function fakeDatabase(workspace, options = {}) {
  const writes = [];
  return {
    writes,
    async transaction(fn) {
      if (options.failWrite) throw new Error('write failed');
      return fn({
        async query(sql, params) {
          if (/SELECT payload FROM event_workspaces/.test(sql)) {
            if (options.missingWorkspace) return { rows: [] };
            return { rows: [{ payload: JSON.stringify(workspace) }] };
          }
          if (/UPDATE event_workspaces/.test(sql)) {
            writes.push({ sql, params });
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      });
    },
  };
}

const sampleWorkspace = () => ({
  messages: [{
    id: 'msg-1',
    title: '안내',
    body: '본문',
    channel: 'SMS',
    status: 'SENDING',
    deliveries: [
      { participantId: 'p-1', name: '가', status: 'SENDING', at: 'x' },
      { participantId: 'p-2', name: '나', status: 'SENDING', at: 'x' },
    ],
    recipientSnapshot: [
      { id: 'p-1', name: '가', phone: '010-1111-1111' },
      { id: 'p-2', name: '나', phone: '010-2222-2222' },
    ],
  }],
});

test('a-fully-delivered-campaign-is-recorded-as-sent', async () => {
  resetMock();
  mock.setBehaviour('accept');
  const workspace = sampleWorkspace();
  const db = fakeDatabase(workspace);
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 't',
  }));

  const result = await dispatchCampaign(db, provider, {
    eventId: 'e-1',
    messageId: 'msg-1',
    channel: 'SMS',
    text: '본문',
    recipients: [
      { participantId: 'p-1', name: '가', phone: '010-1111-1111' },
      { participantId: 'p-2', name: '나', phone: '010-2222-2222' },
    ],
  });

  assert.equal(result.delivered, 2);
  assert.equal(result.message.status, 'SENT');
  assert.equal(db.writes.length, 1, 'the outcome is persisted');
  for (const delivery of result.message.deliveries) assert.equal(delivery.status, 'SENT');
});

test('a-partial-send-is-recorded-as-partial-not-sent', async () => {
  resetMock();
  mock.setBehaviour('per-recipient');
  const workspace = sampleWorkspace();
  const db = fakeDatabase(workspace);
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 't',
  }));

  const result = await dispatchCampaign(db, provider, {
    eventId: 'e-1',
    messageId: 'msg-1',
    channel: 'SMS',
    text: '본문',
    recipients: [
      { participantId: 'p-1', name: '가', phone: '010-0000-0000' },
      { participantId: 'p-2', name: '나', phone: '010-2222-2222' },
    ],
  });

  assert.equal(result.delivered, 1);
  assert.equal(result.message.status, 'PARTIAL', 'a half-delivered campaign does not claim success');
  const statuses = result.message.deliveries.map((d) => d.status).sort();
  assert.deepEqual(statuses, ['FAILED', 'SENT']);
});

test('a-campaign-where-nothing-sent-is-recorded-as-failed', async () => {
  resetMock();
  mock.setBehaviour('reject');
  const workspace = sampleWorkspace();
  const db = fakeDatabase(workspace);
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 't',
  }));

  const result = await dispatchCampaign(db, provider, {
    eventId: 'e-1',
    messageId: 'msg-1',
    channel: 'SMS',
    text: '본문',
    recipients: [{ participantId: 'p-1', name: '가', phone: '010-1111-1111' }],
  });

  assert.equal(result.delivered, 0);
  assert.equal(result.message.status, 'FAILED');
});

test('each-delivery-records-whether-it-went-and-what-went-wrong', async () => {
  resetMock();
  mock.setBehaviour('per-recipient');
  const workspace = sampleWorkspace();
  const db = fakeDatabase(workspace);
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 't',
  }));

  const result = await dispatchCampaign(db, provider, {
    eventId: 'e-1',
    messageId: 'msg-1',
    channel: 'SMS',
    text: '본문',
    recipients: [
      { participantId: 'p-1', name: '가', phone: '010-0000-0000' },
      { participantId: 'p-2', name: '나', phone: '010-2222-2222' },
    ],
  });

  const failed = result.message.deliveries.find((d) => d.status === 'FAILED');
  const sent = result.message.deliveries.find((d) => d.status === 'SENT');
  assert.match(failed.error, /수신 거부/);
  assert.ok(sent.providerId, 'a delivered recipient keeps the provider reference');
  assert.equal(sent.error, null);
});

test('a-missing-workspace-does-not-throw-away-the-send-result', async () => {
  resetMock();
  mock.setBehaviour('accept');
  const db = fakeDatabase(null, { missingWorkspace: true });
  const provider = createMessagingProvider(providerConfig({
    EVENTOUCH_MESSAGING_ENDPOINT: endpoint,
    EVENTOUCH_MESSAGING_TOKEN: 't',
  }));
  const result = await dispatchCampaign(db, provider, {
    eventId: 'e-1',
    messageId: 'msg-1',
    channel: 'SMS',
    text: '본문',
    recipients: [{ participantId: 'p-1', name: '가', phone: '010-1111-1111' }],
  });
  assert.equal(result.delivered, 1, 'the provider result survives a missing workspace');
});

test('dispatch-is-a-no-op-without-a-provider-or-a-dispatch', async () => {
  const db = fakeDatabase(sampleWorkspace());
  assert.deepEqual(await dispatchCampaign(db, null, { messageId: 'msg-1' }), { skipped: true });
  assert.deepEqual(await dispatchCampaign(db, { send: async () => ({ delivered: true }) }, null), { skipped: true });
  assert.equal(db.writes.length, 0);
});