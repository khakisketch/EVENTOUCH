'use strict';

// Shared-SaaS organization isolation: the single server-side authority.
//
// Design (user-confirmed, binding):
// - accounts are the GLOBAL identity (login, password, global suspend, global
//   lockout). role/active/permissions truth per org lives in
//   organization_memberships, never in accounts.role.
// - The org context is always server-verified: session row (selected org +
//   context snapshot) x membership activeness x organizations.context_version.
//   A client-sent orgId is a selection request, never a privilege.
// - No-context requests do NOT fall back to legacy: with exactly one active
//   membership the server selects it (single-org compat); with zero it
//   denies; with several it demands an explicit selection (fail-closed).
// - Stale tabs (old contextVersion) and in-flight retries fixed to their
//   original org are denied on mismatch, never rewritten to another org.
// - Ownership boundary: clients/events/invitations/receipts carry org_id;
//   children (workspaces, event memberships, assignments, tickets, check-ins,
//   files, outbox) resolve through their parent event/client. Every query on
//   those roots carries an explicit org predicate (see predicates below).
//   No AsyncLocalStorage magic, no string-SQL rewriting tricks; RLS is not
//   relied upon (owner/superuser bypass exists), so the predicates here are
//   the enforcement point.

const LEGACY_ORG_ID = 'org-legacy';

const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// UI <-> server header contract (main-frozen, shared with the UI architects):
//   x-eventouch-organization-id: <organizationId>
//   x-eventouch-context-version: <contextVersion integer>
// Both ride every state-changing /api write once the account holds more than
// one active membership. Single-membership accounts may omit them: the server
// derives the only valid org from the membership and never assumes a legacy
// org. Any mismatch, drift, or missing context where one is required answers
// 409 with code ORGANIZATION_CONTEXT_CHANGED. Bodies keep commandId
// idempotency; the session cookie keeps authenticating.
const ORG_HEADER = 'x-eventouch-organization-id';
const ORG_VERSION_HEADER = 'x-eventouch-context-version';

const ERROR_MESSAGE = {
  login: '로그인이 필요합니다',
  forbidden: '권한을 확인하세요',
  orgMismatch: '다른 조직의 항목입니다. 조직을 전환한 뒤 다시 시도하세요',
  stale: '조직 정보가 바뀌었습니다. 새로고침 후 다시 시도하세요',
  selectionRequired: '조직을 선택하세요',
  noMembership: '소속된 조직이 없습니다. 관리자에게 문의하세요',
};

const NO_MEMBERSHIP_CODE = 'NO_ORGANIZATION_MEMBERSHIP';

// Normal identity, no membership anywhere: 403 with a stable machine code so
// the UI can guide (contact admin / wait for an invite) instead of showing a
// bare login failure. Selection recovery (other orgs remain) is separate.
function noMembership() {
  return Object.assign(new Error(ERROR_MESSAGE.noMembership), { status: 403, code: NO_MEMBERSHIP_CODE });
}

function denied(status = 403, message) {
  return Object.assign(new Error(message || (status === 401 ? ERROR_MESSAGE.login : ERROR_MESSAGE.forbidden)), { status });
}

function staleContext(message) {
  return Object.assign(new Error(message || ERROR_MESSAGE.stale), { status: 409, code: 'ORGANIZATION_CONTEXT_CHANGED' });
}

function selectionRequired() {
  return Object.assign(new Error(ERROR_MESSAGE.selectionRequired), { status: 409, code: 'ORGANIZATION_CONTEXT_CHANGED' });
}

function orgMismatch() {
  return Object.assign(new Error(ERROR_MESSAGE.orgMismatch), { status: 409, code: 'ORGANIZATION_CONTEXT_CHANGED' });
}

function normalizeOrgId(value) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  if (!id) return null;
  if (!ORG_ID_PATTERN.test(id)) throw denied(400, '조직을 확인하세요');
  return id;
}

function parseOrgHeaders(req) {
  const headers = (req && req.headers) || {};
  const orgId = normalizeOrgId(headers[ORG_HEADER]);
  const rawVersion = headers[ORG_VERSION_HEADER];
  let contextVersion = null;
  if (rawVersion !== undefined && rawVersion !== null && String(rawVersion).trim() !== '') {
    const parsed = Number(String(rawVersion).trim());
    if (!Number.isInteger(parsed) || parsed < 0) throw denied(400, '조직 정보를 확인하세요');
    contextVersion = parsed;
  }
  return { orgId, contextVersion };
}

