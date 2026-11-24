'use strict';

// EVENTOUCH product server: API-only + service-worker retirement.
// The product UI is the Next app (apps/web); this server answers /api/* and
// serves no repository files. /sw.js stays at this origin so browsers holding
// the retired offline worker receive the cleanup worker (server/sw.js).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store');
const { createDatabase } = require('./db');
const { createDatabaseAuth } = require('./auth');
const { createAccess } = require('./access');
const { createState } = require('./state');
const { createPublicEvents } = require('./public-events');
const { createParticipantCommands } = require('./commands/participants');
const { createOperationsCommands } = require('./commands/operations');
const { createDomainCommands } = require('./commands/domain');
const { createFileService } = require('./files');
const { createFileStorage } = require('./file-storage');
const { handleApi } = require('./api');
const { applySecurityHeaders, failureMessage } = require('./http');
const genericMessaging = require('./messaging');
const solapi = require('./messaging-solapi');
const { drainMessageOutbox } = require('./message-outbox');
const { createAttendeeAccess, attendeeCookie } = require('./attendees');
const { createVerificationTransport } = require('./verification-transport');
const { createEmailTransport } = require('./email-transport');
const { createAccountRecovery } = require('./account-recovery');
const { attachOrgRequest, stampOrgHeaders } = require('./tenancy');
const { createSignupProtection } = require('./signup-protection.ts');
const { createRequestObservability } = require('./request-observability.ts');
const { developmentLoginEmail, createClientAddressResolver } = require('./runtime-security.ts');
const { maintenanceConfig, runMessageMaintenance } = require('./message-maintenance');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8776);

// Retirement worker served at this origin's /sw.js (see server/sw.js). Read
// once at startup: this is the single bounded file read the server performs.
// Nothing else on disk is ever answered.
const RETIREMENT_WORKER = fs.readFileSync(path.join(__dirname, 'sw.js'));

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function notFoundApi(res) {
  sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
}

// The Fastify boundaries require a decodable URL; the legacy router parsed
// segments itself and kept answering malformed requests by branch. Those
// stay on the legacy router.
function decodablePath(urlPath) {
  try {
    decodeURIComponent(urlPath);
    return true;
  } catch {
    return false;
  }
}

// Session lookup shared by every Fastify boundary: the account carries the
// tab's org headers as request-scoped hints (verified per transaction).
function sessionWithOrg(auth, cookieHeader, req) {
  return auth.sessionFromCookie(cookieHeader).then((account) => attachOrgRequest(account, req));
}

// Sliding sessions: when this request's session was just extended on the
// server, the response carries the same cookie with a fresh Max-Age so the
// browser keeps it as long as the database does. A response that already sets
// its own session cookie (login, logout) is never touched.
function refreshSessionCookieOnResponse(auth, req, res) {
  if (!auth || typeof auth.takeSessionCookieRefresh !== 'function') return;
  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithSessionRefresh(...args) {
    res.writeHead = writeHead;
    try {
      const explicit = args.find((value) => value && typeof value === 'object' && !Array.isArray(value));
      const hasCookie = res.hasHeader('set-cookie') ||
        (explicit && Object.keys(explicit).some((name) => name.toLowerCase() === 'set-cookie'));
      const refreshed = auth.takeSessionCookieRefresh(req.headers.cookie);
      if (refreshed && !hasCookie) res.setHeader('set-cookie', refreshed);
    } catch (error) {
      // A cookie refresh must never break the response.
    }
    return writeHead.apply(this, args);
  };
}

// Response stamping shared by every boundary: only the request-start verified
// snapshot (org + session revision) is ever stamped, never a default.
function stampSessionOrg(target, account) {
  const set = typeof target.header === 'function'
    ? (name, value) => target.header(name, value)
    : (name, value) => target.setHeader(name, value);
  return stampOrgHeaders(set, account);
}

