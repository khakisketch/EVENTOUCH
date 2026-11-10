'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { testDatabaseUrl } = require('./helpers/postgres-test.cjs');
const databaseUrl = testDatabaseUrl();
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

test('api bind option limits the actual listening socket and preserves explicit container binding', async () => {
  const schema = `eventouch_bind_${crypto.randomUUID().replace(/-/g, '')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-bind-'));
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const script = `require('./server/server').startServer().then(({server,close}) => {
    process.send({address:server.address()});
    process.once('message', () => close().then(() => process.exit(0), () => process.exit(1)));
  }).catch(() => process.exit(1));`;
  async function inspect(bind) {
    let started = false;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { NODE_ENV: 'production', PORT: '0', DATABASE_URL: scoped.toString(),
        DATA_DIR: path.join(dir, 'data'), STORAGE_DIR: path.join(dir, 'storage'), ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
        EVENTOUCH_API_BIND: bind, EVENTOUCH_PUBLIC_URL: '', EVENTOUCH_SMS_MOCK: '1', EVENTOUCH_MAIL_MOCK: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      const message = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server startup timed out')), 20000);
        child.once('message', (value) => { clearTimeout(timeout); resolve(value); });
        child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited before listening: ${code}`)); });
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      });
      started = true;
      if (bind) assert.equal(message.address.address, bind, 'actual listening socket must match the requested bind address');
      else assert.ok(['::', '0.0.0.0'].includes(message.address.address), 'standalone default keeps its existing wildcard binding');
      assert.equal((await fetch(`http://127.0.0.1:${message.address.port}/api/health`, { headers: { connection: 'close' } })).status, 200);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        if (started && child.connected) child.send('stop'); else child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { await exited; } finally { clearTimeout(killTimer); }
      }
    }
  }
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await inspect('127.0.0.1');
    await inspect('0.0.0.0');
    await inspect(undefined);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
