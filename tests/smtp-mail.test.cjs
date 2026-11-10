'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEmailTransport } = require('../server/email-transport');
const { smtpConfiguration } = require('../server/smtp-mail');
const nodemailer = require('nodemailer');
const env = { EVENTOUCH_MAIL_TRANSPORT: 'smtp', EVENTOUCH_SMTP_HOST: '127.0.0.1', EVENTOUCH_SMTP_PORT: '465', EVENTOUCH_SMTP_FROM: 'account@example.test', EVENTOUCH_SMTP_USER: 'fixture', EVENTOUCH_SMTP_PASSWORD: 'fixture-secret', EVENTOUCH_PUBLIC_URL: 'https://events.example.test' };
const link = 'https://events.example.test/recover#t=' + 'a'.repeat(43);

test('SMTP is explicit, complete, fail-closed and never silently replaces mock', async () => {
  for (const changes of [{ EVENTOUCH_MAIL_TRANSPORT: '' }, { EVENTOUCH_SMTP_HOST: '' }, { EVENTOUCH_SMTP_PORT: 'NaN' }, { EVENTOUCH_SMTP_PORT: '0' }, { EVENTOUCH_SMTP_FROM: 'a@b.test\r\nBcc:x@y.test' }, { EVENTOUCH_SMTP_PASSWORD: '' }, { EVENTOUCH_MAIL_MOCK: '1' }]) {
    const transport = createEmailTransport({ env: { ...env, ...changes }, createTransport: () => assert.fail('must not connect') });
    assert.equal(transport.state().connected, false);
    assert.equal((await transport.sendRecovery({ to: 'holder@example.test', link })).sent, false);
  }
  assert.equal(createEmailTransport({ env: { EVENTOUCH_MAIL_MOCK: '1' } }).state().mode, 'mock');
  assert.equal(smtpConfiguration(env).port, 465);
});

test('SMTP requires verified TLS, one recipient, bounded timeouts and no data logging', async () => {
  let options, message;
  const transport = createEmailTransport({ env: { ...env, EVENTOUCH_SMTP_PORT: '587' }, createTransport: o => { options = o; return { async sendMail(m) { message = m; return { accepted: ['holder@example.test'], rejected: [] }; } }; } });
  assert.equal(transport.state().mode, 'smtp');
  assert.equal((await transport.sendRecovery({ to: 'holder@example.test', link })).sent, true);
  assert.equal(options.secure, false); assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.tls.minVersion, 'TLSv1.2');
  assert.equal(options.logger, false); assert.equal(options.debug, false);
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
  assert.ok(options.socketTimeout <= 15000); assert.deepEqual(message.envelope.to, ['holder@example.test']);
  assert.equal(message.text.includes(link), true);
  assert.equal(message.html, undefined);
  for (const to of ['one@example.test,two@example.test', 'a@example.test\r\nBcc:x@y.test']) assert.equal((await transport.sendRecovery({ to, link })).sent, false);
  for (const invalid of ['https://evil.test/recover#t=' + 'a'.repeat(43), 'file:///etc/passwd', 'https://events.example.test/recover?t=secret']) assert.equal((await transport.sendRecovery({ to: 'holder@example.test', link: invalid })).sent, false);
  const failed = createEmailTransport({ env, createTransport: () => ({ async sendMail() { throw new Error('fixture-secret holder@example.test ' + link); } }) });
  assert.deepEqual(await failed.sendRecovery({ to: 'holder@example.test', link }), { sent: false, reason: 'PROVIDER_FAILED', error: undefined });
});

test('verified TLS SMTP accepts mail, and the real account API verifies and recovers exactly once', async () => {
  const { databaseUrl, startApiHarness, insertAccount, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
  assert.ok(databaseUrl, 'isolated test database is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-smtp-'));
  const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = fs.readFileSync(certFile), messages = [], sockets = new Set();
  const server = tls.createServer({ key: fs.readFileSync(keyFile), cert }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.write('220 localhost fixture\r\n'); let buffer = '', data = null;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data !== null) { if (line === '.') { messages.push(data); data = null; socket.write('250 queued\r\n'); } else data += line + '\r\n'; }
        else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) socket.write('235 authenticated\r\n');
        else if (/^(MAIL FROM|RCPT TO)/.test(line)) socket.write('250 OK\r\n');
        else if (line === 'DATA') { data = ''; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  let harness;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const transport = createEmailTransport({ env, createTransport: opts => nodemailer.createTransport({ ...opts, port: server.address().port, tls: { ...opts.tls, ca: cert, servername: 'localhost' } }) });
    harness = await startApiHarness({ env, mailTransport: transport });
    await insertAccount(harness.database, { id: 'smtp-holder', orgId: LEGACY_ORG, role: 'AGENCY', name: '합성 계정', email: 'holder@example.test' });
    const cookie = await sessionCookie(harness, 'smtp-holder');
    let result = await requestJson(harness.baseUrl, '/api/auth/email/verify/request', { method: 'POST', cookie, body: { currentPassword: 'not-a-real-test-password' } });
    assert.equal(result.status, 200, JSON.stringify(result.json)); assert.equal(messages.length, 1);
    const raw = messages[0], body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    const decoded = /Content-Transfer-Encoding: base64/i.test(raw) ? Buffer.from(body.replace(/\s/g, ''), 'base64').toString() : body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const token = /#t=([A-Za-z0-9_-]{32,128})/.exec(decoded)?.[1]; assert.ok(token, 'SMTP carries the one-time link');
    result = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', { method: 'POST', cookie, body: { token } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    result = await requestJson(harness.baseUrl, '/api/auth/email/verify/confirm', { method: 'POST', cookie, body: { token } });
    assert.notEqual(result.status, 200, 'replay is rejected');
    result = await requestJson(harness.baseUrl, '/api/auth/recovery/request', { method: 'POST', body: { email: 'holder@example.test' } });
    assert.equal(result.status, 200, JSON.stringify(result.json)); assert.equal(messages.length, 2);
    const resetRaw = messages[1], resetBody = resetRaw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    const resetDecoded = /Content-Transfer-Encoding: base64/i.test(resetRaw) ? Buffer.from(resetBody.replace(/\s/g, ''), 'base64').toString() : resetBody.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const resetToken = /#t=([A-Za-z0-9_-]{32,128})/.exec(resetDecoded)?.[1]; assert.ok(resetToken);
    result = await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', { method: 'POST', body: { token: resetToken, password: 'NewSyntheticPassword!2026' } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal((await requestJson(harness.baseUrl, '/api/auth/me', { cookie })).status, 401);
    assert.notEqual((await requestJson(harness.baseUrl, '/api/auth/recovery/confirm', { method: 'POST', body: { token: resetToken, password: 'AnotherSyntheticPassword!2026' } })).status, 200);
    assert.equal((await requestJson(harness.baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'holder@example.test', password: 'NewSyntheticPassword!2026' } })).status, 200);
  } finally {
    if (harness) await harness.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
