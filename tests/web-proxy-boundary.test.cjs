'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual production entry's HTTP boundary without booting Next
// for every unit test. Real Next/Compose forwarding is verified separately.
async function boundary({ handler = async () => {}, env = {} } = {}) {
  let onRequest;
  let listener;
  const exits = [];
  const server = {
    on() {},
    listen(port, hostname, ready) { listener = { port, hostname }; ready(); },
    close(done) { done(); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/web-server.cjs'), 'utf8');
  vm.runInNewContext(source, {
    __dirname: path.join(__dirname, '../apps/web'),
    require(name) {
      if (name === 'node:http') return { createServer(callback) { onRequest = callback; return server; } };
      if (name === 'next') return () => ({ prepare: async () => {}, getRequestHandler: () => handler });
      throw new Error(`unexpected dependency: ${name}`);
    },
    process: { env, stdout: { write() {} }, stderr: { write() {} }, exit(code) { exits.push(code); }, on() {} },
    setTimeout,
  }, { filename: 'web-server.cjs' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, []);
  assert.ok(onRequest);
  return { onRequest, listener };
}

test('web boundary replaces spoofed forwarded addresses with the real socket peer', async () => {
  const seen = [];
  const { onRequest } = await boundary({ handler: async req => { seen.push(req.headers['x-forwarded-for']); } });
  for (const fake of ['203.0.113.1', '203.0.113.2, 203.0.113.3', ['203.0.113.4'], undefined]) {
    const req = { headers: { 'x-forwarded-for': fake }, socket: { remoteAddress: '::ffff:192.0.2.20' } };
    await onRequest(req, {});
  }
  assert.deepEqual(seen, Array(4).fill('::ffff:192.0.2.20'));
});

test('web binding ignores the Docker container hostname and supports an explicit bind address', async () => {
  const defaults = await boundary({ env: { HOSTNAME: 'container-id' } });
  assert.deepEqual(defaults.listener, { port: 8777, hostname: '0.0.0.0' });
  const explicit = await boundary({ env: { PORT: '18893', EVENTOUCH_WEB_BIND: '127.0.0.1' } });
  assert.deepEqual(explicit.listener, { port: 18893, hostname: '127.0.0.1' });
});

test('a handler failure does not expose its error or leave a hung response', async () => {
  for (const headersSent of [false, true]) {
    const { onRequest } = await boundary({ handler() { throw new Error('private backend detail'); } });
    let body;
    let destroyed = false;
    const res = { headersSent, end(value) { body = value; }, destroy() { destroyed = true; } };
    await onRequest({ headers: {}, socket: {} }, res);
    if (headersSent) assert.equal(destroyed, true);
    else {
      assert.equal(res.statusCode, 500);
      assert.doesNotMatch(body, /private backend detail/);
    }
  }
});
