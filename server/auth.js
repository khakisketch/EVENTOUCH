'use strict';

// Session auth with role users. Passwords: scrypt hashes only.
const crypto = require('node:crypto');
const { sendJson, readJsonBody } = require('./http');

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

function createDatabaseAuth(database) {
  async function authenticate(emailValue, passwordValue) {
    const email = normalizeEmail(emailValue);
    if (!email || typeof passwordValue !== 'string') return null;
    const result = await database.query(
      `SELECT id, email, name, role, password_hash, active
       FROM accounts WHERE lower(email) = $1 LIMIT 1`,
      [email]
    );
    const account = result.rows[0];
    if (!account || account.active !== true || !ROLES.includes(account.role)) return null;
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

  async function handleDatabaseAuth(req, res, urlPath) {
    if (urlPath === '/api/auth/login' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      const user = await authenticate(body && body.email, body && body.password);
      if (!user) {
        sendJson(res, 401, { error: '이메일 또는 비밀번호를 확인하세요' });
        return;
      }
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
          sendJson(res, error.status || 500, { error: error.message || '초대를 수락하지 못했습니다' });
        }
        return;
      }
    }
    sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
  }

  return {
    authenticate,
    createSession,
    sessionFromCookie,
    revokeSession,
    seedAdmin,
    readInvitation,
    acceptInvitation,
    handleAuth: handleDatabaseAuth,
  };
}

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  createDatabaseAuth,
};
