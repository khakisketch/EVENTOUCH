'use strict';

// Shared server HTTP helpers (auth + api). No dependencies.
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

module.exports = { sendJson, readJsonBody, parseCookies, failureMessage };
