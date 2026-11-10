'use strict';

// The configured address recipients open on their own devices. Never use
// a request header here, and do not include credentials, query, or hash.
function publicOrigin(env = process.env) {
  const raw = String(env.EVENTOUCH_PUBLIC_URL || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

module.exports = { publicOrigin };
