'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { testDatabaseUrl } = require('./postgres-test.cjs');
const { createDatabase } = require('../../server/db');
const { createDatabaseAuth, hashPassword } = require('../../server/auth');
const { createAccess } = require('../../server/access');
const { openStore } = require('../../server/store');
const { createHttpServer } = require('../../server/server');
const { createEmailTransport } = require('../../server/email-transport');
const { createAccountRecovery } = require('../../server/account-recovery');

const databaseUrl = testDatabaseUrl();
const testPasswordHash = hashPassword('not-a-real-test-password');

async function startApiHarness({ storageDir, env } = {}) {
  if (!databaseUrl) throw new Error('EVENTOUCH_TEST_DATABASE_URL is required');
  const schema = `eventouch_api_test_${crypto.randomUUID().replace(/-/g, '')}`;
  const adminDatabase = createDatabase({ connectionString: databaseUrl });
  let schemaCreated = false;
  let database = null;
  let dataDir = null;
  let server = null;
  try {
    await adminDatabase.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase({ connectionString: scopedUrl.toString() });
    await database.migrate();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-api-test-'));
    // Self-service recovery wiring mirrors server.js: a standards-neutral
    // mail seam with NO provider selected. Tests opt into the loopback fake
    // mail by passing env { EVENTOUCH_MAIL_MOCK: '1',
    // EVENTOUCH_PUBLIC_URL: 'http://...' }; without it the transport stays
    // mode 'none' and delivery-dependent paths answer honestly/generically.
    const harnessEnv = { ...process.env, ...(env || {}) };
    const emailTransport = createEmailTransport({ env: harnessEnv });
    const recovery = createAccountRecovery(database, { transport: emailTransport, env: harnessEnv });
    const auth = createDatabaseAuth(database, { recovery });
    server = createHttpServer(openStore(dataDir), auth, createAccess(database), database, { storageDir: storageDir || path.join(dataDir, 'storage'), env });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    return {
      database,
      auth,
      dataDir,
      baseUrl: `http://127.0.0.1:${address.port}`,
      async restartHttp() {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server = createHttpServer(openStore(dataDir), auth, createAccess(database), database,
          { storageDir: storageDir || path.join(dataDir, 'storage'), env });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(address.port, '127.0.0.1', resolve);
        });
      },
      async close() {
        server.closeAllConnections();
        try {
          await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        } finally {
          await database.close();
          try {
            await adminDatabase.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await adminDatabase.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (database) await database.close();
    if (schemaCreated) await adminDatabase.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminDatabase.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

// Fixture accounts are explicit about their org: there is no default legacy
// fallthrough (use LEGACY_ORG for single-org setups). The membership row is
// the authority the server reads; accounts.role mirrors it for fixtures.
const LEGACY_ORG = 'org-legacy';

async function insertAccount(database, { id, role, name, email, orgPermissions = [], orgId }) {
  if (!orgId) throw new Error('insertAccount requires an explicit orgId');
  await database.query(
    `INSERT INTO accounts (id, email, name, role, password_hash, org_permissions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, email, name, role, testPasswordHash, JSON.stringify(orgPermissions)]
  );
  await database.query(
    `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
     VALUES ($1, $2, $3, true, $4::jsonb)
     ON CONFLICT (org_id, account_id) DO NOTHING`,
    [orgId, id, role, JSON.stringify(orgPermissions)]
  );
}

async function insertEvent(database, { id, slug, payload, workspace, orgId }) {
  if (!orgId) throw new Error('insertEvent requires an explicit orgId');
  await database.query(
    'INSERT INTO events (id, slug, payload, org_id) VALUES ($1, $2, $3::jsonb, $4)',
    [id, slug, JSON.stringify(payload), orgId]
  );
  await database.query(
    'INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)',
    [id, JSON.stringify(workspace)]
  );
}

async function insertMembership(database, accountId, eventId, write = []) {
  await database.query(
    'INSERT INTO memberships (account_id, event_id, write_permissions) VALUES ($1, $2, $3::jsonb)',
    [accountId, eventId, JSON.stringify(write)]
  );
}

async function insertAssignment(database, { id, accountId, eventId, type, targetId, active = true }) {
  await database.query(
    `INSERT INTO staff_assignments (id, account_id, event_id, type, target_id, active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, accountId, eventId, type, targetId, active]
  );
}

async function sessionCookie(harness, accountId) {
  const token = await harness.auth.createSession(accountId);
  return `etko_session=${encodeURIComponent(token)}`;
}

async function requestJson(baseUrl, url, { cookie, bearer, method = 'GET', body, headers: extraHeaders } = {}) {
  const headers = { connection: 'close', ...(extraHeaders || {}) };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch (error) {}
  return { status: response.status, headers: response.headers, json };
}

async function deleteFixtureRows(database, { eventIds = [], accountIds = [], clientIds = [] }) {
  if (eventIds.length) {
    await database.query('DELETE FROM events WHERE id = ANY($1::text[])', [eventIds]);
  }
  if (clientIds.length) {
    await database.query('DELETE FROM clients WHERE id = ANY($1::text[])', [clientIds]);
  }
  if (accountIds.length) {
    await database.query('DELETE FROM accounts WHERE id = ANY($1::text[])', [accountIds]);
  }
}

module.exports = {
  LEGACY_ORG,
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  insertAssignment,
  sessionCookie,
  requestJson,
  deleteFixtureRows,
};
