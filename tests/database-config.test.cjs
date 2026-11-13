'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {databaseConnectionOptions} = require('../server/database-config');
const {createDatabase} = require('../server/db');
const url = 'postgresql://backend:private-password@db.example.test:5432/app';

test('managed database uses verified TLS and a private schema without URL overrides', () => {
  const options = databaseConnectionOptions({connectionString:url,env:{DATABASE_SSL_MODE:'verify-full',DATABASE_SCHEMA:'eventouch',PGPOOL_MAX:'4'}});
  assert.deepEqual(options.ssl,{rejectUnauthorized:true});
  assert.equal(options.options,'-c search_path=eventouch');
  assert.equal(options.max,4);
  assert.equal(options.connectionTimeoutMillis,5000);
});
test('legacy loopback and Compose connections retain local defaults', () => {
  const options = databaseConnectionOptions({connectionString:'postgres://test@db/app',env:{}});
  assert.equal(options.ssl,false);
  assert.equal(options.max,10);
  assert.equal(options.options,undefined);
});
test('verified URL TLS is normalized before node-postgres parses it', () => {
  const options = databaseConnectionOptions({connectionString:url+'?sslmode=verify-full',env:{}});
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'),false);
  assert.equal(options.ssl.rejectUnauthorized,true);
});
test('TLS policy rejects weak, conflicting and hidden driver overrides without secrets', () => {
  for (const query of ['sslmode=require','sslmode=no-verify','sslmode=disable','ssl=false','uselibpqcompat=true','sslcert=/secret','sslkey=/secret','sslmode=verify-full&sslmode=disable']) {
    assert.throws(() => databaseConnectionOptions({connectionString:url+'?'+query,env:{DATABASE_SSL_MODE:'verify-full'}}), error => {
      assert.doesNotMatch(error.message,/private-password|db\.example|\/secret/);
      return true;
    });
  }
});
test('CA file is read explicitly and unreadable configuration fails without a connection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'eventouch-ca-policy-'));
  try {
    const ca = path.join(dir,'ca.pem'); fs.writeFileSync(ca,'test-ca');
    const options = databaseConnectionOptions({connectionString:url,env:{DATABASE_SSL_MODE:'verify-full',DATABASE_SSL_CA_FILE:ca}});
    assert.equal(options.ssl.ca,'test-ca');
    assert.throws(() => databaseConnectionOptions({connectionString:url,env:{DATABASE_SSL_MODE:'verify-full',DATABASE_SSL_CA_FILE:path.join(dir,'missing')}}),/DATABASE_SSL_CA_FILE/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('schema injection and conflicting search paths fail closed', () => {
  for (const schema of ['public,other','eventouch;DROP SCHEMA public','pg_catalog','information_schema','bad-name']) {
    assert.throws(() => databaseConnectionOptions({connectionString:url,env:{DATABASE_SCHEMA:schema}}),/DATABASE_SCHEMA/);
  }
  assert.throws(() => databaseConnectionOptions({connectionString:url+'?options=-c%20search_path%3Dpublic',env:{DATABASE_SCHEMA:'eventouch'}}),/DATABASE_SCHEMA/);
});
test('invalid explicit pool budgets fail before opening connections', () => {
  for (const max of ['0','51','1.5','bad']) assert.throws(() => databaseConnectionOptions({connectionString:url,env:{PGPOOL_MAX:max}}),/PGPOOL_MAX/);
});
test('an uncertain COMMIT is marked and never automatically replayed', async () => {
  const calls = [];
  const lost = new Error('connection lost during commit');
  class Pool {
    async connect() { return {query:async text => { calls.push(text); if (text==='COMMIT') throw lost; }, release(){calls.push('release');}}; }
    async end() {}
  }
  const db = createDatabase({connectionString:'postgres://test',PoolClass:Pool,env:{}});
  await assert.rejects(db.transaction(async () => calls.push('work')), error => error===lost && error.transactionOutcome==='unknown');
  assert.equal(calls.filter(call=>call==='work').length,1);
  assert.equal(calls.filter(call=>call==='COMMIT').length,1);
  assert.equal(calls.at(-1),'release');
  await db.close();
});
