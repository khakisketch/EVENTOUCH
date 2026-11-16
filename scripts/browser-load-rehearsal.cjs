'use strict';
// Local, synthetic browser/desk exercise. This owns an isolated API schema,
// temporary Next server and private evidence directory, never production data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk, typeTicket } = require('./audit-staff-direction.cjs');
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const { testDatabaseUrl } = require('../tests/helpers/postgres-test.cjs');

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]) : null;
  return { count: sorted.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: at(1) };
}

async function main() {
  const requestedDb = process.env.EVENTOUCH_BROWSER_LOAD_DATABASE_URL;
  if (!requestedDb) throw new Error('Set EVENTOUCH_BROWSER_LOAD_DATABASE_URL to a loopback-only isolated PostgreSQL test database');
  testDatabaseUrl(requestedDb);
  const parsed = new URL(requestedDb), name = decodeURIComponent(parsed.pathname.slice(1));
  assert.equal(parsed.search, '', 'database URL query parameters are not allowed');
  assert.match(name, /^[a-z0-9_-]+$/i, 'use a simple test database name');
  assert.match(name, /(?:^|[_-])(test|audit|verify|rehearsal)(?:[_-]|$)/i, 'use an explicitly named test database');
  process.env.EVENTOUCH_TEST_DATABASE_URL = requestedDb;
  delete process.env.EVENTOUCH_A11Y_DATABASE_URL;
  delete process.env.EVENTOUCH_MOBILE_DATABASE_URL;
  const root = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'browser-load')
    : defaultCaptureDir(`browser-load-${runStamp()}`));
  process.env.TMPDIR = ensureRunTmpDir(root);

  const f = await startAuditFixture();
  let browser;
  const contexts = [];
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const command = async (name, payload) => {
      const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok([200, 201].includes(response.status), `setup ${name} ${response.status}`);
      return response.json;
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

    const workers = [{ cookie: f.staff.cookie }];
    for (let index = 1; index < 3; index++) {
      const id = `load-staff-${crypto.randomUUID()}`;
      await f.helpers.insertAccount(db, { id, orgId: f.helpers.LEGACY_ORG, role: 'STAFF', name: `합성 스태프 ${index}`, email: `${id}@example.test` });
      const desk = (await command('desk.save', { name: `합성 데스크 ${index}`, action: 'IN', mode: 'desk', open: true })).desk;
      await f.helpers.insertAssignment(db, { id: `load-assign-${crypto.randomUUID()}`, accountId: id, eventId: f.eventId, type: 'DESK', targetId: desk.id });
      workers.push({ cookie: await f.helpers.sessionCookie(f.harness, id) });
    }
    browser = await launchBrowser();
    for (const worker of workers) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      contexts.push(context);
      const cookie = String(worker.cookie).split(';')[0], separator = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: f.baseUrl }]);
      worker.page = await context.newPage();
      await worker.page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
      await confirmInitialStaffDesk(worker.page);
      await worker.page.locator('#staff-ticket').waitFor();
    }
    const warm = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(warm);
    const warmPage = await warm.newPage();
    await warmPage.goto(`${f.baseUrl}/event/${f.slug}/ticket?ticket=${encodeURIComponent(people[30].ticket)}`);
    await warmPage.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 30000 });
    await warm.close();

    const report = {
      synthetic: true,
      boundary: 'One local macOS host, isolated test gateway, Next production build, API, PostgreSQL and one Chromium process with separate contexts. Not a real network, physical devices or production SLA.',
      participants: 900, staff: 3, build: fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim(),
      host: { os: os.platform(), arch: os.arch(), logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3) },
      runs: [], ok: false,
    };
    let scanCursor = 0;
    for (const size of [8, 24]) for (let iteration = 1; iteration <= 2; iteration++) {
      const clients = [];
      for (let index = 0; index < size; index++) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        contexts.push(context);
        clients.push({ context, page: await context.newPage(), person: people[40 + index] });
      }
      const errors = [], durations = [], scanDurations = [];
      const begin = performance.now();
      await Promise.all([
        ...clients.map(async ({ page, person }, index) => {
          const start = performance.now(), failed = [];
          let phase = 'navigate', status = null;
          try {
            page.on('pageerror', () => errors.push('attendee-js'));
            page.on('requestfailed', request => failed.push({ kind: request.resourceType(), error: request.failure()?.errorText }));
            const response = await page.goto(`${f.baseUrl}/event/${f.slug}/ticket?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            status = response?.status();
            if (!response || status !== 200) throw new Error(`http ${status}`);
            phase = 'ticket-qr';
            await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor({ timeout: 30000 });
            phase = 'identity';
            assert.equal(await page.getByRole('heading', { name: person.name, exact: true }).count(), 1);
            assert.equal(new URL(page.url()).searchParams.has('ticket'), false);
            durations.push(performance.now() - start);
          } catch (error) {
            const info = { phase, status, name: error.name, elapsedMs: Math.round(performance.now() - start), failed,
              body: await page.locator('body').innerText({ timeout: 1000 }).then(text => text.slice(0, 400)).catch(() => null) };
            fs.writeFileSync(path.join(root, `failure-${size}-${iteration}-${index}.json`), JSON.stringify(info, null, 2), { mode: 0o600 });
            await page.screenshot({ path: path.join(root, `failure-${size}-${iteration}-${index}.png`), fullPage: true, timeout: 3000 }).catch(() => {});
            errors.push(`attendee:${phase}:${error.name}`);
          }
        }),
        ...workers.map(async (worker, workerIndex) => {
          for (let index = 0; index < 3; index++) {
            const person = people[scanCursor + workerIndex * 3 + index], start = performance.now();
            try {
              await typeTicket(worker.page, person.ticket);
              await worker.page.getByRole('button', { name: '입장 처리', exact: true }).click();
              await worker.page.getByRole('button', { name: '다음 참가자', exact: true }).waitFor({ timeout: 30000 });
              scanDurations.push(performance.now() - start);
              await worker.page.getByRole('button', { name: '다음 참가자', exact: true }).click();
            } catch (error) { errors.push(`desk:${error.name}`); break; }
          }
        }),
      ]);
      scanCursor += 9;
      const row = { concurrentBrowserContexts: size, iteration, attendeeLoads: distribution(durations), checkins: distribution(scanDurations), elapsedMs: Math.round(performance.now() - begin), errors };
      report.runs.push(row);
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(row));
      for (const client of clients) await client.context.close();
      assert.equal(errors.length, 0, JSON.stringify(errors));
      assert.equal(durations.length, size);
      assert.equal(scanDurations.length, 9);
    }
    workspace = await read();
    assert.equal(workspace.participants.filter(person => person.inside).length, 36);
    assert.equal(workspace.checks.filter(item => item.action === 'IN' || item.type === 'IN').length, 36);
    report.savedInside = 36; report.ok = true;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log('PASS: independent browser QR pages with 3 real staff UIs and 36 persisted check-ins');
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await browser?.close();
    await f.close();
  }
}
if (require.main === module) main().catch(error => {
  console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]'));
  process.exitCode = 1;
});
