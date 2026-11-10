'use strict';
function loginHistoryPolicy(env = process.env) {
  const raw = String(env.EVENTOUCH_LOGIN_HISTORY_DAYS || '');
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(days) && days > 0 && days <= 3650
    ? { enabled: true, retentionDays: days } : { enabled: false, retentionDays: null };
}
async function pruneLoginHistory(database, policy) {
  if (!policy.enabled) return 0;
  const result = await database.query("DELETE FROM account_login_events WHERE occurred_at < now() - ($1::int * interval '1 day')", [policy.retentionDays]);
  return result.rowCount;
}
module.exports = { loginHistoryPolicy, pruneLoginHistory };