// The user-facing contextVersion is the SESSION's selection revision
// (sessions.org_select_revision, monotonic per session, bumped by every
// successful organization.select). The org-side revision
// (organizations.context_version, bumped by every membership change) is the
// binding the session snapshots at select time: a write additionally
// requires the snapshot to equal the live org revision, so membership edits
// deny stale tabs instead of acting on them.
// Membership rows carry their own revision: a tab binds to its OWN row,
// so someone else's join or grant never invalidates this viewer's binding.
// Only a change to the viewer's own membership forces an explicit reselect.
async function activeMemberships(client, accountId) {
  const result = await client.query(
    `SELECT m.org_id, m.role, m.active, m.permissions, m.revision,
            o.name AS org_name, o.context_version AS org_context_version
     FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.account_id = $1 AND m.active = true
     ORDER BY o.id`,
    [String(accountId)]
  );
  return result.rows.map((row) => ({
    orgId: String(row.org_id),
    role: String(row.role),
    permissions: Array.isArray(row.permissions) ? [...row.permissions] : [],
    orgName: String(row.org_name || ''),
    revision: Number(row.revision) || 0,
    // Coarse org clock (change marker only). The tab binding uses revision.
    contextVersion: Number(row.org_context_version) || 0,
  }));
}

// The per-request org authority. Must run inside the request's transaction
// (or on a connection) so the membership check and the write share one view.
//
// Headers never SELECT an org: they only pin the tab's view of the session
// selection. The session pin (org + its monotonic revision) is authoritative,
// and the session's org binding must still equal the live org revision.
// - requestedOrgId: tab's header; must equal the session org when one is set,
//   otherwise 409 (a header cannot override or substitute a selection).
// - expectedVersion: tab's session revision; must equal the session revision.
// - sessionOrgId/sessionRevision/sessionOrgVersion: server-stored selection.
// A selected session with no/partial headers on a multi-membership account
// is 409. A null session org resolves only for single-membership accounts
// (legacy client compat). Anything ambiguous is fail-closed.
async function resolveOrgContext(client, accountId, {
  requestedOrgId = null,
  expectedVersion = null,
  sessionOrgId = null,
  sessionRevision = null,
  sessionOrgVersion = null,
  requireHeaders = true,
} = {}) {
  const id = String(accountId || '').trim();
  if (!id) throw denied(401);
  const memberships = await activeMemberships(client, id);
  if (!memberships.length) throw noMembership();
  const multi = memberships.length > 1;

  const pick = (orgId) => memberships.find((entry) => entry.orgId === orgId) || null;

  if (sessionOrgId) {
    const found = pick(sessionOrgId);
    // The session's org was deactivated: deny, never silently rewrite to
    // another org.
    if (!found) throw staleContext('조직 소속이 바뀌었습니다. 다시 로그인하거나 조직을 선택하세요');
    if (requestedOrgId && String(requestedOrgId) !== String(sessionOrgId)) {
      throw staleContext('다른 조직이 선택되어 있습니다. 새로고침 후 다시 시도하세요');
    }
    // Writes on multi-membership sessions always carry both headers. Reads
    // may rely on the session pin alone.
    if (multi && requireHeaders && (requestedOrgId == null || expectedVersion === null)) {
      throw staleContext('요청 조직 정보를 확인하세요');
    }
    if (expectedVersion !== null && sessionRevision !== null &&
        Number(expectedVersion) !== Number(sessionRevision)) {
      throw staleContext();
    }
    if (sessionOrgVersion !== null && Number(sessionOrgVersion) !== Number(found.revision)) {
      throw staleContext('조직 정보가 바뀌었습니다. 조직을 다시 선택하세요');
    }
    return { ...found, sessionRevision };
  }

  if (multi) throw selectionRequired();
  const only = memberships[0];
  if (requestedOrgId && String(requestedOrgId) !== String(only.orgId)) throw orgMismatch();
  return { ...only, sessionRevision };
}