function createHttpServer(store, auth, access, database, { storageDir, fileStorage, env = process.env, logWriter, messageMaintenance } = {}) {
  const observations = createRequestObservability({ env, write: logWriter });
  const state = database ? createState(database, { env }) : null;
  const publicEvents = database ? createPublicEvents(database) : null;
  const participantCommands = database ? createParticipantCommands(database) : null;
  const operationsCommands = database ? createOperationsCommands(database) : null;
  // Which provider is active is decided by what is configured. Solapi is the
  // production path; the generic provider stays for tests and for any vendor
  // reachable through a translation shim. Absent credentials leave every
  // campaign in its recorded, non-sending state.
  const messaging = genericMessaging.activeProvider(env);
  const messagingStatus = genericMessaging.activeMessagingState(env);
  // This is process-local observation, not a guarantee of provider delivery
  // or the state of another replica. No campaign or tenant data is exposed.
  const maintenance = messageMaintenance || {
    config: maintenanceConfig(env), workerStarted: false, lastAttemptAt: null, lastResult: 'never',
  };
  const storage = database ? (fileStorage || createFileStorage({ storageDir, env })) : null;
  const domainCommands = database ? createDomainCommands(database, { messaging, fileStorage: storage }) : null;
  const files = database ? createFileService(database, { fileStorage: storage }) : null;
  // Attendee verification transport: Solapi when credentials exist, explicit
  // mock (EVENTOUCH_SMS_MOCK=1) for development/tests/demo, honest 503
  // otherwise. Verification codes are never returned to HTTP clients.
  const verificationTransport = createVerificationTransport({ env });
  const attendeeAccess = database ? createAttendeeAccess(database, { transport: verificationTransport }) : null;
  // First Fastify increment: /api/health is served through the route
  // boundary (server/fastify/health.ts). Same shape, same headers — the
  // security wrapper above already ran, Fastify only fills the body.
  const { buildHealthApp } = require('./fastify/health.ts');
  const healthApp = buildHealthApp({
    getMessaging: () => ({
      connected: messagingStatus.connected,
      provider: messagingStatus.provider || null,
    }),
    getVerificationMode: () => verificationTransport.state().mode,
    // Health is public. Global queue depth would reveal activity from every
    // tenant; the authenticated diagnostics route reports only its own org.
    countOutbox: null,
    includeDevLogin: Boolean(env.EVENTOUCH_DEV_QUICK_LOGIN),
  });
  const healthReady = healthApp.ready();
  // Second Fastify increment: public reads (server/fastify/public-reads.ts).
  // Only GET requests under /api/public delegate; verification codes and
  // guest photo uploads keep using the legacy router until their slice moves.
  const { buildPublicReadsApp } = require('./fastify/public-reads.ts');
  const publicReadsApp = buildPublicReadsApp({
    events: publicEvents,
    resolveSession: attendeeAccess ? (cookie) => attendeeAccess.resolveSession(cookie) : null,
    readPublicFile: files ? (input) => files.readPublic(input) : null,
    failureMessage,
  });
  const publicReadsReady = publicReadsApp.ready();
  // Third Fastify increment: organization-scope REST (events, clients,
  // permissions, members). Database mode only — without a database those
  // paths belong to the JSON fallback router, which keeps them.
  const { buildOrganizationRestApp, organizationRestPath } = require('./fastify/organization-rest.ts');
  const organizationRestApp = buildOrganizationRestApp({
    sessionFromCookie: (cookie, req) => sessionWithOrg(auth, cookie, req),
    stampOrgHeaders: (reply, account) => stampSessionOrg(reply, account),
    loadBootstrap: (account) => state.loadBootstrap(account),
    createEvent: (account, body) => state.createEvent(account, body),
    duplicateEvent: (account, eventId, body) => state.duplicateEvent(account, eventId, body),
    saveClient: (account, body) => state.saveClient(account, body),
    saveOrgPermissions: (account, accountId, body) => state.saveOrgPermissions(account, accountId, body),
    assignMember: (account, eventId, body) => state.assignMember(account, eventId, body),
    failureMessage,
  });
  const organizationRestReady = organizationRestApp.ready();
  const { buildScopedReadsApp, scopedReadsPath } = require('./fastify/scoped-reads.ts');
  const scopedReadsApp = buildScopedReadsApp({
    sessionFromCookie: (cookie, req) => sessionWithOrg(auth, cookie, req),
    stampOrgHeaders: (reply, account) => stampSessionOrg(reply, account),
    loadDirectory: (account) => state.loadDirectory(account),
    loadEventBootstrap: async (account, eventId, ifVersion, messageRecipientReview, messageAttentionSummary, messageVersionOnly, messageChangeId) => {
      const result = await state.loadEventBootstrap(account, eventId, ifVersion, messageVersionOnly);
      if (result.unchanged || result.changed) return messageAttentionSummary || messageRecipientReview
        ? { ...result, messageReadObservedAt: new Date().toISOString() }
        : result;
      if (result.viewer.role === 'STAFF') return messageChangeId ? { messageChangeReview: { status: 'unavailable' } } : messageAttentionSummary
        ? { refreshVersion: result.refreshVersion, messageAttentionSummary: { available: false } }
        : result;
      const eligible = String(result.viewer.organizationId) === String(require('./tenancy').LEGACY_ORG_ID);
      const workspace = result.workspaces[eventId];
      const messages = Array.isArray(workspace?.messages) ? workspace.messages : [];
      const { dueScheduleGuards, messageRecipientChangeAssessment, recipientReviewVersion, ticketLinkGuard, smsCharacterGuard, explicitScheduleInstant } = require('./commands/content-results');
      if (messageChangeId) {
        const message = messages.find(item => item && item.id === messageChangeId && item.simulate !== true && ['SCHEDULED', 'NEEDS_CONNECTION'].includes(item.status));
        if (!message) return { messageChangeReview: { status: 'unavailable' } };
        const assessment = messageRecipientChangeAssessment(message, workspace, { details: true });
        return { messageChangeReview: { id: messageChangeId, observedAt: new Date().toISOString(),
          status: assessment.count ? 'changed' : 'unchanged',
          ...(assessment.count ? { count: assessment.count, details: { available: assessment.available, changes: assessment.changes } } : {}) } };
      }
      const recipientReviewVersions = messageRecipientReview && !messageAttentionSummary && Array.isArray(workspace?.participants)
        ? Object.fromEntries(workspace.participants.flatMap(person => person && typeof person.id === 'string' && person.cancelled !== true && String(person.status || '').toUpperCase() !== 'CANCELLED'
          ? [[person.id, recipientReviewVersion(person)]] : []))
        : undefined;
      const blocked = messages.flatMap((message) => {
        if (!message || message.simulate === true || typeof message.id !== 'string' ||
            !['SCHEDULED', 'NEEDS_CONNECTION'].includes(message.status)) return [];
        if (message.status === 'SCHEDULED' && workspace.auditAvailable === false) {
          return [{ id: message.id, reason: 'AUDIT_UNAVAILABLE' }];
        }
        const assessment = messageRecipientReview ? messageRecipientChangeAssessment(message, workspace) : null;
        const event = Array.isArray(result.events) ? result.events.find(item => item?.id === eventId) : null;
        const characterGuard = smsCharacterGuard(message, workspace, { event, providerKind: eligible ? messagingStatus?.provider : null });
        if (assessment?.count && characterGuard) return [{ id: message.id, reason: characterGuard.reason, missing: characterGuard.missing, field: characterGuard.field }];
        if (assessment?.count) return [{ id: message.id, reason: 'RECIPIENT_CHANGED', missing: assessment.count }];
        const ticketGuard = ticketLinkGuard(message, workspace);
        if (ticketGuard) return [{ id: message.id, reason: ticketGuard.reason, missing: ticketGuard.missing }];
        if (characterGuard) return [{ id: message.id, reason: characterGuard.reason, missing: characterGuard.missing, field: characterGuard.field }];
        if (message.status !== 'SCHEDULED') return [];
        const guard = dueScheduleGuards(message, workspace, { event, providerKind: eligible ? messagingStatus?.provider : null });
        return guard && ['NO_PUBLIC_ORIGIN', 'LUCKY_NUMBER_MISSING', 'INVALID_SCHEDULE'].includes(guard.reason)
          ? [{ id: message.id, reason: guard.reason, missing: guard.missing }] : [];
      });
      if (messageAttentionSummary) return {
        refreshVersion: result.refreshVersion,
        messageAttentionSummary: {
          available: true,
          blocked: blocked.length > 0,
          nextScheduledAt: messages.reduce((earliest, message) => {
            const instant = message?.status === 'SCHEDULED' ? explicitScheduleInstant(message.scheduled) : NaN;
            return Number.isFinite(instant) && (earliest === null || instant < earliest) ? instant : earliest;
          }, null),
          observedAt: new Date().toISOString(),
        },
      };
      return { ...result, recipientReviewVersions, messageSchedule: {
        observedAt: new Date().toISOString(),
        autoConfigured: eligible && Boolean(maintenance.config.enabled && maintenance.config.autoSendDue),
        eligibleForAuto: eligible,
        workerStarted: eligible && maintenance.workerStarted === true,
        lastAttemptAt: eligible ? maintenance.lastAttemptAt : null,
        lastResult: eligible ? maintenance.lastResult : 'never',
        blocked,
      } };
    },
    failureMessage,
  });
  const scopedReadsReady = scopedReadsApp.ready();
  // Fourth Fastify increment: the participant command path (signup and the
  // event command dispatcher). Database mode only, like the organization
  // boundary; the JSON fallback keeps its legacy router.
  const { buildCommandPathApp, commandPathPath } = require('./fastify/command-path.ts');
  const commandPathApp = buildCommandPathApp({
    participantCommands,
    operationsCommands,
    domainCommands,
    access,
    sessionFromCookie: (cookie, req) => sessionWithOrg(auth, cookie, req),
    attendeeCookie,
    failureMessage,
    guardSignup: database ? createSignupProtection(database, env) : undefined,
  });
  const commandPathReady = commandPathApp.ready();
  // Auxiliary CSRF defense (defense in depth; cookies/CORS stay as they
  // are). The product is same-origin: every browser write flows through the
  // Next rewrite, so a browser-issued state-changing /api request always
  // carries `Sec-Fetch-Site: same-origin`. A present-but-foreign value
  // (cross-site, same-site, none) on POST/PUT/PATCH/DELETE is denied here.
  // Absent headers (curl, tests, non-browser API clients) still pass, and
  // GET/HEAD (public slug reads, health, images) are never gated, so normal
  // flows cannot break on this check.
  function fetchSiteAllowed(req) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    const urlPath = String(req.url || '').split('?')[0];
    if (!urlPath.startsWith('/api/')) return true;
    const site = req.headers['sec-fetch-site'];
    if (site === undefined || site === null || String(site).trim() === '') return true;
    return String(site).trim().toLowerCase() === 'same-origin';
  }

  const server = http.createServer((req, res) => {
    observations.attach(req, res);
    if (!fetchSiteAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '허용되지 않은 요청 경로입니다' }));
      return;
    }
    // One security-header wrapper per response. Every path below — /api/*,
    // /api/auth/*, /sw.js, 404, 405, 500 — therefore carries the same policy
    // without each call site having to remember it.
    applySecurityHeaders(res);
    refreshSessionCookieOnResponse(auth, req, res);
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/diagnostics' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store');
      auth.sessionFromCookie(req.headers.cookie).then(async account => {
        if (!account) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        if (account.role !== 'AGENCY') {
          const code = account.orgSelectionRequired ? 'ORGANIZATION_CONTEXT_CHANGED' : undefined;
          return sendJson(res, account.orgSelectionRequired ? 409 : 403,
            code ? { error: '조직을 선택하세요', code } : { error: '권한을 확인하세요' });
        }
        // Isolation: the process metric map is GLOBAL (all orgs' request
        // volume), so it must never reach an org owner. Until per-org
        // metrics ship and are verified, HTTP exposes only the shared
        // release/startedAt tech facts, the liveness facts, and the caller's
        // own org context. The full counters stay process-private (platform
        // stdout/stderr only, existing templates, no org PII or tokens).
        res.setHeader('cache-control', 'no-store');
        const full = observations.snapshot();
        const { resolveActorOrg } = require('./tenancy');
        const pending = await database.transaction(async client => {
          const org = await resolveActorOrg(client, account, { write: false });
          if (org.role !== 'AGENCY') throw Object.assign(new Error('권한을 확인하세요'), { status: 403 });
          const result = await client.query(
            `SELECT count(*)::int AS pending FROM message_outbox m
             JOIN events e ON e.id = m.event_id
             WHERE e.org_id = $1 AND m.status IN ('PENDING', 'SENDING') AND m.next_attempt_at <= now()`,
            [org.orgId]
          );
          return result.rows[0].pending;
        });
        stampSessionOrg(res, account);
        sendJson(res, 200, {
          release: full.release,
          startedAt: full.startedAt,
          draining: server.eventouchDraining === true,
          trustedProxyConfigured: Boolean(String(env.EVENTOUCH_TRUSTED_PROXIES || '').trim()),
          organizationId: account.organizationId || null,
          organizationName: account.organizationName || null,
          contextVersion: account.contextVersion ?? null,
          outboxPending: pending,
        });
      }).catch(error => sendJson(res, error.status || 500, {
        error: failureMessage(error, '상태를 확인하지 못했습니다'),
        ...(error.code ? { code: error.code } : {}),
      }));
      return;
    }
    if (urlPath === '/api/health') {
      healthReady.then(
        () => healthApp.routing(req, res),
        () => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '상태를 확인할 수 없습니다' }));
        }
      );
      return;
    }
    // Readiness is separate from liveness: /api/health answers while the
    // process is up, but a backup/restore or a database outage must show up
    // here so an operator (or the container healthcheck) can tell the
    // difference. The JSON fallback mode has no database and is not a
    // production-ready deployment.
    if (urlPath === '/api/readyz') {
      if (server.eventouchDraining) {
        res.setHeader('cache-control', 'no-store');
        return sendJson(res, 503, { ok: false, draining: true });
      }
      if (!database) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, db: false }));
        return;
      }
      database.query('SELECT 1').then(
        async () => {
          try { await storage.ready(); }
          catch { return sendJson(res, 503, { ok: false, db: true, storage: false }); }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, db: true }));
        },
        () => {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, db: false }));
        }
      );
      return;
    }
    if ((urlPath === '/api/public' || urlPath.startsWith('/api/public/')) && req.method === 'GET') {
      publicReadsReady.then(
        () => publicReadsApp.routing(req, res),
        () => sendJson(res, 500, { error: '요청을 처리하지 못했습니다' })
      );
      return;
    }
    if (urlPath === '/api/' || urlPath.startsWith('/api/')) {
      // Undecodable paths never reach the Fastify boundaries: their legacy
      // answers depend on bodies and sessions, so the hand-rolled router keeps
      // answering them exactly as before.
      if (state && decodablePath(urlPath)) {
        if (scopedReadsPath(urlPath, req.method)) {
          scopedReadsReady.then(
            () => scopedReadsApp.routing(req, res),
            () => sendJson(res, 500, { error: '요청을 처리하지 못했습니다' })
          );
          return;
        }
        if (organizationRestPath(urlPath, req.method)) {
          organizationRestReady.then(
            () => organizationRestApp.routing(req, res),
            () => sendJson(res, 500, { error: '요청을 처리하지 못했습니다' })
          );
          return;
        }
        if (commandPathPath(urlPath, req.method)) {
          commandPathReady.then(
            () => commandPathApp.routing(req, res),
            () => sendJson(res, 500, { error: '요청을 처리하지 못했습니다' })
          );
          return;
        }
      }
      if (urlPath.startsWith('/api/auth/')) {
        auth.handleAuth(req, res, urlPath).catch(() => {
          sendJson(res, 500, { error: '요청을 처리하지 못했습니다' });
        });
        return;
      }
      handleApi(req, res, store, urlPath, {
        auth,
        access,
        state,
        publicEvents,
        participantCommands,
        operationsCommands,
        domainCommands,
        files,
        attendeeAccess,
        database,
      }).catch(() => {
        sendJson(res, 500, { error: '요청을 처리하지 못했습니다' });
      });
      return;
    }
    // No repository files are served. The only non-API route is the worker
    // retirement URL: same path the old offline shell registered, now
    // answering the cleanup worker that deletes its caches and unregisters.
    if (urlPath === '/sw.js') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('지원하지 않는 방법입니다');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      });
      res.end(RETIREMENT_WORKER);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('지원하지 않는 방법입니다');
      return;
    }
    // Bounded non-API answer: fixed plain-text body, no path echo, no
    // repository read. data/sample.json stays a backend fallback on disk and
    // is no longer addressable over HTTP.
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('파일을 찾을 수 없습니다');
  });
  server.eventouchDraining = false;
  return server;
}

