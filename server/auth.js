'use strict';

// Session auth with role users. Passwords: scrypt hashes only.
const crypto = require('node:crypto');
const { sendJson, readJsonBody, failureMessage } = require('./http');
const { createClientAddressResolver, developmentLoginEmail } = require('./runtime-security.ts');
const {
  LEGACY_ORG_ID,
  normalizeOrgId,
  parseOrgHeaders,
  activeMemberships,
  resolveOrgContext,
  resolveActorOrg,
  attachOrgRequest,
  stampOrgHeaders,
  checkReceiptScope,
  bumpOrgContext,
  noMembership,
  staleContext,
  selectionRequired,
  orgMismatch,
} = require('./tenancy');

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
  const base = {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
  };
  // Organization context rides on the session user: effectiveRole is the
  // per-org truth, role mirrors it for single-org clients.
  if (account.organizationId !== undefined) {
    base.organizationId = account.organizationId;
    base.organizationName = account.organizationName || null;
    base.contextVersion = account.contextVersion ?? null;
    base.effectiveRole = account.effectiveRole || account.role;
  }
  return base;
}

function publicInvitation(invitation, { requiresSignIn = false } = {}) {
  return {
    id: invitation.id,
    email: invitation.email,
    name: invitation.name,
    role: invitation.role,
    eventId: invitation.event_id || null,
    status: invitation.status,
    expiresAt: new Date(invitation.expires_at).toISOString(),
    // True when the invited email already owns a global account: the UI must
    // NOT show a new-password form. Accept then requires that same login
    // (409 INVITATION_LOGIN_REQUIRED otherwise) and only adds the org
    // membership — the stored password and global identity never change.
    requiresSignIn: requiresSignIn === true,
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
  if (role !== 'MANAGER' && role !== 'STAFF' && role !== 'AGENCY') {
    throw invitationFailure(400, '역할을 확인하세요', { field: 'role' });
  }
  const rawEventId = input && input.eventId !== undefined && input.eventId !== null ? String(input.eventId).trim() : '';
  if (role === 'STAFF' && rawEventId) {
    throw invitationFailure(400, '현장 스태프 초대에는 행사를 지정할 수 없습니다. 수락 후 데스크·부스 배정으로 연결합니다.', { field: 'eventId' });
  }
  // AGENCY owns the whole org: an event scope is forbidden (enforced in the
  // transaction, where the actor's ownership is known).
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
  // Self-service recovery instance (server/account-recovery.js), injected by
  // server.js. Absent in some test harnesses: verification/status degrade to
  // an honest 503, anonymous recovery stays generic and fail-closed.
  const recovery = options.recovery || null;
  const settings = throttleSettings(env);
  const clientAddress = createClientAddressResolver(env);
  const devQuickLogin = developmentLoginEmail(env);

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
    // Rows outside the window can never block anything again. Prune ONLY the
    // login scopes: the table is shared with the recovery throttle
    // (server/account-recovery.js), whose windows (up to 60m) outlive the
    // login windows — an unscoped delete here would eat live recovery rows.
    await database.query(
      `DELETE FROM login_attempts
        WHERE scope IN ('account', 'address')
          AND last_failure_at < now() - ($1 || ' minutes')::interval`,
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

  // Sessions carry the server-verified org selection. The org stored here is
  // a selection, not a privilege: every request re-checks the membership
  // inside its own transaction (see server/tenancy.js).
  async function createSession(accountId, orgId = null) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs());
    const selected = await database.transaction(async (client) => {
      const accountResult = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND active = true LIMIT 1',
        [String(accountId)]
      );
      if (!accountResult.rowCount) throw new Error('활성 계정을 찾을 수 없습니다');
      const memberships = await activeMemberships(client, String(accountId));
      if (!memberships.length) throw noMembership();
      let org = null;
      if (orgId) {
        org = memberships.find((entry) => entry.orgId === String(orgId)) || null;
        if (!org) throw new Error('소속된 조직이 아닙니다');
      } else {
        // Single-org compat: exactly one membership selects itself.
        // Multi-membership sessions start unselected and must select
        // explicitly (fail-closed, no silent legacy fallback).
        org = memberships.length === 1 ? memberships[0] : null;
      }
      // The binding snapshot is the MEMBER row revision (per-membership
      // truth), never the org clock: other members joining later must not
      // invalidate this session.
      const inserted = await client.query(
        `INSERT INTO sessions (token_hash, account_id, expires_at, org_id, org_context_version, org_select_revision)
         VALUES ($1, $2, $3, $4, $5, 0)
         RETURNING token_hash`,
        [tokenHash(token), String(accountId), expiresAt, org ? org.orgId : null, org ? org.revision : 0]
      );
      if (inserted.rowCount !== 1) throw new Error('활성 계정을 찾을 수 없습니다');
      return org;
    });
    void selected;
    return token;
  }

  // Session identity with the server-verified org hint attached. The user-
  // facing contextVersion is the SESSION's selection revision
  // (org_select_revision, monotonic per session); the org-side binding
  // snapshot (org_context_version) rides along for the per-write check in
  // server/tenancy.js. Hints can only deny, never widen. No write happens
  // here: single-membership compat resolves inline.
  async function sessionFromCookie(cookieHeader) {
    const token = cookieToken(cookieHeader);
    if (!token || token.length > 256) return null;
    const result = await database.query(
      `SELECT a.id, a.email, a.name, a.role AS global_role, a.active,
              s.org_id AS session_org, s.org_context_version AS session_org_version,
              s.org_select_revision AS session_revision
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active = true
       LIMIT 1`,
      [tokenHash(token)]
    );
    const row = result.rows[0];
    if (!row || !ROLES.includes(row.global_role)) return null;
    const sessionRevision = Number(row.session_revision) || 0;
    const memberships = await database.query(
      `SELECT m.org_id, m.role, o.name AS org_name, o.context_version
       FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.account_id = $1 AND m.active = true
       ORDER BY o.id`,
      [row.id]
    );
    const active = memberships.rows.map((entry) => ({
      orgId: String(entry.org_id),
      role: String(entry.role),
      orgName: String(entry.org_name || ''),
      contextVersion: Number(entry.context_version) || 0,
    }));
    const availableOrganizations = active.map((entry) => ({
      id: entry.orgId,
      name: entry.orgName,
      role: entry.role,
    }));
    if (!active.length) {
      // Identity is valid but belongs nowhere: report it with the stable code
      // so /me and guards answer 403 + NO_ORGANIZATION_MEMBERSHIP (guidance)
      // instead of a bare 401. Login never mints a session for this state.
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        role: null,
        organizationId: null,
        organizationName: null,
        contextVersion: sessionRevision,
        effectiveRole: null,
        orgSelectionRequired: false,
        noMembership: true,
        availableOrganizations: [],
        sessionRevision,
        sessionOrgVersion: null,
      };
    }
    let selected = null;
    let boundVersion = null;
    if (row.session_org) {
      selected = active.find((entry) => entry.orgId === String(row.session_org)) || null;
      boundVersion = row.session_org_version === null || row.session_org_version === undefined
        ? null
        : Number(row.session_org_version);
      if (selected && !ROLES.includes(selected.role)) selected = null;
      if (!selected && sessionRevision >= 1) {
        // The session EXPLICITLY selected an org that is now gone (the
        // revision only advances on select). Never silently re-pin to a
        // remaining org: return identity plus the available list so the tab
        // explicitly reselects. Drafts and unknown commands stay unassigned.
        return {
          id: row.id,
          email: row.email,
          name: row.name,
          role: null,
          organizationId: null,
          organizationName: null,
          contextVersion: sessionRevision,
          effectiveRole: null,
          orgSelectionRequired: true,
          deselectedOrganizationId: String(row.session_org),
          availableOrganizations,
          sessionRevision,
          sessionOrgVersion: null,
        };
      }
      // Auto-pinned at login (revision 0, never explicitly selected): fall
      // through to the single-remaining compat below.
      if (!selected) selected = null;
    }
    if (!selected && active.length === 1) {
      // Single-org compat, resolved inline without a session write.
      selected = active[0];
      boundVersion = selected.revision;
    }
    if (!selected) {
      // Multi-membership without a selection: identity without authority.
      // Org endpoints (list/select) stay reachable; guarded paths deny with
      // ORGANIZATION_CONTEXT_CHANGED instead of guessing an org.
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        role: null,
        organizationId: null,
        organizationName: null,
        contextVersion: sessionRevision,
        effectiveRole: null,
        orgSelectionRequired: true,
        availableOrganizations,
        sessionRevision,
        sessionOrgVersion: null,
      };
    }
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: selected.role,
      organizationId: selected.orgId,
      organizationName: selected.orgName,
      contextVersion: sessionRevision,
      effectiveRole: selected.role,
      sessionRevision,
      sessionOrgVersion: boundVersion,
    };
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
      // The seeded administrator owns the legacy org (ownerless orgs are
      // forbidden). The membership is the authority; accounts.role mirrors it.
      await client.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [LEGACY_ORG_ID, '기존 조직']
      );
      await client.query(
        `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
         VALUES ($1, 'admin', 'AGENCY', true, '[]'::jsonb)
         ON CONFLICT (org_id, account_id) DO NOTHING`,
        [LEGACY_ORG_ID]
      );
      return 'seeded';
    });
  }

  // Whether this install can accept a login at all. A fresh deployment with
  // no administrator configured otherwise shows a normal login form and
  // then answers "이메일 또는 비밀번호를 확인하세요" forever, which tells
  // the operator nothing about the actual cause.
  async function setupState() {
    const result = await database.query(
      "SELECT count(*)::int AS count FROM accounts WHERE role = 'AGENCY' AND active = true"
    );
    const accounts = Number(result.rows[0] && result.rows[0].count) || 0;
    return { ready: accounts > 0, administratorConfigured: accounts > 0 };
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
    const accountResult = await database.query(
      'SELECT 1 FROM accounts WHERE lower(email) = $1 AND active = true LIMIT 1',
      [String(invitation.email || '').toLowerCase()]
    );
    const requiresSignIn = accountResult.rowCount > 0;
    if (invitation.status !== 'PENDING') return { status: 409, requiresSignIn };
    if (new Date(invitation.expires_at).getTime() <= Date.now()) return { status: 410 };
    if (!['MANAGER', 'STAFF', 'AGENCY'].includes(invitation.role)) return { status: 409, requiresSignIn };
    return {
      status: 200,
      invitation: publicInvitation(invitation, { requiresSignIn }),
    };
  }

  // Account projection with the server-verified org context attached, for
  // freshly joined accounts (the invitation org is authoritative here).
  async function membershipAccount(client, accountId, orgId) {
    const accountResult = await client.query(
      'SELECT id, email, name FROM accounts WHERE id = $1 LIMIT 1',
      [String(accountId)]
    );
    const row = accountResult.rows[0];
    if (!row) throw Object.assign(new Error('계정을 찾을 수 없습니다'), { status: 404 });
    const memberResult = await client.query(
      `SELECT m.role, m.revision, o.name AS org_name
       FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.org_id = $1 AND m.account_id = $2 AND m.active = true LIMIT 1`,
      [String(orgId), String(accountId)]
    );
    const member = memberResult.rows[0];
    if (!member || !ROLES.includes(String(member.role))) {
      throw Object.assign(new Error('조직 소속을 확인할 수 없습니다'), { status: 409 });
    }
    return publicAccount({
      id: row.id,
      email: row.email,
      name: row.name,
      role: String(member.role),
      organizationId: String(orgId),
      organizationName: String(member.org_name || ''),
      contextVersion: Number(member.revision) || 0,
      effectiveRole: String(member.role),
    });
  }

  // Invitation events are pinned to the invitation org; a cross-org event
  // reference is stale data, never a privilege escalation.
  async function requireEventInOrgSafe(client, eventId, orgId) {
    const { requireEventInOrg } = require('./tenancy');
    try {
      await requireEventInOrg(client, eventId, orgId);
    } catch (error) {
      throw Object.assign(new Error('초대 정보를 확인할 수 없습니다'), { status: 409 });
    }
  }

  async function acceptInvitation(token, password, currentAccount = null) {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
      throw Object.assign(new Error('초대 링크를 확인할 수 없습니다'), { status: 404 });
    }
    try {
      return await database.transaction(async (client) => {
        const result = await client.query(
          `SELECT id, email, name, role, event_id, org_id, status, expires_at
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
        if (!['MANAGER', 'STAFF', 'AGENCY'].includes(invitation.role) || !normalizeEmail(invitation.email)) {
          throw Object.assign(new Error('초대 정보를 확인할 수 없습니다'), { status: 409 });
        }
        const orgId = String(invitation.org_id || LEGACY_ORG_ID);
        // Share the role-change path's org-row lock before taking account or
        // membership locks. Separate owners accepting stale invites must see
        // each other's commits, and must use the same lock order as role edits.
        await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
        if (invitation.event_id) {
          await requireEventInOrgSafe(client, invitation.event_id, orgId);
        }
        const email = normalizeEmail(invitation.email);
        const existingAccount = (await client.query(
          'SELECT id, email, name, role, active FROM accounts WHERE lower(email) = $1 LIMIT 1 FOR UPDATE',
          [email]
        )).rows[0];
        if (existingAccount) {
          // Existing accounts join with their own login, never by password
          // overwrite: the caller must already be authenticated as that email.
          // The stored password hash is left untouched.
          if (!currentAccount || String(currentAccount.id) !== String(existingAccount.id)) {
            throw Object.assign(
              new Error('이미 등록된 이메일입니다. 해당 계정으로 로그인한 뒤 초대를 수락하세요'),
              { status: 409, code: 'INVITATION_LOGIN_REQUIRED' }
            );
          }
          if (existingAccount.active !== true) {
            throw Object.assign(new Error('사용 중지된 계정입니다'), { status: 409 });
          }
          // A stale invitation must not demote the org's last active owner:
          // the same invariant the role-change path enforces. The org lock
          // above serializes owner-count decisions across both paths.
          const currentMembership = (await client.query(
            `SELECT role, active FROM organization_memberships
             WHERE org_id = $1 AND account_id = $2 LIMIT 1 FOR UPDATE`,
            [orgId, existingAccount.id]
          )).rows[0];
          if (
            currentMembership &&
            currentMembership.role === 'AGENCY' &&
            currentMembership.active === true &&
            invitation.role !== 'AGENCY'
          ) {
            const otherOwners = await client.query(
              `SELECT count(*)::int AS count FROM organization_memberships
               WHERE org_id = $1 AND role = 'AGENCY' AND active = true AND account_id != $2`,
              [orgId, existingAccount.id]
            );
            if (!otherOwners.rows[0].count) {
              throw Object.assign(
                new Error('마지막 조직 소유자는 초대 수락으로 강등될 수 없습니다. 다른 소유자를 먼저 지정하세요'),
                { status: 409, code: 'LAST_OWNER' }
              );
            }
          }
          await client.query(
            `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
             VALUES ($1, $2, $3, true, '[]'::jsonb)
             ON CONFLICT (org_id, account_id)
             DO UPDATE SET active = true, role = EXCLUDED.role,
               revision = organization_memberships.revision + 1`,
            [orgId, existingAccount.id, invitation.role]
          );
          if (invitation.role === 'MANAGER' && invitation.event_id) {
            await client.query(
              `INSERT INTO memberships (account_id, event_id, write_permissions)
               VALUES ($1, $2, '["all"]')
               ON CONFLICT (account_id, event_id) DO NOTHING`,
              [existingAccount.id, invitation.event_id]
            );
          }
          await bumpOrgContext(client, orgId);
          await client.query("UPDATE invitations SET status = 'ACCEPTED' WHERE id = $1", [invitation.id]);
          return membershipAccount(client, existingAccount.id, orgId);
        }
        if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
          throw Object.assign(new Error('비밀번호를 8~200자로 입력하세요'), { status: 400 });
        }
        const accountId = `acct-${crypto.randomUUID()}`;
        const passwordHash = hashPassword(password);
        await client.query(
          `INSERT INTO accounts (id, email, name, role, password_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [accountId, email, invitation.name, invitation.role, passwordHash]
        );
        await client.query(
          `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
           VALUES ($1, $2, $3, true, '[]'::jsonb)`,
          [orgId, accountId, invitation.role]
        );
        if (invitation.role === 'MANAGER' && invitation.event_id) {
          // An invitation names no write scope, so the grant defaults to full
          // access (pre-allow-list behaviour). A narrower grant is an explicit
          // POST /api/events/:id/members afterwards; explicit [] there stays
          // read-only.
          await client.query(
            `INSERT INTO memberships (account_id, event_id, write_permissions)
             VALUES ($1, $2, '["all"]')`,
            [accountId, invitation.event_id]
          );
        }
        await bumpOrgContext(client, orgId);
        await client.query("UPDATE invitations SET status = 'ACCEPTED' WHERE id = $1", [invitation.id]);
        return membershipAccount(client, accountId, orgId);
      });
    } catch (error) {
      if (error && error.code === '23505' && !error.status) {
        throw Object.assign(new Error('이 이메일로 이미 계정이 등록되었습니다'), { status: 409 });
      }
      throw error;
    }
  }

  // Organization-owner gate: AGENCY membership in the request org, never the
  // legacy global accounts.role. A user selected into (or solely in) an org
  // carries that org; multi-membership requests name it via headers. This is
  // an early gate only: state-changing transactions re-resolve with the
  // header requirement enforced, so the denial always carries the right code.
  async function requireAgency(cookieHeader, req = null) {
    const user = await sessionFromCookie(cookieHeader);
    if (!user) throw invitationFailure(401, '로그인이 필요합니다');
    if (user.orgSelectionRequired) throw selectionRequired();
    attachOrgRequest(user, req);
    const org = await database.transaction(async (client) => resolveActorOrg(client, user, { requireHeaders: false }));
    if (org.role !== 'AGENCY') throw invitationFailure(403, '권한을 확인하세요');
    user.organizationId = org.orgId;
    user.organizationName = org.orgName;
    user.contextVersion = org.contextVersion;
    user.effectiveRole = org.role;
    user.role = org.role;
    return user;
  }

  // Invitation issuance. The raw bearer is returned exactly once in the 201
  // response and never persisted: only its SHA256 token_hash is stored.
  // commandId is stable: a replay of the same creation request returns 409
  // INVITATION_LINK_UNAVAILABLE instead of reissuing (or leaking) the link.
  // Boundary only: global identity plus the resolved org, without any
  // role/grant verdict. Receipt scope checks run against this; verdicts run
  // after the receipt replay check (AGENTS order: receipt before permission).
  async function resolveWriteOrg(client, actor) {
    const accountResult = await client.query(
      'SELECT id FROM accounts WHERE id = $1 AND active = true LIMIT 1 FOR SHARE', [actor.id]
    );
    if (!accountResult.rowCount) throw invitationFailure(401, '로그인이 필요합니다');
    return resolveActorOrg(client, actor);
  }

  function requireOrgOwner(org) {
    if (!org || org.role !== 'AGENCY') throw invitationFailure(403, '권한을 확인하세요');
    return org;
  }

  async function createInvitation(actor, input) {
    const commandIdValue = commandIdentifier(input && input.commandId);
    const request = invitationRequest(input);
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-create:${commandIdValue}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-email:${request.email}`]);
        const org = await resolveWriteOrg(client, actor);

        const receiptResult = await client.query(
          'SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [commandIdValue]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          checkReceiptScope(receipt, org.orgId);
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
        requireOrgOwner(org);
        if (request.role === 'AGENCY') {
          if (request.eventId) {
            throw invitationFailure(400, '조직 소유자 초대에는 행사를 지정할 수 없습니다. 소유자는 조직 전체를 관리합니다.', { field: 'eventId' });
          }
        } else if (request.eventId) {
          try {
            const { requireEventInOrg } = require('./tenancy');
            await requireEventInOrg(client, request.eventId, org.orgId);
          } catch (error) {
            if (error && error.code === 'ORGANIZATION_CONTEXT_CHANGED') throw error;
            throw invitationFailure(404, '행사를 찾을 수 없습니다');
          }
          const eventResult = await client.query('SELECT payload FROM events WHERE id = $1 LIMIT 1', [request.eventId]);
          if (eventArchived(eventResult.rows[0].payload)) {
            throw invitationFailure(409, '보관된 행사는 변경할 수 없습니다');
          }
        }

        // An email already registered can still be invited into THIS org: the
        // accept path then joins after the owner logs in, without touching
        // the stored password. Only an existing member of this org is a
        // duplicate here.
        const memberResult = await client.query(
          `SELECT 1 FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id
           WHERE lower(a.email) = $1 AND m.org_id = $2 AND m.active = true LIMIT 1`,
          [request.email, org.orgId]
        );
        if (memberResult.rowCount) {
          throw invitationFailure(409, '이 이메일은 이미 이 조직의 구성원입니다');
        }
        const pendingResult = await client.query(
          `SELECT 1 FROM invitations
            WHERE lower(email) = $1 AND org_id = $2 AND status = 'PENDING' AND expires_at > now()
            LIMIT 1`,
          [request.email, org.orgId]
        );
        if (pendingResult.rowCount) {
          throw invitationFailure(409, '이 이메일로 이미 대기 중인 초대가 있습니다');
        }

        const invitationId = `inv-${crypto.randomUUID()}`;
        const token = crypto.randomBytes(32).toString('base64url');
        const inserted = await client.query(
          `INSERT INTO invitations (id, token_hash, email, name, role, event_id, org_id, payload, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'PENDING', now() + interval '7 days')
           RETURNING id, email, name, role, event_id, status, expires_at`,
          [invitationId, tokenHash(token), request.email, request.name, request.role, request.eventId, org.orgId]
        );
        const invitation = publicInvitation(inserted.rows[0]);
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [commandIdValue, request.eventId, actor.id, org.orgId, JSON.stringify({
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
  async function resetAccountPassword(actor, accountId, password, commandIdValue, keepTokenHash) {
    const id = String(accountId || '').trim();
    if (!id || id.length > 120) throw invitationFailure(404, '계정을 찾을 수 없습니다');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw invitationFailure(400, '비밀번호를 8~200자로 입력하세요', { field: 'password' });
    }
    const command = commandIdentifier(commandIdValue);
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`account-password:${command}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`account-id:${id}`]);
        const org = await resolveWriteOrg(client, actor);

        const receiptResult = await client.query(
          'SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [command]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          checkReceiptScope(receipt, org.orgId);
          const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
          if (String(receipt.actor_id || '') === String(actor.id) &&
              stored.command === 'account.password-reset' &&
              stored.request && String(stored.request.id || '') === id) {
            const current = await client.query(
              'SELECT id, email, name, role, password_hash FROM accounts WHERE id = $1 LIMIT 1',
              [id]
            );
            if (!current.rowCount) throw invitationFailure(404, '계정을 찾을 수 없습니다');
            // Same command id, different password is a different operation:
            // only a byte-identical replay counts as idempotent.
            if (!verifyPassword(password, current.rows[0].password_hash)) {
              throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
            }
            const { password_hash: _dropped, ...account } = current.rows[0];
            return { account: publicAccount(account), replayed: true, sessionsRevoked: 0 };
          }
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        requireOrgOwner(org);

        const found = await client.query(
          'SELECT id, email, name, role, active FROM accounts WHERE id = $1 FOR UPDATE',
          [id]
        );
        if (!found.rowCount) throw invitationFailure(404, '계정을 찾을 수 없습니다');
        if (found.rows[0].active !== true) throw invitationFailure(409, '사용 중지된 계정입니다');
        // Authority is per-org: the target must hold an ACTIVE membership in
        // the actor org (404 otherwise: other-org accounts are invisible).
        // Shared-ness counts EVERY membership row, inactive included: an org
        // that merely paused the account must not reopen global password
        // changes, since re-enabling would inherit whatever was done meanwhile.
        const activeHere = await client.query(
          `SELECT 1 FROM organization_memberships WHERE account_id = $1 AND org_id = $2 AND active = true LIMIT 1`,
          [id, org.orgId]
        );
        if (!activeHere.rowCount) throw invitationFailure(404, '계정을 찾을 수 없습니다');
        const allOrgs = await client.query(
          'SELECT org_id FROM organization_memberships WHERE account_id = $1',
          [id]
        );
        // A password reset is GLOBAL (it revokes every session in every org),
        // so a shared account is fail-closed here with an explanation: only
        // the per-org membership may be deactivated, never the shared login.
        if (allOrgs.rowCount > 1) {
          throw Object.assign(
            new Error('여러 조직에 속한 계정의 비밀번호는 여기서 재설정할 수 없습니다. 해당 조직의 소속만 비활성화하세요'),
            { status: 403, code: 'SHARED_ACCOUNT_GLOBAL_EFFECT' }
          );
        }
        await client.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hashPassword(password), id]);
        // A credential change retires every outstanding recovery bearer:
        // links mailed before this reset must not regain authority
        // afterwards. to_regclass never fails the transaction (unlike a
        // guarded UPDATE, which would abort it and poison every later
        // statement with 25P02 on a pre-016 schema): a missing table simply
        // skips the invalidation. Lock order stays account-then-proofs, like
        // every other credential write.
        const proofsRelation = await client.query("SELECT to_regclass('account_email_proofs') AS present");
        if (proofsRelation.rows[0] && proofsRelation.rows[0].present) {
          await client.query(
            `UPDATE account_email_proofs SET consumed_at = now()
              WHERE account_id = $1 AND consumed_at IS NULL`,
            [id]
          );
        }
        // A reset logs the account out everywhere except the session that
        // performed it, so a compromised password stops working at once.
        const revoked = await client.query(
          'DELETE FROM sessions WHERE account_id = $1 AND token_hash != $2',
          [id, keepTokenHash || '']
        );
        const account = publicAccount(found.rows[0]);
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [command, null, actor.id, org.orgId, JSON.stringify({
            command: 'account.password-reset',
            request: { id },
            response: { account },
          })]
        );
        return { account, replayed: false, sessionsRevoked: revoked.rowCount };
      });
    } catch (error) {
      if (error && error.code === '23505' && !error.status) {
        throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
      }
      throw error;
    }
  }
  async function revokeInvitation(actor, invitationId, commandIdValue) {
    const id = String(invitationId || '').trim();
    if (!id) throw invitationFailure(404, '초대를 찾을 수 없습니다');
    const command = commandIdentifier(commandIdValue);
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-revoke:${command}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invitation-id:${id}`]);
        const org = await resolveWriteOrg(client, actor);

        const receiptResult = await client.query(
          'SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [command]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          checkReceiptScope(receipt, org.orgId);
          const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
          if (String(receipt.actor_id || '') === String(actor.id) &&
              stored.command === 'invitation.revoke' &&
              stored.request && String(stored.request.id || '') === id) {
            const current = await client.query(
              `SELECT id, email, name, role, event_id, status, expires_at
                FROM invitations WHERE id = $1 AND org_id = $2 LIMIT 1`,
              [id, org.orgId]
            );
            if (!current.rowCount) throw invitationFailure(404, '초대를 찾을 수 없습니다');
            return { invitation: publicInvitation(current.rows[0]), replayed: true };
          }
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        requireOrgOwner(org);

        const found = await client.query(
          `SELECT id, email, name, role, event_id, org_id, status, expires_at
            FROM invitations WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!found.rowCount) throw invitationFailure(404, '초대를 찾을 수 없습니다');
        const row = found.rows[0];
        // Another org's invitation is invisible here (no probing oracle).
        if (String(row.org_id || LEGACY_ORG_ID) !== String(org.orgId)) {
          throw invitationFailure(404, '초대를 찾을 수 없습니다');
        }
        if (row.status === 'ACCEPTED') throw invitationFailure(409, '이미 수락된 초대입니다');
        if (row.status === 'PENDING') {
          await client.query("UPDATE invitations SET status = 'REVOKED' WHERE id = $1", [id]);
          row.status = 'REVOKED';
        }
        const invitation = publicInvitation(row);
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [command, row.event_id, actor.id, org.orgId, JSON.stringify({
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

  // ---- Shared-SaaS organization context API (UI contract, early-freeze) ----
  //
  //   GET  /api/auth/organizations
  //     => { organizations: [{id,name,role}], activeOrganizationId, contextVersion }
  //   POST /api/auth/organizations                { name, commandId }
  //     => { organization: {id,name,contextVersion}, commandId } (201/200 replay)
  //   POST /api/auth/organizations/select         { organizationId, expectedContextVersion, commandId }
  //     => { user, activeOrganizationId, contextVersion } (same commandId
  //     retries the same selection from its receipt; the membership is
  //     re-verified and the user carries the fresh context)
  //   POST /api/auth/organizations/:orgId/members/:accountId
  //        { active, expectedContextVersion, commandId }
  //     => per-org membership activation only (no role change, no global effect)
  //
  // Header contract for every state-changing /api call once an account holds
  // more than one active membership:
  //   x-eventouch-organization-id: <organizationId>
  //   x-eventouch-context-version: <contextVersion>
  // Missing context with several memberships answers 409
  // ORGANIZATION_CONTEXT_CHANGED; a version older than the server answers
  // 409 with the same code (same cookie, other tab switched). Single-membership
  // accounts may omit both headers: the server selects their only org.
  async function listOrganizations(user) {
    const result = await database.query(
      `SELECT m.org_id, m.role, o.name AS org_name, o.context_version
       FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.account_id = $1 AND m.active = true
       ORDER BY o.id`,
      [user.id]
    );
    const organizations = result.rows.map((row) => ({
      id: String(row.org_id),
      name: String(row.org_name || ''),
      role: String(row.role),
    }));
    // Same source of truth as /me, select and every write header: the
    // session's selection revision — not the org-side binding version.
    return {
      organizations,
      activeOrganizationId: user.organizationId || null,
      contextVersion: typeof user.sessionRevision === 'number' ? user.sessionRevision : null,
    };
  }

  // Organization selection: pins the SESSION, never the headers. The tab
  // passes expectedContextVersion = its current session revision (from /me);
  // the server CASes it against the locked session row, so two tabs racing
  // to select serialize and the loser gets 409 instead of forking the pin.
  // The receipt is consulted BEFORE any version check, and a replay never
  // writes: if the session moved on since, the caller gets the CURRENT state
  // with 409 (never a silent revert to the old selection).
  async function selectOrganization(user, cookieHeader, input) {
    const organizationId = normalizeOrgId(input && input.organizationId);
    if (!organizationId) throw invitationFailure(400, '조직을 선택하세요', 'organizationId');
    const command = commandIdentifier(input && input.commandId);
    const rawExpected = input && input.expectedContextVersion;
    if (rawExpected === undefined || rawExpected === null || rawExpected === '') {
      throw invitationFailure(400, '조직 정보를 확인하세요', 'expectedContextVersion');
    }
    const expected = Number(rawExpected);
    if (!Number.isInteger(expected) || expected < 0) {
      throw invitationFailure(400, '조직 정보를 확인하세요', 'expectedContextVersion');
    }
    const token = cookieToken(cookieHeader);
    if (!token || token.length > 256) throw invitationFailure(401, '로그인이 필요합니다');
    const hash = tokenHash(token);
    const outcome = await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`org-select:${command}`]);
      const sessionRow = await client.query(
        `SELECT s.org_id, s.org_select_revision, s.org_context_version, a.id AS account_id
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active = true
         LIMIT 1 FOR UPDATE OF s`,
        [hash]
      );
      if (!sessionRow.rowCount || String(sessionRow.rows[0].account_id) !== String(user.id)) {
        throw invitationFailure(401, '로그인이 필요합니다');
      }
      const session = sessionRow.rows[0];
      const sessionRevision = Number(session.org_select_revision) || 0;

      const receiptResult = await client.query(
        'SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
        [command]
      );
      if (receiptResult.rowCount) {
        const receipt = receiptResult.rows[0];
        const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
        if (String(receipt.actor_id || '') !== String(user.id) ||
            stored.command !== 'organization.select' ||
            !stored.request || String(stored.request.organizationId || '') !== String(organizationId)) {
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        const receiptRevision = Number(stored.response && stored.response.revision);
        if (String(session.org_id || '') === String(organizationId) &&
            sessionRevision === receiptRevision) {
          return { replay: true, organizationId, revision: receiptRevision };
        }
        // The session moved on after this nonce committed: report the current
        // state loudly instead of reverting the newer selection.
        throw selectConflict('다른 탭에서 조직을 전환했습니다. 현재 조직을 확인하세요');
      }

      if (expected !== sessionRevision) {
        throw selectConflict('조직 정보가 바뀌었습니다. 새로고침 후 다시 시도하세요');
      }
      const memberResult = await client.query(
        `SELECT m.role, m.revision, o.name AS org_name
         FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
         WHERE m.org_id = $1 AND m.account_id = $2 AND m.active = true LIMIT 1 FOR UPDATE`,
        [organizationId, user.id]
      );
      const member = memberResult.rows[0];
      if (!member) throw orgMismatch();
      const updated = await client.query(
        `UPDATE sessions SET org_id = $2, org_context_version = $3, org_select_revision = $4
         WHERE token_hash = $1`,
        [hash, organizationId, Number(member.revision) || 0, sessionRevision + 1]
      );
      if (!updated.rowCount) throw invitationFailure(401, '로그인이 필요합니다');
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, NULL, $2, $3, $4::jsonb)`,
        [command, user.id, organizationId, JSON.stringify({
          command: 'organization.select',
          request: { organizationId },
          response: { organizationId, revision: sessionRevision + 1 },
        })]
      );
      return { replay: false, organizationId, revision: sessionRevision + 1 };
    });
    const me = await sessionFromCookie(cookieHeader);
    if (!me || me.orgSelectionRequired) {
      throw staleContext('조직 소속이 바뀌었습니다. 다시 로그인하세요');
    }
    return {
      user: me,
      activeOrganizationId: outcome.organizationId,
      contextVersion: outcome.revision,
      ...(outcome.replay ? { replayed: true } : {}),
    };
  }

  // Marks a select race the caller lost: the route re-reads the CURRENT
  // session afterwards and answers 409 with that state, so the tab rebases
  // without guessing and nothing is silently reverted.
  function selectConflict(message) {
    const error = staleContext(message);
    error.stateRefresh = true;
    return error;
  }

  // Organization creation: the caller's CURRENT org must hold an AGENCY
  // membership (no standalone privilege, no manager escalation). The creator
  // becomes the new org's AGENCY in the same transaction, so an ownerless
  // org can never exist. New orgs inherit nothing: no events, clients,
  // files, credentials or memberships are copied.
  async function createOrganization(actor, input) {
    const name = String(input && input.name !== undefined && input.name !== null ? input.name : '').trim();
    if (!name || name.length > 200) throw invitationFailure(400, '조직명을 1~200자로 입력하세요', 'name');
    const command = commandIdentifier(input && input.commandId);
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`org-create:${command}`]);
        // Boundary (never trusted as a selection): the receipt below is
        // global by command_id, and a replay returns the historical creation
        // for the same actor+request only — it never creates another org.
        const org = await resolveWriteOrg(client, actor);
        const receiptResult = await client.query(
          'SELECT actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [command]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
          if (String(receipt.actor_id || '') === String(actor.id) &&
              stored.command === 'organization.create' &&
              stored.request && String(stored.request.name || '') === name &&
              stored.response && stored.response.organization) {
            return { organization: stored.response.organization, commandId: command, replayed: true };
          }
          // A commandId is global: reuse across orgs is a conflict, never a fork.
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        requireOrgOwner(org);
        const orgId = `org-${crypto.randomUUID()}`;
        await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, name]);
        await client.query(
          `INSERT INTO organization_memberships (org_id, account_id, role, active, permissions)
           VALUES ($1, $2, 'AGENCY', true, '[]'::jsonb)`,
          [orgId, actor.id]
        );
        const organization = { id: orgId, name, contextVersion: 0 };
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, NULL, $2, $3, $4::jsonb)`,
          [command, actor.id, orgId, JSON.stringify({
            command: 'organization.create',
            request: { name },
            response: { organization },
          })]
        );
        return { organization, commandId: command, replayed: false };
      });
    } catch (error) {
      if (error && error.code === '23505' && !error.status) {
        throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
      }
      throw error;
    }
  }

  // In-org membership management (owner-only): per-org activation and role
  // changes. At least one of active/role must be given; omitted fields keep
  // their current values (a role-only change never reactivates). Only this
  // org's row is touched, so other orgs of a shared account are unaffected,
  // and the global accounts row (identity/password/active) is never written.
  // Owner scope only: there is no platform-global admin role.
  const ORG_MEMBER_ROLES = ['AGENCY', 'MANAGER', 'STAFF'];
  async function setOrgMembership(actor, orgIdValue, targetAccountId, input) {
    const orgId = normalizeOrgId(orgIdValue);
    if (!orgId) throw invitationFailure(404, '조직을 찾을 수 없습니다');
    const targetId = String(targetAccountId || '').trim();
    if (!targetId || targetId.length > 160) throw invitationFailure(404, '구성원을 찾을 수 없습니다');
    const command = commandIdentifier(input && input.commandId);
    const active = input && input.active === false ? false : input && input.active === true ? true : null;
    const rawRole = input && input.role !== undefined && input.role !== null ? String(input.role).trim().toUpperCase() : '';
    const role = rawRole === '' ? null : rawRole;
    if (active === null && role === null) {
      throw invitationFailure(400, '소속 상태 또는 역할을 지정하세요', 'active');
    }
    if (role !== null && !ORG_MEMBER_ROLES.includes(role)) {
      throw invitationFailure(400, '역할을 확인하세요', 'role');
    }
    const rawExpected = input && input.expectedContextVersion;
    const expected = rawExpected === undefined || rawExpected === null || rawExpected === ''
      ? null
      : Number(rawExpected);
    if (expected !== null && (!Number.isInteger(expected) || expected < 0)) {
      throw invitationFailure(400, '조직 정보를 확인하세요', 'expectedContextVersion');
    }
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`org-member:${command}`]);
        // Receipt before verdict: an applied membership change retried with
        // its original (now old) expected version must still re-confirm.
        const receiptResult = await client.query(
          'SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [command]
        );
        const requestFingerprint = {
          accountId: String(targetId),
          active: active === null ? null : active,
          role: role === null ? null : role,
        };
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          checkReceiptScope(receipt, orgId);
          const stored = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
          if (String(receipt.actor_id || '') === String(actor.id) &&
              stored.command === 'organization.membership.set' &&
              stored.request && String(stored.request.accountId || '') === requestFingerprint.accountId &&
              (stored.request.active === undefined ? null : stored.request.active) === requestFingerprint.active &&
              (stored.request.role === undefined ? null : stored.request.role) === requestFingerprint.role) {
            return { membership: stored.response.membership, previous: stored.response.previous, replayed: true };
          }
          throw invitationFailure(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        // Lock the org before either membership row, just as invitation
        // acceptance does. Re-check the actor only after waiting for this lock.
        await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
        const actorMember = await client.query(
          `SELECT role FROM organization_memberships
           WHERE org_id = $1 AND account_id = $2 AND active = true LIMIT 1 FOR SHARE`,
          [orgId, actor.id]
        );
        if (!actorMember.rowCount || actorMember.rows[0].role !== 'AGENCY') {
          throw invitationFailure(403, '권한을 확인하세요');
        }
        // Owner-safety serializes on the org row itself: two owners racing a
        // demote/deactivate always observe each other's commit in the
        // last-owner check below, so at least one active owner survives.
        const targetResult = await client.query(
          `SELECT account_id, role, active, revision FROM organization_memberships
           WHERE org_id = $1 AND account_id = $2 LIMIT 1 FOR UPDATE`,
          [orgId, targetId]
        );
        if (!targetResult.rowCount) throw invitationFailure(404, '구성원을 찾을 수 없습니다');
        const target = targetResult.rows[0];
        // The expected version binds to the TARGET row: a retried write
        // carries the receipt path instead (checked above), so an applied
        // change always re-confirms.
        if (expected !== null && expected !== (Number(target.revision) || 0)) throw staleContext();
        const nextActive = active === null ? target.active === true : active;
        const nextRole = role === null ? String(target.role) : role;
        // The last active owner can neither be deactivated nor demoted:
        // at least one active AGENCY always remains.
        if (target.role === 'AGENCY' && target.active === true && (nextActive !== true || nextRole !== 'AGENCY')) {
          const owners = await client.query(
            `SELECT count(*)::int AS count FROM organization_memberships
             WHERE org_id = $1 AND role = 'AGENCY' AND active = true AND account_id != $2`,
            [orgId, targetId]
          );
          if (!owners.rows[0].count) {
            throw invitationFailure(409, '마지막 조직 소유자는 비활성화하거나 강등할 수 없습니다');
          }
        }
        const previous = { role: String(target.role), active: target.active === true };
        if (nextActive === (target.active === true) && nextRole === String(target.role)) {
          // No-op: identical state, no revision bump, no receipt.
          return {
            membership: {
              orgId, accountId: targetId, role: String(target.role), active: target.active === true,
              contextVersion: Number(target.revision) || 0,
            },
            previous,
            replayed: false,
          };
        }
        await client.query(
          'UPDATE organization_memberships SET active = $3, role = $4, revision = revision + 1 WHERE org_id = $1 AND account_id = $2',
          [orgId, targetId, nextActive, nextRole]
        );
        await bumpOrgContext(client, orgId);
        const versionResult = await client.query(
          'SELECT revision FROM organization_memberships WHERE org_id = $1 AND account_id = $2 LIMIT 1',
          [orgId, targetId]
        );
        const membership = {
          orgId, accountId: targetId, role: nextRole, active: nextActive,
          contextVersion: Number(versionResult.rows[0].revision) || 0,
        };
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, NULL, $2, $3, $4::jsonb)`,
          [command, actor.id, orgId, JSON.stringify({
            command: 'organization.membership.set',
            request: requestFingerprint,
            response: { membership, previous },
          })]
        );
        return { membership, previous, replayed: false };
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
        const state = await setupState();
        if (!state.ready) {
          sendJson(res, 503, {
            error: '운영자 계정이 아직 설정되지 않았습니다.',
            setupRequired: true,
          });
          return;
        }
      }
      if (!user) {
        await recordFailureSafely('account', throttle.accountKey);
        await recordFailureSafely('address', throttle.address);
        sendJson(res, 401, { error: '이메일 또는 비밀번호를 확인하세요' });
        return;
      }
      await clearFailures('account', throttle.accountKey);
      await clearFailures('address', throttle.address);
      let token;
      try {
        token = await createSession(user.id);
      } catch (error) {
        if (error && error.status) {
          sendJson(res, error.status, Object.assign(
            { error: failureMessage(error, '로그인하지 못했습니다') },
            error.code ? { code: error.code } : null
          ));
          return;
        }
        throw error;
      }
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
      const sessionUser = await sessionFromCookie(cookie);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': databaseCookie(token),
      });
      res.end(JSON.stringify({ user: sessionUser || user }));
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
    if (urlPath === '/api/auth/setup-state' && req.method === 'GET') {
      sendJson(res, 200, await setupState());
      return;
    }
    // A locked-out manager or staffer is told to ask the organization
    // administrator, so the login screen needs a way to reach them. The
    // address is the deployment-configured ADMIN_EMAIL, never an arbitrary
    // account row: it is the administrator the operator chose to publish,
    // and it is only returned once an administrator account actually exists.
    if (urlPath === '/api/auth/help' && req.method === 'GET') {
      const state = await setupState();
      const email = String(env.ADMIN_EMAIL || '').trim();
      const name = String(env.ADMIN_NAME || '').trim() || '조직 관리자';
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      sendJson(res, 200, {
        administrator: state.ready && valid ? { name, email } : null,
      });
      return;
    }
    if (urlPath === '/api/auth/me' && req.method === 'GET') {
      const user = await sessionFromCookie(req.headers.cookie);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      if (user.noMembership) {
        sendJson(res, 403, {
          error: failureMessage({ status: 403, message: '소속된 조직이 없습니다. 관리자에게 문의하세요' }, '소속된 조직이 없습니다. 관리자에게 문의하세요'),
          code: 'NO_ORGANIZATION_MEMBERSHIP',
          user: { id: user.id, email: user.email, name: user.name },
        });
        return;
      }
      stampOrgHeaders((name, value) => res.setHeader(name, value), user);
      sendJson(res, 200, { user });
      return;
    }
    // Read-only login protection overview for the organization owner: which
    // accounts are currently counting failures and which overrides are fresh.
    // Failure rows are counters, not an access log — successful logins are
    // never recorded, so there is nothing here to mistake for one.
    if (urlPath === '/api/auth/security' && req.method === 'GET') {
      let actor;
      try {
        actor = await requireAgency(req.headers.cookie, req);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '보호 상태를 불러오지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
        return;
      }
      try {
        // Org-scoped: an org owner sees only their own org's memberACCOUNT
        // counters. Address (client-IP) rows are deployment-global protection
        // and stay invisible here; so do other orgs' emails and addresses.
        const attempts = await database.query(
          `SELECT scope, key, failures, first_failure_at, last_failure_at
           FROM login_attempts ORDER BY last_failure_at DESC LIMIT 50`
        );
        const overrides = await database.query(
          `SELECT key, cleared_at, cleared_by FROM login_lockout_overrides
           WHERE cleared_at > now() - interval '24 hours' ORDER BY cleared_at DESC LIMIT 50`
        );
        // Shared global accounts are never attributed to one org: their
        // counters stay out of every org view (global protection state, not
        // per-org data). Only sole-membership active members appear.
        const accountKeys = [...new Set(
          attempts.rows.filter((row) => String(row.scope) === 'account').map((row) => String(row.key).toLowerCase())
            .concat(overrides.rows.filter((row) => String(row.key).startsWith('account:')).map((row) => String(row.key).slice('account:'.length).toLowerCase()))
        )];
        let orgEmails = new Set();
        if (accountKeys.length) {
          const members = await database.query(
            `SELECT DISTINCT lower(a.email) AS email
             FROM accounts a JOIN organization_memberships m
               ON m.account_id = a.id AND m.org_id = $2 AND m.active = true
             WHERE lower(a.email) = ANY($1::text[])
               AND NOT EXISTS (
                 SELECT 1 FROM organization_memberships m2
                 WHERE m2.account_id = a.id AND m2.org_id <> $2
               )`,
            [accountKeys, actor.organizationId]
          );
          orgEmails = new Set(members.rows.map((row) => String(row.email)));
        }
        stampOrgHeaders((name, value) => res.setHeader(name, value), actor);
        sendJson(res, 200, {
          attempts: attempts.rows
            .filter((row) => String(row.scope) === 'account' && orgEmails.has(String(row.key).toLowerCase()))
            .map((row) => ({
              scope: String(row.scope),
              key: String(row.key),
              failures: Number(row.failures) || 0,
              firstFailureAt: row.first_failure_at,
              lastFailureAt: row.last_failure_at,
            })),
          overrides: overrides.rows
            .filter((row) => {
              const key = String(row.key);
              if (!key.startsWith('account:')) return false;
              return orgEmails.has(key.slice('account:'.length).toLowerCase());
            })
            .map((row) => ({
              key: String(row.key),
              clearedAt: row.cleared_at,
              clearedBy: row.cleared_by ? String(row.cleared_by) : null,
            })),
          actor: actor.id,
          organizationId: actor.organizationId,
        });
      } catch (error) {
        if (/login_attempts|login_lockout_overrides/.test(String(error && error.message))) {
          sendJson(res, 200, { attempts: [], overrides: [], unmigrated: true, actor: actor.id });
          return;
        }
        sendJson(res, error.status || 500, { error: failureMessage(error, '보호 상태를 불러오지 못했습니다') });
      }
      return;
    }
    // ---- Self-service recovery by verified email ("이메일+수동 예외") ----
    //
    //   POST /api/auth/email/verify/request  { currentPassword }
    //     => { ok, expiresAt } (authenticated holder proves the session still
    //     knows the current password; the token goes to the account's OWN
    //     stored address only). Unconfigured delivery: 503 EMAIL_NOT_CONFIGURED.
    //   POST /api/auth/email/verify/confirm  { token }
    //     => { ok, verified } (mailbox click while signed in as the same
    //     account; invalid/expired/used get distinct honest answers here —
    //     the caller is already authenticated as that account).
    //   GET  /api/auth/email/status
    //     => { verified, verifiedAt, emailMasked, delivery } (own account only).
    //   POST /api/auth/recovery/request  { email }
    //     => { ok } ALWAYS (anonymous): sends only to an active account whose
    //     stored address still equals its proven address. 429 only for the
    //     caller's own address/global abuse — never for an email outcome.
    //   POST /api/auth/recovery/confirm  { token, password }
    //     => { ok } (anonymous): every non-success answers the identical 401.
    //     Success resets the global password and revokes every session.
    //
    // Verification/recovery are GLOBAL identity operations on the caller's
    // own account: no org-owner authority is consulted, and other orgs' rows
    // are never read. Invitation acceptance never counts as verification.
    if (urlPath === '/api/auth/email/verify/request' && req.method === 'POST') {
      res.setHeader('cache-control', 'no-store');
      const user = await sessionFromCookie(req.headers.cookie).catch(() => null);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      if (!recovery) {
        sendJson(res, 503, { error: '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요', code: 'EMAIL_NOT_CONFIGURED' });
        return;
      }
      try {
        const result = await recovery.requestEmailVerification({
          accountId: user.id,
          currentPassword: body && body.currentPassword,
          clientIp: clientAddress(req),
          // Under-lock liveness (see revalidateHolder): a session revoked
          // after this route authenticated cannot mint a proof on dead
          // authority.
          sessionToken: cookieToken(req.headers.cookie),
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '인증 메일을 보내지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
      }
      return;
    }
    if (urlPath === '/api/auth/email/verify/confirm' && req.method === 'POST') {
      res.setHeader('cache-control', 'no-store');
      const user = await sessionFromCookie(req.headers.cookie).catch(() => null);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      if (!recovery) {
        sendJson(res, 503, { error: '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요', code: 'EMAIL_NOT_CONFIGURED' });
        return;
      }
      try {
        const result = await recovery.confirmEmailVerification({
          accountId: user.id,
          token: body && body.token,
          sessionToken: cookieToken(req.headers.cookie),
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '인증 링크를 확인하세요') },
          error.code ? { code: error.code } : null
        ));
      }
      return;
    }
    if (urlPath === '/api/auth/email/status' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store');
      const user = await sessionFromCookie(req.headers.cookie).catch(() => null);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      if (!recovery) {
        sendJson(res, 503, { error: '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요', code: 'EMAIL_NOT_CONFIGURED' });
        return;
      }
      try {
        sendJson(res, 200, await recovery.emailStatus({ accountId: user.id }));
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '인증 상태를 확인하지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
      }
      return;
    }
    if (urlPath === '/api/auth/recovery/request' && req.method === 'POST') {
      res.setHeader('cache-control', 'no-store');
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        // Malformed bodies stay generic too: no oracle, no field leak.
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!recovery) {
        sendJson(res, 200, { ok: true });
        return;
      }
      try {
        // The delivery flag is GLOBAL send capability (never whether this
        // address qualified), so the UI can be honest about an unconfigured
        // provider without oracling.
        const outcome = await recovery.requestRecovery({ email: body && body.email, clientIp: clientAddress(req) });
        sendJson(res, 200, outcome && typeof outcome === 'object' ? outcome : { ok: true });
      } catch (error) {
        if (error && error.status === 429) {
          sendJson(res, 429, { error: failureMessage(error, '요청이 많습니다. 잠시 후 다시 시도하세요') });
          return;
        }
        sendJson(res, 200, { ok: true });
      }
      return;
    }
    if (urlPath === '/api/auth/recovery/confirm' && req.method === 'POST') {
      res.setHeader('cache-control', 'no-store');
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 401, { error: '복구 링크를 확인하세요' });
        return;
      }
      if (!recovery) {
        sendJson(res, 401, { error: '복구 링크를 확인하세요' });
        return;
      }
      try {
        await recovery.confirmRecovery({
          token: body && body.token,
          newPassword: body && body.password,
          clientIp: clientAddress(req),
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, error.status || 401, { error: failureMessage(error, '복구 링크를 확인하세요') });
      }
      return;
    }
    const passwordResetPath = /^\/api\/auth\/accounts\/([^/]+)\/password$/.exec(urlPath);
    if (passwordResetPath && req.method === 'POST') {
      let accountId;
      try {
        accountId = decodeURIComponent(passwordResetPath[1]);
      } catch (error) {
        sendJson(res, 404, { error: '계정을 찾을 수 없습니다' });
        return;
      }
      let actor;
      try {
        actor = await requireAgency(req.headers.cookie, req);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '비밀번호를 재설정하지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
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
        const token = cookieToken(req.headers.cookie);
        const result = await resetAccountPassword(
          actor, accountId, body && body.password, body && body.commandId,
          token && token.length <= 256 ? tokenHash(token) : ''
        );
        sendJson(res, 200, { account: result.account, sessionsRevoked: result.sessionsRevoked });
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '비밀번호를 재설정하지 못했습니다') },
          error.field ? { field: error.field } : null,
          error.code ? { code: error.code } : null
        ));
      }
      return;
    }
    if (urlPath === '/api/auth/invitations' && req.method === 'POST') {
      let actor;
      try {
        actor = await requireAgency(req.headers.cookie, req);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '초대를 만들지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
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
        actor = await requireAgency(req.headers.cookie, req);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '초대를 철회하지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
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
    // ---- Organization context API (see the contract block above) ----
    if (urlPath === '/api/auth/organizations' && req.method === 'GET') {
      const user = await sessionFromCookie(req.headers.cookie);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      try {
        stampOrgHeaders((name, value) => res.setHeader(name, value), user);
        sendJson(res, 200, await listOrganizations(user));
      } catch (error) {
        sendJson(res, error.status || 500, { error: failureMessage(error, '조직 목록을 불러오지 못했습니다') });
      }
      return;
    }
    if (urlPath === '/api/auth/organizations' && req.method === 'POST') {
      let actor;
      try {
        actor = await requireAgency(req.headers.cookie, req);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '조직을 만들지 못했습니다') },
          error.code ? { code: error.code } : null
        ));
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
        const created = await createOrganization(actor, body);
        sendJson(res, created.replayed ? 200 : 201, created);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '조직을 만들지 못했습니다') },
          error.code ? { code: error.code } : null,
          error.field ? { field: error.field } : null
        ));
      }
      return;
    }
    if ((urlPath === '/api/auth/organizations/select' || urlPath === '/api/auth/organization/select') && req.method === 'POST') {
      const user = await sessionFromCookie(req.headers.cookie);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
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
        const selected = await selectOrganization(user, req.headers.cookie, body);
        sendJson(res, 200, selected);
      } catch (error) {
        // A lost select race answers with the CURRENT session state (never a
        // silent revert): same shape as success plus the error/code.
        if (error && error.stateRefresh) {
          const current = await sessionFromCookie(req.headers.cookie).catch(() => null);
          sendJson(res, error.status || 409, {
            error: failureMessage(error, '조직을 선택하지 못했습니다'),
            code: 'ORGANIZATION_CONTEXT_CHANGED',
            user: current,
            activeOrganizationId: current ? current.organizationId : null,
            contextVersion: current ? current.contextVersion : null,
          });
          return;
        }
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '조직을 선택하지 못했습니다') },
          error.code ? { code: error.code } : null,
          error.field ? { field: error.field } : null
        ));
      }
      return;
    }
    const orgMemberPath = /^\/api\/auth\/organizations\/([^/]+)\/members\/([^/]+)$/.exec(urlPath);
    if (orgMemberPath && req.method === 'POST') {
      let orgId;
      let targetAccountId;
      try {
        orgId = decodeURIComponent(orgMemberPath[1]);
        targetAccountId = decodeURIComponent(orgMemberPath[2]);
      } catch (error) {
        sendJson(res, 404, { error: '구성원을 찾을 수 없습니다' });
        return;
      }
      const user = await sessionFromCookie(req.headers.cookie);
      if (!user) {
        sendJson(res, 401, { error: '로그인이 필요합니다' });
        return;
      }
      if (user.orgSelectionRequired) {
        sendJson(res, 409, { error: '조직을 선택하세요', code: 'ORGANIZATION_CONTEXT_CHANGED' });
        return;
      }
      attachOrgRequest(user, req);
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      try {
        const result = await setOrgMembership(user, orgId, targetAccountId, body);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, error.status || 500, Object.assign(
          { error: failureMessage(error, '소속을 변경하지 못했습니다') },
          error.code ? { code: error.code } : null,
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
          sendJson(res, result.status, result.requiresSignIn === true
            ? { error, requiresSignIn: true }
            : { error });
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
          const currentUser = await sessionFromCookie(req.headers.cookie).catch(() => null);
          const account = await acceptInvitation(token, body && body.password, currentUser);
          sendJson(res, 201, { account });
        } catch (error) {
          sendJson(res, error.status || 500, Object.assign(
            { error: failureMessage(error, '초대를 수락하지 못했습니다') },
            error.code ? { code: error.code } : null
          ));
        }
        return;
      }
    }
    sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
  }

  // Operational escape hatch: clear a lockout without waiting out the block.
  // Requires an authenticated AGENCY session so it cannot itself be abused.
  // Lockout release is org-scoped like everything else. Address (client-IP)
  // rows are deployment-global protection: org owners can neither see nor
  // clear them. Account rows clear only for active members of the actor org,
  // and a shared (multi-org) account is safe-blocked with
  // SHARED_ACCOUNT_GLOBAL_EFFECT — releasing it would affect other orgs.
  // Single-org members keep the historical release behavior.
  async function clearLoginLockout(req, res, scopeValue, keyValue) {
    const actor = await sessionFromCookie(req.headers.cookie);
    if (!actor || actor.noMembership || actor.orgSelectionRequired || actor.role !== 'AGENCY') {
      sendJson(res, 403, { error: '운영사 구성원만 잠금을 해제할 수 있습니다' });
      return;
    }
    attachOrgRequest(actor, req);
    let org;
    try {
      org = await database.transaction(async (client) => resolveActorOrg(client, actor, { requireHeaders: false }));
    } catch (error) {
      sendJson(res, error.status || 403, Object.assign(
        { error: failureMessage(error, '운영사 구성원만 잠금을 해제할 수 있습니다') },
        error.code ? { code: error.code } : null
      ));
      return;
    }
    if (org.role !== 'AGENCY') {
      sendJson(res, 403, { error: '운영사 구성원만 잠금을 해제할 수 있습니다' });
      return;
    }
    const scope = scopeValue === 'address' ? 'address' : 'account';
    const key = String(keyValue || '').trim().toLowerCase();
    if (!key) {
      sendJson(res, 400, { error: '해제할 대상을 입력하세요' });
      return;
    }
    if (scope === 'address') {
      sendJson(res, 403, { error: '전역 주소 보호는 해제할 수 없습니다. 잠시 후 다시 시도하세요' });
      return;
    }
    const activeHere = await database.query(
      `SELECT 1 FROM accounts a JOIN organization_memberships m
         ON m.account_id = a.id AND m.org_id = $2 AND m.active = true
       WHERE lower(a.email) = $1 LIMIT 1`,
      [key, org.orgId]
    );
    if (!activeHere.rowCount) {
      sendJson(res, 404, { error: '해제할 대상을 찾을 수 없습니다' });
      return;
    }
    // Shared-ness counts every membership row, inactive included: releasing
    // a paused-away account globally would leak into the other org on return.
    const allOrgs = await database.query(
      `SELECT m.org_id FROM accounts a JOIN organization_memberships m
         ON m.account_id = a.id
       WHERE lower(a.email) = $1`,
      [key]
    );
    if (allOrgs.rowCount > 1) {
      sendJson(res, 403, Object.assign(
        { error: '여러 조직에 속한 계정의 잠금은 여기서 해제할 수 없습니다. 해당 조직의 소속만 비활성화하세요' },
        { code: 'SHARED_ACCOUNT_GLOBAL_EFFECT' }
      ));
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
    setupState,
    readInvitation,
    acceptInvitation,
    listOrganizations,
    selectOrganization,
    createOrganization,
    setOrgMembership,
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
