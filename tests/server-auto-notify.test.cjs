'use strict';
// 자동 안내(2026-11-24 결정): 기본 꺼짐, 규칙별 옵트인, 켜기 전 확정자에게 소급 발송 금지, 한 번만 안내,
// 리마인드는 예정 시각 뒤 30분 안에서만 만든다. 이 모듈은 발송하지 않고 기존 AUTO 예약 경로가 맡는다.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { materializeForEvent, materializeAutoNotices, eligibleRecipient } = require('../server/auto-notify');
const { anchorInstant } = require('../server/message-schedule-anchor');
const { emptyWorkspace } = require('../server/state');
const { enqueueDueScheduled, runMessageMaintenance } = require('../server/message-maintenance');
const { databaseUrl, startApiHarness, insertAccount, insertEvent, insertMembership, sessionCookie, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const dbTest = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL database' }, fn);

const person = (id, status = 'APPROVED', phone = '01012345678') => ({ id, name: `합성 ${id}`, phone, status, group: '일반' });

nodeTest('only confirmed people with a phone are eligible', () => {
  assert.equal(eligibleRecipient(person('a')), true);
  assert.equal(eligibleRecipient(person('a', 'PENDING')), false);
  assert.equal(eligibleRecipient(person('a', 'CANCELLED')), false);
  assert.equal(eligibleRecipient(person('a', 'APPROVED', '')), false);
  assert.equal(eligibleRecipient(null), false);
});

nodeTest('nothing is created while rules are off or missing', () => {
  const workspace = { ...emptyWorkspace(), participants: [person('a')] };
  const event = { id: 'e', date: '2030-11-13', stage: 'READY' };
  const made = materializeForEvent(workspace, event, { now: '2030-11-12T09:00:00.000Z' });
  assert.deepEqual(made.created, []); assert.equal(made.changed, false);
  workspace.autoNotify = { rules: { confirmed: { enabled: false, body: '안내' }, reminder: { enabled: false, body: '안내', days: 1, time: '18:00' } }, notified: { confirmed: [] }, reminderSlots: [] };
  assert.deepEqual(materializeForEvent(workspace, event, { now: '2030-11-12T09:00:00.000Z' }).created, []);
  assert.equal(workspace.messages.length, 0);
});

nodeTest('confirmed rule notifies each newly confirmed person once as an AUTO reservation', () => {
  const workspace = { ...emptyWorkspace(), participants: [person('old'), person('new'), person('wait', 'PENDING')] };
  workspace.autoNotify = { rules: { confirmed: { enabled: true, body: '{{이름}}님 참가가 확정되었습니다.', enabledAt: '2030-11-01T00:00:00.000Z' } },
    notified: { confirmed: ['old'] }, reminderSlots: [] };
  const event = { id: 'e', date: '2030-11-13', stage: 'READY' };
  const now = '2030-11-02T03:00:00.000Z';
  const made = materializeForEvent(workspace, event, { now });
  assert.equal(made.created.length, 1); assert.equal(made.created[0].recipients, 1);
  const message = workspace.messages[0];
  assert.deepEqual(message.recipientIds, ['new']);
  assert.equal(message.status, 'SCHEDULED'); assert.equal(message.scheduleMode, 'AUTO'); assert.equal(message.autoScheduleIntent, 'confirmed-v1');
  assert.equal(message.simulate, false); assert.equal(message.channel, 'SMS'); assert.equal(message.scheduled, now);
  assert.equal(message.deliveries[0].status, 'WAITING');
  assert.deepEqual(workspace.autoNotify.notified.confirmed, ['old', 'new']);
  assert.equal(workspace.audit[0].type, 'autoNotify.create'); assert.equal(workspace.audit[0].actor, 'maintenance');
  const again = materializeForEvent(workspace, event, { now: '2030-11-02T03:01:00.000Z' });
  assert.deepEqual(again.created, []); assert.equal(again.changed, false); assert.equal(workspace.messages.length, 1);
});

nodeTest('reminder rule fires once, only inside the 30 minutes after its slot, and not for a slot passed before it was enabled', () => {
  const event = { id: 'e', date: '2030-11-13', stage: 'READY' };
  const slot = anchorInstant('2030-11-13', { kind: 'EVENT_DATE', days: 1, time: '18:00' });
  const make = (enabledAt) => {
    const workspace = { ...emptyWorkspace(), participants: [person('a'), person('b'), person('c', 'CANCELLED')] };
    workspace.autoNotify = { rules: { reminder: { enabled: true, body: '내일 뵙겠습니다', days: 1, time: '18:00', enabledAt } }, notified: { confirmed: [] }, reminderSlots: [] };
    return workspace;
  };
  const at = (ms) => new Date(Date.parse(slot) + ms).toISOString();
  const early = make('2030-11-01T00:00:00.000Z');
  assert.deepEqual(materializeForEvent(early, event, { now: at(-1000) }).created, []);
  const fired = materializeForEvent(early, event, { now: at(60 * 1000) });
  assert.equal(fired.created.length, 1); assert.deepEqual(early.messages[0].recipientIds, ['a', 'b']); assert.equal(early.messages[0].autoNotice.slot, slot);
  assert.deepEqual(materializeForEvent(early, event, { now: at(120 * 1000) }).created, [], 'one slot never fires twice');
  assert.deepEqual(materializeForEvent(make('2030-11-01T00:00:00.000Z'), event, { now: at(31 * 60 * 1000) }).created, [], 'no late catch-up');
  assert.deepEqual(materializeForEvent(make(at(5 * 60 * 1000)), event, { now: at(10 * 60 * 1000) }).created, [], 'a slot passed before enabling is skipped');
  const moved = { id: 'e', date: '2030-11-20', stage: 'READY' };
  const nextSlot = anchorInstant('2030-11-20', { kind: 'EVENT_DATE', days: 1, time: '18:00' });
  assert.equal(materializeForEvent(early, moved, { now: new Date(Date.parse(nextSlot) + 1000).toISOString() }).created.length, 1, 'a moved event date is a new slot');
});

nodeTest('a failing guard turns the rule off with a reason instead of creating a campaign', () => {
  const workspace = { ...emptyWorkspace(), participants: [person('a')] };
  workspace.autoNotify = { rules: { confirmed: { enabled: true, body: '{{티켓링크}}', enabledAt: '2030-11-01T00:00:00.000Z' } }, notified: { confirmed: [] }, reminderSlots: [] };
  const made = materializeForEvent(workspace, { id: 'e', date: '2030-11-13', stage: 'READY' }, { now: '2030-11-02T03:00:00.000Z' });
  assert.deepEqual(made.created, []);
  assert.equal(made.issues.length, 1);
  assert.equal(workspace.autoNotify.rules.confirmed.enabled, false);
  assert.ok(workspace.autoNotify.rules.confirmed.issue.reason);
  assert.equal(workspace.messages.length, 0);
});

nodeTest('archived events never create automatic notices', () => {
  const workspace = { ...emptyWorkspace(), participants: [person('a')] };
  workspace.autoNotify = { rules: { confirmed: { enabled: true, body: '안내', enabledAt: '2030-11-01T00:00:00.000Z' } }, notified: { confirmed: [] }, reminderSlots: [] };
  assert.deepEqual(materializeForEvent(workspace, { id: 'e', date: '2030-11-13', stage: 'ARCHIVED' }, { now: '2030-11-02T03:00:00.000Z' }).created, []);
});

dbTest('saving a rule baselines current confirmations; the maintenance pass creates and queues exactly one send', async () => {
  const h = await startApiHarness();
  try {
    const eventId = `auto-${crypto.randomUUID()}`, manager = `manager-${crypto.randomUUID()}`;
    const workspace = emptyWorkspace();
    workspace.participants = [person('old')];
    await insertAccount(h.database, { id: manager, role: 'MANAGER', name: '합성 운영자', email: `${manager}@example.test`, orgId: LEGACY_ORG });
    await insertEvent(h.database, { id: eventId, slug: eventId, orgId: LEGACY_ORG, payload: { id: eventId, slug: eventId, name: '합성 행사', date: '2030-11-13', stage: 'READY', features: [] }, workspace });
    await insertMembership(h.database, manager, eventId, ['all']);
    const cookie = await sessionCookie(h, manager);
    const send = (command, payload) => requestJson(h.baseUrl, `/api/events/${eventId}/commands`, { method: 'POST', cookie, body: { commandId: crypto.randomUUID(), command, payload } });
    const read = async () => (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;

    assert.equal((await send('autoNotify.save', { rule: 'confirmed', enabled: true, body: '' })).status, 400);
    assert.equal((await send('autoNotify.save', { rule: 'confirmed', enabled: true, body: '{{없는변수}}' })).status, 400);
    assert.equal((await send('autoNotify.save', { rule: 'other', enabled: true, body: '안내' })).status, 400);
    assert.equal((await send('autoNotify.save', { rule: 'reminder', enabled: true, body: '안내', days: 40, time: '18:00' })).status, 400);
    const saved = await send('autoNotify.save', { rule: 'confirmed', enabled: true, body: '{{이름}}님 참가가 확정되었습니다.' });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    let state = await read();
    assert.deepEqual(state.autoNotify.notified.confirmed, ['old'], 'people confirmed before enabling are never messaged');
    assert.equal(state.messages.length, 0);

    const none = await materializeAutoNotices(h.database, { now: new Date().toISOString() });
    assert.equal(none.created, 0);

    state.participants.push(person('fresh'));
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(state)]);
    const now = new Date().toISOString();
    const first = await materializeAutoNotices(h.database, { now });
    assert.equal(first.created, 1);
    const second = await materializeAutoNotices(h.database, { now });
    assert.equal(second.created, 0, 'the same person is never announced twice');
    state = await read();
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].status, 'SCHEDULED');
    assert.deepEqual(state.messages[0].recipientIds, ['fresh']);

    const queued = await enqueueDueScheduled(h.database, { now: new Date().toISOString(), eventIds: [eventId] });
    assert.equal(queued.enqueued, 1, JSON.stringify(queued));
    state = await read();
    assert.equal(state.messages[0].status, 'SENDING');
    const outbox = await h.database.query('SELECT count(*)::int AS n FROM message_outbox WHERE event_id=$1', [eventId]).catch(() => null);
    if (outbox) assert.equal(outbox.rows[0].n, 1);

    const off = await send('autoNotify.save', { rule: 'confirmed', enabled: false });
    assert.equal(off.status, 200);
    assert.equal((await read()).autoNotify.rules.confirmed.enabled, false);

    // 배포 옵트인이 없으면 유지보수 루프는 아무것도 만들지 않는다.
    const provider = { state: { connected: true, provider: 'solapi' } };
    state = await read(); state.participants.push(person('later')); state.autoNotify.rules.confirmed.enabled = true;
    await h.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [eventId, JSON.stringify(state)]);
    const idle = await runMessageMaintenance(h.database, provider, { enabled: true, autoSendDue: false });
    assert.equal(idle.autoNotices, null);
    assert.equal((await read()).messages.length, 1);
  } finally { await h.close(); }
});

