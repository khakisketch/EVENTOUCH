'use strict';

const { managerWriteAllowed, membershipOnlyCommand } = require('./event-permissions');

const ROLES = ['AGENCY', 'MANAGER', 'STAFF'];
const STAFF_COMMANDS = new Map([
  ['assignment.read', null],
  ['participants.read', 'DESK'],
  ['check.scan', 'DESK'],
  ['check.correct', 'DESK'],
  ['checkin.scan', 'DESK'],
  ['checkin.sync', 'DESK'],
  ['checkin.correction', 'DESK'],
  ['booth.visit', 'BOOTH'],
  ['reward.lookup', 'DESK'],
  ['reward.collect', 'DESK'],
]);
const STAFF_TARGET_REQUIRED = new Set(['check.scan', 'checkin.scan', 'booth.visit']);

function denied(status = 403) {
  return Object.assign(new Error(status === 401 ? '로그인이 필요합니다' : '권한을 확인하세요'), { status });
}

function createAccess(database) {
  // Route pre-check. The executor re-verifies inside its own transaction, so
  // this gate can only deny, never widen. Org truth comes from
  // organization_memberships (never accounts.role); the event must belong to
  // the resolved org. Everything runs in one transaction so the membership
  // read and the event read share a view.
  async function authorize({ account, eventId, command, assignmentId, targetId, forWrite = true } = {}) {
    if (!account || !account.id) throw denied(401);
    const { resolveEventAuthority } = require('./tenancy');
    // Pool in the route pre-check, transaction client inside executors and
    // the file service: without .transaction the queries still share one
    // connection, which is exactly the view a pre-check needs.
    const runner = database && typeof database.transaction === 'function'
      ? database
      : { transaction: (fn) => fn(database) };
    return runner.transaction(async (client) => {
      const idResult = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND active = true LIMIT 1',
        [account.id]
      );
      if (!idResult.rowCount) throw denied(401);
      let org;
      try {
        org = await resolveEventAuthority(client, account, eventId, { requireHeaders: forWrite });
      } catch (error) {
        // 401/409 (login, stale context, cross-org write) keep their shape;
        // an invisible event answers exactly like an unknown id so membership
        // cannot be probed through this gate.
        if (error && (error.status === 401 || error.status === 409)) throw error;
        if (error && error.status === 404) {
          throw Object.assign(new Error('행사를 찾을 수 없습니다'), { status: 404 });
        }
        throw denied(403);
      }
      const current = { role: org.role, active: true };
      if (current.role === 'AGENCY') return true;
      if (current.role === 'MANAGER') {
        if (!eventId) throw denied();
        const membership = await client.query(
          `SELECT m.write_permissions FROM memberships m
           JOIN events e ON e.id = m.event_id
           WHERE m.account_id = $1 AND m.event_id = $2 LIMIT 1`,
          [account.id, String(eventId)]
        );
        if (!membership.rowCount) throw denied();
        // Reads and file staging stay membership-gated (see
        // server/event-permissions.js); every other command needs its write
        // scope in the grant, and an unmapped command is denied.
        if (membershipOnlyCommand(command)) return true;
        if (managerWriteAllowed(membership.rows[0].write_permissions, command)) return true;
        throw denied();
      }

      const expectedType = STAFF_COMMANDS.get(String(command || ''));
      if (!STAFF_COMMANDS.has(String(command || '')) || !eventId || !assignmentId ||
        (STAFF_TARGET_REQUIRED.has(String(command)) && !targetId)) throw denied();
      const assignment = await client.query(
        `SELECT 1 FROM staff_assignments a
         JOIN events e ON e.id = a.event_id
          WHERE a.id = $1 AND a.account_id = $2 AND a.event_id = $3 AND a.active = true
            AND ($4::text IS NULL OR a.type = $4)
            AND ($5::text IS NULL OR a.target_id = $5)
          LIMIT 1`,
        [String(assignmentId), account.id, String(eventId), expectedType, targetId == null ? null : String(targetId)]
      );
      if (assignment.rowCount) return true;
      throw denied();
    });
  }

  return { authorize };
}

module.exports = { createAccess, ROLES, STAFF_COMMANDS };
