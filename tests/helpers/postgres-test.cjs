'use strict';

function testDatabaseUrl(value = process.env.EVENTOUCH_TEST_DATABASE_URL) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('EVENTOUCH_TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const host = url.hostname.toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (!loopback.includes(host)) {
    throw new Error('PostgreSQL integration tests must use a loopback-only database or approved local test socket');
  }
  const effectiveHost = url.searchParams.get('host');
  if (effectiveHost && !loopback.includes(effectiveHost.toLowerCase()) &&
    !/^\/tmp\/opencode\/eventouch-pg-test-[a-zA-Z0-9._-]+$/.test(effectiveHost)) {
    throw new Error('PostgreSQL integration tests must use a loopback-only database or approved local test socket');
  }
  return value;
}

module.exports = { testDatabaseUrl };
