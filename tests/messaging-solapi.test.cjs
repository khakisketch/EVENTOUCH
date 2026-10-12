const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');

const solapi = require('../server/messaging-solapi');

const TEST_SECRET = 'test-api-secret';

function config(overrides = {}) {
  return {
    apiKey: 'TESTKEY',
    apiSecret: TEST_SECRET,
    sender: '0212345678',
    kakaoPfId: 'PFxxxxxxxxxxxxxxxx',
    host: '',
    configured: true,
    kakaoReady: true,
    ...overrides,
  };
}

// A stand-in for api.solapi.com. It records the exact request body so the
// tests can assert what would have been sent and charged for.
function startMock() {
  const requests = [];
  let sendResponse = null;
  let listResponse = null;
  let sendStatus = 200;
  let hang = false;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let parsed = null;
      try { parsed = JSON.parse(body || 'null'); } catch (err) {}
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, authorization: req.headers.authorization });

      if (hang) return;

      if (url.pathname === '/messages/v4/send-many/detail') {
        if (sendStatus !== 200) {
          res.writeHead(sendStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errorCode: 'TooManyRequests', message: '잦은 호출로 제한되었습니다.' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sendResponse || { failedMessageList: [], groupInfo: { groupId: 'G4V-TEST' } }));
        return;
      }
      if (url.pathname === '/messages/v4/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(listResponse || { messageList: {}, limit: 20, startKey: null }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorCode: 'NotFound' }));
    });
  });

  return {
    server,
    requests,
    setSend: (value) => { sendResponse = value; },
    setList: (value) => { listResponse = value; },
    setSendStatus: (value) => { sendStatus = value; },
    setHang: (value) => { hang = value; },
    reset: () => { requests.length = 0; sendResponse = null; listResponse = null; sendStatus = 200; hang = false; },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let mock;
let host;

before(async () => {
  mock = startMock();
  const port = await mock.listen();
  host = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (mock) await mock.close();
});

// --- configuration ---------------------------------------------------------

test('a-key-without-its-secret-is-not-a-working-provider', () => {
  // Half-configured must not read as connected, or campaigns would be marked
  // sent while nothing could authenticate.
  assert.equal(solapi.providerConfig({ SOLAPI_API_KEY: 'k' }).configured, false);
  assert.equal(solapi.providerConfig({ SOLAPI_API_SECRET: 's' }).configured, false);
  assert.equal(solapi.providerConfig({ SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's' }).configured, false, 'a sender is required too');
  assert.equal(solapi.providerConfig({ SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '02' }).configured, true);
});

test('alimtalk-readiness-is-reported-separately-from-connection', () => {
  const withoutChannel = solapi.providerConfig({ SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '02' });
  assert.equal(withoutChannel.configured, true);
  assert.equal(withoutChannel.kakaoReady, false, 'no channel id means no alimtalk');
  const withChannel = solapi.providerConfig({ SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '02', SOLAPI_KAKAO_PFID: 'PF1' });
  assert.equal(withChannel.kakaoReady, true);
  assert.equal(solapi.messagingState({ SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '02' }).provider, 'solapi');
});

// --- authentication --------------------------------------------------------

test('the-signature-is-hmac-sha256-over-date-plus-salt', () => {
  const date = '2026-01-01T00:00:00.000Z';
  const salt = 'abcdef0123456789';
  const expected = crypto.createHmac('sha256', TEST_SECRET).update(date + salt).digest('hex');
  const header = solapi.authorizationHeader(config(), { now: new Date(date), salt });
  assert.equal(
    header,
    `HMAC-SHA256 apiKey=TESTKEY, date=${date}, salt=${salt}, signature=${expected}`
  );
});

test('each-request-carries-a-fresh-salt', () => {
  // Solapi rejects a reused signature inside 15 minutes.
  const first = solapi.authorizationHeader(config());
  const second = solapi.authorizationHeader(config());
  const saltOf = (header) => /salt=([^,]+)/.exec(header)[1];
  assert.notEqual(saltOf(first), saltOf(second));
});

test('every-call-is-signed', async () => {
  mock.reset();
  mock.setSend({ failedMessageList: [], groupInfo: { groupId: 'G1' } });
  const provider = solapi.createSolapiProvider(config({ host }));
  await provider.sendBatch([{ participantId: 'p1', channel: 'SMS', to: '01011112222', text: 'hi' }]);
  assert.match(mock.requests[0].authorization, /^HMAC-SHA256 apiKey=TESTKEY, date=/);
});

// --- numbers and length ----------------------------------------------------

test('phone-numbers-are-normalised-to-digits', () => {
  // Product data has hyphens; Solapi requires digits only, so a miss here
  // would fail every send.
  assert.equal(solapi.normalizePhone('010-1234-5678'), '01012345678');
  assert.equal(solapi.normalizePhone(' 010 1234 5678 '), '01012345678');
  assert.equal(solapi.normalizePhone(null), '');
});

test('korean-text-counts-two-bytes-per-character', () => {
  assert.equal(solapi.messageBytes('안녕하세요'), 10);
  assert.equal(solapi.messageBytes('hello'), 5);
  assert.equal(solapi.messageBytes('안녕 hi'), 7);
});

test('the-sms-to-lms-boundary-is-measured-in-bytes-not-characters', () => {
  // 45 Korean characters is exactly the 90-byte SMS limit.
  assert.equal(solapi.resolveTextType('가'.repeat(45)).type, 'SMS');
  assert.equal(solapi.resolveTextType('가'.repeat(46)).type, 'LMS');
  // 90 ascii characters is also exactly at the limit.
  assert.equal(solapi.resolveTextType('a'.repeat(90)).type, 'SMS');
  assert.equal(solapi.resolveTextType('a'.repeat(91)).type, 'LMS');
});

test('text-beyond-the-lms-limit-is-rejected-instead-of-truncated', () => {
  const tooLong = solapi.resolveTextType('가'.repeat(1001));
  assert.equal(tooLong.type, null);
  assert.equal(tooLong.reason, 'TOO_LONG');
});

test('a-long-notice-becomes-lms-rather-than-failing-as-sms', () => {
  // The common real case: a venue notice runs past 45 Korean characters.
  const notice = '등록하신 행사가 내일 진행됩니다. 주차장은 행사장 지하 2층이며, 모바일 티켓을 준비해주세요. 입장은 오전 9시부터 시작합니다.';
  const planned = solapi.resolveTextType(notice);
  assert.equal(planned.type, 'LMS');
  assert.ok(planned.bytes > solapi.SMS_MAX_BYTES);
  // The same notice trimmed to exactly the limit stays SMS, so the boundary is
  // not shifting the operator into a pricier channel by accident.
  const atLimit = '등록하신 행사가 내일 진행됩니다. 주차장은 행사장 지하 2층이며, 모바일 티켓을 준비해주세요.';
  assert.equal(solapi.messageBytes(atLimit), solapi.SMS_MAX_BYTES);
  assert.equal(solapi.resolveTextType(atLimit).type, 'SMS');
});

// --- variable mapping ------------------------------------------------------

test('product-variables-map-to-solapi-placeholders', () => {
  const mapped = solapi.templateVariables('{{이름}}님 {{행사명}}', { 이름: '홍길동', 행사명: '박람회', 미사용: 'x' });
  assert.deepEqual(mapped, { '#{이름}': '홍길동', '#{행사명}': '박람회' });
});

test('only-variables-the-template-actually-uses-are-sent', () => {
  // Sending a variable the approved template does not declare is rejected.
  assert.deepEqual(solapi.templateVariables('안내입니다', { 이름: '홍길동' }), {});
});

test('plain-text-rendering-substitutes-and-leaves-unknown-tokens-alone', () => {
  assert.equal(solapi.renderText('{{이름}}님', { 이름: '홍길동' }), '홍길동님');
  assert.equal(solapi.renderText('{{없는변수}}님', {}), '{{없는변수}}님');
});

// --- payload construction --------------------------------------------------

test('a-plain-message-uses-a-digits-only-recipient-and-the-sender', () => {
  const provider = solapi.createSolapiProvider(config({ host }));
  const built = provider.buildMessage({ channel: 'SMS', to: '010-1111-2222', text: '안내' });
  assert.equal(built.message.to, '01011112222');
  assert.equal(built.message.from, '0212345678');
  assert.equal(built.message.type, 'SMS');
  assert.equal(built.message.text, '안내');
  assert.equal(built.message.kakaoOptions, undefined);
});

test('an-lms-message-carries-a-subject-so-it-does-not-read-as-a-truncated-sms', () => {
  const provider = solapi.createSolapiProvider(config({ host }));
  const built = provider.buildMessage({ channel: 'LMS', to: '01011112222', text: '가'.repeat(60), subject: '행사 안내' });
  assert.equal(built.message.type, 'LMS');
  assert.equal(built.message.subject, '행사 안내');
});

test('an-alimtalk-message-carries-the-channel-and-approved-template', () => {
  const provider = solapi.createSolapiProvider(config({ host }));
  const built = provider.buildMessage({
    channel: 'ALIMTALK', to: '01011112222', text: '{{이름}}님 안녕하세요',
    variables: { 이름: '홍길동' }, templateId: 'KAxxxxxxxxxxxxxxxx',
  });
  assert.equal(built.message.type, 'ATA');
  assert.equal(built.message.kakaoOptions.pfId, 'PFxxxxxxxxxxxxxxxx');
  assert.equal(built.message.kakaoOptions.templateId, 'KAxxxxxxxxxxxxxxxx');
  assert.deepEqual(built.message.kakaoOptions.variables, { '#{이름}': '홍길동' });
  // Without this a failed alimtalk is simply lost.
  assert.equal(built.message.kakaoOptions.disableSms, false, 'text fallback stays available');
});

test('alimtalk-without-an-approved-template-is-refused-not-guessed', () => {
  const provider = solapi.createSolapiProvider(config({ host }));
  const built = provider.buildMessage({ channel: 'ALIMTALK', to: '01011112222', text: '안내' });
  assert.equal(built.error, 'ALIMTALK_NOT_CONFIGURED');
});

test('a-recipient-without-a-number-is-refused', () => {
  const provider = solapi.createSolapiProvider(config({ host }));
  assert.equal(provider.buildMessage({ channel: 'SMS', to: '', text: 'hi' }).error, 'NO_RECIPIENT');
  assert.equal(provider.buildMessage({ channel: 'SMS', to: '없음', text: 'hi' }).error, 'NO_RECIPIENT');
});

test('an-unsupported-channel-is-refused', () => {
  const provider = solapi.createSolapiProvider(config({ host }));
  assert.equal(provider.buildMessage({ channel: 'MMS', to: '01011112222', text: 'hi' }).error, 'UNSUPPORTED_CHANNEL');
});

// --- batch sending ---------------------------------------------------------

test('a-whole-campaign-goes-out-in-one-request', async () => {
  mock.reset();
  mock.setSend({ failedMessageList: [], groupInfo: { groupId: 'G4V-1' } });
  const provider = solapi.createSolapiProvider(config({ host }));

  const result = await provider.sendBatch([
    { participantId: 'p1', channel: 'SMS', to: '010-1111-1111', text: '안내' },
    { participantId: 'p2', channel: 'SMS', to: '010-2222-2222', text: '안내' },
    { participantId: 'p3', channel: 'SMS', to: '010-3333-3333', text: '안내' },
  ]);

  assert.equal(result.accepted, true);
  assert.equal(result.groupId, 'G4V-1');
  const sendCalls = mock.requests.filter((r) => r.path === '/messages/v4/send-many/detail');
  assert.equal(sendCalls.length, 1, 'one call for three recipients');
  assert.equal(sendCalls[0].body.messages.length, 3);
  assert.equal(sendCalls[0].body.showMessageList, true, 'message ids are needed to poll later');
  assert.ok(result.registered.every((entry) => entry.accepted));
});

test('acceptance-is-never-reported-as-delivery', async () => {
  mock.reset();
  mock.setSend({ failedMessageList: [], groupInfo: { groupId: 'G4V-1' } });
  const provider = solapi.createSolapiProvider(config({ host }));
  const result = await provider.sendBatch([{ participantId: 'p1', channel: 'SMS', to: '01011111111', text: 'hi' }]);
  assert.equal(result.deliveryUnconfirmed, true, 'the caller must poll before claiming SENT');
  assert.equal(result.registered[0].delivered, undefined);
});

test('a-recipient-listed-in-failedMessageList-is-marked-rejected', async () => {
  mock.reset();
  mock.setSend({
    failedMessageList: [{ to: '01022222222', statusCode: '3000', statusMessage: '수신번호 오류' }],
    groupInfo: { groupId: 'G4V-1' },
  });
  const provider = solapi.createSolapiProvider(config({ host }));

  const result = await provider.sendBatch([
    { participantId: 'p1', channel: 'SMS', to: '010-1111-1111', text: 'hi' },
    { participantId: 'p2', channel: 'SMS', to: '010-2222-2222', text: 'hi' },
  ]);

  const rejected = result.registered.find((entry) => entry.participantId === 'p2');
  const accepted = result.registered.find((entry) => entry.participantId === 'p1');
  assert.equal(rejected.accepted, false);
  assert.match(rejected.error, /수신번호 오류/);
  assert.equal(accepted.accepted, true);
});

test('locally-invalid-recipients-are-excluded-from-the-request', async () => {
  mock.reset();
  mock.setSend({ failedMessageList: [], groupInfo: { groupId: 'G4V-1' } });
  const provider = solapi.createSolapiProvider(config({ host }));

  const result = await provider.sendBatch([
    { participantId: 'p1', channel: 'SMS', to: '010-1111-1111', text: 'hi' },
    { participantId: 'p2', channel: 'SMS', to: '', text: 'hi' },
  ]);

  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'NO_RECIPIENT');
  const sendCall = mock.requests.find((r) => r.path === '/messages/v4/send-many/detail');
  assert.equal(sendCall.body.messages.length, 1, 'an unusable recipient must not be submitted');
});

