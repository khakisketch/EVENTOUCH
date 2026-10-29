'use strict';

// Tenancy migration preservation: synthetic pre-tenancy rows (001..010
// shape, no org columns) must survive 011/012 with byte-identical payloads,
// ids, tickets, checks, receipts and file metadata — only org_id is added.
// Also proves the 013 same-org trigger on real PostgreSQL.

const nodeTest = require('node:test').test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const { runMigrations } = require('../server/migrate');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');

const databaseUrl = testDatabaseUrl();
const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const ids = {
  event: `mig-event-${suffix}`,
  client: `mig-client-${suffix}`,
  invite: `mig-invite-${suffix}`,
  receipt: `mig-cmd-${suffix}`,
  file: `mig-file-${suffix}`,
  person: 'mig-person-1',
};

test('011 maps pre-tenancy rows without touching a single byte', async (t) => {
  if (!databaseUrl) return t.skip();
  const admin = createDatabase({ connectionString: databaseUrl });
  const schema = `tenancy_mig_${suffix.replace(/-/g, '')}`;
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-mig-'));
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    const db = createDatabase({ connectionString: scopedUrl.toString() });
    try {
      // Stop the staged migration before 005 so the synthetic rows below
      // exist first; the full migrate then proves every backfill (005/006
      // plus the 011 org mapping) sees them.
      for (const name of [
        '001_initial.sql', '002_stored-file-dimensions.sql', '003_login-throttle.sql',
        '004_message-outbox.sql',
      ]) {
        fs.copyFileSync(path.join(__dirname, '..', 'server', 'migrations', name), path.join(tmpd, name));
      }
      await runMigrations(db, tmpd);

      // Synthetic pre-tenancy universe (legacy shapes: no org_id anywhere).
      const ticket = `ET:${ids.event}:T-${crypto.randomBytes(16).toString('base64url')}`;
      await db.query('INSERT INTO accounts (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)', [
        'mig-acct', 'mig@example.test', '이관', 'AGENCY', 'scrypt:fake',
      ]);
      await db.query('INSERT INTO clients (id, payload) VALUES ($1, $2::jsonb)', [
        ids.client, JSON.stringify({ name: '이관 고객사', contact: '담당', email: 'c@example.test' }),
      ]);
      const eventPayload = {
        id: ids.event, name: '이관 행사 üñí', slug: `mig-${suffix}`, clientId: ids.client,
        date: '2026-12-01', start: '10:00', end: '17:00', capacity: 50, stage: 'LIVE', features: ['photo'],
      };
      const workspacePayload = {
        participants: [{
          id: ids.person, name: '이전 참가자', phone: '010-1111-2222', status: 'APPROVED',
          ticket, revoked: false, ticketExpiresAt: '2027-12-31T00:00:00.000Z',
        }],
        checks: [{
          id: 'mig-check-1', participantId: ids.person, name: '이전 참가자', action: 'IN',
          deskId: 'desk-1', actor: 'actor-1', at: '2026-12-01T10:00:00.000Z',
          before: { inside: false, everIn: false }, corrected: false,
        }],
      };
      await db.query('INSERT INTO events (id, slug, client_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
        ids.event, `mig-${suffix}`, ids.client, JSON.stringify(eventPayload),
      ]);
      await db.query('INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)', [
        ids.event, JSON.stringify(workspacePayload),
      ]);
      await db.query(
        `INSERT INTO invitations (id, token_hash, email, name, role, event_id, payload, status, expires_at)
         VALUES ($1, $2, $3, $4, 'MANAGER', $5, '{}'::jsonb, 'PENDING', now() + interval '1 day')`,
        [ids.invite, 'hash-mig', 'invited@example.test', '초대', ids.event]
      );
      const receiptResult = { command: 'notice.save', response: { notice: { id: 'n1', title: '공지 ü' } } };
      await db.query('INSERT INTO command_receipts (command_id, event_id, actor_id, result) VALUES ($1, $2, $3, $4::jsonb)', [
        ids.receipt, ids.event, 'mig-acct', JSON.stringify(receiptResult),
      ]);
      await db.query(
        `INSERT INTO stored_files (id, event_id, storage_key, original_name, content_type, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ids.file, ids.event, ids.file, '증빙.png', 'image/png', 12345, 'mig-acct']
      );

      const before = {
        event: (await db.query('SELECT payload::text AS p FROM events WHERE id = $1', [ids.event])).rows[0].p,
        workspace: (await db.query('SELECT payload::text AS p FROM event_workspaces WHERE event_id = $1', [ids.event])).rows[0].p,
        client: (await db.query('SELECT payload::text AS p FROM clients WHERE id = $1', [ids.client])).rows[0].p,
        receipt: (await db.query('SELECT result::text AS p FROM command_receipts WHERE command_id = $1', [ids.receipt])).rows[0].p,
        invite: (await db.query('SELECT email, name, role, event_id, status FROM invitations WHERE id = $1', [ids.invite])).rows[0],
        file: (await db.query('SELECT id, event_id, original_name, content_type, size_bytes, created_by FROM stored_files WHERE id = $1', [ids.file])).rows[0],
      };

      const applied = await runMigrations(db);
      assert.ok(applied.includes('011_organizations-scope.sql'));
      assert.ok(applied.includes('012_session-select-revision.sql'));
      assert.ok(applied.includes('013_event-client-same-org.sql'));
      assert.ok(applied.includes('014_membership-revision.sql'));
      assert.ok(applied.includes('015_invitation-owner-role.sql'));

      // Byte identity: nothing but org_id changed.
      const after = {
        event: (await db.query('SELECT payload::text AS p, org_id FROM events WHERE id = $1', [ids.event])).rows[0],
        workspace: (await db.query('SELECT payload::text AS p FROM event_workspaces WHERE event_id = $1', [ids.event])).rows[0].p,
        client: (await db.query('SELECT payload::text AS p, org_id FROM clients WHERE id = $1', [ids.client])).rows[0],
        receipt: (await db.query('SELECT result::text AS p, org_id FROM command_receipts WHERE command_id = $1', [ids.receipt])).rows[0],
        invite: (await db.query('SELECT email, name, role, event_id, status, org_id FROM invitations WHERE id = $1', [ids.invite])).rows[0],
        file: (await db.query('SELECT id, event_id, original_name, content_type, size_bytes, created_by FROM stored_files WHERE id = $1', [ids.file])).rows[0],
        membership: (await db.query('SELECT org_id, role, active FROM organization_memberships WHERE account_id = $1', ['mig-acct'])).rows,
      };
      assert.equal(after.event.p, before.event);
      assert.equal(after.workspace, before.workspace);
      assert.equal(after.client.p, before.client);
      assert.equal(after.receipt.p, before.receipt);
      assert.deepEqual(
        { email: after.invite.email, name: after.invite.name, role: after.invite.role, event_id: after.invite.event_id, status: after.invite.status },
        before.invite
      );
      assert.deepEqual(after.file, before.file);
      // 011 mapping: everything lands in the legacy org, membership copied.
      for (const row of [after.event, after.client, after.receipt, after.invite]) {
        assert.equal(row.org_id, 'org-legacy');
      }
      assert.deepEqual(after.membership, [{ org_id: 'org-legacy', role: 'AGENCY', active: true }]);
      // 005/006 backfills still see the pre-existing rows.
      assert.equal((await db.query('SELECT count(*)::int AS n FROM checkin_records WHERE event_id = $1', [ids.event])).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM tickets WHERE event_id = $1', [ids.event])).rows[0].n, 1);

      // 013 trigger: cross-org client links are rejected by PostgreSQL itself.
      await db.query("INSERT INTO organizations (id, name) VALUES ('mig-org-b', 'B') ON CONFLICT DO NOTHING");
      await db.query("INSERT INTO clients (id, org_id, payload) VALUES ('mig-client-b', 'mig-org-b', '{}') ON CONFLICT (id) DO NOTHING");
      await assert.rejects(
        db.query('UPDATE events SET client_id = $1 WHERE id = $2', ['mig-client-b', ids.event]),
        (error) => error && error.code === '23503'
      );
      await db.query("DELETE FROM clients WHERE id = 'mig-client-b'");
      await db.query("DELETE FROM organizations WHERE id = 'mig-org-b'");
    } finally {
      await db.close();
    }
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.close();
    fs.rmSync(tmpd, { recursive: true, force: true });
  }
});
