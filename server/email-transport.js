'use strict';

// Outbound email transport seam for account recovery mail (verification and
// password-reset links). Standards-neutral by design: the product selects NO
// provider here, holds no credentials, and performs no live delivery.
//
// Modes, chosen explicitly (never silently):
//
//   1. Injected provider (selected deployments/tests only). Active only when
//      a `send` function is passed in: `send({ to, link })` must resolve to
//      `{ sent: true }` or `{ sent: false, reason, error? }`. The repository
//      never passes one — server.js wires none — so no provider, cost, or
//      credential decision is made by this codebase.
//   2. Mock (development/tests only). Active only when EVENTOUCH_MAIL_MOCK=1.
//      Records the message in process memory (visible to the in-process test
//      harness) and writes a MASKED line to the server log so a developer can
//      complete the flow by hand. The raw address and token never reach an
//      HTTP client; logs carry only the masked address (no token at all).
//   3. None (default). Anything else reports NOT_CONFIGURED and the caller
//      answers honestly: an authenticated holder gets 503 EMAIL_NOT_CONFIGURED,
//      an anonymous recovery request stays generic (fail-closed, no send).
//
// Raw tokens and addresses are never logged. Health output exposes only the
// mode, never recipients or links.

const mockOutbox = [];

function clearMockOutbox() {
  mockOutbox.length = 0;
}

function mockEnabled(env = process.env) {
  return String(env.EVENTOUCH_MAIL_MOCK || '') === '1';
}

// Local-part first character plus domain only. Short or malformed input
// collapses to a fixed mask so logs cannot be probed for shape.
function maskEmail(email) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return '***';
  const domain = raw.slice(at + 1);
  if (!/^[^\s@]+\.[^\s@]+$/.test(domain)) return '***';
  const head = raw[0] || '*';
  return `${head}***@${domain}`;
}

function createEmailTransport({ send, env = process.env } = {}) {
  const mock = !send && mockEnabled(env);

  function state() {
    if (send) return { mode: 'injected', connected: true };
    if (mock) return { mode: 'mock', connected: true };
    return { mode: 'none', connected: false };
  }

  async function sendRecovery({ to, link }) {
    const address = String(to || '').trim();
    const url = String(link || '').trim();
    if (!address || !url) return { sent: false, reason: 'NO_RECIPIENT' };
    if (send) {
      const result = await send({ to: address, link: url });
      if (result && result.sent === true) return { sent: true, mode: 'injected' };
      return {
        sent: false,
        reason: (result && result.reason) || 'PROVIDER_REJECTED',
        error: (result && result.error) || undefined,
      };
    }
    if (mock) {
      mockOutbox.push({ to: address, link: url, at: new Date().toISOString() });
      // Developer-visible only: the demo/test server log is how a human
      // completes the flow without credentials. Masked address, no token.
      process.stdout.write(`[eventouch] recovery mock mail to ${maskEmail(address)}\n`);
      return { sent: true, mode: 'mock' };
    }
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }

  return { state, sendRecovery };
}

module.exports = {
  createEmailTransport,
  mockOutbox,
  clearMockOutbox,
  mockEnabled,
  maskEmail,
};
