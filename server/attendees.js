'use strict';

// Attendee verification and browser sessions (slice 7a).
//
// Three credentials with three disjoint jobs:
//
//   admission token  the existing QR bearer; unchanged, still the only
//                    credential scanners accept.
//   challenge code   6-digit SMS proof of phone possession. Short-lived,
//                    attempt-bounded, single-use. Never returned to HTTP.
//   browser session  opaque HttpOnly cookie token mapping to per-event
//                    grants. Restores read access (own ticket incl. QR) on
//                    the same browser; authorizes nothing by itself.
//
// Lookup rules that keep enumeration out:
//
//   - request always answers 200-shaped success, whether or not the number
//     is registered or the event takes verification.
//   - confirm answers the same generic failure for wrong code, expired
//     challenge, exhausted attempts, and (recover) unknown number.
//   - QR/token possession never mints a session: no endpoint exchanges a
//     ticket token for session grants.
//
// Sessions authorize READS only in this slice (own ticket incl. QR token,
// so the tab can resume bearer flows from memory). Guest writes still
// require the ticket bearer.

const crypto = require('node:crypto');

const ATTENDEE_COOKIE = 'etko_attendee';
const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const DAILY_CAP_PER_PHONE = 10;
const HOURLY_GLOBAL_CAP = 500;
const GRANT_TTL_MINUTES = 15;
const SESSION_DEFAULT_DAYS = 90;
const SESSION_EVENT_TAIL_DAYS = 30;
const SESSION_MAX_DAYS = 180;
const TICKET_TOKEN = /^(?:[A-Za-z0-9_-]{32,128}|ET:[A-Za-z0-9_-]{1,80}:T-[A-Za-z0-9_-]{32,128})$/;
const PUBLIC_STAGES = new Set(['READY', 'LIVE', 'ENDED']);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function normalizePhone(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

function validPhone(phone) {
  return /^\d{9,15}$/.test(phone);
}

function failure(status, message, field, code) {
  return Object.assign(new Error(message), { status }, field ? { field } : {}, code ? { code } : {});
}

// Generic failure shared by every confirm path so responses do not tell
// registered numbers apart from wrong codes.
function genericConfirmFailure() {
  return failure(401, '인증번호를 확인하세요', 'code');
}

// Each event gets a stable cookie name based on its immutable internal id.
// A slug can change, and two initial event responses must not overwrite one
// another's browser credential. Keep the old common name readable.
function attendeeCookieName(eventId) {
  return eventId ? `${ATTENDEE_COOKIE}_${sha256(eventId).slice(0, 24)}` : ATTENDEE_COOKIE;
}

function attendeeCookie(token, maxAgeSeconds, eventId) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  const maxAge = Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0
    ? `; Max-Age=${maxAgeSeconds}`
    : '';
  return `${attendeeCookieName(eventId)}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secure}${maxAge}`;
}

function cookieEntry(header, name) {
  let found = false;
  let value = null;
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    // Ambiguous duplicate names must never select a different session.
    if (found) return { present: true, value: null };
    found = true;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim()) || null;
    } catch (error) {
      value = null;
    }
  }
  return { present: found, value };
}

function cookieToken(header, eventId) {
  if (eventId) {
    const scoped = cookieEntry(header, attendeeCookieName(eventId));
    // Invalid or empty event cookies block legacy fallback: a stale common
    // grant must not silently select a different participant.
    if (scoped.present) return scoped.value;
  }
  return cookieEntry(header, ATTENDEE_COOKIE).value;
}

function grantsFromRow(row) {
  if (!row) return [];
  const grants = row.grants;
  if (!Array.isArray(grants)) return [];
  return grants.filter((grant) =>
    grant && typeof grant.eventId === 'string' && typeof grant.participantId === 'string'
  );
}

function sessionExpiry(eventEndMs, nowMs) {
  const tail = SESSION_EVENT_TAIL_DAYS * 24 * 3600 * 1000;
  const max = SESSION_MAX_DAYS * 24 * 3600 * 1000;
  const fallback = nowMs + SESSION_DEFAULT_DAYS * 24 * 3600 * 1000;
  const anchored = Number.isFinite(eventEndMs) ? eventEndMs + tail : fallback;
  return new Date(Math.min(Math.max(nowMs + 3600 * 1000, anchored), nowMs + max));
}

