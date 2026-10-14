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

const databaseUrl = testDatabaseUrl();
const testPasswordHash = hashPassword('not-a-real-test-password');

async function startApiHarness({ storageDir } = {}) {
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
    const auth = createDatabaseAuth(database);
    server = createHttpServer(openStore(dataDir), auth, createAccess(database), database, { storageDir: storageDir || path.join(dataDir, 'storage') });

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
          { storageDir: storageDir || path.join(dataDir, 'storage') });
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

async function insertAccount(database, { id, role, name, email, orgPermissions = [] }) {
  await database.query(
    `INSERT INTO accounts (id, email, name, role, password_hash, org_permissions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, email, name, role, testPasswordHash, JSON.stringify(orgPermissions)]
  );
}

async function insertEvent(database, { id, slug, payload, workspace }) {
  await database.query(
    'INSERT INTO events (id, slug, payload) VALUES ($1, $2, $3::jsonb)',
    [id, slug, JSON.stringify(payload)]
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

async function requestJson(baseUrl, url, { cookie, bearer, method = 'GET', body } = {}) {
  const headers = { connection: 'close' };
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
