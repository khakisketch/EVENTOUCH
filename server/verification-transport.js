'use strict';

// Verification-code transport: the single seam through which attendee
// phone-ownership checks leave the server.
//
// Two modes, chosen explicitly (never silently):
//
//   1. Solapi (production path). Active only when SOLAPI_API_KEY,
//      SOLAPI_API_SECRET and SOLAPI_SENDER are all set. Sends a short SMS
//      through the existing send-many/detail contract. No test account is
//      needed to verify this file: payload shape, auth header and batch
//      mapping are covered by unit tests with an injected fetch.
//   2. Mock (development/demo/tests only). Active only when
//      EVENTOUCH_SMS_MOCK=1. Records the message in process memory (visible
//      to the in-process test harness) and writes the code to the server
//      log so a developer can complete the flow by hand. The code is NEVER
//      returned to the HTTP client in any mode.
//
// Anything else (no credentials, no mock flag) reports NOT_CONFIGURED and
// the caller answers 503: the product stays honest instead of pretending a
// code was sent.

const solapi = require('./messaging-solapi');

// In-memory record of mock sends. Process memory only: readable by the
// in-process API test harness, invisible to HTTP clients. Tests clear it
// between cases; production Solapi sends never touch it.
const mockOutbox = [];

function clearMockOutbox() {
  mockOutbox.length = 0;
}

function mockEnabled(env = process.env) {
  return String(env.EVENTOUCH_SMS_MOCK || '') === '1';
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function createVerificationTransport({ fetchImpl, env = process.env } = {}) {
  const mock = mockEnabled(env);
  const solapiConfig = solapi.providerConfig(env);
  const solapiProvider = solapi.createSolapiProvider(solapiConfig, fetchImpl ? { fetchImpl } : {});

  function state() {
    if (solapiConfig.configured) {
      return { mode: 'solapi', connected: true, sender: solapiConfig.sender };
    }
    if (mock) {
      return { mode: 'mock', connected: true, sender: null };
    }
    return { mode: 'none', connected: false, sender: null };
  }

  async function sendCode({ to, code, eventName }) {
    const number = solapi.normalizePhone(to);
    if (!number) return { sent: false, reason: 'NO_RECIPIENT' };
    const text = `[EVENTOUCH] 인증번호 ${code} (${String(eventName || '행사').slice(0, 20)})`;
    if (solapiConfig.configured) {
      const result = await solapiProvider.sendBatch([{
        to: number,
        text,
        channel: 'SMS',
        participantId: 'verification',
      }]);
      if (!result.accepted) {
        const first = (result.registered || []).find((entry) => entry.accepted === false);
        return {
          sent: false,
          reason: result.reason || 'PROVIDER_REJECTED',
          error: (first && first.error) || result.error || '공급사가 접수를 거부했습니다',
        };
      }
      return { sent: true, mode: 'solapi' };
    }
    if (mock) {
      mockOutbox.push({ to: number, code: String(code), text, at: new Date().toISOString() });
      // Developer-visible only: the demo server log is how a human completes
      // the flow without credentials. Never sent to the client.
      process.stdout.write(`[eventouch] verification mock SMS to ${maskPhone(number)} code ${code}\n`);
      return { sent: true, mode: 'mock' };
    }
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }

  return { state, sendCode };
}

module.exports = {
  createVerificationTransport,
  mockOutbox,
  clearMockOutbox,
  mockEnabled,
  maskPhone,
};