function createAttendeeAccess(database, { transport } = {}) {
  async function findEvent(ref) {
    const byId = await database.query(
      'SELECT id, slug, org_id, payload FROM events WHERE id = $1 LIMIT 1',
      [String(ref || '')]
    );
    if (byId.rows[0]) return byId.rows[0];
    const bySlug = await database.query(
      'SELECT id, slug, org_id, payload FROM events WHERE slug = $1 LIMIT 1',
      [String(ref || '')]
    );
    return bySlug.rows[0] || null;
  }

  function eventEndMs(event) {
    const payload = (event && event.payload) || {};
    const end = Date.parse(`${String(payload.date || '').slice(0, 32)}T23:59:00`);
    return Number.isFinite(end) ? end : NaN;
  }

  function activeParticipant(workspacePayload, participantId) {
    const people = (workspacePayload && workspacePayload.participants) || [];
    if (!Array.isArray(people)) return null;
    const person = people.find((item) => item && item.id === participantId) || null;
    if (!person || String(person.status || '').toUpperCase() === 'CANCELLED' || person.cancelled === true) return null;
    return person;
  }

  function participantByPhone(workspacePayload, phone) {
    const people = (workspacePayload && workspacePayload.participants) || [];
    if (!Array.isArray(people)) return null;
    return people.find((item) =>
      item && String(item.status || '').toUpperCase() !== 'CANCELLED' && item.cancelled !== true &&
      normalizePhone(item.phone) === phone
    ) || null;
  }

  async function requestChallenge({ eventRef, phone: rawPhone, purpose }) {
    const phone = normalizePhone(rawPhone);
    const cleanPurpose = purpose === 'RECOVER' ? 'RECOVER' : 'ENROLL';
    if (!validPhone(phone)) throw failure(400, '연락처를 숫자 9~15자리로 입력하세요', 'phone');
    const event = await findEvent(eventRef);
    // Unknown event or number: same success shape, nothing sent. The
    // caller learns nothing about registration or event existence.
    if (!event) return { challengeId: null, expiresAt: null };
    const now = Date.now();

    const id = `ac-${randomToken(16)}`;
    const code = randomCode();
    const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    // Reserve the send under a short lock. Supplier I/O stays after commit,
    // but simultaneous clicks cannot overspend the cooldown/daily limits.
    await database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('attendee-challenge-admission', 0))");
    // Hourly admission cap is per-organization (event -> org join), so one
    // org's traffic can never starve another into 429s. Pre-011 rows without
    // an org match only their own NULL partition and never another org.
    const eventOrgId = event.org_id ? String(event.org_id) : null;
    const hourly = await client.query(
      `SELECT COUNT(*)::int AS n FROM attendee_challenges c
        LEFT JOIN events e ON e.id = c.event_id
       WHERE c.created_at > now() - interval '1 hour'
         AND e.org_id IS NOT DISTINCT FROM $1::text`,
      [eventOrgId]
    );
    const hourlyCap = Number(process.env.EVENTOUCH_VERIFY_HOURLY_CAP || HOURLY_GLOBAL_CAP);
    if (hourly.rows[0].n >= hourlyCap) {
      throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
    }
    const recent = await client.query(
      `SELECT id, created_at FROM attendee_challenges
        WHERE event_id = $1 AND phone = $2 AND consumed_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC LIMIT 5`,
      [event.id, phone]
    );
    const pending = recent.rows;
    if (pending.length) {
      const latest = Date.parse(pending[0].created_at);
      if (Number.isFinite(latest) && now - latest < RESEND_COOLDOWN_SECONDS * 1000) {
        throw failure(429, '인증번호를 다시 받으려면 잠시 후 시도하세요', 'phone');
      }
      if (pending.length >= 3) {
        throw failure(429, '이전 인증번호를 먼저 입력하세요', 'phone');
      }
    }
    const daily = await client.query(
      `SELECT COUNT(*)::int AS n FROM attendee_challenges
        WHERE event_id = $1 AND phone = $2 AND created_at > date_trunc('day', now())`,
      [event.id, phone]
    );
    if (daily.rows[0].n >= DAILY_CAP_PER_PHONE) {
      throw failure(429, '오늘 받을 수 있는 횟수를 초과했습니다. 내일 다시 시도하세요', 'phone');
    }

    await client.query(
      `INSERT INTO attendee_challenges
         (id, event_id, phone, purpose, code_hash, max_attempts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [id, event.id, phone, cleanPurpose, sha256(code), CODE_MAX_ATTEMPTS, expiresAt]
    );
    });

    const eventName = String((event.payload && event.payload.name) || '행사');
    // Deployment SMS credentials are legacy-org bound and never auto-inherited:
    // a new org's event does not send through them (honest NOT_CONFIGURED,
    // same as an unconfigured install). The explicit mock transport keeps
    // working everywhere for tests/dev. A NULL org only exists on legacy test
    // fixtures written before 011; migration backfills every real row.
    const { LEGACY_ORG_ID } = require('./tenancy');
    const eventOrgId = event.org_id ? String(event.org_id) : null;
    const transportMode = transport && typeof transport.state === 'function'
      ? transport.state().mode
      : 'none';
    const smsAllowed = transport && !(transportMode === 'solapi' && eventOrgId && eventOrgId !== String(LEGACY_ORG_ID));
    const send = smsAllowed
      ? await transport.sendCode({ to: phone, code, eventName })
      : { sent: false, reason: 'NOT_CONFIGURED' };
    if (!send.sent) {
      await database.query(
        `UPDATE attendee_challenges SET send_state = 'FAILED' WHERE id = $1`,
        [id]
      );
      if (send.reason === 'NOT_CONFIGURED') {
        throw Object.assign(
          failure(503, '인증번호 발송이 준비되지 않았습니다. 운영자에게 문의하세요'),
          { code: 'NEEDS_CONNECTION' }
        );
      }
      throw failure(503, typeof send.error === 'string' ? send.error : '인증번호를 보내지 못했습니다. 다시 시도하세요');
    }
    await database.query(
      `UPDATE attendee_challenges SET send_state = $2 WHERE id = $1`,
      [id, send.mode === 'mock' ? 'MOCK' : 'SENT']
    );
    return { challengeId: id, expiresAt };
  }

  async function confirmChallenge({ eventRef, phone: rawPhone, code: rawCode, cookieHeader }) {
    const phone = normalizePhone(rawPhone);
    const code = String(rawCode || '').replace(/\D/g, '').slice(0, 6);
    if (!validPhone(phone) || code.length !== 6) throw genericConfirmFailure();
    const event = await findEvent(eventRef);
    if (!event) throw genericConfirmFailure();

    const verified = await database.transaction(async (client) => {
    // Keep event/workspace, challenge, then session in the same lock order
    // as participant cancellation and phone changes. The code must not be
    // checked against one participant state and attached to another.
    const locked = await client.query(
      `SELECT e.id, e.slug, e.org_id, e.payload, w.payload AS workspace_payload
         FROM events e JOIN event_workspaces w ON w.event_id = e.id
        WHERE e.id = $1 FOR UPDATE OF e, w`, [event.id]
    );
    if (!locked.rows[0]) return null;
    const pending = await client.query(
      `SELECT * FROM attendee_challenges
         WHERE event_id = $1 AND phone = $2
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [event.id, phone]
    );
    const challenge = pending.rows[0];
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= Date.now() ||
        Number(challenge.attempts) >= Number(challenge.max_attempts || CODE_MAX_ATTEMPTS)) return null;
    const expected = Buffer.from(String(challenge.code_hash), 'hex');
    const probe = Buffer.from(sha256(code), 'hex');
    const matches = expected.length === probe.length && crypto.timingSafeEqual(expected, probe);
    if (!matches) {
      const attempts = Number(challenge.attempts || 0) + 1;
      if (attempts >= Number(challenge.max_attempts || CODE_MAX_ATTEMPTS)) {
        await client.query(
          `UPDATE attendee_challenges SET attempts = $2, consumed_at = now() WHERE id = $1`,
          [challenge.id, attempts]
        );
      } else {
        await client.query(
          `UPDATE attendee_challenges SET attempts = $2 WHERE id = $1`,
          [challenge.id, attempts]
        );
      }
      // Return, rather than throw: failed attempts must commit even though
      // the HTTP result is a generic verification failure.
      return null;
    }
    await client.query(
      `UPDATE attendee_challenges SET attempts = attempts + 1, consumed_at = now() WHERE id = $1`,
      [challenge.id]
    );

    if (challenge.purpose === 'ENROLL') {
      const grant = randomToken(32);
      const grantExpiresAt = new Date(Date.now() + GRANT_TTL_MINUTES * 60 * 1000).toISOString();
      await client.query(
        `INSERT INTO attendee_grants (token_hash, event_id, phone, purpose, expires_at)
         VALUES ($1, $2, $3, 'ENROLL', $4::timestamptz)`,
        [sha256(grant), event.id, phone, grantExpiresAt]
      );
      return { kind: 'grant', grant, grantExpiresAt, eventId: event.id };
    }
    // Freeze the actual ticket under the same lock as the verified phone.
    // A later cancellation can invalidate this bearer, but can never make
    // an old proof return a newly reissued bearer.
    const person = participantByPhone(locked.rows[0].workspace_payload, phone);
    const expiration = person && Date.parse(person.ticketExpiresAt);
    if (!PUBLIC_STAGES.has(String(locked.rows[0].payload?.stage || '').toUpperCase()) ||
        !person || person.revoked === true || !TICKET_TOKEN.test(String(person.ticket || '')) ||
        !Number.isFinite(expiration) || expiration <= Date.now()) return null;
    const session = await mergeGrant({ client, cookieHeader, event: locked.rows[0], participantId: String(person.id), phone });
    return { kind: 'session', session, eventId: event.id, participantId: String(person.id), ticket: person.ticket };
    });
    if (!verified) throw genericConfirmFailure();
    return verified;
  }

  // The signup transaction spends the grant with its participant and receipt.
  async function consumeGrant(client, { token, eventId, phone }) {
    const grant = String(token || '');
    if (!grant) throw failure(409, '연락처 인증을 먼저 완료하세요', 'phone', 'SIGNUP_VERIFICATION_REQUIRED');
    const result = await client.query(
      `UPDATE attendee_grants SET consumed_at = now()
        WHERE token_hash = $1 AND event_id = $2 AND phone = $3
          AND consumed_at IS NULL AND expires_at > now()`,
      [sha256(grant), eventId, normalizePhone(phone)]
    );
    if (!result.rowCount) throw failure(409, '이 연락처의 인증 정보를 사용할 수 없습니다. 다시 인증하세요', 'phone', 'SIGNUP_VERIFICATION_REQUIRED');
  }

  async function grantAccess({ event, eventId, participantId, phone, client }) {
    const id = eventId || (event && event.id);
    if (!id || !participantId) throw failure(400, '참가 정보를 확인하세요');
    const endMs = event ? eventEndMs(event) : NaN;
    const expiresAt = sessionExpiry(endMs, Date.now()).toISOString();
    const grant = { eventId: String(id), participantId: String(participantId), phone: normalizePhone(phone), grantedAt: new Date().toISOString() };
    const token = randomToken(32);
    const tokenHash = sha256(token);
    await (client || database).query(
      `INSERT INTO attendee_sessions (token_hash, grants, expires_at)
       VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (token_hash) DO UPDATE
       SET grants = attendee_sessions.grants, expires_at = EXCLUDED.expires_at`,
      [tokenHash, JSON.stringify([grant]), expiresAt]
    );
    return { token, expiresAt };
  }

  async function mergeGrant({ cookieHeader, event, participantId, phone, client }) {
    const id = event && event.id;
    const grant = {
      eventId: String(id),
      participantId: String(participantId),
      phone: normalizePhone(phone),
      grantedAt: new Date().toISOString(),
    };
    const scoped = cookieEntry(cookieHeader, attendeeCookieName(id));
    const legacy = cookieEntry(cookieHeader, ATTENDEE_COOKIE);
    const incoming = scoped.present ? scoped.value : legacy.value;
    const legacyHash = legacy.value ? sha256(legacy.value) : null;
    const incomingHash = incoming ? sha256(incoming) : null;
    const executor = client || database;
    // When a different per-event session supersedes a legacy common grant,
    // remove only that event from the common session. Otherwise expiry of
    // the newer cookie could unexpectedly restore the former participant.
    if (legacyHash && legacyHash !== incomingHash) {
      const hashes = [legacyHash, incomingHash].filter(Boolean).sort();
      if (client) await executor.query('SELECT token_hash FROM attendee_sessions WHERE token_hash = ANY($1::text[]) ORDER BY token_hash FOR UPDATE', [hashes]);
      await executor.query(
        `UPDATE attendee_sessions SET grants = (
           SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(grants) = 'array' THEN grants ELSE '[]'::jsonb END) AS item
           WHERE item->>'eventId' IS DISTINCT FROM $2
         ) WHERE token_hash = $1`, [legacyHash, grant.eventId]
      );
    }
    if (incoming) {
      const requestedExpiry = sessionExpiry(eventEndMs(event), Date.now()).toISOString();
      // UPDATE takes the row lock before rebuilding the array, so concurrent
      // event enrollments and revocations cannot overwrite one another.
      const updated = await executor.query(
        `UPDATE attendee_sessions SET
           grants = (
             SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(grants) = 'array' THEN grants ELSE '[]'::jsonb END
             ) AS item
             WHERE jsonb_typeof(item->'eventId') = 'string'
               AND jsonb_typeof(item->'participantId') = 'string'
               AND item->>'eventId' <> $2
           ) || jsonb_build_array($3::jsonb),
           expires_at = GREATEST(expires_at, $4::timestamptz),
           last_seen_at = now()
         WHERE token_hash = $1 AND expires_at > now()
         RETURNING expires_at`,
        [incomingHash, grant.eventId, JSON.stringify(grant), requestedExpiry]
      );
      if (updated.rows[0]) {
        return { token: incoming, expiresAt: new Date(updated.rows[0].expires_at).toISOString(), fresh: false, eventId: grant.eventId };
      }
    }
    const created = await grantAccess({ event, participantId, phone, client });
    return { ...created, fresh: true, eventId: grant.eventId };
  }

  async function resolveSession(cookieHeader) {
    const token = cookieToken(cookieHeader);
    if (!token) return null;
    const found = await database.query(
      `SELECT grants, expires_at FROM attendee_sessions
        WHERE token_hash = $1 AND expires_at > now() LIMIT 1`,
      [sha256(token)]
    );
    const row = found.rows[0];
    if (!row) return null;
    return { grants: grantsFromRow(row), expiresAt: row.expires_at };
  }

  function grantForEvent(session, eventId) {
    if (!session) return null;
    return session.grants.find((grant) => grant.eventId === String(eventId)) || null;
  }

  // Drops every grant pointing at a participant whose phone changed or whose
  // registration was cancelled. Reads then fall back to "no access" instead
  // of serving a stale identity.
  async function revokeParticipants(client, eventId, participantIds, phones = []) {
    const ids = [...new Set(participantIds.map(String))];
    if (!ids.length) return;
    const numbers = [...new Set(phones.map(normalizePhone).filter(Boolean))];
    if (numbers.length) {
      // Old, unused recovery codes must not become valid again after a
      // cancellation and reapproval or a phone number changes away and back.
      await client.query(
        `UPDATE attendee_challenges SET consumed_at = now()
          WHERE event_id = $1 AND phone = ANY($2::text[]) AND purpose = 'RECOVER' AND consumed_at IS NULL`,
        [String(eventId), numbers]
      );
    }
    // Shared browser sessions can contain several events. Lock them in a
    // common order so concurrent bulk changes on different events cannot
    // lock the same sessions in opposite orders.
    const locked = await client.query(
      `SELECT token_hash FROM attendee_sessions
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(grants) = 'array' THEN grants ELSE '[]'::jsonb END) AS item
           WHERE item->>'eventId' = $1 AND item->>'participantId' = ANY($2::text[])
        ) ORDER BY token_hash FOR UPDATE`, [String(eventId), ids]
    );
    if (!locked.rows.length) return;
    await client.query(
      `UPDATE attendee_sessions SET grants = (
         SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(grants) = 'array' THEN grants ELSE '[]'::jsonb END) AS item
          WHERE NOT COALESCE(item->>'eventId' = $1 AND item->>'participantId' = ANY($2::text[]), false)
       ) WHERE token_hash = ANY($3::text[])`,
      [String(eventId), ids, locked.rows.map(row => row.token_hash)]
    );
  }

  return {
    requestChallenge,
    confirmChallenge,
    consumeGrant,
    grantAccess,
    mergeGrant,
    resolveSession,
    grantForEvent,
    revokeParticipants,
    activeParticipant,
    participantByPhone,
  };
}

module.exports = {
  createAttendeeAccess,
  attendeeCookie,
  attendeeCookieName,
  cookieToken,
  normalizePhone,
  ATTENDEE_COOKIE,
};
