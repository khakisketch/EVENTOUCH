'use strict';

// Self-service account recovery by verified email ("이메일+수동 예외").
//
// A signed-in holder first proves mailbox ownership of their OWN stored
// address (VERIFY proof: session + current password + mailbox click). Only a
// proven address may later receive recovery links (RECOVER proof); confirming
// one resets the global password and revokes every session. Locked accounts
// with no proven channel are NOT recovered here — the manual
// identity-verification process is separately decided and unbuilt, so those
// callers stay on the honest generic/limitation answers.
//
// Security properties (kept, adjust details only with evidence):
//
// - Prior-session current-password reauthentication: every VERIFY request
//   re-checks the current password; the request never redirects mail.
// - Proof-of-mailbox: VERIFY confirms only with the token sent to the
//   account's own stored address; RECOVER sends only to a proven address.
//   accounts.email and invitation acceptance are NEVER treated as verified.
// - One-time high-entropy expiring single-use proofs: 32-byte CSPRNG bearer,
//   sha256 hash stored, 60/30-minute expiry, and consumption revalidated
//   under the account/proof row locks so concurrent confirms serialize and
//   exactly one wins.
// - Safe password hashing (scrypt, same parameters as login) and revocation
//   of ALL previous sessions on recovery confirm.
// - No enumeration: anonymous endpoints answer the same shape for unknown,
//   unverified, deactivated, and throttled-email cases; only per-address and
//   global abuse get a 429 (which reveals nothing about any address).
// - Abuse/rate controls: per-address + per-email throttle rows plus per-
//   account cooldown/hourly/daily proof caps and a global hourly cap.
// - No raw token or full recipient address in logs: proofs store token hashes;
//   the mock transport logs a masked address at most, and request observability
//   templates carry no token.
// - Unsafe URL/referrer handling: the link token travels in the email link
//   and the confirm POST body only; the Next page moves it into tab memory
//   and strips it from the URL. Links need EVENTOUCH_PUBLIC_URL; without a
//   valid public base there is no send (fail-closed, honest 503 to holders).
// - Default-off / fail-closed delivery: without an injected provider or
//   EVENTOUCH_MAIL_MOCK=1 the transport is mode 'none' and nothing sends.
// - Safe old-schema compatibility: every proof-table/column access degrades
//   when 016 is absent (42P01/42703, widened scope 23514) — holders get an
//   honest 503, anonymous callers keep the generic answers, never a 500.
// - Org isolation: verification and recovery are GLOBAL identity operations
//   on the caller's own account. No org-owner authority is consulted or
//   granted, and other orgs' rows are never read. Deactivated accounts and
//   consumed/expired proofs fail closed; active no-membership accounts may
//   still recover the global login (org access stays 403 NO_MEMBERSHIP).

const crypto = require('node:crypto');
const { maskEmail } = require('./email-transport');

const VERIFY_TTL_MINUTES = 60;
const RECOVER_TTL_MINUTES = 30;
const RESEND_COOLDOWN_SECONDS = 60;
const HOURLY_CAP_PER_ACCOUNT = 5;
const DAILY_CAP_PER_ACCOUNT = 10;
const GLOBAL_HOURLY_CAP = 500;

// Anonymous abuse windows. Email-scoped caps stay SILENT (generic 200, no
// send) so they cannot become an address oracle; address/global caps answer
// 429, which describes only the caller's own traffic.
const RECOVERY_EMAIL_LIMIT = 10;
const RECOVERY_EMAIL_WINDOW_MINUTES = 60;
const RECOVERY_ADDRESS_LIMIT = 30;
const RECOVERY_ADDRESS_WINDOW_MINUTES = 15;

