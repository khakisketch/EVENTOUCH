'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { eventCloseHref, readCloseReturn, closeHandoffHref, closePrerequisite, readCloseSnapshot, linearCloseProgress } = require('../apps/web/app/console/console-event-close.ts');
const read = (p) => fs.readFileSync(`apps/web/app/console/${p}`, 'utf8');

test('close return is canonical, event-bound, query-allowlisted and non-external', () => {
  for (const id of [null, 'report-123']) {
    const href = eventCloseHref('event-a', id);
    assert.equal(readCloseReturn(href, 'event-a'), href);
    assert.equal(readCloseReturn(href, 'event-b'), null);
  }
  for (const bad of ['https://evil.test', '//evil.test', 'javascript:alert(1)', '/console/events/event-a/reports?x=1#event-close', '/console/events/event-a/reports?closeReport=a&closeReport=b#event-close', '/console/events/event-a/reports?closeReport=#event-close', '/console/events/event-a/reports#report-1', '/console/events/event-a/reports?closeReport=a%0Ab#event-close', '/console/events/event-a/reports\\#event-close']) assert.equal(readCloseReturn(bad, 'event-a'), null, bad);
});

test('handoffs preserve filters and anchors, reject other events and unsafe destinations', () => {
  const href = closeHandoffHref('/console/events/e/participants?status=PENDING&query=Lee', 'e', 'r');
  const parsed = new URL(href, 'https://eventouch.invalid');
  assert.equal(parsed.searchParams.get('status'), 'PENDING');
  assert.equal(parsed.searchParams.get('query'), 'Lee');
  assert.equal(parsed.searchParams.get('closeReturn'), eventCloseHref('e', 'r'));
  assert.equal(new URL(closeHandoffHref('/console/events/e/settings#settings-stage', 'e'), 'https://eventouch.invalid').hash, '#settings-stage');
  assert.match(closeHandoffHref('/console/events/e/reports?closeFlow=1#event-close', 'e'), /closeFlow=1/);
  for (const bad of ['https://evil.test', '/console/events/other/settings', '/console/events/e/operations', '//evil.test/settings']) assert.throws(() => closeHandoffHref(bad, 'e'));
});

test('close progression protects approvals, disabled open modules and archive lock', () => {
  const ready = { stage: 'LIVE', pending: 0, registrationOpen: false, openModules: [], features: ['poll'] };
  assert.equal(closePrerequisite({ ...ready, pending: 1 }), 'pending');
  assert.equal(closePrerequisite({ ...ready, openModules: [{ name: 'p', type: 'poll' }], features: [] }), 'features');
  assert.equal(closePrerequisite({ ...ready, openModules: [{ name: 'p', type: 'poll' }] }), 'programs');
  assert.equal(closePrerequisite({ ...ready, registrationOpen: true }), 'intake');
  assert.equal(closePrerequisite(ready), 'stage');
  assert.equal(closePrerequisite({ ...ready, stage: 'ENDED', pending: 1 }), 'report');
  assert.equal(closePrerequisite({ ...ready, stage: 'ARCHIVED', pending: 1 }), 'archived');
});

