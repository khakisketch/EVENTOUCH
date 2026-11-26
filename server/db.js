'use strict';

const { Pool } = require('pg');

const { databaseConnectionOptions } = require('./database-config');

const STATEMENT_CANCELED = '57014';

function createDatabase({ connectionString, PoolClass = Pool, env = process.env, apiLimits = false } = {}) {
  const pool = new PoolClass(databaseConnectionOptions({ connectionString, env, apiLimits }));
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
      // A canceled statement or a lost session stays the reported failure even
      // when the callback rewrote it (for example into a 403): callers must see
      // an unconfirmed failure, never a business refusal.
      let cause = null;
      const lostSession = (error) => { cause = cause || error; };
      const canceledStatement = (error) => { if (error && error.code === STATEMENT_CANCELED) lostSession(error); };
      // pg emits an error on a checked-out client when the server ends the
      // session (idle-in-transaction limit); unheard, it would end the process.
      client.on?.('error', lostSession);
      client.connection?.on('errorMessage', canceledStatement);
      try {
        await client.query('BEGIN');
        began = true;
        const result = await fn(client);
        committing = true;
        const committed = await client.query('COMMIT');
        began = false;
        // PostgreSQL answers COMMIT with ROLLBACK, not an error, when an earlier
        // statement failed and the callback swallowed it. Nothing was saved.
        if (committed?.command === 'ROLLBACK') {
          committing = false;
          throw Object.assign(new Error('트랜잭션이 취소되었습니다'), { code: '25P02' });
        }
        return result;
      } catch (thrown) {
        const error = cause || thrown;
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
        client.connection?.removeListener('errorMessage', canceledStatement);
        client.removeListener?.('error', lostSession);
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
