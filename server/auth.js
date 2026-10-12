'use strict';

// Session auth with role users. Passwords: scrypt hashes only.
const crypto = require('node:crypto');
const { sendJson, readJsonBody, failureMessage } = require('./http');

const ROLES = ['AGENCY', 'MANAGER', 'STAFF'];
const SESSION_COOKIE = 'etko_session';

function hashPassword(password) {
  const pw = String(password);
  if (pw.length < 8 || pw.length > 200) throw new Error('비밀번호를 8~200자로 입력하세요');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return false;
    const parts = String(stored).split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const probe = crypto.scryptSync(String(password), parts[1], 32);
    const expected = Buffer.from(parts[2], 'hex');
    return probe.length === expected.length && crypto.timingSafeEqual(probe, expected);
  } catch (err) {
    return false;
  }
}

// A dummy hash of an unguessable value, verified when no account matches.
// Without this, "no such account" returns measurably faster than "wrong
// password" and the endpoint becomes an account-enumeration oracle.
const ABSENT_ACCOUNT_PROBE = hashPassword(crypto.randomBytes(24).toString('base64'));

function burnAbsentAccountTime() {
  try {
    crypto.scryptSync(crypto.randomBytes(24).toString('base64'), 'absent-account-probe', 32);
  } catch (err) {
    // Timing equalization is best effort; a failure must never block login.
  }
}

// Login throttling. Scoped per account AND per client address so that
// hammering one operator account and spraying one password across many
// emails are both bounded. Failures decay after the window so a burst of
// typos never permanently locks a real operator out.
const THROTTLE = {
  account: { limit: 5, windowMinutes: 15, blockMinutes: 15 },
  address: { limit: 20, windowMinutes: 15, blockMinutes: 15 },
};

function throttleSettings(env = process.env) {
  const parse = (key, fallback, min, max) => {
    const value = Number(env[key]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    account: {
      limit: parse('EVENTOUCH_LOGIN_ACCOUNT_LIMIT', THROTTLE.account.limit, 1, 100),
      windowMinutes: parse('EVENTOUCH_LOGIN_WINDOW_MINUTES', THROTTLE.account.windowMinutes, 1, 1440),
      blockMinutes: parse('EVENTOUCH_LOGIN_BLOCK_MINUTES', THROTTLE.account.blockMinutes, 1, 1440),
    },
    address: {
      limit: parse('EVENTOUCH_LOGIN_ADDRESS_LIMIT', THROTTLE.address.limit, 1, 1000),
      windowMinutes: parse('EVENTOUCH_LOGIN_WINDOW_MINUTES', THROTTLE.address.windowMinutes, 1, 1440),
      blockMinutes: parse('EVENTOUCH_LOGIN_BLOCK_MINUTES', THROTTLE.address.blockMinutes, 1, 1440),
    },
  };
}

function clientAddress(req) {
  return String((req && req.socket && req.socket.remoteAddress) || 'unknown');
}

function ttlMs() {
  const hours = Number(process.env.SESSION_TTL_HOURS || 12);
  return (Number.isFinite(hours) && hours > 0 && hours <= 24 * 365 ? hours : 12) * 3600 * 1000;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieToken(header) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()) || null;
    } catch (error) {
      return null;
    }
  }
  return null;
}

function databaseCookie(token, maxAge = Math.floor(ttlMs() / 1000)) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
  };
}

function publicInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    name: invitation.name,
    role: invitation.role,
    eventId: invitation.event_id || null,
    status: invitation.status,
    expiresAt: new Date(invitation.expires_at).toISOString(),
  };
}

function invitationFailure(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

function commandIdentifier(value) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw invitationFailure(400, '요청 식별자를 확인하세요', { field: 'commandId' });
  }
  return id;
}

function invitationRequest(input) {
  const name = String(input && input.name !== undefined && input.name !== null ? input.name : '').trim().slice(0, 120);
  if (!name || name.length > 60) {
    throw invitationFailure(400, '이름을 1~60자로 입력하세요', { field: 'name' });
  }
  const email = normalizeEmail(input && input.email);
  if (!email) {
    throw invitationFailure(400, '이메일을 확인하세요', { field: 'email' });
  }
  const role = String((input && input.role) || '').trim().toUpperCase();
  if (role !== 'MANAGER' && role !== 'STAFF') {
    throw invitationFailure(400, '역할을 확인하세요', { field: 'role' });
  }
  const rawEventId = input && input.eventId !== undefined && input.eventId !== null ? String(input.eventId).trim() : '';
  if (role === 'STAFF' && rawEventId) {
    throw invitationFailure(400, '현장 스태프 초대에는 행사를 지정할 수 없습니다. 수락 후 데스크·부스 배정으로 연결합니다.', { field: 'eventId' });
  }
  return { name, email, role, eventId: rawEventId || null };
}