test('one hub owns the complete checklist; detail is a handoff outside print', () => {
  const reports = read('events/[id]/reports/ReportsWorkspace.tsx');
  const flow = read('events/[id]/reports/EventCloseFlow.tsx');
  assert.equal((reports.match(/<EventCloseFlow /g) || []).length, 1);
  assert.match(flow, /<details/);
  assert.doesNotMatch(flow, /<details[^>]*\bopen[= >]/);
  assert.match(flow, /다음 할 일/);
  assert.match(reports, /state\.reports\.find\(\(item\) => item\.id === closeReportId\)/);
  assert.doesNotMatch(reports, /setCloseReportId\(state\.reports\[0\]/);
  assert.match(flow, /초안도 집계가 고정됩니다/);
  assert.match(flow, /보관 후에는 메시지 작성·발송도 잠깁니다/);
  assert.match(flow, /발송 완료를 자동으로 판단하지 않습니다/);
  assert.doesNotMatch(flow, /fetch\(|report\.publish|event\.stage|message\.create/);
  assert.match(reports, /data-report-close-return/);
  assert.match(reports, /participantChangesLocked=\{\["ENDED", "ARCHIVED"\]\.includes\(state\.stage\)\}/);
  assert.match(reports, /종료 이후에는 참가자 승인 상태를 변경할 수 없습니다/);
  assert.ok(reports.indexOf('archiveCheck') > reports.indexOf('</article>'));
});

test('shared return handles five existing destinations and keeps draft guards', () => {
  const page = read('console-ui/ConsolePage.tsx');
  const back = read('console-ui/EventCloseReturn.tsx');
  assert.match(page, /\["settings", "participants", "programs", "draws", "messages"\]/);
  assert.match(page, /<Suspense fallback=\{null\}/);
  assert.match(back, /readCloseReturn/);
  assert.match(back, /prefetch=\{false\} data-close-back/);
  assert.match(back, /onNavigate=\{\(\) => window\.dispatchEvent\(new Event\("eventouch:shell-reload"\)\)\}/, 'a committed task return refreshes shell stage and queue badges too');
  assert.doesNotMatch(back, /router\.back|history\.back|location\.href\s*=/);
  assert.match(read('events/[id]/settings/SettingsWorkspace.tsx'), /useConsoleDraftGuard/);
});

test('linear close skips fulfilled steps and never forces an optional map return', () => {
  const snapshot = { stage: 'LIVE', pending: 0, registrationOpen: true, openModules: [{ name: 'p', type: 'poll' }], features: ['poll'], reports: [] };
  const progress = (page, patch = {}, intent = null, hash = '') => linearCloseProgress('e', page, { ...snapshot, ...patch }, null, intent, hash);
  assert.match(progress('participants').next.href, /\/programs\?/);
  assert.match(progress('participants', { openModules: [] }).next.href, /closeStep=intake/);
  assert.match(progress('participants', { openModules: [], registrationOpen: false }).next.href, /closeStep=end/);
  assert.match(progress('programs', { registrationOpen: false }).next.href, /closeStep=end/);
  const intakeDone = progress('settings', { openModules: [], registrationOpen: false }, 'intake', '#settings-intake');
  assert.equal(intakeDone.position, 3);
  assert.equal(intakeDone.next.href, '#settings-stage');
  assert.equal(intakeDone.next.localStage, true);
  const ended = progress('settings', { stage: 'ENDED', openModules: [], registrationOpen: false }, 'intake', '#settings-stage');
  assert.equal(ended.position, 4);
  assert.match(ended.next.href, /\/reports\?closeFlow=1/);
  const archive = progress('settings', { stage: 'ARCHIVED', openModules: [], registrationOpen: false }, 'archive', '#settings-stage');
  assert.equal(archive.position, 7);
  assert.equal(archive.next, null);
});

test('linear next warns about unfinished prerequisites without adding a new business gate', () => {
  const snapshot = { stage: 'LIVE', pending: 2, registrationOpen: true, openModules: [{ name: 'p', type: 'poll' }], features: ['poll'], reports: [] };
  const program = linearCloseProgress('e', 'programs', snapshot, null, null, '');
  assert.match(program.warnings.join(' '), /승인 대기 2명/);
  assert.match(program.next.href, /closeStep=intake/);
  const message = linearCloseProgress('e', 'messages', snapshot, null, null, '');
  assert.match(message.next.href, /closeStep=archive/);
  assert.ok(message.warnings.some(w => w.includes('동결 미확인')));
  assert.ok(message.warnings.some(w => w.includes('행사 종료 미확인')));
  const scheduled = linearCloseProgress('e', 'messages', snapshot, null, null, '', 'SCHEDULED');
  assert.match(scheduled.detail, /자동 발송되지 않습니다/);
});

test('linear snapshots come from the page bootstrap, with no polling or success inference', () => {
  const snapshot = readCloseSnapshot({ stage: 'live', features: ['poll'] }, { participants: [{ status: 'PENDING' }, { status: 'CANCELLED' }], modules: [{ title: 'p', type: 'poll', status: 'OPEN' }], reports: [{ id: 'r', status: 'DRAFT' }], registrationOpen: true });
  assert.equal(snapshot.stage, 'LIVE');
  assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.openModules.length, 1);
  assert.equal(snapshot.reports[0].status, 'DRAFT');
  for (const [dir, file] of [['participants','ParticipantList'],['programs','ProgramsWorkspace'],['settings','SettingsWorkspace'],['messages','MessagingWorkspace'],['draws','DrawsWorkspace']]) {
    const source = read(`events/[id]/${dir}/${file}.tsx`);
    assert.match(source, /closeSnapshot: readCloseSnapshot\(event, workspace\)/);
    assert.match(source, /closeSnapshot=\{state\.closeSnapshot\}/);
  }
  const back = read('console-ui/EventCloseReturn.tsx');
  assert.match(back, /data-close-linear-next/);
  assert.doesNotMatch(back, /fetch\(|setInterval\(/);
});

test('inline close archive reuses the exact stage confirmation, permissions and safe receipt path', () => {
  const message = read('events/[id]/messages/MessagingWorkspace.tsx');
  const settings = read('events/[id]/settings/SettingsWorkspace.tsx');
  const confirmation = read('console-ui/StageTransitionConfirmation.tsx');
  assert.match(message, /state\.canManage && state\.stage === "ENDED" && !state\.closeSnapshot\.registrationOpen && state\.closeSnapshot\.openModules\.length === 0/);
  assert.match(message, /postCommand\("event\.stage", \{ stage: "ARCHIVED" \}, id\)/);
  assert.match(message, /archiveCommandRef\.current \?\? commandId\(\)/);
  assert.match(message, /event\.id !== eventId \|\| text\(event\.stage\)\.toUpperCase\(\) !== "ARCHIVED"/);
  assert.match(message, /confirmLeaveForArchive\(\)/);
  assert.match(message, /useConsoleDraftGuard\(archiveUnresolved/);
  assert.match(message, /UNCONFIRMED_WRITE_CLOSE_MESSAGE/);
  assert.match(message, /text\(event\.stage\)\.toUpperCase\(\) === "ARCHIVED" && archiveCommandRef\.current/);
  assert.match(message, /서버 재조회에서 보관된 행사임을 확인했습니다/);
  assert.match(message, /<StageTransitionConfirmation label="보관"/);
  assert.match(settings, /<StageTransitionConfirmation/);
  assert.match(confirmation, /aria-label="단계 전환 확인"/);
  assert.match(confirmation, /정말 전환합니다/);
  assert.match(confirmation, /같은 요청 다시 시도/);
  assert.match(confirmation, /취소/);
  assert.match(confirmation, /event\.repeat && \(event\.key === "Enter" \|\| event\.key === " "\)/, 'held activation keys cannot confirm the newly opened irreversible transition');
});