// Enforces that an event belongs to the resolved org. Reads should map the
// thrown 404 (no probing oracle); writes map to the 403 explanation — both
// helpers throw orgMismatch() and the caller picks the user-facing shape.
async function requireEventInOrg(client, eventId, orgId, { lock = false } = {}) {
  const id = String(eventId || '').trim();
  if (!id) {
    const error = orgMismatch();
    error.status = 404;
    error.message = '행사를 찾을 수 없습니다';
    throw error;
  }
  const result = await client.query(
    `SELECT org_id FROM events WHERE id = $1 LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  if (!result.rowCount) {
    const error = orgMismatch();
    error.status = 404;
    error.message = '행사를 찾을 수 없습니다';
    throw error;
  }
  if (String(result.rows[0].org_id || '') !== String(orgId)) throw orgMismatch();
  return true;
}

async function requireClientInOrg(client, clientId, orgId) {
  const id = String(clientId || '').trim();
  if (!id) throw denied(404, '고객사를 찾을 수 없습니다');
  const result = await client.query('SELECT org_id FROM clients WHERE id = $1 LIMIT 1', [id]);
  if (!result.rowCount) throw denied(404, '고객사를 찾을 수 없습니다');
  if (String(result.rows[0].org_id || '') !== String(orgId)) throw orgMismatch();
  return true;
}

// Receipts keep their global command_id collision meaning, but a receipt from
// another org is never returned: same key + different org is a conflict, and
// a confirmed receipt is never re-sent into another org.
function checkReceiptScope(receiptRow, orgId) {
  if (!receiptRow) return null;
  if (receiptRow.org_id && String(receiptRow.org_id) !== String(orgId)) {
    throw Object.assign(new Error('요청 식별자가 이미 다른 작업에 사용되었습니다'), { status: 409 });
  }
  return receiptRow;
}

// Authoritative identity for an event write inside the command transaction:
// global account + active org membership + event-in-org. Throws errors with
// {status, code} for the executor to map onto its failure shape. A receipt
// confirmed in another org is never returned here (see checkReceiptScope).
async function resolveEventAuthority(client, account, eventId, { requireHeaders = true } = {}) {
  if (!account || !account.id) throw denied(401);
  const idResult = await client.query(
    'SELECT id FROM accounts WHERE id = $1 AND active = true LIMIT 1 FOR SHARE',
    [String(account.id)]
  );
  if (!idResult.rowCount) throw denied(401);
  const org = await resolveActorOrg(client, account, { requireHeaders });
  try {
    await requireEventInOrg(client, eventId, org.orgId);
  } catch (error) {
    // requireEventInOrg already throws the frozen denial (409 +
    // ORGANIZATION_CONTEXT_CHANGED) for cross-org writes; only non-status
    // surprises fall through.
    throw error;
  }
  return org;
}

// Bumps the org context so stale tabs/membership caches are denied at the
// next write. Call inside the same transaction that changes memberships.
async function bumpOrgContext(client, orgId) {
  await client.query(
    'UPDATE organizations SET context_version = context_version + 1 WHERE id = $1',
    [String(orgId)]
  );
}


// Request plumbing: the boundary copies the tab's org headers onto the
// session account as request-scoped hints. They are verified against the
// membership table inside every transaction (resolveActorOrg) and confer
// nothing by themselves.
// Response stamping for org-scoped private GETs. The ONLY values ever
// stamped are the request-start session snapshot (org + its monotonic
// selection revision) that the successful data path just verified: a 200
// means the in-transaction checks passed for exactly these values, so a tab
// that switched to B mid-flight never gets its A-verified reply stamped B.
// Unselected sessions (org null) stamp nothing; the explicit selector body
// stays usable without headers. Health/public/OTP never stamp.
function stampOrgHeaders(setHeader, account) {
  if (!account || typeof account !== 'object') return false;
  const orgId = account.organizationId;
  const version = account.sessionRevision !== undefined && account.sessionRevision !== null
    ? account.sessionRevision
    : account.contextVersion;
  if (typeof orgId !== 'string' || !orgId) return false;
  if (typeof version !== 'number' && typeof version !== 'string') return false;
  try {
    setHeader('x-eventouch-organization-id', String(orgId));
    setHeader('x-eventouch-context-version', String(version));
  } catch (error) {
    return false;
  }
  return true;
}

function attachOrgRequest(account, req) {
  if (!account || typeof account !== 'object') return account;
  try {
    const parsed = parseOrgHeaders(req);
    if (parsed.orgId) account.requestedOrgId = parsed.orgId;
    if (parsed.contextVersion !== null && parsed.contextVersion !== undefined) {
      account.expectedVersion = parsed.contextVersion;
    }
  } catch (error) {
    account.orgHeaderError = error;
  }
  return account;
}

// Per-transaction org authority for a session account carrying request hints.
async function resolveActorOrg(client, actor, { requireHeaders = true } = {}) {
  if (actor && actor.orgHeaderError) throw actor.orgHeaderError;
  return resolveOrgContext(client, actor && actor.id, {
    requestedOrgId: (actor && actor.requestedOrgId) || null,
    expectedVersion: actor && actor.expectedVersion !== undefined && actor.expectedVersion !== null
      ? actor.expectedVersion
      : null,
    sessionOrgId: (actor && actor.organizationId) || null,
    sessionRevision: actor && actor.sessionRevision !== undefined && actor.sessionRevision !== null
      ? actor.sessionRevision
      : null,
    sessionOrgVersion: actor && actor.sessionOrgVersion !== undefined && actor.sessionOrgVersion !== null
      ? actor.sessionOrgVersion
      : null,
    requireHeaders,
  });
}

module.exports = {
  LEGACY_ORG_ID,
  ORG_HEADER,
  ORG_VERSION_HEADER,
  ERROR_MESSAGE,
  denied,
  staleContext,
  selectionRequired,
  orgMismatch,
  normalizeOrgId,
  parseOrgHeaders,
  activeMemberships,
  resolveOrgContext,
  requireEventInOrg,
  requireClientInOrg,
  checkReceiptScope,
  bumpOrgContext,
  attachOrgRequest,
  stampOrgHeaders,
  resolveActorOrg,
  resolveEventAuthority,
  noMembership,
  NO_MEMBERSHIP_CODE,
};
