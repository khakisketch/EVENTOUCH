'use strict';

// Shared isolated fixture for the product browser audits
// (accessibility-audit, mobile-audit, web-audit) and for the
// main-owned web-import / web-hanwool / web-theme audits.
//
// Every audit boots the same shape: an isolated PostgreSQL schema with a
// realistic event (manager + staff assignments, approved participants, an
// open desk, notices), a real API harness on a loopback port, a short-lived
// Next production server bound to that harness for server-side rendering,
// and a same-origin reverse-proxy gateway in front of the owned Next server.
// The gateway forwards real HTTP and never fabricates an API result; only
// committed-response loss may be injected by callers that explicitly ask
// for it.
//
// Why the fixture owns Next: the audited pages render server-side against
// process.env.EVENTOUCH_API_URL directly (apps/web/app/event/[slug]/*),
// not through the gateway. Pointing a gateway at an external Next build
// whose SSR still targets the default API (or nothing at all) renders the
// error boundary while the audits see no pageerror or overflow — a false
// positive. The fixture therefore always starts its own `next start` with
// EVENTOUCH_API_URL set to the isolated harness and gates every audited
// route on its real content before any axe/overflow probe runs.
//
// WEB_BASE / webBase compatibility: the option and env var are still
// accepted so existing callers keep working, but an externally running
// build is never audited silently. When a caller passes an explicit
// webBase (or WEB_BASE is set), the fixture logs that the value is
// superseded by the isolated Next server and audits the isolated server.
//
// The default root API and any user demo database are never touched: all
// writes land in the harness's random schema, which is dropped on close.
// The fixture never teaches the product to trust request Host/Origin or
// arbitrary API URL headers: SSR binds to the harness URL through the
// owned child process environment only (no SSRF surface, no product
// change).
//
// Database wiring: tests/helpers/postgres-api-server.cjs reads
// EVENTOUCH_TEST_DATABASE_URL once at require time, so this module maps the
// audit-specific variables onto it BEFORE loading the helper. CI passes
// portable localhost URLs; local runs use the approved socket URL.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WEB_BASE = (process.env.WEB_BASE || 'http://127.0.0.1:8777').replace(/\/+$/, '');
const WEB_BASE_EXPLICIT = Object.hasOwn(process.env, 'WEB_BASE');

// Isolated-test-only credential for UI form logins through the gateway.
// The harness accounts otherwise use an untypable hash; this password is
// disclosed because it only ever exists inside a dropped schema.
const FIXTURE_PASSWORD = 'Audit2026!test-only';

function resolveAuditDatabaseUrl() {
  return String(
    process.env.EVENTOUCH_A11Y_DATABASE_URL
    || process.env.EVENTOUCH_MOBILE_DATABASE_URL
    || process.env.EVENTOUCH_TEST_DATABASE_URL
    || ''
  ).trim();
}

function ensureAuditDatabaseEnv() {
  const url = resolveAuditDatabaseUrl();
  if (!url) {
    throw new Error('set EVENTOUCH_A11Y_DATABASE_URL (or EVENTOUCH_MOBILE_DATABASE_URL) to an isolated PostgreSQL database');
  }
  // The helper reads EVENTOUCH_TEST_DATABASE_URL at require time.
  process.env.EVENTOUCH_TEST_DATABASE_URL = url;
  return url;
}

// Require after ensureAuditDatabaseEnv() so the helper sees the mapped URL.
function loadHelpers() {
  const harnessHelpers = require('../tests/helpers/postgres-api-server.cjs');
  const { startWebApiGateway } = require('../tests/helpers/web-api-gateway.cjs');
  const { emptyWorkspace } = require('../server/state');
  const { hashPassword } = require('../server/auth');
  return { ...harnessHelpers, startWebApiGateway, emptyWorkspace, hashPassword };
}

function webDir() {
  return path.join(__dirname, '..', 'apps', 'web');
}

