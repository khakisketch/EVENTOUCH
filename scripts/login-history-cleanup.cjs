'use strict';
const { createDatabase } = require('../server/db');
const { loginHistoryPolicy, pruneLoginHistory } = require('../server/login-history');
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('사용법: npm run login-history:cleanup -- [--apply]');
  const policy = loginHistoryPolicy();
  if (!policy.enabled) throw new Error('명시적인 로그인 기록 보존일이 필요합니다');
  const database = createDatabase();
  try {
    const count = (await database.query("SELECT count(*)::int AS n FROM account_login_events WHERE occurred_at < now() - ($1::int * interval '1 day')", [policy.retentionDays])).rows[0].n;
    const deleted = args.includes('--apply') ? await pruneLoginHistory(database, policy) : 0;
    process.stdout.write(JSON.stringify({ retentionDays: policy.retentionDays, expired: count, deleted, dryRun: !args.includes('--apply') }) + '\n');
  } finally { await database.close(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('로그인 기록 정리 실패: 보존일·접속 설정·스키마를 확인하세요.\n'); process.exitCode = 1; });