async function startServer() {
  // Reject an unsafe/malformed runtime before opening or migrating a database.
  developmentLoginEmail();
  createClientAddressResolver();
  const fileStorage = createFileStorage();
  await fileStorage.ready();
  const database = createDatabase();
  try {
    await database.migrate();
    // Explicit SMTP or development mock only. Configuration readiness does
    // not assert delivery; bearer tokens and provider errors are never logged.
    const emailTransport = createEmailTransport();
    const accountRecovery = createAccountRecovery(database, { transport: emailTransport });
    const auth = createDatabaseAuth(database, { recovery: accountRecovery });
    const access = createAccess(database);
    const seedStatus = await auth.seedAdmin();
    if (seedStatus === 'unconfigured') {
      process.stderr.write('[eventouch] administrator is not configured; login is disabled\n');
    }
    const store = openStore(process.env.DATA_DIR || path.join(ROOT, 'data', 'server'));
    const messageConfig = maintenanceConfig();
    const messageMaintenance = { config: messageConfig, workerStarted: false, lastAttemptAt: null, lastResult: 'never', cursor: { afterId: '' }, resolutionCursor: { afterId: '' } };
    const server = createHttpServer(store, auth, access, database, { messageMaintenance, fileStorage });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // A supervised local web/API pair pins the API to loopback. Standalone
      // and container deployments keep Node's existing all-interface default
      // unless their own deployment configuration supplies an address.
      const bindAddress = String(process.env.EVENTOUCH_API_BIND || '').trim() || undefined;
      server.listen(PORT, bindAddress, () => {
        server.removeListener('error', reject);
        process.stdout.write(`eventouch server on ${PORT}\n`);
        resolve();
      });
    });
    // Replay dispatch intents queued before a previous shutdown (crash
    // between commit and provider call). Fire-and-forget by design: a drain
    // failure must not take down boot, and leftovers are retried next boot.
    const bootDrain = drainMessageOutbox(database, genericMessaging.activeProvider(), { fileStorage }).then(
      (result) => {
        if (result && (result.dispatched || result.settled)) {
          process.stdout.write(
            `[eventouch] outbox drain: dispatched=${result.dispatched} settled=${result.settled}\n`
          );
        }
      },
      (error) => {
        process.stderr.write('[eventouch] outbox drain failed: ' + (error && error.message) + '\n');
      }
    );
    let maintenanceRun = null;
    const interval = Number(process.env.EVENTOUCH_MESSAGE_MAINTENANCE_INTERVAL_MS || 60000);
    const maintenanceTimer = messageConfig.enabled ? setInterval(() => {
      if (maintenanceRun) return;
      messageMaintenance.lastAttemptAt = new Date().toISOString();
      messageMaintenance.lastResult = 'running';
      maintenanceRun = runMessageMaintenance(database, genericMessaging.activeProvider(), { ...messageConfig, fileStorage, cursor: messageMaintenance.cursor, resolutionCursor: messageMaintenance.resolutionCursor })
        .then((result) => { messageMaintenance.lastResult = result.skipped ? 'skipped' : 'ok'; })
        .catch(() => { messageMaintenance.lastResult = 'failed'; process.stderr.write('[eventouch] message maintenance failed; queued work is retained\n'); })
        .finally(() => { maintenanceRun = null; });
    }, Number.isFinite(interval) ? Math.min(3600000, Math.max(1000, interval)) : 60000) : null;
    messageMaintenance.workerStarted = Boolean(maintenanceTimer);
    maintenanceTimer?.unref();
    let closing = null;
    const close = () => {
      if (closing) return closing;
      server.eventouchDraining = true;
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      messageMaintenance.workerStarted = false;
      closing = (async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await bootDrain;
        if (maintenanceRun) await maintenanceRun;
        await database.close();
      })();
      return closing;
    };
    return { server, database, close };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  startServer().then(({ close }) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 30000);
      deadline.unref();
      close().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(deadline));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch((error) => {
    const code = error && error.code ? ` (${error.code})` : '';
    process.stderr.write(`[eventouch] startup failed${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = { startServer, createHttpServer };
