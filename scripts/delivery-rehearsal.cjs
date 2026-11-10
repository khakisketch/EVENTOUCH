'use strict';
// Local synthetic API/DB scale + restart + pg_dump/pg_restore rehearsal.
// Owns TWO fresh databases; never dumps or restores the shared test database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');
const http = require('node:http');
const run = promisify(execFile);
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const { testDatabaseUrl } = require('../tests/helpers/postgres-test.cjs');
const { isolatedTestEnvironment } = require('../tests/helpers/test-provider-env.cjs');
const backup = require('./backup-lib.cjs');

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] * 10) / 10;
  return { count: sorted.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: at(1) };
}

async function coldBurst(url) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 900 }, async () => {
    try { const response = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(30000) }); await response.arrayBuffer(); return String(response.status); }
    catch (error) { return error.cause?.code || error.code || 'transport'; }
  }));
  const counts = {}; for (const value of results) counts[value] = (counts[value] || 0) + 1;
  return { clients: 900, counts, elapsedMs: Math.round(performance.now() - started) };
}

async function main() {
  const root = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`delivery-${runStamp()}`);
  prepareCaptureDir(root); process.env.TMPDIR = ensureRunTmpDir(root);
  const baseUrl = testDatabaseUrl(process.env.EVENTOUCH_REHEARSAL_DATABASE_URL);
  assert.ok(baseUrl, 'EVENTOUCH_REHEARSAL_DATABASE_URL must name a loopback test database');
  const parsedBase = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  assert.ok(parsedBase.searchParams.getAll('host').every(host => loopback.includes(host.toLowerCase())), 'all database host overrides must remain loopback');
  assert.match(parsedBase.pathname, /test|audit|verify|rehearsal/i, 'use an explicitly named test database');
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const names = [`eventouch_rehearsal_source_${suffix}`, `eventouch_rehearsal_restore_${suffix}`];
  const admin = new Pool({ connectionString: baseUrl });
  const owned = [], report = { at: new Date().toISOString(), synthetic: true, boundary: '900 concurrent API HTTP clients plus 3 desks, local Node/PostgreSQL; not 900 browser devices or production SLA', ok: false, phases: {} };
  const urlFor = name => { const url = new URL(baseUrl); url.pathname = '/' + name; url.search = ''; return url.toString(); };
  let harness, restored, restoredServer;
  const agents = [];
  function readConnected(url, agent) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { agent, timeout: 30000 }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', c => body += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (error) { reject(error); } });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject);
    });
  }
  try {
    for (const name of names) { await admin.query(`CREATE DATABASE "${name}"`); owned.push(name); }
    process.env.EVENTOUCH_TEST_DATABASE_URL = urlFor(names[0]);
    // No live provider may be inherited into this rehearsal.
    for (const key of Object.keys(process.env)) if (/^(?:SOLAPI_|MESSAGING_)|^EVENTOUCH_(?:SMTP_|MAIL_|MESSAGE_|MESSAGING_)/.test(key)) delete process.env[key];
    process.env.EVENTOUCH_REQUEST_LOGS = '0';
    const { loadHelpers, seedAuditFixture } = require('./audit-fixture.cjs');
    const helpers = loadHelpers(); harness = await helpers.startApiHarness();
    const f = await seedAuditFixture(harness, helpers);
    const command = async (command, payload) => {
      const r = await helpers.requestJson(harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload } });
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json;
    };
    await harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{capacity}','1200'::jsonb) WHERE id=$1", [f.eventId]);
    await command('participant.import', { rows: Array.from({ length: 892 }, (_, i) => ({ name: `합성 참가자 ${i + 1}`, phone: `0108${String(i).padStart(7, '0')}`, company: `합성 업체 ${i % 30 + 1}` })) });
    let state = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.equal(state.participants.length, 900);
    await command('participant.status', { ids: state.participants.map(p => p.id), status: 'APPROVED' });
    state = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const cookies = [f.staff.cookie], assignments = [`audit-assign-${f.suffix}`], desks = [f.deskId];
    for (let i = 1; i < 3; i++) {
      const id = `scale-staff-${i}`; await helpers.insertAccount(harness.database, { id, orgId: helpers.LEGACY_ORG, role: 'STAFF', name: `합성 스태프 ${i}`, email: `scale-${i}@example.test` });
      const desk = (await command('desk.save', { name: `합성 데스크 ${i}`, action: 'IN', mode: 'desk', open: true })).desk;
      const assignment = `scale-assignment-${i}`; await helpers.insertAssignment(harness.database, { id: assignment, accountId: id, eventId: f.eventId, type: 'DESK', targetId: desk.id });
      cookies.push(await helpers.sessionCookie(harness, id)); assignments.push(assignment); desks.push(desk.id);
    }
    const publicPath = `/api/public/events/${f.slug}`;
    for (let i = 0; i < 10; i++) assert.equal((await helpers.requestJson(harness.baseUrl, publicPath)).status, 200);
    const applicationCold = await coldBurst(harness.baseUrl + publicPath);
    const echo = http.createServer((req, res) => { res.writeHead(200); res.end('synthetic echo'); });
    let echoCold;
    try { await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve)); echoCold = await coldBurst(`http://127.0.0.1:${echo.address().port}`); }
    finally { echo.closeAllConnections(); await new Promise(resolve => echo.close(resolve)); }
    report.phases.coldConnections = { application: applicationCold, echoControl: echoCold, passed: applicationCold.counts['200'] === 900, boundary: 'same-host new TCP handshakes; echo control separates kernel/listen-queue limits from DB work' };
    // Prepare 900 independently established HTTP connections without an
    // artificial 900-handshake burst against the host's TCP listen backlog.
    // This measures concurrent application work, not cold connection capacity.
    for (let i = 0; i < 900; i++) agents.push(new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }));
    for (let start = 0; start < agents.length; start += 30) {
      await Promise.all(agents.slice(start, start + 30).map(async agent => assert.equal((await readConnected(harness.baseUrl + publicPath, agent)).status, 200)));
    }
    const latency = [], scanLatency = [], errors = [], start = performance.now();
    await Promise.all([
      ...agents.map(async agent => {
        const begin = performance.now();
        try { const r = await readConnected(harness.baseUrl + publicPath, agent); if (r.status !== 200 || !r.json?.workspace) errors.push({ phase: 'read', status: r.status }); }
        catch (error) { errors.push({ phase: 'read', status: 'transport', code: error.cause?.code || error.code || 'unknown' }); }
        finally { latency.push(performance.now() - begin); }
      }),
      ...cookies.map(async (cookie, desk) => {
        for (let index = 0; index < 10; index++) {
          const begin = performance.now(), person = state.participants[desk * 10 + index];
          const body = { commandId: crypto.randomUUID(), command: 'check.scan', assignmentId: assignments[desk], payload: { deskId: desks[desk], ticket: person.ticket } };
          try {
            const r = await helpers.requestJson(harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie, body });
            if (r.status !== 200) errors.push({ phase: 'scan', status: r.status });
          } catch (error) { errors.push({ phase: 'scan', status: 'transport', code: error.cause?.code || error.code || 'unknown' }); }
          finally { scanLatency.push(performance.now() - begin); }

        }
      }),
    ]);
    const elapsedMs = performance.now() - start;
    report.phases.scale = { connectionModel: '900 pre-established independent keep-alive connections; cold handshake capacity is separate', readers: 900, attendees: 900, deskWorkers: 3, scans: 30, reads: distribution(latency), writes: distribution(scanLatency), elapsedMs: Math.round(elapsedMs), errors };
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.equal(errors.length, 0, JSON.stringify(errors.slice(0, 8)));
    state = (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.equal(state.participants.filter(p => p.inside).length, 30);
    // Upload and later download the exact same synthetic image through the API.
    const bytes = fs.readFileSync(path.join(__dirname, '../tests/fixtures/booth-map/synthetic-demo-floorplan.png'));
    const storage = path.join(harness.dataDir, 'storage');
    const uploaded = await fetch(`${harness.baseUrl}/api/events/${f.eventId}/files?name=rehearsal.png&commandId=${crypto.randomUUID()}`, { method: 'POST', headers: { cookie: f.manager.cookie, 'content-type': 'image/png' }, body: bytes });
    const uploadedBody = await uploaded.json(); assert.equal(uploaded.status, 201, JSON.stringify(uploadedBody));
    const fileId = uploadedBody.file.fileId; assert.ok(fileId);
    const dbUrl = harness.database.pool.options.connectionString;
    const snapshotStart = performance.now();
    await run(process.execPath, [path.join(__dirname, 'backup.cjs'), '--database-url', dbUrl, '--storage-dir', storage, '--out', path.join(root, 'backup')], { maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'backup/manifest.json')));
    for (const part of [manifest.database, manifest.storage]) assert.equal(await backup.sha256File(path.join(root, 'backup', part.file)), part.sha256);
    const backupMs = performance.now() - snapshotStart;
    const restoreStart = performance.now();
    await run('pg_restore', ['--dbname', urlFor(names[1]), '--no-owner', '--no-privileges', '--exit-on-error', path.join(root, 'backup/database.dump')]);
    const restoreStorage = path.join(root, 'restored-storage'); fs.mkdirSync(restoreStorage, { mode: 0o700 });
    await run('tar', ['-xzf', path.join(root, 'backup/storage.tar.gz'), '-C', restoreStorage]);
    const { createDatabase } = require('../server/db');
    const restoredUrl = new URL(dbUrl); restoredUrl.pathname = '/' + names[1];
    restored = createDatabase({ connectionString: restoredUrl.toString() });
    for (const [table, expected] of Object.entries(manifest.counts)) { backup.identifier(table, 'table'); const actual = (await restored.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n; assert.equal(actual, expected, table); }
    assert.deepEqual(await backup.hashTree(restoreStorage), manifest.storage.files);
    const { createDatabaseAuth } = require('../server/auth'), { createAccess } = require('../server/access'), { createHttpServer } = require('../server/server'), { openStore } = require('../server/store');
    restoredServer = createHttpServer(openStore(path.join(root, 'restored-state')), createDatabaseAuth(restored), createAccess(restored), restored, { storageDir: restoreStorage, env: isolatedTestEnvironment(process.env) });
    await new Promise(resolve => restoredServer.listen(0, '127.0.0.1', resolve));
    const restoredBase = `http://127.0.0.1:${restoredServer.address().port}`;
    assert.equal((await helpers.requestJson(restoredBase, '/api/auth/me', { cookie: f.manager.cookie })).status, 200);
    const restoredState = await helpers.requestJson(restoredBase, `/api/events/${f.eventId}/bootstrap`, { cookie: f.manager.cookie }); assert.equal(restoredState.status, 200);
    const persisted = (await restored.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.equal(persisted.participants.length, 900); assert.equal(persisted.participants.filter(p => p.inside).length, 30);
    const downloaded = await fetch(`${restoredBase}/api/events/${f.eventId}/files/${fileId}`, { headers: { cookie: f.manager.cookie } });
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    report.phases.restore = { backupMs: Math.round(backupMs), restoreAndVerifyMs: Math.round(performance.now() - restoreStart), tables: Object.keys(manifest.counts).length, files: manifest.storage.files.length, accountsAndSessionsRestored: true, attendees: 900, checkins: 30, bytes: manifest.database.bytes + manifest.storage.bytes };
    report.ok = report.phases.coldConnections.passed;
  } finally {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    for (const agent of agents) agent.destroy();
    if (restoredServer) { restoredServer.closeAllConnections(); await new Promise(resolve => restoredServer.close(resolve)); }
    if (restored) await restored.close(); if (harness) await harness.close();
    for (const name of owned.reverse()) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { process.stderr.write(`[delivery-rehearsal] ${error.message}\n`); process.exitCode = 1; });
module.exports = { distribution };