test('a-campaign-where-every-recipient-is-invalid-is-not-submitted', async () => {
  mock.reset();
  const provider = solapi.createSolapiProvider(config({ host }));
  const result = await provider.sendBatch([{ participantId: 'p1', channel: 'SMS', to: '', text: 'hi' }]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'ALL_REJECTED');
  assert.equal(mock.requests.filter((r) => r.path.includes('send-many')).length, 0);
});

test('rate-limiting-is-reported-distinctly-so-it-can-be-retried', async () => {
  mock.reset();
  mock.setSendStatus(429);
  const provider = solapi.createSolapiProvider(config({ host }));
  const result = await provider.sendBatch([{ participantId: 'p1', channel: 'SMS', to: '01011111111', text: 'hi' }]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'RATE_LIMITED');
});

test('a-hanging-provider-times-out-instead-of-blocking-the-request', async () => {
  mock.reset();
  mock.setHang(true);
  const provider = solapi.createSolapiProvider(config({ host }), { timeoutMs: 300 });
  const started = Date.now();
  const result = await provider.sendBatch([{ participantId: 'p1', channel: 'SMS', to: '01011111111', text: 'hi' }]);
  mock.setHang(false);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'TIMEOUT');
  assert.ok(Date.now() - started < 5000);
});

test('an-unconfigured-provider-sends-nothing', async () => {
  mock.reset();
  const provider = solapi.createSolapiProvider({ ...config({ host }), configured: false });
  const result = await provider.sendBatch([{ participantId: 'p1', channel: 'SMS', to: '01011111111', text: 'hi' }]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'NOT_CONFIGURED');
  assert.equal(mock.requests.length, 0);
});