nodeTest('automatic notices are wired as an opt-in maintenance step and a messages tab', () => {
  const fs = require('node:fs');
  const maintenance = fs.readFileSync('server/message-maintenance.js', 'utf8');
  const guarded = maintenance.slice(maintenance.indexOf('if (autoSendDue) {'), maintenance.indexOf('} else {', maintenance.indexOf('if (autoSendDue) {')));
  assert.match(guarded, /materializeAutoNotices\(/u, 'rule-driven campaigns exist only when the deployment opted into automatic sends');
  assert.doesNotMatch(maintenance.slice(maintenance.indexOf('} else {')), /materializeAutoNotices\(/u);
  assert.match(fs.readFileSync('server/event-permissions.js', 'utf8'), /'autoNotify\.save': 'messages'/u);
  assert.match(fs.readFileSync('apps/web/lib/event-capabilities.ts', 'utf8'), /"autoNotify\.save": "messages"/u);
  const messages = fs.readFileSync('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx', 'utf8');
  assert.match(messages, /id: "auto-notify-heading", label: "자동 안내"/u);
  assert.match(messages, /active=\{state\.integrations\.connected && state\.messageSchedule\?\.autoConfigured === true\}/u);
  const panel = fs.readFileSync('apps/web/app/console/events/[id]/messages/AutoNotifyPanel.tsx', 'utf8');
  assert.match(panel, /command: "autoNotify\.save"/u);
  assert.match(panel, /turningOn \? setConfirming\(true\)/u, 'turning a rule on always passes through a confirmation');
  assert.match(panel, /켜 두면|켠 뒤에 확정되는 사람/u);
});
