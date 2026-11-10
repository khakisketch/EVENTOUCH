'use strict';

// Test harnesses must never inherit an outbound provider or SMTP transport
// from a developer's shell. A proxy keeps other values live for existing
// tests that change public URLs while a harness is running.
const BLOCKED = /^(?:SOLAPI_|MESSAGING_|EVENTOUCH_MESSAGING_|EVENTOUCH_SMTP_|EVENTOUCH_MAIL_TRANSPORT)/;
const blocked = key => typeof key === 'string' && BLOCKED.test(key);

function isolatedTestEnvironment(source = process.env) {
  return new Proxy(source, {
    get(target, key, receiver) { return blocked(key) ? undefined : Reflect.get(target, key, receiver); },
    has(target, key) { return !blocked(key) && Reflect.has(target, key); },
    ownKeys(target) { return Reflect.ownKeys(target).filter(key => !blocked(key)); },
    getOwnPropertyDescriptor(target, key) {
      return blocked(key) ? undefined : Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

// Only the two explicitly configured browser tests use this. The fake
// credentials are fixed; even an inherited real key can never be forwarded.
function fixtureSolapiEnvironment(source, host) {
  let url;
  try { url = new URL(host); } catch { throw new Error('fixture Solapi requires a literal loopback HTTP origin'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('fixture Solapi requires a literal loopback HTTP origin');
  }
  return {
    ...isolatedTestEnvironment(source),
    SOLAPI_API_HOST: url.origin,
    SOLAPI_API_KEY: 'fixture-key',
    SOLAPI_API_SECRET: 'fixture-secret',
    SOLAPI_SENDER: '0212345678',
  };
}

module.exports = { isolatedTestEnvironment, fixtureSolapiEnvironment };