// --- delivery polling ------------------------------------------------------

test('a-message-the-carrier-has-not-settled-yet-stays-pending', () => {
  assert.equal(solapi.interpretStatus({ status: 'PENDING', statusCode: '2000' }).state, 'PENDING');
  assert.equal(solapi.interpretStatus({ status: 'SENDING', statusCode: '2000' }).state, 'PENDING');
});

test('a-completed-message-in-the-4xxx-band-counts-as-delivered', () => {
  const result = solapi.interpretStatus({
    status: 'COMPLETE', statusCode: '4000', messageId: 'M1', type: 'SMS', dateReceived: '2026-01-01T00:00:00Z',
  });
  assert.equal(result.state, 'DELIVERED');
  assert.equal(result.type, 'SMS');
  assert.equal(result.receivedAt, '2026-01-01T00:00:00Z');
});

test('a-completed-message-below-the-4xxx-band-counts-as-failed', () => {
  const result = solapi.interpretStatus({ status: 'COMPLETE', statusCode: '3000', reason: '수신번호 오류' });
  assert.equal(result.state, 'FAILED');
  assert.match(result.reason, /수신번호 오류/);
});

test('an-alimtalk-that-fell-back-to-text-is-flagged-as-replaced', () => {
  // It arrived, so it is not a failure, but the operator should be able to see
  // it did not arrive as alimtalk.
  const result = solapi.interpretStatus({ status: 'COMPLETE', statusCode: '4000', replacement: true, type: 'SMS' });
  assert.equal(result.state, 'DELIVERED');
  assert.equal(result.replacement, true);
});