function sameInvitationRequest(left, right) {
  return left && right &&
    left.name === right.name &&
    left.email === right.email &&
    left.role === right.role &&
    (left.eventId || null) === (right.eventId || null);
}

function eventArchived(payload) {
  const stage = payload && typeof payload === 'object' ? String(payload.stage || '') : '';
  return stage.toUpperCase() === 'ARCHIVED';
}

function createDatabaseAuth(database, options = {}) {
  const env = options.env || process.env;
  const settings = throttleSettings(env);

  // An override cleared by an administrator always wins, and is consumed by
  // the very next attempt for that key so a stuck operator can get back in.
  async function overrideFor(scope, key) {
    const result = await database.query(
      `SELECT 1 FROM login_lockout_overrides o
       WHERE o.key = $1
         AND o.cleared_at > now() - interval '24 hours'
       LIMIT 1`,
      [`${scope}:${key}`]
    );
    return result.rowCount > 0;
  }

  async function isBlocked(scope, key, rule) {
    if (await overrideFor(scope, key)) return false;
    const result = await database.query(
      `SELECT failures FROM login_attempts
       WHERE scope = $1 AND key = $2
         AND last_failure_at > now() - ($3 || ' minutes')::interval`,
      [scope, key, String(rule.windowMinutes)]
    );
    const failures = result.rowCount ? Number(result.rows[0].failures) : 0;
    return failures >= rule.limit;
  }

  async function recordFailure(scope, key) {
    const rule = settings[scope];
    await database.query(
      `INSERT INTO login_attempts (scope, key, failures, first_failure_at, last_failure_at)
       VALUES ($1, $2, 1, now(), now())
       ON CONFLICT (scope, key) DO UPDATE SET
         failures = login_attempts.failures + 1,
         last_failure_at = now()`,
      [scope, key]
    );
    // Rows outside the window can never block anything again.
    await database.query(
      `DELETE FROM login_attempts WHERE last_failure_at < now() - ($1 || ' minutes')::interval`,
      [String(Math.max(rule.windowMinutes, rule.blockMinutes))]
    );
  }

  // Login must keep working even if the throttle tables are missing. An
  // unmigrated database would otherwise 500 on every login and lock the
  // operators out of their own product, so the throttle is treated as a
  // defence rather than a dependency: its absence degrades to "no
  // throttling", never to "no login". Startup migrates, so this only
  // guards a stale schema reached some other way.
  let throttleAvailable = true;

  async function withThrottle(operation, fallback) {
    if (!throttleAvailable) return fallback;
    try {
      return await operation();
    } catch (error) {
      if (/login_attempts|login_lockout_overrides/.test(String(error && error.message))) {
        throttleAvailable = false;
        process.stderr.write(
          '[eventouch] login throttle unavailable (migration missing); login continues without throttling\n'
        );
        return fallback;
      }
      throw error;
    }
  }

  async function clearFailures(scope, key) {
    await withThrottle(
      () => database.query('DELETE FROM login_attempts WHERE scope = $1 AND key = $2', [scope, key]),
      null
    );
  }

  async function recordFailureSafely(scope, key) {
    await withThrottle(() => recordFailure(scope, key), null);
  }

  async function throttleState(req, email) {
    const address = clientAddress(req);
    const accountKey = email || `absent:${address}`;
    return withThrottle(async () => {
      const accountBlocked = await isBlocked('account', accountKey, settings.account);
      const addressBlocked = await isBlocked('address', address, settings.address);
      return { address, accountKey, blocked: accountBlocked || addressBlocked };
    }, { address, accountKey, blocked: false });
  }

  async function authenticate(emailValue, passwordValue) {
    const email = normalizeEmail(emailValue);
    if (!email || typeof passwordValue !== 'string') {
      burnAbsentAccountTime();
      return null;
    }
    const result = await database.query(
      `SELECT id, email, name, role, password_hash, active
       FROM accounts WHERE lower(email) = $1 LIMIT 1`,
      [email]
    );
    const account = result.rows[0];
    if (!account || account.active !== true || !ROLES.includes(account.role)) {
      burnAbsentAccountTime();
      return null;
    }
    if (!verifyPassword(passwordValue, account.password_hash)) return null;
    return publicAccount(account);
  }

  async function createSession(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs());
    const inserted = await database.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at)
       SELECT $1, id, $3 FROM accounts WHERE id = $2 AND active = true
       RETURNING token_hash`,
      [tokenHash(token), accountId, expiresAt]
    );
    if (inserted.rowCount !== 1) throw new Error('활성 계정을 찾을 수 없습니다');
    return token;
  }

  async function sessionFromCookie(cookieHeader) {
    const token = cookieToken(cookieHeader);
    if (!token || token.length > 256) return null;
    const result = await database.query(
      `SELECT a.id, a.email, a.name, a.role
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active = true
         AND a.role = ANY($2::text[])
       LIMIT 1`,
      [tokenHash(token), ROLES]
    );
    return result.rows[0] ? publicAccount(result.rows[0]) : null;
  }

  async function revokeSession(cookieHeader) {
    const token = cookieToken(cookieHeader);
    if (!token || token.length > 256) return false;
    const result = await database.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
    return result.rowCount > 0;
  }

  async function seedAdmin(env = process.env) {
    const rawEmail = String(env.ADMIN_EMAIL || '').trim();
    const email = normalizeEmail(rawEmail);
    const password = env.ADMIN_PASSWORD;
    if (!rawEmail && !password) {
      const existing = await database.query("SELECT 1 FROM accounts WHERE role = 'AGENCY' LIMIT 1");
      return existing.rowCount ? 'existing' : 'unconfigured';
    }
    if (!email || typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw new Error('ADMIN_EMAIL과 8~200자 ADMIN_PASSWORD를 설정하세요');
    }
    return database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7319462041702']);
      const existing = await client.query("SELECT id FROM accounts WHERE role = 'AGENCY' LIMIT 1");
      if (existing.rowCount) return 'existing';
      const passwordHash = hashPassword(password);
      await client.query(
        `INSERT INTO accounts (id, email, name, role, password_hash)
         VALUES ('admin', $1, $2, 'AGENCY', $3)`,
        [email, String(env.ADMIN_NAME || '관리자').trim().slice(0, 60) || '관리자', passwordHash]
      );
      return 'seeded';
    });
  }

  async function readInvitation(token) {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return { status: 404 };
    const result = await database.query(
      `SELECT id, email, name, role, event_id, status, expires_at
       FROM invitations WHERE token_hash = $1 LIMIT 1`,
      [tokenHash(token)]
    );
    const invitation = result.rows[0];
    if (!invitation) return { status: 404 };
    if (invitation.status !== 'PENDING') return { status: 409 };
    if (new Date(invitation.expires_at).getTime() <= Date.now()) return { status: 410 };
    if (!['MANAGER', 'STAFF'].includes(invitation.role)) return { status: 409 };
    return {
      status: 200,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        eventId: invitation.event_id,
        status: invitation.status,
        expiresAt: new Date(invitation.expires_at).toISOString(),
      },
    };
  }

  async function acceptInvitation(token, password) {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
      throw Object.assign(new Error('초대 링크를 확인할 수 없습니다'), { status: 404 });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw Object.assign(new Error('비밀번호를 8~200자로 입력하세요'), { status: 400 });
    }
    try {
      return await database.transaction(async (client) => {
        const result = await client.query(
          `SELECT id, email, name, role, event_id, status, expires_at
           FROM invitations WHERE token_hash = $1 FOR UPDATE`,
          [tokenHash(token)]
        );
        const invitation = result.rows[0];
        if (!invitation) throw Object.assign(new Error('초대 링크를 확인할 수 없습니다'), { status: 404 });
        if (invitation.status !== 'PENDING') {
          throw Object.assign(new Error('이미 사용되었거나 철회된 초대입니다'), { status: 409 });
        }
        if (new Date(invitation.expires_at).getTime() <= Date.now()) {
          throw Object.assign(new Error('초대 링크가 만료되었습니다'), { status: 410 });
        }
        if (!['MANAGER', 'STAFF'].includes(invitation.role) || !normalizeEmail(invitation.email)) {
          throw Object.assign(new Error('초대 정보를 확인할 수 없습니다'), { status: 409 });
        }
        const accountId = `acct-${crypto.randomUUID()}`;
        const passwordHash = hashPassword(password);
        await client.query(
          `INSERT INTO accounts (id, email, name, role, password_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [accountId, normalizeEmail(invitation.email), invitation.name, invitation.role, passwordHash]
        );
        if (invitation.role === 'MANAGER' && invitation.event_id) {
          await client.query(
            'INSERT INTO memberships (account_id, event_id) VALUES ($1, $2)',
            [accountId, invitation.event_id]
          );
        }
        await client.query("UPDATE invitations SET status = 'ACCEPTED' WHERE id = $1", [invitation.id]);
        return publicAccount({
          id: accountId,
          email: normalizeEmail(invitation.email),
          name: invitation.name,
          role: invitation.role,
        });
      });
    } catch (error) {
      if (error && error.code === '23505') {
        throw Object.assign(new Error('이 이메일로 이미 계정이 등록되었습니다'), { status: 409 });
      }
      throw error;
    }
  }

  async function requireAgency(cookieHeader) {
    const user = await sessionFromCookie(cookieHeader);
    if (!user) throw invitationFailure(401, '로그인이 필요합니다');
    const current = await database.query('SELECT role, active FROM accounts WHERE id = $1 LIMIT 1', [user.id]);
    const actor = current.rows[0];
    if (!actor || actor.active !== true) throw invitationFailure(401, '로그인이 필요합니다');
    if (actor.role !== 'AGENCY') throw invitationFailure(403, '권한을 확인하세요');
    return user;
  }

  // Invitation issuance. The raw bearer is returned exactly once in the 201
  // response and never persisted: only its SHA256 token_hash is stored.
  // commandId is stable: a replay of the same creation request returns 409
  // INVITATION_LINK_UNAVAILABLE instead of reissuing (or leaking) the link.
  async function authorizeAgencyWrite(client, actor) {
    const result = await client.query('SELECT role, active FROM accounts WHERE id = $1 LIMIT 1 FOR SHARE', [actor.id]);
    const current = result.rows[0];
    if (!current || current.active !== true) throw invitationFailure(401, '로그인이 필요합니다');
    if (current.role !== 'AGENCY') throw invitationFailure(403, '권한을 확인하세요');
  }

  async function createInvitation(actor, input) {
    const commandIdValue = commandIdentifier(input && input.commandId);
    const request = invitationRequest(input);
    try {
      return await database.transaction(async (client) => {
        await authorizeAgencyWrite(client, actor);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-create:${commandIdValue}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-email:${request.email}`]);

        const receiptResult = await client.query(
          'SELECT actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [commandIdValue]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
          if (String(receipt.actor_id || '') === String(actor.id) &&
              stored.command === 'invitation.create' &&
              sameInvitationRequest(stored.request, request)) {
            throw invitationFailure(
              409,
              '이미 초대 링크가 발급되었습니다. 링크는 생성 시 한 번만 표시되므로 분실한 경우 기존 초대를 철회하고 다시 초대하세요',
              { code: 'INVITATION_LINK_UNAVAILABLE' }
            );
          }
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }

        if (request.eventId) {
          const eventResult = await client.query('SELECT id, payload FROM events WHERE id = $1 LIMIT 1', [request.eventId]);
          if (!eventResult.rowCount) throw invitationFailure(404, '행사를 찾을 수 없습니다');
          if (eventArchived(eventResult.rows[0].payload)) {
            throw invitationFailure(409, '보관된 행사는 변경할 수 없습니다');
          }
        }

        const accountResult = await client.query(
          'SELECT 1 FROM accounts WHERE lower(email) = $1 AND active = true LIMIT 1',
          [request.email]
        );
        if (accountResult.rowCount) {
          throw invitationFailure(409, '이 이메일로 이미 계정이 등록되었습니다');
        }
        const pendingResult = await client.query(
          `SELECT 1 FROM invitations
            WHERE lower(email) = $1 AND status = 'PENDING' AND expires_at > now()
            LIMIT 1`,
          [request.email]
        );
        if (pendingResult.rowCount) {
          throw invitationFailure(409, '이 이메일로 이미 대기 중인 초대가 있습니다');
        }

        const invitationId = `inv-${crypto.randomUUID()}`;
        const token = crypto.randomBytes(32).toString('base64url');
        const inserted = await client.query(
          `INSERT INTO invitations (id, token_hash, email, name, role, event_id, payload, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'PENDING', now() + interval '7 days')
           RETURNING id, email, name, role, event_id, status, expires_at`,
          [invitationId, tokenHash(token), request.email, request.name, request.role, request.eventId]
        );
        const invitation = publicInvitation(inserted.rows[0]);
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, result)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [commandIdValue, request.eventId, actor.id, JSON.stringify({
            command: 'invitation.create',
            request,
            response: { invitation },
          })]
        );
        return { invitation, token };
      });
    } catch (error) {
      if (error && error.code === '23505' && !error.status) {
        throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
      }
      throw error;
    }
  }

  // Revocation is idempotent: revoked invitations stay revoked and retries of
  // the same revocation command return the current state.
  async function revokeInvitation(actor, invitationId, commandIdValue) {
    const id = String(invitationId || '').trim();
    if (!id) throw invitationFailure(404, '초대를 찾을 수 없습니다');
    const command = commandIdentifier(commandIdValue);
    try {
      return await database.transaction(async (client) => {
        await authorizeAgencyWrite(client, actor);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-revoke:${command}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-id:${id}`]);

        const receiptResult = await client.query(
          'SELECT actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [command]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
          if (String(receipt.actor_id || '') === String(actor.id) &&
              stored.command === 'invitation.revoke' &&
              stored.request && String(stored.request.id || '') === id) {
            const current = await client.query(
              `SELECT id, email, name, role, event_id, status, expires_at
                FROM invitations WHERE id = $1 LIMIT 1`,
              [id]
            );
            if (!current.rowCount) throw invitationFailure(404, '초대를 찾을 수 없습니다');
            return { invitation: publicInvitation(current.rows[0]), replayed: true };
          }
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }

        const found = await client.query(
          `SELECT id, email, name, role, event_id, status, expires_at
            FROM invitations WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!found.rowCount) throw invitationFailure(404, '초대를 찾을 수 없습니다');
        const row = found.rows[0];
        if (row.status === 'ACCEPTED') throw invitationFailure(409, '이미 수락된 초대입니다');
        if (row.status === 'PENDING') {
          await client.query("UPDATE invitations SET status = 'REVOKED' WHERE id = $1", [id]);
          row.status = 'REVOKED';
        }
        const invitation = publicInvitation(row);
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, result)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [command, row.event_id, actor.id, JSON.stringify({
            command: 'invitation.revoke',
            request: { id },
            response: { invitation },
          })]
        );
        return { invitation, replayed: false };
      });
    } catch (error) {
      if (error && error.code === '23505' && !error.status) {
        throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
      }
      throw error;
    }
  }

  async function handleDatabaseAuth(req, res, urlPath) {
    if (urlPath === '/api/auth/login-lockouts' && req.method === 'DELETE') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      await clearLoginLockout(req, res, body && body.scope, body && body.key);
      return;
    }
    const devQuickLogin = String(process.env.EVENTOUCH_DEV_QUICK_LOGIN || '').trim().toLowerCase();
    if (devQuickLogin && urlPath === '/api/auth/dev/quick-login' && req.method === 'POST') {
      const result = await database.query(
        'SELECT id, email, name, role, active FROM accounts WHERE lower(email) = $1 LIMIT 1',
        [devQuickLogin]
      );
      const account = result.rows[0];
      if (!account || account.active !== true) {
        sendJson(res, 404, { error: '개발용 계정을 찾을 수 없습니다' });
        return;
      }
      const token = await createSession(account.id);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': databaseCookie(token),
      });
      res.end(JSON.stringify({ user: publicAccount(account) }));
      return;
    }
    if (urlPath === '/api/auth/login' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      const email = normalizeEmail(body && body.email);
      const throttle = await throttleState(req, email);
      if (throttle.blocked) {
        // Same wording as an ordinary credential failure on purpose: telling
        // an attacker that a lockout is in progress turns it into a signal.
        sendJson(res, 429, {
          error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
          retryAfterSeconds: settings.account.blockMinutes * 60,
        });
        return;
      }
      const user = await authenticate(body && body.email, body && body.password);
      if (!user) {
        await recordFailureSafely('account', throttle.accountKey);
        await recordFailureSafely('address', throttle.address);
        sendJson(res, 401, { error: '이메일 또는 비밀번호를 확인하세요' });
        return;
      }
      await clearFailures('account', throttle.accountKey);
      await clearFailures('address', throttle.address);
      const token = await createSession(user.id);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': databaseCookie(token),
      });
      res.end(JSON.stringify({ user }));
      return;
    }
    if (urlPath === '/api/auth/logout' && req.method === 'POST') {
      await revokeSession(req.headers.cookie);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': databaseCookie('', 0),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (urlPath === '/api/auth/me' && req.method === 'GET') {
      const user = await sessionFromCookie(req.headers.cookie);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      sendJson(res, 200, { user });
      return;
    }
    if (urlPath === '/api/auth/invitations' && req.method === 'POST') {
      let actor;
      try {
        actor = await requireAgency(req.headers.cookie);
      } catch (error) {
        sendJson(res, error.status || 401, { error: error.message });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      try {
        const created = await createInvitation(actor, body);
        sendJson(res, 201, created);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '초대를 만들지 못했습니다') },
          error.code ? { code: error.code } : null,
          error.field ? { field: error.field } : null
        ));
      }
      return;
    }
    const revokePath = /^\/api\/auth\/invitations\/([^/]+)\/revoke$/.exec(urlPath);
    if (revokePath && req.method === 'POST') {
      let invitationId;
      try {
        invitationId = decodeURIComponent(revokePath[1]);
      } catch (error) {
        sendJson(res, 404, { error: '초대를 찾을 수 없습니다' });
        return;
      }
      let actor;
      try {
        actor = await requireAgency(req.headers.cookie);
      } catch (error) {
        sendJson(res, error.status || 401, { error: error.message });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      try {
        const result = await revokeInvitation(actor, invitationId, body && body.commandId);
        sendJson(res, 200, { invitation: result.invitation });
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '초대를 철회하지 못했습니다') },
          error.field ? { field: error.field } : null
        ));
      }
      return;
    }
    const invitePath = /^\/api\/auth\/invitations\/([^/]+)(\/accept)?$/.exec(urlPath);
    if (invitePath) {
      let token;
      try {
        token = decodeURIComponent(invitePath[1]);
      } catch (error) {
        sendJson(res, 404, { error: '초대 링크를 확인할 수 없습니다' });
        return;
      }
      if (req.method === 'GET' && !invitePath[2]) {
        const result = await readInvitation(token);
        if (result.status !== 200) {
          const error = result.status === 410
            ? '초대 링크가 만료되었습니다'
            : result.status === 409 ? '사용할 수 없는 초대 링크입니다' : '초대 링크를 확인할 수 없습니다';
          sendJson(res, result.status, { error });
          return;
        }
        sendJson(res, 200, { invitation: result.invitation });
        return;
      }
      if (req.method === 'POST' && invitePath[2]) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        try {
          const account = await acceptInvitation(token, body && body.password);
          sendJson(res, 201, { account });
        } catch (error) {
          sendJson(res, error.status || 500, { error: failureMessage(error, '초대를 수락하지 못했습니다') });
        }
        return;
      }
    }
    sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
  }

  // Operational escape hatch: clear a lockout without waiting out the block.
  // Requires an authenticated AGENCY session so it cannot itself be abused.
  async function clearLoginLockout(req, res, scopeValue, keyValue) {
    const actor = await sessionFromCookie(req.headers.cookie);
    if (!actor || actor.role !== 'AGENCY') {
      sendJson(res, 403, { error: '운영사 구성원만 잠금을 해제할 수 있습니다' });
      return;
    }
    const scope = scopeValue === 'address' ? 'address' : 'account';
    const key = String(keyValue || '').trim().toLowerCase();
    if (!key) {
      sendJson(res, 400, { error: '해제할 대상을 입력하세요' });
      return;
    }
    await database.query(
      `INSERT INTO login_lockout_overrides (key, cleared_by) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET cleared_at = now(), cleared_by = EXCLUDED.cleared_by`,
      [`${scope}:${key}`, actor.id]
    );
    await clearFailures(scope, key);
    sendJson(res, 200, { ok: true });
  }

  return {
    authenticate,
    createSession,
    sessionFromCookie,
    revokeSession,
    seedAdmin,
    readInvitation,
    acceptInvitation,
    throttleState,
    clearLoginLockout,
    handleAuth: handleDatabaseAuth,
  };
}

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  throttleSettings,
  createDatabaseAuth,
};
