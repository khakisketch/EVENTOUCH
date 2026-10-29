'use strict';

// Scoped-read performance baseline (reproducible, synthetic data only).
//
// WHAT: realistic small-load burst — three desks scanning concurrently while
// the console shell (directory) and an event screen (event bootstrap) keep
// reading — plus read-size baselines and the directory query plan.
// Reports correctness (every scan applied exactly once, reads stay 200 and
// consistent) and latency (median/p95/max), then exits non-zero on any
// mismatch so it works as a gate, not just a log.
//
// WHICH DATABASE — READ THIS BEFORE RUNNING:
// - This script connects ONLY to the URL in SCOPED_READ_TASK_DATABASE_URL.
//   It never reads EVENTOUCH_TEST_DATABASE_URL, DATABASE_URL or any other
//   environment, and it never touches a protected/shared database.
// - The URL must be loopback-only (enforced by the shared test helper).
// - All fixtures live in one uuid-named PostgreSQL schema created for this
//   run and dropped afterwards (the standard API harness). Nothing outside
//   that schema is read or written.
// - The script prints the sanitized (password-free) target before doing
//   anything so a wrong URL is visible immediately.
//
// RUN: node scripts/scoped-read-performance.cjs
//   with SCOPED_READ_TASK_DATABASE_URL='postgres://user:pass@127.0.0.1:port/db'

const assert = require('node:assert/strict');
const { ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const crypto = require('node:crypto');
const { testDatabaseUrl } = require('../tests/helpers/postgres-test.cjs');

function commandId() {
  return `perf-${crypto.randomUUID().replace(/-/g, '')}`;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))];
}

function summarize(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    name,
    count: sorted.length,
    medianMs: Number(percentile(sorted, 0.5).toFixed(1)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...sorted).toFixed(1)),
    meanMs: Number((sum / sorted.length).toFixed(1)),
  };
}