function failure(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

// Recovery links carry the same generic denial for every non-success so
// callers (and observers) cannot separate invalid/expired/used/deactivated.
function genericRecoveryFailure() {
  return failure(401, '복구 링크를 확인하세요');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function proofId() {
  return `rp-${crypto.randomUUID()}`;
}

function validTokenShape(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

// Additive-only schema drift (016 absent, scope widening absent) must degrade,
// never 500. 42P01 undefined_table, 42703 undefined_column, 23514 a check the
// old schema still forbids (recovery-* throttle scopes).
function isSchemaMissing(error) {
  const code = error && error.code;
  if (code === '42P01' || code === '42703' || code === '23514') return true;
  return /account_email_proofs|email_verified|login_attempts/.test(String((error && error.message) || ''));
}

// Best-effort timing floor for anonymous request paths: eligible and
// ineligible outcomes both perform this work. Real provider/network latency
// can still differ; equal response shapes are not a timing-proof guarantee.
function burnTiming() {
  try {
    crypto.scryptSync(crypto.randomBytes(24).toString('base64'), 'recovery-probe', 32);
  } catch (error) {
    // Timing equalization is best effort; it must never block the answer.
  }
}

// The public origin recipients open on their own devices. Same rule as
// participant ticket links: server environment only (never the request Host),
// http(s) without credentials/query/hash, and never invented — without it no
// recovery link can be built, so sending stays off.
function publicBaseUrl(env = process.env) {
  const raw = String(env.EVENTOUCH_PUBLIC_URL || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function createAccountRecovery(database, { transport, env = process.env } = {}) {
  // Throttle rows reuse the login_attempts table with recovery-only scopes.
  // Without the necessary table or scope migration, fail closed rather than
  // issuing proofs or checking passwords without an abuse limit.
  // Admission is ATOMIC: the counter increments and the verdict is read back
  // in one statement, so N concurrent callers cannot all slip under a
  // check-then-record race. Reset an expired bucket inside the same upsert:
  // pruning after refreshing last_failure_at would otherwise revive an old
  // block instead of letting a caller retry after the window.
  // Scope split is deliberate: the anonymous recovery path and the signed-in
  // reauthentication path use different per-email buckets, so anonymous
  // requests for a victim's address can never fill the victim's own
  // verification bucket and deny them without guessing any password.
  async function throttleHit(scope, key, windowMinutes, limit) {
    try {
      const result = await database.query(
        `INSERT INTO login_attempts (scope, key, failures, first_failure_at, last_failure_at)
          VALUES ($1, $2, 1, now(), now())
          ON CONFLICT (scope, key) DO UPDATE SET
            failures = CASE
              WHEN login_attempts.last_failure_at <= now() - ($3 || ' minutes')::interval THEN 1
              ELSE login_attempts.failures + 1
            END,
            first_failure_at = CASE
              WHEN login_attempts.last_failure_at <= now() - ($3 || ' minutes')::interval THEN now()
              ELSE login_attempts.first_failure_at
            END,
            last_failure_at = now()
          RETURNING failures`,
        [scope, key, String(windowMinutes)]
      );
      // Prune ONLY this feature's scopes: the table is shared with the login
      // throttle (see server/auth.js), and an unscoped delete here would
      // shorten configured login lockouts (windows up to 1440m) the same way
      // the login prune must not eat recovery rows.
      await database.query(
        `DELETE FROM login_attempts
          WHERE scope IN ('recovery-email', 'recovery-address', 'verify-email', 'verify-address')
            AND last_failure_at < now() - ($1 || ' minutes')::interval`,
        [String(Math.max(windowMinutes, 60))]
      );
      return Number(result.rows[0].failures) > limit;
    } catch (error) {
      if (isSchemaMissing(error)) {
        throw failure(503, '이메일 복구를 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요', {
          code: 'RECOVERY_THROTTLE_UNAVAILABLE',
        });
      }
      throw error;
    }
  }

  async function throttleClear(scope, key) {
    try {
      await database.query('DELETE FROM login_attempts WHERE scope = $1 AND key = $2', [scope, key]);
    } catch (error) {
      if (isSchemaMissing(error)) return;
      throw error;
    }
  }

  // Lazy: auth.js owns scrypt parameters; a top-level require would close a
  // cycle only if auth required this module (it does not — the instance is
  // injected), but lazy keeps the seam one-directional like tenancy does.
  function passwords() {
    return require('./auth');
  }

  // Lock order for every credential-adjacent write is account row first,
  // proof rows second (see confirmRecovery and the owner reset): a consistent
  // order keeps concurrent resets and confirms from deadlocking on the same
  // two rows in opposite order.
  async function loadAccount(client, accountId, forUpdate = false) {
    const result = await client.query(
      `SELECT id, email, name, active, password_hash, email_verified_email, email_verified_at
        FROM accounts WHERE id = $1 LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [String(accountId)]
    );
    return result.rows[0] || null;
  }

  async function lockAccountForWrite(client, accountId) {
    const account = await loadAccount(client, accountId, true);
    if (!account || account.active !== true) {
      throw failure(401, '로그인이 필요합니다');
    }
    return account;
  }

  // Under-lock holder revalidation: the credential hash and the caller
  // session observed before the locks must still be current inside them. A
  // concurrent owner reset or recovery between the pre-lock password check
  // and this transaction revokes both — and must also retire the proof
  // about to be issued, never mint a fresh one on stale authority.
  async function revalidateHolder(client, { accountId, seenHash, sessionToken }) {
    const locked = await lockAccountForWrite(client, accountId);
    if (seenHash !== undefined && locked.password_hash !== seenHash) {
      throw failure(409, '비밀번호나 세션이 바뀌었습니다. 다시 로그인한 뒤 요청하세요');
    }
    if (sessionToken !== undefined && sessionToken !== null) {
      const live = await client.query(
        `SELECT 1 FROM sessions
          WHERE token_hash = $1 AND account_id = $2 AND expires_at > now() LIMIT 1`,
        [tokenHash(String(sessionToken)), String(accountId)]
      );
      if (!live.rowCount) {
        throw failure(401, '로그인이 필요합니다');
      }
    }
    return locked;
  }

  function verifiedAccount(account) {
    if (!account || account.active !== true) return false;
    if (!account.email_verified_at || !account.email_verified_email) return false;
    return String(account.email_verified_email).toLowerCase() === String(account.email || '').toLowerCase();
  }

  // Per-account send caps, enforced inside the caller's transaction while it
  // holds the account advisory lock: resend cooldown, hourly and daily caps.
  // Returns null when sending may proceed, otherwise a holder-honest message.
  async function accountCaps(client, accountId, now) {
    const cooldown = await client.query(
      `SELECT created_at FROM account_email_proofs
        WHERE account_id = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [String(accountId)]
    );
    if (cooldown.rowCount) {
      const latest = Date.parse(cooldown.rows[0].created_at);
      if (Number.isFinite(latest) && now - latest < RESEND_COOLDOWN_SECONDS * 1000) {
        return '인증 메일을 다시 받으려면 잠시 후 시도하세요';
      }
    }
    const hourly = await client.query(
      `SELECT COUNT(*)::int AS n FROM account_email_proofs
        WHERE account_id = $1 AND created_at > now() - interval '1 hour'`,
      [String(accountId)]
    );
    if (hourly.rows[0].n >= HOURLY_CAP_PER_ACCOUNT) {
      return '요청이 많습니다. 잠시 후 다시 시도하세요';
    }
    const daily = await client.query(
      `SELECT COUNT(*)::int AS n FROM account_email_proofs
        WHERE account_id = $1 AND created_at > date_trunc('day', now())`,
      [String(accountId)]
    );
    if (daily.rows[0].n >= DAILY_CAP_PER_ACCOUNT) {
      return '오늘 받을 수 있는 횟수를 초과했습니다. 내일 다시 시도하세요';
    }
    return null;
  }

  async function globalCap(client) {
    const hourly = await client.query(
      `SELECT COUNT(*)::int AS n FROM account_email_proofs
        WHERE created_at > now() - interval '1 hour'`
    );
    return hourly.rows[0].n >= GLOBAL_HOURLY_CAP;
  }

  function deliveryState() {
    const mode = transport && typeof transport.state === 'function' ? transport.state().mode : 'none';
    // Connected means a send can actually leave: a transport AND a valid
    // public base for the link. Callers gate honest disabled UI on this, so
    // a mock without a base (or a provider without one) must read false.
    const connected = (mode === 'mock' || mode === 'injected') && publicBaseUrl(env) !== null;
    return { mode, connected };
  }

  function sendLink(to, token, purpose) {
    const base = publicBaseUrl(env);
    if (!base || !transport || typeof transport.sendRecovery !== 'function') {
      return Promise.resolve({ sent: false, reason: 'NOT_CONFIGURED' });
    }
    // Verify clicks land on the signed-in account page (mailbox proof joins
    // the session there); recovery clicks land on the logged-out reset page.
    // The token travels in the URL FRAGMENT (#t=), never the query: fragments
    // are stripped by the client before any same-origin fetch and never reach
    // the Next/proxy access line, the Referer, or request logs. Both pages
    // move the token into tab memory and strip the fragment at once.
    const path = purpose === 'VERIFY' ? '/account/email' : '/recover';
    const link = `${base}${path}#t=${encodeURIComponent(token)}`;
    return transport.sendRecovery({ to, link });
  }

  async function insertProof(client, { accountId, email, purpose, ttlMinutes }) {
    const token = randomToken();
    const id = proofId();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    await client.query(
      `INSERT INTO account_email_proofs (id, account_id, email, purpose, token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [id, String(accountId), email, purpose, tokenHash(token), expiresAt]
    );
    return { id, token, expiresAt };
  }

  async function requestEmailVerification({ accountId, currentPassword, clientIp, sessionToken = null }) {
    const { verifyPassword } = passwords();
    const address = String(clientIp || 'unknown');
    // Atomic admission BEFORE the expensive check and before any lock: one
    // request, one count. A stolen session guessing passwords is bounded
    // (not unlimited scrypt), and concurrent holders do not serialize on a
    // global lock while each burns CPU inside it.
    if (await throttleHit('verify-address', address, RECOVERY_ADDRESS_WINDOW_MINUTES, RECOVERY_ADDRESS_LIMIT)) {
      throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
    }
    let account;
    try {
      const result = await database.query(
        `SELECT id, email, active, password_hash, email_verified_email, email_verified_at
          FROM accounts WHERE id = $1 LIMIT 1`,
        [String(accountId)]
      );
      account = result.rows[0] || null;
    } catch (error) {
      if (isSchemaMissing(error)) {
        throw Object.assign(
          failure(503, '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요'),
          { code: 'EMAIL_NOT_CONFIGURED' }
        );
      }
      throw error;
    }
    if (!account || account.active !== true) {
      throw failure(401, '로그인이 필요합니다');
    }
    const storedEmail = normalizeEmail(account.email);
    if (storedEmail && (await throttleHit('verify-email', storedEmail, RECOVERY_EMAIL_WINDOW_MINUTES, RECOVERY_EMAIL_LIMIT))) {
      throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
    }
    // Prior-session reauthentication: proving the mailbox starts from
    // proving the session holder still knows the current password. The hash
    // travels into the transaction for the under-lock freshness check below.
    if (!verifyPassword(currentPassword, account.password_hash)) {
      // Already counted by the admission hits above: one request, one count.
      throw failure(401, '현재 비밀번호를 확인하세요');
    }
    const seenHash = account.password_hash;
    if (verifiedAccount(account)) {
      return { ok: true, already: true };
    }
    let proof = null;
    try {
      proof = await database.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('account-email-proof', 0))");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`email-verify:${accountId}`]);
        // Re-read under the account lock and revalidate the holder: a
        // concurrent reset or recovery that changed the credential or revoked
        // this session between the password check above and this write must
        // win — no fresh proof on stale authority.
        const locked = await revalidateHolder(client, { accountId, seenHash, sessionToken });
        if (verifiedAccount(locked)) {
          return { already: true };
        }
        const delivery = deliveryState();
        if (!delivery.connected) {
          throw Object.assign(
            failure(503, '이메일 발송이 설정되지 않아 인증 메일을 보낼 수 없습니다. 관리자에게 문의하세요'),
            { code: 'EMAIL_NOT_CONFIGURED' }
          );
        }
        const cap = await accountCaps(client, locked.id, Date.now());
        if (cap) throw failure(429, cap);
        if (await globalCap(client)) throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
        const email = normalizeEmail(locked.email);
        if (!email) throw failure(409, '계정 이메일을 확인할 수 없습니다');
        return insertProof(client, { accountId: locked.id, email, purpose: 'VERIFY', ttlMinutes: VERIFY_TTL_MINUTES });
      });
    } catch (error) {
      if (isSchemaMissing(error)) {
        throw Object.assign(
          failure(503, '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요'),
          { code: 'EMAIL_NOT_CONFIGURED' }
        );
      }
      throw error;
    }
    if (proof && proof.already) {
      return { ok: true, already: true };
    }
    const accountEmail = async () => {
      const result = await database.query('SELECT email FROM accounts WHERE id = $1 LIMIT 1', [String(accountId)]);
      return result.rows[0] ? normalizeEmail(result.rows[0].email) : '';
    };
    const to = await accountEmail();
    const send = await sendLink(to, proof.token, 'VERIFY');
    if (!send.sent) {
      await database.query('DELETE FROM account_email_proofs WHERE id = $1', [proof.id]).catch(() => {});
      if (send.reason === 'NOT_CONFIGURED') {
        throw Object.assign(
          failure(503, '이메일 발송이 설정되지 않아 인증 메일을 보낼 수 없습니다. 관리자에게 문의하세요'),
          { code: 'EMAIL_NOT_CONFIGURED' }
        );
      }
      throw failure(503, '인증 메일을 보내지 못했습니다. 다시 시도하세요');
    }
    return { ok: true, expiresAt: proof.expiresAt };
  }

  async function confirmEmailVerification({ accountId, token, sessionToken = null }) {
    if (!validTokenShape(token)) throw failure(404, '인증 링크를 확인하세요');
    // Unlocked peek first (see confirmRecovery): identifies the mailbox
    // without taking proof-row locks, so the transaction below locks
    // account-then-proofs like every other credential write.
    let peek = null;
    try {
      const peeked = await database.query(
        `SELECT account_id, purpose, consumed_at, expires_at, email FROM account_email_proofs
          WHERE token_hash = $1 LIMIT 1`,
        [tokenHash(token)]
      );
      peek = peeked.rows[0] || null;
    } catch (error) {
      if (!isSchemaMissing(error)) throw error;
    }
    // A proof for another account is invisible here (no cross-account
    // oracle): the holder only ever confirms their own mailbox.
    if (peek && (peek.purpose !== 'VERIFY' || String(peek.account_id) !== String(accountId))) {
      throw failure(404, '인증 링크를 확인하세요');
    }
    if (peek && peek.consumed_at) throw failure(409, '이미 사용된 인증 링크입니다. 다시 요청하세요');
    if (peek && Date.parse(peek.expires_at) <= Date.now()) throw failure(410, '인증 링크가 만료되었습니다. 다시 요청하세요');
    try {
      return await database.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('account-email-proof', 0))");
        // Account first, then the proof row (lock-order note on
        // loadAccount). The session liveness check runs in the same
        // transactional boundary as a reset: a session revoked after the
        // route authenticated cannot confirm on dead authority.
        const account = await revalidateHolder(client, { accountId, sessionToken });
        const found = await client.query(
          `SELECT * FROM account_email_proofs WHERE token_hash = $1 LIMIT 1 FOR UPDATE`,
          [tokenHash(token)]
        );
        const proof = found.rows[0];
        if (!proof || proof.purpose !== 'VERIFY' || String(proof.account_id) !== String(account.id)) {
          throw failure(404, '인증 링크를 확인하세요');
        }
        if (proof.consumed_at) throw failure(409, '이미 사용된 인증 링크입니다. 다시 요청하세요');
        if (Date.parse(proof.expires_at) <= Date.now()) throw failure(410, '인증 링크가 만료되었습니다. 다시 요청하세요');
        const current = normalizeEmail(account.email);
        if (!current || current !== String(proof.email || '').toLowerCase()) {
          throw failure(409, '계정 이메일이 바뀌었습니다. 다시 요청하세요');
        }
        await client.query(
          `UPDATE account_email_proofs SET consumed_at = now() WHERE id = $1`,
          [proof.id]
        );
        await client.query(
          `UPDATE accounts SET email_verified_email = $2, email_verified_at = now() WHERE id = $1`,
          [account.id, current]
        );
        return { ok: true, verified: true };
      });
    } catch (error) {
      if (isSchemaMissing(error)) {
        throw Object.assign(
          failure(503, '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요'),
          { code: 'EMAIL_NOT_CONFIGURED' }
        );
      }
      throw error;
    }
  }

  async function emailStatus({ accountId }) {
    try {
      const result = await database.query(
        `SELECT email, email_verified_email, email_verified_at, active
          FROM accounts WHERE id = $1 LIMIT 1`,
        [String(accountId)]
      );
      const account = result.rows[0];
      if (!account || account.active !== true) throw failure(401, '로그인이 필요합니다');
      const delivery = deliveryState();
      const verified = Boolean(
        account.email_verified_at &&
        account.email_verified_email &&
        String(account.email_verified_email).toLowerCase() === String(account.email || '').toLowerCase()
      );
      return {
        verified,
        verifiedAt: verified ? new Date(account.email_verified_at).toISOString() : null,
        emailMasked: maskEmail(account.email),
        delivery,
      };
    } catch (error) {
      if (isSchemaMissing(error)) {
        throw Object.assign(
          failure(503, '이메일 인증을 지금 사용할 수 없습니다. 잠시 후 다시 시도하세요'),
          { code: 'EMAIL_NOT_CONFIGURED' }
        );
      }
      throw error;
    }
  }

  // Anonymous recovery request. Always 200 with the same shape unless the
  // CALLER's own traffic (address/global) is abusive — the email-scoped
  // outcome never changes it. Sends only to an active account whose stored
  // address still equals its proven address. The `delivery` flag describes
  // GLOBAL send capability only (never whether this address qualified), so
  // the UI can be honest about an unconfigured provider without oracling.
  // Every 200 path burns the same scrypt floor exactly once, so an eligible
  // address does not answer on a trivially faster branch than an unknown one.
  async function requestRecovery({ email, clientIp }) {
    const address = String(clientIp || 'unknown');
    const normalized = normalizeEmail(email);
    const delivery = deliveryState();
    const answered = (extra) => Object.assign({ ok: true, delivery }, extra);
    // Atomic admission on the ANONYMOUS scopes (never the signed-in
    // verify-* buckets): one request, one count, even under concurrency.
    try {
      if (await throttleHit('recovery-address', address, RECOVERY_ADDRESS_WINDOW_MINUTES, RECOVERY_ADDRESS_LIMIT)) {
        throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
      }
      if (normalized && (await throttleHit('recovery-email', normalized, RECOVERY_EMAIL_WINDOW_MINUTES, RECOVERY_EMAIL_LIMIT))) {
        // Silent: a per-email cap must not tell one address about another.
        burnTiming();
        return answered();
      }
    } catch (error) {
      if (error && error.code === 'RECOVERY_THROTTLE_UNAVAILABLE') {
        burnTiming();
        return answered({ delivery: { ...delivery, connected: false } });
      }
      throw error;
    }
    let proof = null;
    let eligible = false;
    try {
      const outcome = await database.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('account-email-proof', 0))");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`recovery:${normalized || `absent:${address}`}`]);
        if (await globalCap(client)) {
          throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
        }
        const found = normalized ? await client.query(
          `SELECT id, email, active, email_verified_email, email_verified_at
            FROM accounts WHERE lower(email) = $1 LIMIT 1`,
          [normalized]
        ) : { rows: [] };
        const account = found.rows[0];
        if (!account || !verifiedAccount(account)) return null;
        const cap = await accountCaps(client, account.id, Date.now());
        if (cap) return null;
        return insertProof(client, {
          accountId: account.id,
          email: normalized,
          purpose: 'RECOVER',
          ttlMinutes: RECOVER_TTL_MINUTES,
        });
      });
      proof = outcome;
      eligible = Boolean(outcome);
    } catch (error) {
      if (isSchemaMissing(error)) {
        burnTiming();
        return answered({ delivery: { ...delivery, connected: false } });
      }
      throw error;
    }
    if (eligible && proof) {
      const send = await sendLink(normalized, proof.token, 'RECOVER').catch(() => ({ sent: false }));
      if (!send.sent) {
        // Fail closed: nobody received the token, so the proof must not linger
        // as a live bearer. The answer stays generic either way.
        await database.query('DELETE FROM account_email_proofs WHERE id = $1', [proof.id]).catch(() => {});
      }
    }
    burnTiming();
    return answered();
  }

  // Anonymous recovery confirm. Every non-success — invalid, expired, used,
  // deactivated, address drift, weak password — answers the identical 401 so
  // the token cannot be probed. Caller-abuse throttling runs BEFORE the
  // expensive hash, so valid-shaped guesses cannot burn unbounded CPU.
  // Success resets the global password, revokes every session, and consumes
  // every live proof of the account in the same transaction, so no older or
  // sibling link regains authority afterwards.
  async function confirmRecovery({ token, newPassword, clientIp }) {
    const { hashPassword } = passwords();
    const address = String(clientIp || 'unknown');
    const password = typeof newPassword === 'string' ? newPassword : '';
    // Atomic admission BEFORE the expensive hash: one guess, one count, even
    // under concurrency. Invalid shapes burn the same floor without hashing.
    try {
      if (await throttleHit('recovery-address', address, RECOVERY_ADDRESS_WINDOW_MINUTES, RECOVERY_ADDRESS_LIMIT)) {
        throw failure(429, '요청이 많습니다. 잠시 후 다시 시도하세요');
      }
    } catch (error) {
      if (error && error.code === 'RECOVERY_THROTTLE_UNAVAILABLE') {
        burnTiming();
        throw genericRecoveryFailure();
      }
      throw error;
    }
    if (!validTokenShape(token) || password.length < 8 || password.length > 200) {
      burnTiming();
      throw genericRecoveryFailure();
    }
    let passwordHash;
    try {
      passwordHash = hashPassword(password);
    } catch (error) {
      burnTiming();
      throw genericRecoveryFailure();
    }
    try {
      // Unlocked peek first: identifies the account without taking proof-row
      // locks, so the transaction below can lock account-then-proofs in the
      // same order as every other credential write (no opposite-order
      // deadlock with a concurrent reset).
      let peek = null;
      try {
        const peeked = await database.query(
          `SELECT account_id, purpose, consumed_at, expires_at FROM account_email_proofs
            WHERE token_hash = $1 LIMIT 1`,
          [tokenHash(token)]
        );
        peek = peeked.rows[0] || null;
      } catch (error) {
        if (!isSchemaMissing(error)) throw error;
      }
      if (!peek || peek.purpose !== 'RECOVER' || peek.consumed_at ||
          Date.parse(peek.expires_at) <= Date.now()) {
        burnTiming();
        throw genericRecoveryFailure();
      }
      const accountEmail = await database.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('account-email-proof', 0))");
        // Account row first (see the lock-order note on loadAccount).
        const account = await loadAccount(client, peek.account_id, true);
        if (!account || account.active !== true) throw genericRecoveryFailure();
        // Re-read the proof under its row lock and revalidate: a concurrent
        // reset may have consumed it after the peek above.
        const found = await client.query(
          `SELECT * FROM account_email_proofs WHERE token_hash = $1 LIMIT 1 FOR UPDATE`,
          [tokenHash(token)]
        );
        const proof = found.rows[0];
        if (!proof || proof.purpose !== 'RECOVER' || proof.consumed_at ||
            Date.parse(proof.expires_at) <= Date.now() ||
            String(proof.account_id) !== String(account.id)) {
          throw genericRecoveryFailure();
        }
        // Triple bind: the address the mailbox proved, the address the
        // account proved, and the CURRENT address must all agree. An address
        // that changed after issuance leaves old-mailbox bearers powerless.
        const current = normalizeEmail(account.email);
        const proven = String(proof.email || '').toLowerCase();
        if (!current || current !== proven ||
            String(account.email_verified_email || '').toLowerCase() !== proven ||
            !account.email_verified_at) {
          throw genericRecoveryFailure();
        }
        await client.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [passwordHash, account.id]);
        // A recovery is GLOBAL: every previous session in every org stops at
        // once, so a compromised password cannot linger anywhere.
        await client.query('DELETE FROM sessions WHERE account_id = $1', [account.id]);
        // No sibling link survives the reset it did not perform: every live
        // proof of this account dies in the same transaction.
        await client.query(
          `UPDATE account_email_proofs SET consumed_at = now()
            WHERE account_id = $1 AND consumed_at IS NULL`,
          [account.id]
        );
        return current;
      });
      // A successful recovery clears the login throttle the lockout may have
      // left behind, so the holder is not stuck behind their own failures.
      if (accountEmail) {
        await throttleClear('account', accountEmail).catch(() => {});
      }
      return { ok: true };
    } catch (error) {
      // Already counted by the admission hit above: burn the floor, no more.
      if (error && error.status === 401) {
        burnTiming();
      }
      if (isSchemaMissing(error)) {
        burnTiming();
        throw genericRecoveryFailure();
      }
      throw error;
    }
  }

  return {
    deliveryState,
    requestEmailVerification,
    confirmEmailVerification,
    emailStatus,
    requestRecovery,
    confirmRecovery,
  };
}

module.exports = {
  createAccountRecovery,
  maskEmail,
};
