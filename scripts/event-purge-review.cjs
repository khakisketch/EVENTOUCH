'use strict';
// Read-only impact review. Hard deletion remains unavailable until the
// retention/hold/backup rules and event-command receipt contract are approved.
const { createDatabase } = require('../server/db');
async function review(database, orgId, eventId) {
  if (!orgId || !eventId) throw new Error('조직와 행사 ID가 필요합니다');
  const event = (await database.query('SELECT id,payload,updated_at FROM events WHERE id=$1 AND org_id=$2', [eventId, orgId])).rows[0];
  if (!event) throw new Error('해당 조직의 행사를 찾을 수 없습니다');
  const files = (await database.query('SELECT count(*)::int AS count,coalesce(sum(f.size_bytes),0)::text AS bytes FROM stored_files f JOIN events e ON e.id=f.event_id WHERE f.event_id=$1 AND e.org_id=$2', [eventId, orgId])).rows[0];
  const workspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0]?.payload || {};
  return { eventId, orgId, stage: event.payload.stage, updatedAt: event.updated_at.toISOString(), deletionEnabled: false,
    counts: { participants: Array.isArray(workspace.participants) ? workspace.participants.length : 0, reports: Array.isArray(workspace.reports) ? workspace.reports.length : 0, files: files.count, fileBytes: Number(files.bytes) },
    requiredDecisions: ['보존 기산일과 기간', '삭제 권한과 보존 예외·보류', '백업·복제본·파일의 삭제 범위', '삭제 후 동일 요청 영수증과 감사 기록의 보존'],
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--org-id' || args[2] !== '--event-id') throw new Error('사용법: npm run event:purge:review -- --org-id <조직> --event-id <행사>');
  const database = createDatabase();
  try { process.stdout.write(JSON.stringify(await review(database, args[1], args[3]), null, 2) + '\n'); } finally { await database.close(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('삭제 영향 검토 실패: 조직·행사 ID와 DB 접속을 확인하세요. 데이터는 삭제하지 않았습니다.\n'); process.exitCode = 1; });
module.exports = { review };
