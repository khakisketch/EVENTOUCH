'use strict';

const ROLES = ['AGENCY', 'MANAGER', 'STAFF'];
const STAFF_COMMANDS = new Map([
  ['assignment.read', null],
  ['participants.read', 'DESK'],
  ['checkin.scan', 'DESK'],
  ['checkin.sync', 'DESK'],
  ['checkin.correction', 'DESK'],
  ['booth.visit', 'BOOTH'],
]);
const STAFF_TARGET_REQUIRED = new Set(['booth.visit']);

function denied(status = 403) {
  return Object.assign(new Error(status === 401 ? '로그인이 필요합니다' : '권한을 확인하세요'), { status });
}

function createAccess(database) {
  async function authorize({ account, eventId, command, assignmentId, targetId } = {}) {
    if (!account || !account.id) throw denied(401);
    const result = await database.query(
      'SELECT role, active FROM accounts WHERE id = $1 LIMIT 1',
      [account.id]
    );
    const current = result.rows[0];
    if (!current || current.active !== true || !ROLES.includes(current.role)) throw denied(401);

    if (current.role === 'AGENCY') return true;
    if (current.role === 'MANAGER') {
      if (!eventId) throw denied();
      const membership = await database.query(
        `SELECT 1 FROM memberships m
         JOIN events e ON e.id = m.event_id
         WHERE m.account_id = $1 AND m.event_id = $2 LIMIT 1`,
        [account.id, String(eventId)]
      );
      if (membership.rowCount) return true;
      throw denied();
    }

    const expectedType = STAFF_COMMANDS.get(String(command || ''));
    if (!STAFF_COMMANDS.has(String(command || '')) || !eventId || !assignmentId ||
      (STAFF_TARGET_REQUIRED.has(String(command)) && !targetId)) throw denied();
    const assignment = await database.query(
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
  }

  return { authorize };
}

module.exports = { createAccess, ROLES, STAFF_COMMANDS };