test('polling-reads-status-by-message-id', async () => {
  mock.reset();
  mock.setList({
    messageList: {
      M1: { messageId: 'M1', status: 'COMPLETE', statusCode: '4000', type: 'SMS' },
      M2: { messageId: 'M2', status: 'PENDING', statusCode: '2000' },
    },
    limit: 20, startKey: null,
  });
  const provider = solapi.createSolapiProvider(config({ host }));
  const result = await provider.pollResults(['M1', 'M2']);
  assert.equal(result.ok, true);
  assert.equal(result.results.M1.state, 'DELIVERED');
  assert.equal(result.results.M2.state, 'PENDING');
  const call = mock.requests.find((r) => r.path === '/messages/v4/list');
  assert.deepEqual(call.query.messageIds, JSON.stringify(['M1', 'M2']));
});

test('polling-more-ids-than-one-page-holds-is-split-into-batches', async () => {
  mock.reset();
  mock.setList({ messageList: {}, limit: 500, startKey: null });
  const provider = solapi.createSolapiProvider(config({ host }));
  const ids = Array.from({ length: 1200 }, (unused, index) => `M${index}`);
  await provider.pollResults(ids);
  const calls = mock.requests.filter((r) => r.path === '/messages/v4/list');
  assert.equal(calls.length, 3, '1200 ids at 500 per call');
});

