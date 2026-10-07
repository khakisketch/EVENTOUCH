'use strict';

const { Pool } = require('pg');

function databaseConnectionString(value) {
  const connectionString = value || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL을 설정하세요');
  let url;
  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new Error('DATABASE_URL 형식을 확인하세요');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL은 PostgreSQL 주소여야 합니다');
  }
  return connectionString;
}

function poolSize() {
  const configured = Number(process.env.PGPOOL_MAX || 10);
  return Number.isInteger(configured) && configured >= 1 && configured <= 50 ? configured : 10;
}

function createDatabase({ connectionString, PoolClass = Pool } = {}) {
  const pool = new PoolClass({
    connectionString: databaseConnectionString(connectionString),
    max: poolSize(),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  let closed = false;

  if (typeof pool.on === 'function') {
    pool.on('error', (error) => {
      const code = error && error.code ? ` (${error.code})` : '';
      process.stderr.write(`[eventouch] idle PostgreSQL connection error${code}\n`);
    });
  }

  const database = {
    pool,
    query(text, values = []) {
      if (closed) return Promise.reject(new Error('데이터베이스 연결이 종료되었습니다'));
      return pool.query(text, values);
    },
    async transaction(fn) {
      if (closed) throw new Error('데이터베이스 연결이 종료되었습니다');
      if (typeof fn !== 'function') throw new TypeError('transaction callback is required');
      const client = await pool.connect();
      let began = false;
      try {
        await client.query('BEGIN');
        began = true;
        const result = await fn(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            // Preserve the original failure; callers must not receive driver details.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async migrate() {
      if (closed) throw new Error('데이터베이스 연결이 종료되었습니다');
      const { runMigrations } = require('./migrate');
      return runMigrations(database);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
  return database;
}

module.exports = { createDatabase };
