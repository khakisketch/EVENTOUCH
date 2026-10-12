'use strict';

const crypto = require('node:crypto');

// Shared server HTTP helpers (auth + api). No dependencies.

// One nonce per response so the CSP can allow exactly this document's own
// inline <style>/<script> and nothing else.
function createNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // The product ships inline SVG icons and one inline style block; both are
    // markup, not script, so 'unsafe-inline' here does not weaken script-src.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

// Security headers on every response, static and API alike. HSTS only means
// anything over HTTPS, so it follows COOKIE_SECURE instead of being sent on
// an internal HTTP deployment. CSP starts in report-only so a policy that
// would break the product can be measured before it is enforced.
function securityHeaders(nonce, env = process.env) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (env.COOKIE_SECURE === '1') {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  const reportOnly = env.EVENTOUCH_CSP_REPORT_ONLY === '1';
  headers[reportOnly ? 'content-security-policy-report-only' : 'content-security-policy'] =
    contentSecurityPolicy(nonce);
  return headers;
}

// Applied once per response before any handler runs. Headers go through
// setHeader rather than writeHead so they merge with whatever status and
// content-type each call site writes afterwards. Returns the nonce so the
// HTML route can stamp it onto this response's inline scripts.
function applySecurityHeaders(res, env = process.env) {
  const nonce = createNonce();
  for (const [name, value] of Object.entries(securityHeaders(nonce, env))) {
    res.setHeader(name, value);
  }
  return nonce;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, maxBytes) {
  const cap = maxBytes || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > cap) {
        tooBig = true;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        reject(new Error('요청이 너무 큽니다'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error('요청 형식을 확인하세요'));
      }
    });
    req.on('error', () => reject(new Error('요청을 읽지 못했습니다')));
  });
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Expected domain failures carry an explicit status plus a user-facing
// message; unexpected errors must not echo internal details to clients.
function failureMessage(error, fallback) {
  return error && error.status && error.message ? error.message : fallback;
}

module.exports = {
  sendJson,
  readJsonBody,
  parseCookies,
  failureMessage,
  createNonce,
  securityHeaders,
  applySecurityHeaders,
  contentSecurityPolicy,
};
