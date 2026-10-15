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

function failure(status, message, field) {
  return Object.assign(new Error(message), { status }, field ? { field } : {});
}

// Generic failure shared by every confirm path so responses do not tell
// registered numbers apart from wrong codes.
function genericConfirmFailure() {
  return failure(401, '인증번호를 확인하세요', 'code');
}

function attendeeCookie(token, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  const maxAge = Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0
    ? `; Max-Age=${maxAgeSeconds}`
    : '';
  return `${ATTENDEE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secure}${maxAge}`;
}

function cookieToken(header) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== ATTENDEE_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()) || null;
    } catch (error) {
      return null;
    }
  }
  return null;
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
      'SELECT id, slug, payload FROM events WHERE id = $1 LIMIT 1',
      [String(ref || '')]
    );
    if (byId.rows[0]) return byId.rows[0];
    const bySlug = await database.query(
      'SELECT id, slug, payload FROM events WHERE slug = $1 LIMIT 1',
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
    if (!person || person.status === 'CANCELLED' || person.cancelled === true) return null;
    return person;
  }

  function participantByPhone(workspacePayload, phone) {
    const people = (workspacePayload && workspacePayload.participants) || [];
    if (!Array.isArray(people)) return null;
    return people.find((item) =>
      item && item.status !== 'CANCELLED' && item.cancelled !== true &&
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

    const hourly = await database.query(
      `SELECT COUNT(*)::int AS n FROM attendee_challenges
        WHERE created_at > now() - interval '1 hour'`
    );
    const hourlyCap = Number(process.env.EVENTOUCH_VERIFY_HOURLY_CAP || HOURLY_GLOBAL_CAP);
    if (hourly.rows[0].n >= hourlyCap) {
      throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
    }
    const recent = await database.query(
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
    const daily = await database.query(
      `SELECT COUNT(*)::int AS n FROM attendee_challenges
        WHERE event_id = $1 AND phone = $2 AND created_at > date_trunc('day', now())`,
      [event.id, phone]
    );
    if (daily.rows[0].n >= DAILY_CAP_PER_PHONE) {
      throw failure(429, '오늘 받을 수 있는 횟수를 초과했습니다. 내일 다시 시도하세요', 'phone');
    }

    const id = `ac-${randomToken(16)}`;
    const code = randomCode();
    const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await database.query(
      `INSERT INTO attendee_challenges
         (id, event_id, phone, purpose, code_hash, max_attempts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [id, event.id, phone, cleanPurpose, sha256(code), CODE_MAX_ATTEMPTS, expiresAt]
    );

    const eventName = String((event.payload && event.payload.name) || '행사');
    const send = transport
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

  async function confirmChallenge({ eventRef, phone: rawPhone, code: rawCode }) {
    const phone = normalizePhone(rawPhone);
    const code = String(rawCode || '').replace(/\D/g, '').slice(0, 6);
    if (!validPhone(phone) || code.length !== 6) throw genericConfirmFailure();
    const event = await findEvent(eventRef);
    if (!event) throw genericConfirmFailure();

    const pending = await database.query(
      `SELECT * FROM attendee_challenges
        WHERE event_id = $1 AND phone = $2 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [event.id, phone]
    );
    const challenge = pending.rows[0];
    if (!challenge) throw genericConfirmFailure();
    const expected = Buffer.from(String(challenge.code_hash), 'hex');
    const probe = Buffer.from(sha256(code), 'hex');
    const matches = expected.length === probe.length && crypto.timingSafeEqual(expected, probe);
    if (!matches) {
      const attempts = Number(challenge.attempts || 0) + 1;
      if (attempts >= Number(challenge.max_attempts || CODE_MAX_ATTEMPTS)) {
        await database.query(
          `UPDATE attendee_challenges SET attempts = $2, consumed_at = now() WHERE id = $1`,
          [challenge.id, attempts]
        );
      } else {
        await database.query(
          `UPDATE attendee_challenges SET attempts = $2 WHERE id = $1`,
          [challenge.id, attempts]
        );
      }
      throw genericConfirmFailure();
    }
    await database.query(
      `UPDATE attendee_challenges SET attempts = attempts + 1, consumed_at = now() WHERE id = $1`,
      [challenge.id]
    );

    if (challenge.purpose === 'ENROLL') {
      const grant = randomToken(32);
      const grantExpiresAt = new Date(Date.now() + GRANT_TTL_MINUTES * 60 * 1000).toISOString();
      await database.query(
        `INSERT INTO attendee_grants (token_hash, event_id, phone, purpose, expires_at)
         VALUES ($1, $2, $3, 'ENROLL', $4::timestamptz)`,
        [sha256(grant), event.id, phone, grantExpiresAt]
      );
      return { kind: 'grant', grant, grantExpiresAt, eventId: event.id };
    }

    // RECOVER: the number must belong to a live participant, but the
    // response never says whether it does.
    const workspaceResult = await database.query(
      'SELECT payload FROM event_workspaces WHERE event_id = $1 LIMIT 1',
      [event.id]
    );
    const workspace = workspaceResult.rows[0] && workspaceResult.rows[0].payload;
    const person = participantByPhone(workspace, phone);
    if (!person) throw genericConfirmFailure();
    const session = await grantAccess({ event, participantId: String(person.id), phone });
    return { kind: 'session', session, eventId: event.id, participantId: String(person.id) };
  }

  // Atomically consumes a signup grant. The loser of a concurrent double
  // submit gets 409 before any participant row is created.
  async function consumeGrant({ token, eventId, phone }) {
    const grant = String(token || '');
    if (!grant) throw failure(409, '연락처 인증을 먼저 완료하세요', 'phone');
    const result = await database.query(
      `UPDATE attendee_grants SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING event_id, phone`,
      [sha256(grant)]
    );
    const row = result.rows[0];
    if (!row) throw failure(409, '인증 정보가 만료되었습니다. 다시 인증하세요', 'phone');
    if (String(row.event_id) !== String(eventId) || normalizePhone(row.phone) !== normalizePhone(phone)) {
      throw failure(409, '인증한 연락처와 신청 연락처가 다릅니다', 'phone');
    }
    return row;
  }

  async function grantAccess({ event, eventId, participantId, phone }) {
    const id = eventId || (event && event.id);
    if (!id || !participantId) throw failure(400, '참가 정보를 확인하세요');
    const endMs = event ? eventEndMs(event) : NaN;
    const expiresAt = sessionExpiry(endMs, Date.now()).toISOString();
    const grant = { eventId: String(id), participantId: String(participantId), phone: normalizePhone(phone), grantedAt: new Date().toISOString() };
    const token = randomToken(32);
    const tokenHash = sha256(token);
    await database.query(
      `INSERT INTO attendee_sessions (token_hash, grants, expires_at)
       VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (token_hash) DO UPDATE
       SET grants = attendee_sessions.grants, expires_at = EXCLUDED.expires_at`,
      [tokenHash, JSON.stringify([grant]), expiresAt]
    );
    return { token, expiresAt };
  }

  async function mergeGrant({ cookieHeader, event, participantId, phone }) {
    const id = event && event.id;
    const grant = {
      eventId: String(id),
      participantId: String(participantId),
      phone: normalizePhone(phone),
      grantedAt: new Date().toISOString(),
    };
    const incoming = cookieToken(cookieHeader);
    if (incoming) {
      const found = await database.query(
        `SELECT grants, expires_at FROM attendee_sessions
          WHERE token_hash = $1 AND expires_at > now() LIMIT 1`,
        [sha256(incoming)]
      );
      const row = found.rows[0];
      if (row) {
        const grants = grantsFromRow(row);
        const rest = grants.filter((item) =>
          !(item.eventId === grant.eventId && item.participantId === grant.participantId)
        );
        rest.push(grant);
        const endMs = eventEndMs(event);
        const expiresAt = sessionExpiry(endMs, Date.now()).toISOString();
        await database.query(
          `UPDATE attendee_sessions SET grants = $2::jsonb, expires_at = $3::timestamptz, last_seen_at = now()
            WHERE token_hash = $1`,
          [sha256(incoming), JSON.stringify(rest), expiresAt]
        );
        return { token: incoming, expiresAt, fresh: false };
      }
    }
    const created = await grantAccess({ event, participantId, phone });
    return { ...created, fresh: true };
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
  async function revokeParticipant(eventId, participantId) {
    await database.query(
      `UPDATE attendee_sessions SET grants = (
         SELECT COALESCE(jsonb_agg(item), '[]'::jsonb) FROM jsonb_array_elements(grants) AS item
         WHERE NOT (item->>'eventId' = $1::text AND item->>'participantId' = $2::text)
       )
       WHERE grants @> jsonb_build_array(jsonb_build_object('eventId', $1::text, 'participantId', $2::text))`,
      [String(eventId), String(participantId)]
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
    revokeParticipant,
    activeParticipant,
    participantByPhone,
  };
}

module.exports = {
  createAttendeeAccess,
  attendeeCookie,
  cookieToken,
  normalizePhone,
  ATTENDEE_COOKIE,
};
