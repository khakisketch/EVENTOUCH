'use strict';

// Session auth with role users. Passwords: scrypt hashes only.
const crypto = require('node:crypto');
const { sendJson, readJsonBody, parseCookies } = require('./http');

const ROLES = ['AGENCY', 'MANAGER', 'CLIENT', 'STAFF', 'VIEWER'];
const SESSION_COOKIE = 'etko_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
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
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3600 * 1000;
}

function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role, scope: user.scope || null };
}

function ensureSeed(store) {
  const users = store.read('users');
  if (!users.admin) {
    const password = process.env.ADMIN_PASSWORD || 'admin-local-only';
    users.admin = {
      id: 'admin',
      name: '관리자',
      role: 'AGENCY',
      scope: null,
      hash: hashPassword(password),
    };
    store.write('users', users);
  }
}

function createSession(store, userId) {
  const sid = crypto.randomUUID();
  const sessions = store.read('sessions');
  sessions[sid] = { userId, expiresAt: Date.now() + ttlMs() };
  store.write('sessions', sessions);
  return sid;
}

function sessionFromCookie(store, header) {
  const cookies = parseCookies(header);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const sessions = store.read('sessions');
  const entry = sessions[sid];
  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) {
      delete sessions[sid];
      store.write('sessions', sessions);
    }
    return null;
  }
  const users = store.read('users');
  const user = users[entry.userId];
  if (!user) return null;
  return { sid, user };
}

function sessionCookieHeader(sid) {
  const maxAge = Math.floor(ttlMs() / 1000);
  return `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

async function handleAuth(req, res, store, urlPath) {
  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    let body = null;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const users = store.read('users');
    const user = users[body && body.id];
    if (!user || !verifyPassword(body && body.password, user.hash)) {
      sendJson(res, 401, { error: '아이디 또는 비밀번호를 확인하세요' });
      return;
    }
    const sid = createSession(store, user.id);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': sessionCookieHeader(sid),
    });
    res.end(JSON.stringify({ user: publicUser(user) }));
    return;
  }
  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    const sess = sessionFromCookie(store, req.headers.cookie);
    if (sess) {
      const sessions = store.read('sessions');
      delete sessions[sess.sid];
      store.write('sessions', sessions);
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': clearCookieHeader(),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (urlPath === '/api/auth/me' && req.method === 'GET') {
    const sess = sessionFromCookie(store, req.headers.cookie);
    if (!sess) {
      sendJson(res, 401, { error: '로그인이 필요합니다' });
      return;
    }
    sendJson(res, 200, { user: publicUser(sess.user) });
    return;
  }
  sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
}

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  ensureSeed,
  createSession,
  sessionFromCookie,
  handleAuth,
};
