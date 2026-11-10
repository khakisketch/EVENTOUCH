'use strict';

// Explicit SMTP configuration, with TLS verification and no message logging.
// Configuration readiness does not assert provider acceptance or inbox arrival.
function smtpConfiguration(env) {
  if (env.EVENTOUCH_MAIL_TRANSPORT !== 'smtp') return null;
  if (env.EVENTOUCH_MAIL_MOCK === '1') return null;
  const host = String(env.EVENTOUCH_SMTP_HOST || '').trim();
  const port = Number(env.EVENTOUCH_SMTP_PORT || 587);
  const from = String(env.EVENTOUCH_SMTP_FROM || '').trim();
  const user = String(env.EVENTOUCH_SMTP_USER || '');
  const pass = String(env.EVENTOUCH_SMTP_PASSWORD || '');
  if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !singleAddress(from) || !user || !pass) return null;
  return { host, port, from, user, pass };
}

function singleAddress(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/.test(value);
}

function createSmtpSender({ env = process.env, createTransport = require('nodemailer').createTransport } = {}) {
  const config = smtpConfiguration(env);
  if (!config) return null;
  const transport = createTransport({
    host: config.host, port: config.port, secure: config.port === 465,
    requireTLS: config.port !== 465, auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    maxRecipients: 1,
  });
  return async function send({ to, link }) {
    if (!singleAddress(to)) return { sent: false, reason: 'NO_RECIPIENT' };
    let url, origin;
    try { url = new URL(link); origin = new URL(env.EVENTOUCH_PUBLIC_URL); } catch { return { sent: false, reason: 'INVALID_LINK' }; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin || url.username || url.password || !/^#t=[A-Za-z0-9_-]{32,}$/.test(url.hash)) return { sent: false, reason: 'INVALID_LINK' };
    try {
      const result = await transport.sendMail({
        from: { name: 'EVENTOUCH', address: config.from }, to: { address: to },
        envelope: { from: config.from, to: [to] },
        subject: 'EVENTOUCH 계정 이메일 확인 및 비밀번호 복구',
        text: `본인이 요청한 경우 아래 링크에서 계속 진행하세요.\n\n${url.href}\n\n요청하지 않았다면 이 메일을 무시하세요. 링크는 한 번만 사용할 수 있으며 유효기간이 지나면 다시 요청해야 합니다.`,
        disableFileAccess: true, disableUrlAccess: true,
      });
      return result.accepted?.length === 1 && !result.rejected?.length
        ? { sent: true } : { sent: false, reason: 'PROVIDER_REJECTED' };
    } catch {
      // SMTP errors may echo credentials, recipient addresses or message text.
      return { sent: false, reason: 'PROVIDER_FAILED' };
    }
  };
}

module.exports = { smtpConfiguration, createSmtpSender };
