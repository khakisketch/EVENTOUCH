'use strict';

// Removes expired credential rows, and nothing else. Phone verification
// challenges (retention undecided), receipts, events, accounts and files are
// never touched.

const HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 1000;
const EXPIRED = [
  ['sessions', 'token_hash', 'expires_at <= now()'],
  ['attendee_sessions', 'token_hash', 'expires_at <= now()'],
  ['attendee_grants', 'token_hash', 'expires_at <= now()'],
  // Mail send caps count proof rows by creation time (server/account-recovery.js):
  // an expired proof stays until neither the hourly nor the daily cap counts it.
  ['account_email_proofs', 'id',
    "expires_at <= now() AND created_at <= now() - interval '1 hour' AND created_at < date_trunc('day', now())"],
];

const writeStderr = (line) => process.stderr.write(line);

async function pruneExpiredCredentials(database, { batchSize = BATCH_SIZE, shouldStop = () => false, write = writeStderr } = {}) {
  const removed = {};
  for (const [table, key, condition] of EXPIRED) {
    removed[table] = 0;
    try {
      let count = batchSize;
      while (count === batchSize && !shouldStop()) {
        // SKIP LOCKED: the cleanup never waits on a row a request holds, so it
        // cannot deadlock one. A skipped row goes on a later run.
        const result = await database.query(
          `WITH expired AS (SELECT ${key} FROM ${table} WHERE ${condition} LIMIT $1 FOR UPDATE SKIP LOCKED)
           DELETE FROM ${table} target USING expired WHERE target.${key} = expired.${key}`,
          [batchSize]
        );
        count = result.rowCount;
        removed[table] += count;
      }
    } catch (error) {
      const code = /^[A-Za-z0-9_]{1,64}$/.test(String(error?.code || '')) ? ` (${error.code})` : '';
      write(`[eventouch] expired credential cleanup failed for ${table}${code}\n`);
    }
  }
  return removed;
}

// Runs once now and then every interval, one run at a time. stop() prevents new
// work and resolves when the current statement has finished.
function startCredentialPruning(database, { intervalMs = HOUR_MS, write = writeStderr } = {}) {
  let stopped = false;
  let running = null;
  const run = () => {
    if (stopped || running) return;
    running = pruneExpiredCredentials(database, { write, shouldStop: () => stopped })
      // Nothing here may take the server down, including a failing log write.
      .catch(() => {})
      .finally(() => { running = null; });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  run();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

module.exports = { pruneExpiredCredentials, startCredentialPruning };