// The fixture serves the committed production artifact, never a dev server
// or an ad-hoc directory. A missing build fails loudly instead of auditing
// an unrelated tree.
function assertNextBuild(dir = webDir()) {
  const buildId = path.join(dir, '.next', 'BUILD_ID');
  const requiredFiles = path.join(dir, '.next', 'required-server-files.json');
  const missing = [buildId, requiredFiles].filter((file) => {
    try {
      return !fs.statSync(file).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length) {
    throw new Error(
      `audit fixture requires a production Next build (missing ${missing.join(', ')}); run 'npm --prefix apps/web run build' first`,
    );
  }
  return dir;
}

function nextBin(dir = webDir()) {
  const bin = path.join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  try {
    if (fs.statSync(bin).isFile()) return bin;
  } catch {
    // Fall through to the descriptive error below.
  }
  throw new Error(
    `audit fixture cannot find the Next launcher at ${bin}; run 'npm run setup' first`,
  );
}

function pickLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

// Starts `next start` for the existing production .next artifact with SSR bound to
// apiBase. Returns { baseUrl, close }. Only this child process is owned:
// close() signals it, escalates to SIGKILL on a bounded wait, and never
// touches unrelated processes or ports.
async function startOwnedNext({ apiBase, timeoutMs = 90000, dir } = {}) {
  if (!apiBase) throw new Error('startOwnedNext requires apiBase (the isolated harness URL)');
  const root = assertNextBuild(dir);
  const bin = nextBin(root);
  const port = await pickLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const remember = (chunk) => {
    output.push(String(chunk));
    while (output.join('\n').length > 20000) output.shift();
  };
  const child = spawn(process.execPath, [bin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: root,
    env: { ...process.env, EVENTOUCH_API_URL: apiBase, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  let exited = null;
  let spawnError = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  const childLog = () => output.join('\n').slice(-4000);

  async function close() {
    if (exited) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    if (!exited) {
      child.kill('SIGKILL');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  const startedAt = Date.now();
  let lastError = null;
  // Each readiness probe is bounded by the remaining overall deadline (at
  // most one short attempt), so a hung connection or stalled body can never
  // outlive nextTimeoutMs: headers and body share one AbortSignal per try.
  const REQUEST_CAP_MS = 10000;
  for (;;) {
    if (spawnError) {
      throw new Error(`audit fixture could not spawn the Next server: ${spawnError.message}`);
    }
    if (exited) {
      throw new Error(
        `audit fixture Next server exited before readiness (code=${exited.code} signal=${exited.signal}):\n${childLog()}`,
      );
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      await close().catch(() => {});
      throw new Error(
        `audit fixture Next server at ${baseUrl} was not ready within ${timeoutMs}ms`
        + ` (last: ${lastError && lastError.message}); log:\n${childLog()}`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, REQUEST_CAP_MS));
    try {
      const response = await fetch(`${baseUrl}/`, {
        headers: { connection: 'close' },
        signal: controller.signal,
      });
      await response.arrayBuffer();
      if (response.status < 500) {
        clearTimeout(timer);
        break;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (exited) {
        clearTimeout(timer);
        throw new Error(
          `audit fixture Next server exited before readiness (code=${exited.code} signal=${exited.signal}):\n${childLog()}`,
        );
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    baseUrl,
    port,
    childPid: child.pid,
    async close() {
      await close();
    },
  };
}

// Proves the owned Next server renders the isolated fixture through SSR
// before any audit runs: the register page server-fetches the harness, so a
// wrong EVENTOUCH_API_URL binding surfaces here as non-200 or as the
// not-found state instead of silently passing browser probes downstream.
async function verifyOwnedNextRendersFixture(owned, fixture, { timeoutMs = 20000 } = {}) {
  const url = `${owned.baseUrl}/event/${encodeURIComponent(fixture.slug)}/register`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { connection: 'close' }, signal: controller.signal });
    const body = await response.text().catch(() => '');
    if (response.status !== 200) {
      throw new Error(
        `audit fixture SSR check failed: GET ${url} -> ${response.status}; `
        + 'the owned Next server is not bound to the isolated API',
      );
    }
    if (!body.includes('registration-form')) {
      const hint = body.includes('신청할 수 없는 행사입니다')
        ? 'the register page rendered not-found (SSR is not reading the isolated fixture)'
        : 'the register page did not render its form (possible error boundary)';
      throw new Error(`audit fixture SSR check failed: ${hint}; GET ${url}`);
    }
  } catch (error) {
    if (error.message.startsWith('audit fixture SSR check failed')) throw error;
    throw new Error(`audit fixture SSR check failed: cannot reach owned Next at ${url}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function commandBody(command, payload) {
  return { commandId: `audit-${crypto.randomUUID()}`, command, payload };
}

async function seedAuditFixture(harness, helpers, { suffix = crypto.randomUUID().replace(/-/g, '') } = {}) {
  const { insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson, emptyWorkspace, hashPassword } = helpers;
  const eventId = `audit-event-${suffix}`.toLowerCase();
  const slug = eventId;
  const managerId = `audit-manager-${suffix}`.toLowerCase();
  const staffId = `audit-staff-${suffix}`.toLowerCase();
  const managerEmail = `${managerId}@example.test`;
  const staffEmail = `${staffId}@example.test`;

  // A configured product has an organization owner before event managers and
  // staff sign in. Keep that real install invariant in browser fixtures too.
  await insertAccount(harness.database, { id: `audit-owner-${suffix}`, role: 'AGENCY', name: '감사 조직 운영자', email: `audit-owner-${suffix}@example.test` });
  await insertAccount(harness.database, { id: managerId, role: 'MANAGER', name: '감사 운영자', email: managerEmail });
  await insertAccount(harness.database, { id: staffId, role: 'STAFF', name: '감사 스태프', email: staffEmail });
  // UI logins type the fixture password; cookie logins use sessions.
  const passwordHash = hashPassword(FIXTURE_PASSWORD);
  await harness.database.query('UPDATE accounts SET password_hash=$1 WHERE id=ANY($2)', [passwordHash, [managerId, staffId]]);

  await insertEvent(harness.database, {
    id: eventId,
    slug,
    payload: {
      id: eventId, slug, name: '감사 검증 행사', stage: 'LIVE',
      date: '2027-01-16', start: '09:00', end: '17:00', capacity: 200,
      features: ['draw', 'poll', 'reward', 'screen', 'venue'],
    },
    workspace: emptyWorkspace(),
  });
  await insertMembership(harness.database, managerId, eventId, ['all']);

  const managerCookie = await sessionCookie(harness, managerId);
  const staffCookie = await sessionCookie(harness, staffId);
  const asManager = async (command, payload) => {
    const response = await requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: managerCookie, body: commandBody(command, payload),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`seed ${command}: ${response.status} ${JSON.stringify(response.json)}`);
    }
    return response.json;
  };

  const rows = [];
  for (let index = 1; index <= 8; index += 1) {
    rows.push({ name: `감사 참가자 ${index}`, phone: `0100000${String(index).padStart(4, '0')}`, company: `감사 업체 ${(index - 1) % 4 + 1}` });
  }
  await asManager('participant.import', { rows });
  const desk = (await asManager('desk.save', { name: '감사 입장 데스크', action: 'IN', mode: 'desk', open: true })).desk;
  await insertAssignment(harness.database, { id: `audit-assign-${suffix}`.toLowerCase(), accountId: staffId, eventId, type: 'DESK', targetId: desk.id });
  await asManager('notice.save', { title: '감사 안내', body: '행사장 입구는 동문입니다.' });
  await asManager('form.publish', {});

  return {
    suffix, eventId, slug, deskId: desk.id,
    manager: { id: managerId, email: managerEmail, password: FIXTURE_PASSWORD, cookie: managerCookie },
    staff: { id: staffId, email: staffEmail, password: FIXTURE_PASSWORD, cookie: staffCookie },
  };
}

// Boots harness + seed + owned Next + gateway. Close with fixture.close(),
// which unwinds gateway -> owned Next -> harness and only those three.
// fixture.gateway / fixture.harness stay exposed for compatibility.
async function startAuditFixture({ webBase, loseFirstResponseFor = null, nextTimeoutMs = 90000 } = {}) {
  const requestedWebBase = webBase !== undefined ? String(webBase).replace(/\/+$/, '') : null;
  if (requestedWebBase || WEB_BASE_EXPLICIT) {
    process.stderr.write(
      `[audit-fixture] WEB_BASE ${requestedWebBase || WEB_BASE} is superseded: `
      + 'audits run against an isolated Next server bound to the isolated API, never an externally running build\n',
    );
  }
  ensureAuditDatabaseEnv();
  const helpers = loadHelpers();
  const harness = await helpers.startApiHarness();
  let owned = null;
  let gateway = null;
  try {
    const fixture = await seedAuditFixture(harness, helpers);
    owned = await startOwnedNext({ apiBase: harness.baseUrl, timeoutMs: nextTimeoutMs });
    await verifyOwnedNextRendersFixture(owned, fixture);
    gateway = await helpers.startWebApiGateway({ apiBase: harness.baseUrl, webBase: owned.baseUrl, loseFirstResponseFor });
    const result = {
      ...fixture, harness, helpers, web: owned, gateway,
      baseUrl: gateway.baseUrl, webBase: owned.baseUrl, requestedWebBase,
    };
    result.close = async () => {
      const errors = [];
      await gateway.close().catch((error) => errors.push(error));
      await owned.close().catch((error) => errors.push(error));
      await harness.close().catch((error) => errors.push(error));
      if (errors.length) {
        throw new Error(`audit fixture close failed: ${errors.map((error) => error.message).join('; ')}`);
      }
    };
    return result;
  } catch (error) {
    if (gateway) await gateway.close().catch(() => {});
    if (owned) await owned.close().catch(() => {});
    await harness.close().catch(() => {});
    throw error;
  }
}

// The six real product routes every layout/accessibility audit covers.
function auditRoutes(fixture) {
  const { slug, eventId } = fixture;
  return [
    { name: 'home', path: '/' },
    { name: 'attendee-home', path: `/event/${slug}/home` },
    { name: 'register', path: `/event/${slug}/register` },
    { name: 'screen', path: `/screen/${slug}` },
    { name: 'staff', path: `/staff/events/${eventId}`, auth: 'staff' },
    { name: 'console-participants', path: `/console/events/${eventId}/participants`, auth: 'manager' },
  ];
}

// Semantic readiness per audited route: selectors that only the genuinely
// loaded screen shows, plus product copy whose presence proves the wrong
// state rendered (not-found, closed, load failure). Returns null for
// intentional error states (unknown slugs, anon views), which audits cover
// without a loaded-screen gate.
function routeReadiness(name) {
  switch (name) {
    case 'home':
      return { expect: ['#home-title'], forbidText: [] };
    case 'event':
      return { expect: ['main.public-event-page h1'], forbidText: [] };
    case 'attendee-home':
      return { expect: ['nav[aria-label="참가 메뉴"]'], forbidText: ['행사를 불러올 수 없습니다'] };
    case 'register':
      return {
        expect: ['form.registration-form', '#field-name', 'form.registration-form button[type="submit"]'],
        forbidText: ['신청할 수 없는 행사입니다', '현재 신청을 받지 않습니다.'],
      };
    case 'screen':
      return { expect: ['.display-board'], forbidText: ['행사를 찾을 수 없습니다'] };
    case 'staff':
      return { expect: ['#staff-desk'], forbidText: ['이 행사에 대한 업무 배정이 없습니다'] };
    case 'console-participants':
      return {
        expect: ['input[placeholder*="이름·소속·연락처 검색"]'],
        forbidText: ['참가자 목록을 불러오지 못했습니다.'],
      };
    default:
      return null;
  }
}

const ERROR_BOUNDARY_TEXT = ['Application error', 'Something went wrong', 'Minified React'];

// Gates a Playwright page on the real target screen: rejects login
// redirects, error boundaries, and not-found/closed states before callers
// run axe or overflow probes, so those probes can never pass on the wrong
// page. Unknown slugs and other intentional error states return without
// gating. Throws a descriptive error naming the route, the missing marker,
// the current URL, and a short body-text excerpt.
async function assertAuditRoute(page, routeOrName, { timeoutMs = 15000 } = {}) {
  const name = typeof routeOrName === 'string' ? routeOrName : routeOrName && routeOrName.name;
  const readiness = routeReadiness(name);
  if (!readiness) return;
  const url = page.url();
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const expectedPath = typeof routeOrName === 'object' && routeOrName && typeof routeOrName.path === 'string'
    ? routeOrName.path
    : null;
  if (expectedPath && pathname !== expectedPath) {
    throw new Error(
      `[audit-fixture] ${name}: expected to stay on ${expectedPath} but landed on ${pathname} `
      + '(likely a login redirect or not-found reroute)',
    );
  }
  const bodyExcerpt = await page.evaluate(
    () => document.body.innerText.slice(0, 300).replace(/\s+/g, ' '),
  ).catch(() => '');
  const forbid = [...ERROR_BOUNDARY_TEXT, ...readiness.forbidText];
  for (const text of forbid) {
    const count = await page.getByText(text, { exact: false }).count().catch(() => 0);
    if (count > 0) {
      throw new Error(
        `[audit-fixture] ${name}: rendered the wrong state (found ${JSON.stringify(text)}) `
        + `at ${url}; excerpt: ${JSON.stringify(bodyExcerpt)}`,
      );
    }
  }
  const runtimeError = await page.locator('#runtime-error:not([hidden])').count().catch(() => 0);
  if (runtimeError > 0) {
    throw new Error(`[audit-fixture] ${name}: runtime error marker is visible at ${url}`);
  }
  for (const selector of readiness.expect) {
    try {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new Error(
        `[audit-fixture] ${name}: expected loaded marker ${JSON.stringify(selector)} not visible `
        + `at ${url} within ${timeoutMs}ms; excerpt: ${JSON.stringify(bodyExcerpt)}`,
      );
    }
  }
}

function cookieForContext(fixture, which) {
  const cookie = which === 'staff' ? fixture.staff.cookie : fixture.manager.cookie;
  return { name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), httpOnly: true, sameSite: 'Lax' };
}

module.exports = {
  WEB_BASE,
  FIXTURE_PASSWORD,
  resolveAuditDatabaseUrl,
  ensureAuditDatabaseEnv,
  loadHelpers,
  webDir,
  assertNextBuild,
  startOwnedNext,
  verifyOwnedNextRendersFixture,
  seedAuditFixture,
  startAuditFixture,
  auditRoutes,
  routeReadiness,
  assertAuditRoute,
  cookieForContext,
};