test('polling-with-no-ids-does-not-call-the-provider', async () => {
  mock.reset();
  const provider = solapi.createSolapiProvider(config({ host }));
  const result = await provider.pollResults([]);
  assert.deepEqual(result, { ok: true, results: {} });
  assert.equal(mock.requests.length, 0);
});

test('duplicate-ids-are-polled-once', async () => {
  mock.reset();
  mock.setList({ messageList: {}, limit: 500, startKey: null });
  const provider = solapi.createSolapiProvider(config({ host }));
  await provider.pollResults(['M1', 'M1', 'M1']);
  const call = mock.requests.find((r) => r.path === '/messages/v4/list');
  assert.deepEqual(call.query.messageIds, JSON.stringify(['M1']));
});

test('a-group-read-can-be-used-to-recover-message-ids', async () => {
  mock.reset();
  mock.setList({
    messageList: { M1: { messageId: 'M1', to: '01011111111' } },
    limit: 500, startKey: null,
  });
  const provider = solapi.createSolapiProvider(config({ host }));
  const result = await provider.groupMessages('G4V-1');
  assert.equal(result.ok, true);
  assert.equal(result.messages.M1.to, '01011111111');
});


// --- provider selection ----------------------------------------------------
//
// Which provider is active must be decided in one place. server/state.js was
// calling the generic messagingState(), which only reads EVENTOUCH_MESSAGING_*,
// so a Solapi-only deployment told the browser it was disconnected while the
// server was sending. That is the shape of bug these tests exist to prevent.

test('active-state-reports-solapi-when-solapi-is-configured', () => {
  const { activeMessagingState } = require('../server/messaging');
  const state = activeMessagingState({
    SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '0212345678',
  });
  assert.equal(state.connected, true, 'a Solapi-only deployment is connected');
  assert.equal(state.provider, 'solapi');
});

test('active-state-falls-back-to-the-generic-provider', () => {
  const { activeMessagingState } = require('../server/messaging');
  const state = activeMessagingState({
    EVENTOUCH_MESSAGING_ENDPOINT: 'https://example.test/send',
    EVENTOUCH_MESSAGING_TOKEN: 't',
  });
  assert.equal(state.connected, true);
  assert.equal(state.provider, undefined, 'the generic provider does not name itself');
});

test('active-state-is-disconnected-when-nothing-is-configured', () => {
  const { activeMessagingState } = require('../server/messaging');
  assert.equal(activeMessagingState({}).connected, false);
});

test('active-provider-is-the-solapi-adapter-when-solapi-is-configured', () => {
  const { activeProvider } = require('../server/messaging');
  const provider = activeProvider({
    SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SOLAPI_SENDER: '0212345678',
  });
  // batch capability is what marks the Solapi adapter
  assert.equal(typeof provider.sendBatch, 'function');
  assert.equal(typeof provider.pollResults, 'function');
});

test('active-provider-falls-back-to-per-recipient-sending', () => {
  const { activeProvider } = require('../server/messaging');
  const provider = activeProvider({
    EVENTOUCH_MESSAGING_ENDPOINT: 'https://example.test/send',
    EVENTOUCH_MESSAGING_TOKEN: 't',
  });
  assert.equal(typeof provider.send, 'function');
  assert.equal(provider.sendBatch, undefined);
});

test('the-bootstrap-projection-and-the-health-probe-agree', () => {
  // Two separate call sites decide "is messaging live". They drifted once and
  // the browser showed disconnected while the server was sending, so both must
  // route through the shared decision.
  const path = require('node:path');
  const state = fs.readFileSync(path.join(__dirname, '..', 'server/state.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server/server.js'), 'utf8');
  assert.match(state, /activeMessagingState\(\)/, 'state.js must use the shared decision');
  assert.match(server, /activeMessagingState\(\)/, 'server.js must use the shared decision');
});

test('state-js-never-calls-the-generic-state-directly', () => {
  // Calling it directly is what caused the drift: it only knows the generic
  // provider, so a Solapi deployment reported itself as disconnected.
  const path = require('node:path');
  const state = fs.readFileSync(path.join(__dirname, '..', 'server/state.js'), 'utf8');
  const calls = state.match(/\bmessagingState\(\)/g) || [];
  assert.equal(calls.length, 0, 'use activeMessagingState() instead');
});
