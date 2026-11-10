'use strict';

// Synthetic load only. This runs real API commands and PostgreSQL in an
// isolated fixture; it must never point at a deployment or a user's database.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { testDatabaseUrl } = require('../tests/helpers/postgres-test.cjs');
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const q = percentile => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]) : null;
  return { count: sorted.length, p50Ms: q(.5), p95Ms: q(.95), p99Ms: q(.99), maxMs: q(1), overEightSeconds: sorted.filter(value => value > 8000).length };
}

async function main() {
  const url = process.env.EVENTOUCH_LOAD_DATABASE_URL;
  if (!url) throw new Error('Set EVENTOUCH_LOAD_DATABASE_URL to a dedicated loopback PostgreSQL test database');
  testDatabaseUrl(url);
  const parsed = new URL(url);
  assert.equal(parsed.search, '', 'database URL query parameters are not permitted');
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^[a-z0-9_-]+$/i);
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /(?:^|[_-])(test|audit|verify|rehearsal)(?:[_-]|$)/i, 'database name must identify a test database');
  process.env.EVENTOUCH_TEST_DATABASE_URL = url;
  delete process.env.EVENTOUCH_A11Y_DATABASE_URL;
  delete process.env.EVENTOUCH_MOBILE_DATABASE_URL;
  // Pin the same default pool for each run so results do not silently inherit
  // an unrelated host setting. It is not a recommendation for deployment.
  process.env.PGPOOL_MAX = '10';
  const root = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'ticket-burst')
    : defaultCaptureDir(`ticket-burst-${runStamp()}`));
  process.env.TMPDIR = ensureRunTmpDir(root);
  const { startAuditFixture } = require('./audit-fixture.cjs');
  const f = await startAuditFixture();
  const agents = [];
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const command = async (name, payload) => {
      const res = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok([200, 201].includes(res.status), `fixture command ${name} failed: ${res.status}`);
      return res.json;
    };
    await db.query("UPDATE events SET payload=jsonb_set(payload,'{capacity}','1200'::jsonb) WHERE id=$1", [f.eventId]);
    await command('participant.import', { rows: Array.from({ length: 892 }, (_, index) => ({
      name: `합성 참가자 ${index + 1}`, phone: `0108${String(index).padStart(7, '0')}`, company: `합성 회사 ${index % 30 + 1}`,
    })) });
    let workspace = await read();
    assert.equal(workspace.participants.length, 900);
    await command('participant.status', { ids: workspace.participants.map(person => person.id), status: 'APPROVED' });
    workspace = await read();
    const people = workspace.participants;
    assert.ok(people.every(person => person.status === 'APPROVED' && person.ticket));

    const staff = [{ cookie: f.staff.cookie, deskId: f.deskId, assignmentId: `audit-assign-${f.suffix}`.toLowerCase() }];
    for (let i = 1; i < 3; i++) {
      const id = `load-staff-${crypto.randomUUID()}`;
      await f.helpers.insertAccount(db, { id, orgId: f.helpers.LEGACY_ORG, role: 'STAFF', name: `합성 스태프 ${i}`, email: `${id}@example.test` });
      const desk = (await command('desk.save', { name: `합성 데스크 ${i}`, action: 'IN', mode: 'desk', open: true })).desk;
      const assignmentId = `load-assign-${crypto.randomUUID()}`;
      await f.helpers.insertAssignment(db, { id: assignmentId, accountId: id, eventId: f.eventId, type: 'DESK', targetId: desk.id });
      staff.push({ cookie: await f.helpers.sessionCookie(f.harness, id), deskId: desk.id, assignmentId });
    }

    // Each client has its own connection. Pre-establish in small groups to
    // separate simultaneous API work from the host's TCP listen backlog.
    // Socket setup and the load generator still share the API's process.
    function request(agent, route, { method = 'GET', headers = {}, body } = {}) {
      return new Promise(resolve => {
        const start = performance.now();
        let settled = false;
        const finish = result => { if (!settled) { settled = true; resolve({ ...result, ms: performance.now() - start }); } };
        const req = http.request(f.harness.baseUrl + route, { agent, method, headers }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { text += chunk; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(text); } catch { /* checked by caller */ }
            finish({ status: res.statusCode, json });
          });
          res.on('error', error => finish({ error: error.code || error.name }));
        });
        req.on('error', error => finish({ error: error.code || error.name }));
        req.setTimeout(30000, () => req.destroy(Object.assign(new Error('request timeout'), { code: 'TIMEOUT' })));
        req.end(body);
      });
    }

    const report = {
      boundary: '900 pre-established independent local HTTP client connections to the real API, synthetic PostgreSQL data and three assigned staff. API, database and load generator share one Mac. This is not 900 browsers, a production deployment, external network, physical devices or an SLA.',
      participants: 900, databasePoolMax: 10,
      build: fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim(),
      host: { os: os.platform(), arch: os.arch(), logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3) },
      runs: [], ok: false,
    };
    for (let run = 0; run < 2; run++) {
      const current = Array.from({ length: 903 }, () => new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }));
      agents.push(...current);
      for (let index = 0; index < current.length; index += 30) {
        const warm = await Promise.all(current.slice(index, index + 30).map(agent => request(agent, '/api/health')));
        assert.ok(warm.every(item => item.status === 200), 'could not establish all test connections');
      }
      const connections = current.reduce((n, agent) => n + Object.values(agent.freeSockets).flat().length, 0);
      assert.equal(connections, 903, 'the local test requires all connections to remain open before the burst');
      const ticketPath = `/api/public/events/${f.slug}/ticket`;
      const warmTicket = await request(current[0], ticketPath, { headers: { authorization: `Bearer ${people[0].ticket}` } });
      assert.equal(warmTicket.status, 200);
      assert.equal(warmTicket.json?.participant?.id, people[0].id);
      let maxWaiting = 0, maxTotal = 0, samples = 0;
      const delay = monitorEventLoopDelay({ resolution: 20 });
      const started = performance.now(), cpu = process.cpuUsage();
      delay.enable();
      const sampler = setInterval(() => { samples++; maxWaiting = Math.max(maxWaiting, db.pool.waitingCount); maxTotal = Math.max(maxTotal, db.pool.totalCount); }, 20);
      const reads = people.map((person, index) => request(current[index], ticketPath, { headers: { authorization: `Bearer ${person.ticket}` } }));
      const scans = staff.map((worker, index) => {
        const body = JSON.stringify({ commandId: crypto.randomUUID(), command: 'check.scan', assignmentId: worker.assignmentId,
          payload: { deskId: worker.deskId, ticket: people[run * 3 + index].ticket, expectedAction: 'IN' } });
        return request(current[900 + index], `/api/events/${f.eventId}/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie: worker.cookie }, body,
        });
      });
      const [replies, writes] = await Promise.all([Promise.all(reads), Promise.all(scans)]);
      clearInterval(sampler); delay.disable();
      const used = process.cpuUsage(cpu), statuses = {};
      let identityMismatch = 0;
      replies.forEach((reply, index) => {
        const key = reply.error || String(reply.status);
        statuses[key] = (statuses[key] || 0) + 1;
        if (reply.status === 200 && reply.json?.participant?.id !== people[index].id) identityMismatch++;
      });
      workspace = await read();
      const expectedPeople = people.slice(0, (run + 1) * 3);
      const exactCheckins = expectedPeople.every(person =>
        workspace.participants.some(item => item.id === person.id && item.inside === true)
        && workspace.checks.filter(item => item.participantId === person.id && (item.action === 'IN' || item.type === 'IN')).length === 1);
      const row = {
        connections, elapsedMs: Math.round(performance.now() - started), statuses, identityMismatch,
        latency: distribution(replies.map(reply => reply.ms)),
        staff: writes.map(reply => ({ status: reply.status || reply.error, ms: Math.round(reply.ms) })),
        savedCheckins: workspace.checks.filter(item => item.action === 'IN' || item.type === 'IN').length,
        exactCheckins,
        pool: { maxWaiting, maxTotal, samples }, processCpuMs: Math.round((used.user + used.system) / 1000),
        eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6), rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      };
      report.runs.push(row);
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(row));
      current.forEach(agent => agent.destroy());
      assert.equal(row.statuses['200'], 900, 'all synthetic ticket reads must succeed');
      assert.equal(row.identityMismatch, 0, 'every response must match its own bearer');
      assert.ok(row.staff.every(result => result.status === 200), 'all three assigned staff requests must succeed');
      assert.equal(row.savedCheckins, (run + 1) * 3, 'every check-in must persist exactly once');
      assert.equal(row.exactCheckins, true, 'the intended participants must each be inside with one entry record');
    }
    report.ok = true;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log('PASS: 900 pre-established ticket connections and three assigned staff, twice');
  } finally {
    agents.forEach(agent => agent.destroy());
    await f.close();
  }
}
if (require.main === module) main().catch(error => {
  console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]'));
  process.exitCode = 1;
});
