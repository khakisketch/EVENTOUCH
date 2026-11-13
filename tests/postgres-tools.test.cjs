'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {postgresToolEnvironment}=require('../scripts/postgres-tools.cjs');
test('PostgreSQL tools use matching verified policy with credentials only in the child environment',()=>{
  const env=postgresToolEnvironment({connectionString:'postgres://backend:p%2Bword@db.example.test:5433/app?application_name=backup',env:{PATH:'/bin',DATABASE_SSL_MODE:'verify-full',DATABASE_SCHEMA:'eventouch',PGSERVICE:'unexpected',PGOPTIONS:'-c search_path=wrong',PGSSLKEY:'/other-key'}});
  assert.equal(env.PGHOST,'db.example.test'); assert.equal(env.PGPORT,'5433');
  assert.equal(env.PGUSER,'backend');assert.equal(env.PGPASSWORD,'p+word');assert.equal(env.PGDATABASE,'app');
  assert.equal(env.PGSSLMODE,'verify-full');assert.equal(env.PGOPTIONS,'-c search_path=eventouch');
  assert.equal(env.PGSERVICE,undefined);assert.equal(env.PGSSLKEY,undefined);
});
test('PostgreSQL tools respect effective URL host and user overrides while preserving the driver database',()=>{
  const env=postgresToolEnvironment({connectionString:'postgres://a:b@host/db?host=127.0.0.1&user=local&database=other',env:{}});
  assert.equal(env.PGHOST,'127.0.0.1');assert.equal(env.PGUSER,'local');assert.equal(env.PGDATABASE,'db');
});
