'use strict';

// Bounded, synthetic latency sample. Uses a temporary schema in an explicitly
// named local test database; never dispatches a campaign or uses real data.
const { performance } = require('node:perf_hooks');
const database = String(process.env.EVENTOUCH_TEST_DATABASE_URL || '');
const url = new URL(database);
const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    [url.hostname, ...url.searchParams.getAll('host')].some(host => !loopback.includes(host.toLowerCase())) ||
    !/(test|audit|verify|improv)/i.test(url.pathname)) throw new Error('use a loopback test database');
for (const key of Object.keys(process.env)) {
  if (/^(?:SOLAPI_|MESSAGING_|ADMIN_)/.test(key) || /^EVENTOUCH_(?:MESSAGE_|PUBLIC_URL|DEV_)/.test(key)) delete process.env[key];
}
const { startApiHarness, insertAccount, insertEvent, sessionCookie, requestJson, LEGACY_ORG } = require('../tests/helpers/postgres-api-server.cjs');
const { emptyWorkspace } = require('../server/state');
const { dueScheduleGuards } = require('../server/commands/content-results');

(async () => {
  const harness = await startApiHarness();
  try {
    await insertAccount(harness.database, { id: 'bench-owner', name: 'bench', email: 'bench@example.test', role: 'AGENCY', orgId: LEGACY_ORG });
    const ids = Array.from({ length: 2500 }, (_, index) => `p${index}`);
    const workspace = emptyWorkspace();
    workspace.luckyNumbers = ids.map((id, index) => ({ participantId: id, number: index + 1 }));
    workspace.messages = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, status: 'SCHEDULED',
      scheduled: '2020-01-01T00:00:00Z', body: '{{럭키번호}}', recipientIds: ids, simulate: false }));
    await insertEvent(harness.database, { id: 'bench', slug: 'bench', orgId: LEGACY_ORG,
      payload: { id: 'bench', slug: 'bench', name: 'bench', stage: 'LIVE', features: [] }, workspace });
    const cookie = await sessionCookie(harness, 'bench-owner');
    const samples = [];
    for (let i = 0; i < 8; i += 1) {
      const started = performance.now();
      const response = await requestJson(harness.baseUrl, '/api/events/bench/bootstrap', { cookie });
      if (response.status !== 200) throw new Error('fixture bootstrap failed');
      if (i >= 2) samples.push(performance.now() - started);
    }
    const started = performance.now();
    for (const message of workspace.messages) dueScheduleGuards(message, workspace);
    const guardMs = performance.now() - started;
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ synthetic: true, messages: 20, recipients: 2500, warmupRequests: 2,
      measuredRequests: samples.length, requestMsP50: samples[3], requestMsMax: samples[5], guardMs }));
  } finally { await harness.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