async function main() {
  process.env.TMPDIR = ensureRunTmpDir(defaultCaptureDir(`perf-reads-run-${runStamp()}`));
  const rawUrl = process.env.SCOPED_READ_TASK_DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      'Set SCOPED_READ_TASK_DATABASE_URL to the task-isolated PostgreSQL URL. ' +
      'This script refuses any other environment variable so a protected database is never touched.'
    );
  }
  // Loopback-only is enforced here; anything else throws before connecting.
  testDatabaseUrl(rawUrl);
  const shown = new URL(rawUrl);
  shown.password = '***';
  // eslint-disable-next-line no-console
  console.log(`[scoped-read-perf] target (synthetic task database only): ${shown.toString()}`);

  process.env.EVENTOUCH_TEST_DATABASE_URL = rawUrl;
  const {
    startApiHarness,
    insertAccount,
    insertEvent,
    insertMembership,
    insertAssignment,
    sessionCookie,
    requestJson,
    LEGACY_ORG,
  } = require('../tests/helpers/postgres-api-server.cjs');
  const { createState } = require('../server/state');

  const suffix = crypto.randomUUID().replace(/-/g, '');
  const ids = {
    agency: `perf-agency-${suffix}`,
    manager: `perf-manager-${suffix}`,
    staffA: `perf-staff-a-${suffix}`,
    staffB: `perf-staff-b-${suffix}`,
    staffC: `perf-staff-c-${suffix}`,
    event: `perf-event-${suffix}`,
    deskA: `perf-desk-a-${suffix}`,
    deskB: `perf-desk-b-${suffix}`,
    deskC: `perf-desk-c-${suffix}`,
    assignA: `perf-assign-a-${suffix}`,
    assignB: `perf-assign-b-${suffix}`,
    assignC: `perf-assign-c-${suffix}`,
  };

  const harness = await startApiHarness();
  try {
    await insertAccount(harness.database, {
      orgId: LEGACY_ORG,
      id: ids.agency, role: 'AGENCY', name: '성능 조직 관리자',
      email: `perf-agency-${suffix}@example.test`, orgPermissions: ['events.all'],
    });
    await insertAccount(harness.database, {
      orgId: LEGACY_ORG,
      id: ids.manager, role: 'MANAGER', name: '성능 매니저',
      email: `perf-manager-${suffix}@example.test`,
    });
    for (const key of ['staffA', 'staffB', 'staffC']) {
      await insertAccount(harness.database, {
        orgId: LEGACY_ORG,
        id: ids[key], role: 'STAFF', name: `성능 스태프 ${key}`,
        email: `perf-${key}-${suffix}@example.test`,
      });
    }

    const APPROVED = 100;
    const PENDING = 20;
    const participants = [];
    for (let index = 0; index < APPROVED + PENDING; index += 1) {
      participants.push({
        id: `perf-person-${index}`,
        name: `참가자 ${index}`,
        phone: `010${String(10000000 + index)}`,
        email: `perf-${index}@example.test`,
        ticket: `perf-ticket-${suffix}-${index}`,
        company: index % 4 === 0 ? '협력사' : '',
        group: '일반',
        status: index < APPROVED ? 'APPROVED' : 'PENDING',
        paymentStatus: 'FREE',
        inside: false,
        everIn: false,
        ...(index < APPROVED ? { ticketExpiresAt: '2027-11-20T00:00:00.000Z' } : {}),
      });
    }
    const desks = [ids.deskA, ids.deskB, ids.deskC].map((id, index) => ({
      id, name: `등록 데스크 ${index + 1}`, action: 'IN', open: true,
    }));
    await insertEvent(harness.database, {
      orgId: LEGACY_ORG,
      id: ids.event,
      slug: `perf-event-${suffix}`,
      payload: {
        id: ids.event, slug: `perf-event-${suffix}`, name: '성능 행사',
        date: '2026-11-20', start: '09:00', end: '17:00', capacity: 200,
        stage: 'LIVE', features: ['stamp'],
      },
      workspace: {
        participants, desks, booths: [], checks: [], visits: [],
        messages: Array.from({ length: 20 }, (_, index) => ({
          id: `perf-message-${index}`, status: index % 5 === 0 ? 'FAILED' : 'SENT',
        })),
        venue: { name: '성능 홀' },
      },
    });
    await insertMembership(harness.database, ids.manager, ids.event, ['all']);
    const deskByStaff = { staffA: ids.deskA, staffB: ids.deskB, staffC: ids.deskC };
    const assignByStaff = { staffA: ids.assignA, staffB: ids.assignB, staffC: ids.assignC };
    for (const key of ['staffA', 'staffB', 'staffC']) {
      await insertAssignment(harness.database, {
        id: assignByStaff[key], accountId: ids[key], eventId: ids.event, type: 'DESK', targetId: deskByStaff[key],
      });
    }
    // The table row authorizes; the workspace array is what the UI reads.
    // Keep both, the way the product write path does.
    const workspaceRow = await harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id = $1', [ids.event]
    );
    const workspace = workspaceRow.rows[0].payload;
    workspace.assignments = Array.isArray(workspace.assignments) ? workspace.assignments : [];
    for (const key of ['staffA', 'staffB', 'staffC']) {
      workspace.assignments.push({
        id: assignByStaff[key], accountId: ids[key], type: 'DESK', targetId: deskByStaff[key],
      });
    }
    await harness.database.query(
      'UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
      [ids.event, JSON.stringify(workspace)]
    );

    const cookies = {
      agency: await sessionCookie(harness, ids.agency),
      manager: await sessionCookie(harness, ids.manager),
      staffA: await sessionCookie(harness, ids.staffA),
      staffB: await sessionCookie(harness, ids.staffB),
      staffC: await sessionCookie(harness, ids.staffC),
    };
    const state = createState(harness.database);

    // -- Phase A: read baselines (state level, 5 iterations each). --
    const readLatencies = { bootstrap: [], directory: [], eventBootstrap: [] };
    let fullBytes = 0;
    let directoryBytes = 0;
    let singleBytes = 0;
    for (let round = 0; round < 5; round += 1) {
      let started = Date.now();
      const full = await state.loadBootstrap({ id: ids.agency });
      readLatencies.bootstrap.push(Date.now() - started);
      fullBytes = Buffer.byteLength(JSON.stringify(full));

      started = Date.now();
      const directory = await state.loadDirectory({ id: ids.agency });
      readLatencies.directory.push(Date.now() - started);
      directoryBytes = Buffer.byteLength(JSON.stringify(directory));

      started = Date.now();
      const single = await state.loadEventBootstrap({ id: ids.manager }, ids.event);
      readLatencies.eventBootstrap.push(Date.now() - started);
      singleBytes = Buffer.byteLength(JSON.stringify(single));

      // Freshness: the new reads observe the same revision as bootstrap.
      assert.equal(directory.revision, full.revision, 'directory revision parity');
      assert.equal(single.revision, full.revision, 'event bootstrap revision parity');
      assert.equal(directory.events[0].pending, PENDING, 'directory pending parity');
    }

    // -- Phase B: realistic burst — 3 desks x 10 scans, reads interleaved. --
    const scanTargets = [];
    for (let index = 0; index < 30; index += 1) {
      scanTargets.push({
        staff: ['staffA', 'staffB', 'staffC'][index % 3],
        person: index,
      });
    }
    const scanLatencies = [];
    const readDuringBurstLatencies = [];
    async function staffScan({ staff, person }) {
      const started = Date.now();
      const response = await requestJson(harness.baseUrl, `/api/events/${ids.event}/commands`, {
        method: 'POST',
        cookie: cookies[staff],
        body: {
          commandId: commandId(),
          command: 'check.scan',
          assignmentId: assignByStaff[staff],
          payload: { deskId: deskByStaff[staff], ticket: `perf-ticket-${suffix}-${person}` },
        },
      });
      scanLatencies.push(Date.now() - started);
      return response;
    }
    async function interleavedRead(kind) {
      const started = Date.now();
      const url = kind === 'directory' ? '/api/console/directory' : `/api/events/${ids.event}/bootstrap`;
      const response = await requestJson(harness.baseUrl, url, { cookie: cookies.manager });
      readDuringBurstLatencies.push({ kind, ms: Date.now() - started, status: response.status });
      return response;
    }
    const burst = await Promise.all([
      ...scanTargets.map((target) => staffScan(target)),
      ...['directory', 'event', 'directory', 'event', 'directory', 'event'].map((kind) => interleavedRead(kind)),
    ]);
    const scanResponses = burst.slice(0, scanTargets.length);
    const readResponses = burst.slice(scanTargets.length);
    for (const [index, response] of scanResponses.entries()) {
      assert.equal(response.status, 200, `scan ${index} applies, got ${response.status}: ${JSON.stringify(response.json)}`);
    }
    for (const [index, response] of readResponses.entries()) {
      assert.equal(response.status, 200, `interleaved read ${index} stays 200`);
      assert.equal(response.headers.get('cache-control'), 'no-store', `interleaved read ${index} stays no-store`);
    }

    const afterRow = await harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id = $1', [ids.event]
    );
    const after = afterRow.rows[0].payload;
    assert.equal(after.checks.length, 30, 'every scan recorded exactly one check');
    for (let person = 0; person < 30; person += 1) {
      const record = after.participants.find((item) => item.id === `perf-person-${person}`);
      assert.ok(record && record.inside === true, `scanned participant ${person} is inside`);
    }
    // Same ticket scanned again is rejected as a duplicate, not recorded twice.
    const replay = await requestJson(harness.baseUrl, `/api/events/${ids.event}/commands`, {
      method: 'POST',
      cookie: cookies.staffA,
      body: {
        commandId: commandId(),
        command: 'check.scan',
        assignmentId: ids.assignA,
        payload: { deskId: ids.deskA, ticket: `perf-ticket-${suffix}-0` },
      },
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.json.error, '이미 입장한 참가자입니다. 중복 처리하지 않았습니다.');
    const replayedRow = await harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id = $1', [ids.event]
    );
    assert.equal(replayedRow.rows[0].payload.checks.length, 30, 're-scan classifies without a second check row');

    // -- Phase C: the directory query plan (slow-query evidence). --
    // Mirrors loadDirectory's summary SELECT; parity with the live directory
    // entry is asserted below so drift between the two fails loudly.
    const planResult = await harness.database.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT e.id,
              NULLIF(w.payload->'venue'->>'name', '') AS venue,
              CASE WHEN jsonb_typeof(COALESCE(w.payload->'participants', '[]'::jsonb)) = 'array'
                   THEN (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(w.payload->'participants', '[]'::jsonb)) AS p
                         WHERE p->>'status' = 'PENDING')
                   ELSE 0 END::int AS pending,
              CASE WHEN jsonb_typeof(COALESCE(w.payload->'messages', '[]'::jsonb)) = 'array'
                   THEN (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(w.payload->'messages', '[]'::jsonb)) AS m
                         WHERE m->>'status' IN ('FAILED', 'PARTIAL', 'NEEDS_CONNECTION'))
                   ELSE 0 END::int AS attention
       FROM events e LEFT JOIN event_workspaces w ON w.event_id = e.id
       WHERE e.id = $1::text`,
      [ids.event]
    );
    const plan = planResult.rows[0]['QUERY PLAN'][0].Plan;
    const verifyResult = await harness.database.query(
      `SELECT NULLIF(w.payload->'venue'->>'name', '') AS venue,
              (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(w.payload->'participants', '[]'::jsonb)) AS p
               WHERE p->>'status' = 'PENDING')::int AS pending,
              (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(w.payload->'messages', '[]'::jsonb)) AS m
               WHERE m->>'status' IN ('FAILED', 'PARTIAL', 'NEEDS_CONNECTION'))::int AS attention
       FROM event_workspaces w WHERE w.event_id = $1`,
      [ids.event]
    );
    const directory = await state.loadDirectory({ id: ids.manager });
    const entry = directory.events.find((item) => item.id === ids.event);
    assert.equal(verifyResult.rows[0].venue, entry.venue, 'plan-query venue parity');
    assert.equal(Number(verifyResult.rows[0].pending), entry.pending, 'plan-query pending parity');
    assert.equal(Number(verifyResult.rows[0].attention), entry.messageAttention, 'plan-query attention parity');

    const summary = {
      fixture: { participants: APPROVED + PENDING, desks: 3, scans: 30, interleavedReads: readResponses.length },
      bytes: { bootstrap: fullBytes, directory: directoryBytes, eventBootstrap: singleBytes },
      reads: [
        summarize('loadBootstrap', readLatencies.bootstrap),
        summarize('loadDirectory', readLatencies.directory),
        summarize('loadEventBootstrap', readLatencies.eventBootstrap),
      ],
      burst: {
        scans: summarize('check.scan', scanLatencies),
        readsDuringBurst: readDuringBurstLatencies,
      },
      directoryPlan: {
        executionMs: plan['Actual Total Time'],
        planningMs: planResult.rows[0]['QUERY PLAN'][0]['Planning Time'],
        sharedHitBlocks: plan['Shared Hit Blocks'],
        sharedReadBlocks: plan['Shared Read Blocks'],
      },
      verdict: 'pass',
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[scoped-read-perf] FAIL: ${error && error.message}`);
  process.exitCode = 1;
});
