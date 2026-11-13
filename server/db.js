'use strict';

const { Pool } = require('pg');

const { databaseConnectionOptions } = require('./database-config');

function createDatabase({ connectionString, PoolClass = Pool, env = process.env } = {}) {
  const pool = new PoolClass(databaseConnectionOptions({ connectionString, env }));
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
      let committing = false;
      try {
        await client.query('BEGIN');
        began = true;
        const result = await fn(client);
        committing = true;
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        // A lost COMMIT reply is not proof of rollback. File compensation
        // must retain bytes until the original receipt can be reconciled.
        if (committing) Object.defineProperty(error, 'transactionOutcome', { value: 'unknown', configurable: true });
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
      // migrate.js requires this file back for its CLI entry point. Requiring
      // it from here would observe a half-initialised module depending on
      // which entry point ran first, so the require stays inside the call
      // that actually needs it — by then this module is fully initialised.
      const { runMigrations } = require('./migrate');
      if (typeof runMigrations !== 'function') {
        throw new Error('마이그레이션을 실행할 수 없습니다');
      }
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
