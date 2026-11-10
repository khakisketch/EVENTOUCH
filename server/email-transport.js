'use strict';

// Recovery mail defaults to unavailable. SMTP is enabled only through explicit
// EVENTOUCH_MAIL_TRANSPORT=smtp and a complete TLS SMTP configuration. Injected
// senders remain supported; explicit development mock never sends externally.
// SMTP readiness is configuration, not proof of inbox delivery. No token,
// address, provider exception or message body is logged.
const { createSmtpSender } = require('./smtp-mail');

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

function createEmailTransport({ send, env = process.env, createTransport } = {}) {
  const smtp = !send && createSmtpSender({ env, createTransport });
  const activeSend = send || smtp;
  const activeMode = send ? 'injected' : 'smtp';
  const mock = !activeSend && !env.EVENTOUCH_MAIL_TRANSPORT && mockEnabled(env);

  function state() {
    if (activeSend) return { mode: activeMode, connected: true };
    if (mock) return { mode: 'mock', connected: true };
    return { mode: 'none', connected: false };
  }

  async function sendRecovery({ to, link }) {
    const address = String(to || '').trim();
    const url = String(link || '').trim();
    if (!address || !url) return { sent: false, reason: 'NO_RECIPIENT' };
    if (activeSend) {
      const result = await activeSend({ to: address, link: url });
      if (result && result.sent === true) return { sent: true, mode: activeMode };
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
