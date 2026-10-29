'use strict';

// Hanwool attendee-experience capability layer: voting config + tally,
// inventory-driven roulette, preassigned lucky numbers, eligible stage draws,
// and STAFF OUT-scan prize lookup. API + database behavioral tests through
// the single transactional command path (idempotency, receipt replay, audit,
// reload persistence) plus the denied/recovery paths.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  insertAssignment,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { buildMessageDispatch } = require('../server/commands/content-results.js');
const { drainMessageOutbox } = require('../server/message-outbox.js');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const accounts = {
  agency: `hanwool-agency-${suffix}`,
  manager: `hanwool-manager-${suffix}`,
  staff: `hanwool-staff-${suffix}`,
};
let harness;
let cookies = {};
let fixtureNumber = 0;

function commandId() {
  return `hanwool-${crypto.randomUUID()}`;
}

function ticketFor(eventId) {
  return `ET:${eventId}:T-${crypto.randomBytes(32).toString('base64url')}`;
}

function person(eventId, name, overrides = {}) {
  return {
    id: `person-${crypto.randomUUID()}`,
    name,
    phone: `010${String(crypto.randomInt(10000000, 99999999))}`,
    email: '',
    company: '한울',
    group: '일반',
    status: 'APPROVED',
    inside: false,
    everIn: true,
    revoked: false,
    ticket: ticketFor(eventId),
    ticketExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    registrationType: 'PRE',
    paymentStatus: 'FREE',
    answers: {},
    consent: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function workspaceDefaults(overrides = {}) {
  return {
    participants: [],
    fields: [
      { id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true },
      { id: 'company', label: '소속', type: 'text', required: false },
    ],
    publishedFields: [],
    formVersion: 1,
    publishedVersion: 0,
    registrationOpen: false,
    approvalRequired: false,
    consentText: '검증용 행사 안내',
    consentVersion: 1,
    notices: [],
    program: [],
    venue: { name: '', address: '', directions: '', contact: '', description: '' },
    groups: ['일반', 'VIP'],
    desks: [],
    booths: [],
    assignments: [],
    checks: [],
    visits: [],
    modules: [],
    responses: [],
    questions: [],
    photos: [],
    posts: [],
    messages: [],
    reports: [],
    payments: [],
    rewards: [],
    audit: [],
    display: { type: 'idle', moduleId: null },
    branding: { tagline: '행사 안내', logo: null, keyvisual: null },
    stampMode: 'STAFF',
    allowReentry: true,
    price: 0,
    luckyNumbers: [],
    rouletteResults: [],
    teams: [],
    votes: [],
    voteConfig: null,
    rouletteConfig: null,
    luckyConfig: null,
    drawPrograms: [],
    ...overrides,
  };
}

async function createFixture({
  stage = 'LIVE',
  features = ['draw', 'poll', 'reward'],
  participants = [],
  workspace = {},
} = {}) {
  fixtureNumber += 1;
  const id = `hanwool-${fixtureNumber}-${suffix}`;
  const slug = `hanwool-${fixtureNumber}-${suffix}`;
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id,
    slug,
    payload: {
      id,
      slug,
      name: '한울 검증 행사',
      clientId: null,
      date: '2026-12-01',
      start: '09:00',
      end: '17:00',
      capacity: 100,
      stage,
      features,
    },
    workspace: workspaceDefaults({ ...workspace, participants }),
  });
  await insertMembership(harness.database, accounts.manager, id, ['all']);
  return { id, slug };
}

async function readWorkspace(eventId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [eventId]
  );
  return result.rows[0].payload;
}

function operator(event, command, payload, { actor = 'manager', id = commandId() } = {}) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    cookie: cookies[actor],
    body: { commandId: id, command, payload },
  });
}

function staffCall(event, command, payload, assignmentId, id = commandId()) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    cookie: cookies.staff,
    body: { commandId: id, command, assignmentId, payload },
  });
}

function attendee(event, ticket, command, payload, id = commandId()) {
  return requestJson(harness.baseUrl, `/api/events/${event.id}/commands`, {
    method: 'POST',
    bearer: ticket,
    body: { commandId: id, command, payload },
  });
}

async function seedDesk(event, { name = '데스크', action = 'IN' } = {}) {
  const saved = await operator(event, 'desk.save', { name, action, mode: 'desk', open: true });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  await insertAssignment(harness.database, {
    id: assignmentId,
    accountId: accounts.staff,
    eventId: event.id,
    type: 'DESK',
    targetId: saved.json.desk.id,
  });
  return { desk: saved.json.desk, assignmentId };
}

async function seedTeams(event, names) {
  const teams = [];
  for (let index = 0; index < names.length; index += 1) {
    const saved = await operator(event, 'team.save', { name: names[index], order: index + 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    teams.push(saved.json.team);
  }
  return teams;
}

async function seedDrawModule(event) {
  const saved = await operator(event, 'module.save', {
    type: 'draw', title: '무대 추첨', options: '',
  });
  assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.json));
  const opened = await operator(event, 'module.status', { id: saved.json.module.id, status: 'OPEN' });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  return opened.json.module;
}

// The public origin is process-wide environment shared with the in-process
// API harness: tests that need it set their own value and restore ambient
// afterwards, never relying on ambient configuration.
const ambientPublicUrl = process.env.EVENTOUCH_PUBLIC_URL;

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role, name] of [
    ['agency', 'AGENCY', '운영사 관리자'],
    ['manager', 'MANAGER', '행사 매니저'],
    ['staff', 'STAFF', '현장 스태프'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
      id: accounts[key],
      role,
      name,
      email: `${accounts[key]}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, accounts[key]);
  }
});

after(async () => {
  if (ambientPublicUrl === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
  else process.env.EVENTOUCH_PUBLIC_URL = ambientPublicUrl;
  if (harness) await harness.close();
});

// ---------------------------------------------------------------------------
// 1) Voting
// ---------------------------------------------------------------------------

test('vote-config-enforces-exact-count-open-close-and-immutable-ballots', async () => {
  const people = [person('p', '투표자1'), person('p', '투표자2')];
  const event = await createFixture({ participants: [] });
  // Re-issue tickets bound to the real event id.
  for (const p of people) p.ticket = ticketFor(event.id);
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const teams = await seedTeams(event, ['팀가', '팀나', '팀다', '팀라', '팀마', '팀바']);

  const config = await operator(event, 'vote.config.save', { pickCount: 5 });
  assert.equal(config.status, 200, JSON.stringify(config.json));
  assert.equal(config.json.voteConfig.pickCount, 5);
  assert.equal(config.json.voteConfig.status, 'CLOSED');

  // Closed gate refuses before any ballot exists.
  const closed = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: teams.slice(0, 5).map((team) => ({ teamId: team.id })),
  });
  assert.equal(closed.status, 409);

  const opened = await operator(event, 'vote.config.save', { status: 'OPEN' });
  assert.equal(opened.status, 200);

  const short = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: teams.slice(0, 4).map((team) => ({ teamId: team.id })),
  });
  assert.equal(short.status, 400);
  assert.match(String(short.json.error), /5팀/);

  const dup = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: [teams[0], teams[0], teams[1], teams[2], teams[3]].map((team) => ({ teamId: team.id })),
  });
  assert.equal(dup.status, 400);

  const unknown = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: [{ teamId: 'no-such-team' }, ...teams.slice(0, 4).map((team) => ({ teamId: team.id }))],
  });
  assert.equal(unknown.status, 404);

  const ballotId = commandId();
  const first = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: teams.slice(0, 5).map((team) => ({ teamId: team.id })),
  }, ballotId);
  assert.equal(first.status, 201, JSON.stringify(first.json));

  // Lost-response retry replays the same receipt instead of a second ballot.
  const replay = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: teams.slice(1, 6).map((team) => ({ teamId: team.id })),
  }, ballotId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.vote.picks, first.json.vote.picks);

  // Final submissions are immutable.
  const second = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: teams.slice(1, 6).map((team) => ({ teamId: team.id })),
  });
  assert.equal(second.status, 409);

  // Other voter still votes exactly 5.
  const other = await attendee(event, people[1].ticket, 'vote.ranked', {
    picks: teams.slice(1, 6).map((team) => ({ teamId: team.id })),
  });
  assert.equal(other.status, 201, JSON.stringify(other.json));

  const stored = await readWorkspace(event.id);
  assert.equal(stored.votes.length, 2);
});

test('vote-legacy-workspaces-keep-up-to-five-and-tally-marks-ties', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'A'), person(event.id, 'B'), person(event.id, 'C'), person(event.id, 'D')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const teams = await seedTeams(event, ['가', '나', '다', '라']);

  // No voteConfig: legacy rule (1..5) still applies.
  const legacy = await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: [{ teamId: teams[0].id }, { teamId: teams[1].id }],
  });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.json));

  // A:가나 / B:다라 / C:가다 / D:나다 → 가2 나2 다3 라1.
  // Top: 다(rank1), 가·나 tied rank2, 라 rank4.
  const bVote = await attendee(event, people[1].ticket, 'vote.ranked', {
    picks: [{ teamId: teams[2].id }, { teamId: teams[3].id }],
  });
  assert.equal(bVote.status, 201);
  const cVote = await attendee(event, people[2].ticket, 'vote.ranked', {
    picks: [{ teamId: teams[0].id }, { teamId: teams[2].id }],
  });
  assert.equal(cVote.status, 201);
  const dVote = await attendee(event, people[3].ticket, 'vote.ranked', {
    picks: [{ teamId: teams[1].id }, { teamId: teams[2].id }],
  });
  assert.equal(dVote.status, 201);
  // Totals: 가2 나2 다3 라1 → top: 다(rank1), 가·나 tied rank2, 라 rank4.
  const tally = await operator(event, 'vote.tally', {});
  assert.equal(tally.status, 200, JSON.stringify(tally.json));
  assert.equal(tally.json.totalVotes, 4);
  const byTeam = Object.fromEntries(tally.json.results.map((row) => [row.name, row]));
  assert.equal(byTeam['다'].rank, 1);
  assert.equal(byTeam['다'].tied, false);
  assert.equal(byTeam['가'].rank, 2);
  assert.equal(byTeam['나'].rank, 2);
  assert.equal(byTeam['가'].tied, true);
  assert.equal(byTeam['나'].tied, true);
  assert.equal(byTeam['라'].rank, 4);
  // Top-3 includes the tied pair, never silently drops one side of a tie.
  assert.ok(tally.json.top3.length >= 3);
  assert.ok(tally.json.top3.some((row) => row.name === '가'));
  assert.ok(tally.json.top3.some((row) => row.name === '나'));
});

test('vote-counts-stay-hidden-until-published-but-own-ballot-visible', async () => {
  const event = await createFixture({});
  const people = [person(event.id, '유권자')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const teams = await seedTeams(event, ['T1', 'T2', 'T3']);
  assert.equal((await operator(event, 'vote.config.save', { pickCount: 2, status: 'OPEN' })).status, 200);
  assert.equal((await attendee(event, people[0].ticket, 'vote.ranked', {
    picks: [{ teamId: teams[0].id }, { teamId: teams[1].id }],
  })).status, 201);

  const hidden = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.json));
  assert.deepEqual(hidden.json.workspace.voteCounts, {});
  assert.equal(hidden.json.workspace.voteSubmitted, true);
  assert.ok(Array.isArray(hidden.json.workspace.ownVote.picks));

  assert.equal((await operator(event, 'vote.config.save', { resultsPublished: true })).status, 200);
  const shown = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(shown.status, 200);
  assert.equal(shown.json.workspace.voteCounts[teams[0].id].count, 1);
});

// ---------------------------------------------------------------------------
// 2) Roulette
// ---------------------------------------------------------------------------

test('roulette-refuses-without-setup-and-replays-persisted-result-after-close', async () => {
  const event = await createFixture({});
  const people = [person(event.id, '룰렛1'), person(event.id, '룰렛2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  const naked = await attendee(event, people[0].ticket, 'roulette.spin', {});
  assert.equal(naked.status, 409);
  assert.match(String(naked.json.error), /특정 시간에 운영됩니다/);

  const draft = await operator(event, 'roulette.config.save', {
    prizes: [{ label: '한울타리 이용권', quantity: 2 }, { label: '참가상', quantity: null, weight: 1 }],
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.equal(draft.json.rouletteConfig.status, 'DRAFT');
  assert.equal((await attendee(event, people[0].ticket, 'roulette.spin', {})).status, 409);

  assert.equal((await operator(event, 'roulette.config.save', { status: 'OPEN' })).status, 200);
  const spinId = commandId();
  const first = await attendee(event, people[0].ticket, 'roulette.spin', {}, spinId);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.ok(first.json.roulette.label);
  assert.ok(first.json.roulette.rewardId);

  // Reward entitlement persisted for the participant.
  const stored = await readWorkspace(event.id);
  const entitlement = stored.rewards.find((item) => item.id === first.json.roulette.rewardId);
  assert.ok(entitlement);
  assert.equal(entitlement.participantId, people[0].id);
  assert.equal(entitlement.status, 'READY');

  // Retry with the same command id replays; a fresh id returns the persisted result.
  const replay = await attendee(event, people[0].ticket, 'roulette.spin', {}, spinId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.roulette, first.json.roulette);
  const again = await attendee(event, people[0].ticket, 'roulette.spin', {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.roulette, first.json.roulette);
  assert.equal((await readWorkspace(event.id)).rouletteResults.length, 1);

  // Closing stops new spins but keeps the visible result retryable.
  assert.equal((await operator(event, 'roulette.config.save', { status: 'CLOSED' })).status, 200);
  const afterClose = await attendee(event, people[0].ticket, 'roulette.spin', {});
  assert.equal(afterClose.status, 200);
  assert.deepEqual(afterClose.json.roulette, first.json.roulette);
  assert.equal((await attendee(event, people[1].ticket, 'roulette.spin', {})).status, 409);
});

test('roulette-derives-probability-from-remaining-inventory-without-oversell', async () => {
  const event = await createFixture({});
  const people = [
    person(event.id, 'R1'), person(event.id, 'R2'), person(event.id, 'R3'),
  ];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  assert.equal((await operator(event, 'roulette.config.save', {
    status: 'OPEN',
    prizes: [{ label: '한정1', quantity: 1 }, { label: '참가상', quantity: null, weight: 1 }],
  })).status, 200);

  // Concurrent spins for distinct people: row lock serializes, the single
  // limited prize is never oversold (at most one win), the rest fall to the
  // explicitly weighted consolation.
  const spins = await Promise.all(people.map((p) =>
    attendee(event, p.ticket, 'roulette.spin', {}, commandId())
  ));
  for (const spin of spins) assert.equal(spin.status, 200, JSON.stringify(spin.json));
  const stored = await readWorkspace(event.id);
  assert.equal(stored.rouletteResults.length, 3);
  assert.ok(stored.rouletteResults.filter((item) => item.label === '한정1').length <= 1);
  assert.equal(stored.rewards.length, 3);
  assert.equal(new Set(stored.rewards.map((item) => item.participantId)).size, 3);
});

test('roulette-limited-only-inventory-sells-out-clearly', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'S1'), person(event.id, 'S2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  assert.equal((await operator(event, 'roulette.config.save', {
    status: 'OPEN',
    prizes: [{ label: '한정1', quantity: 1 }],
  })).status, 200);
  assert.equal((await attendee(event, people[0].ticket, 'roulette.spin', {})).status, 200);
  const soldOut = await attendee(event, people[1].ticket, 'roulette.spin', {});
  assert.equal(soldOut.status, 409);
  assert.match(String(soldOut.json.error), /소진/);

  // Limited-only concurrency: exactly one winner, no oversell.
  const event2 = await createFixture({});
  const trio = [person(event2.id, 'C1'), person(event2.id, 'C2'), person(event2.id, 'C3')];
  const ws2 = await readWorkspace(event2.id);
  ws2.participants = trio;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event2.id, JSON.stringify(ws2)]);
  assert.equal((await operator(event2, 'roulette.config.save', {
    status: 'OPEN',
    prizes: [{ label: '한정1', quantity: 1 }],
  })).status, 200);
  const race = await Promise.all(trio.map((p) => attendee(event2, p.ticket, 'roulette.spin', {}, commandId())));
  assert.equal(race.filter((spin) => spin.status === 200).length, 1);
  assert.ok(race.filter((spin) => spin.status === 409).every((spin) => /소진/.test(String(spin.json.error))));
  const stored2 = await readWorkspace(event2.id);
  assert.equal(stored2.rouletteResults.length, 1);
  assert.equal(stored2.rewards.length, 1);
});

// ---------------------------------------------------------------------------
// 3) Lucky numbers
// ---------------------------------------------------------------------------

test('lucky-preassign-is-atomic-and-invitation-send-refuses-empty-numbers', async () => {
  const event = await createFixture({});
  const people = [
    person(event.id, 'L1'), person(event.id, 'L2'), person(event.id, 'L3'), person(event.id, 'L4'),
  ];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  assert.equal((await operator(event, 'lucky.config.save', { min: 1, max: 3 })).status, 200);

  // Pool too small: whole batch fails, nobody gets a number.
  const short = await operator(event, 'lucky.preassign', { participantIds: people.map((p) => p.id) });
  assert.equal(short.status, 409);
  assert.match(String(short.json.error), /부족/);
  assert.deepEqual((await readWorkspace(event.id)).luckyNumbers, []);

  const batch = await operator(event, 'lucky.preassign', {
    participantIds: people.slice(0, 3).map((p) => p.id),
  });
  assert.equal(batch.status, 200, JSON.stringify(batch.json));
  assert.equal(batch.json.assigned.length, 3);
  const numbers = batch.json.assigned.map((item) => item.number);
  assert.equal(new Set(numbers).size, 3);
  assert.ok(numbers.every((n) => n >= 1 && n <= 3));

  // Already-numbered participants are skipped, never reassigned.
  const again = await operator(event, 'lucky.preassign', {
    participantIds: people.slice(0, 2).map((p) => p.id),
  });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual(again.json.assigned, []);
  assert.equal(again.json.skipped, 2);

  // A {{럭키번호}} campaign refuses enqueue while L4 still lacks a number.
  // The invitation also requests {{티켓링크}}, so this test pins its own
  // synthetic public origin instead of relying on ambient environment.
  process.env.EVENTOUCH_PUBLIC_URL = 'https://invites.example.test/';
  try {
  const created = await operator(event, 'message.create', {
    title: '초대',
    body: '안녕하세요 {{이름}}님, 럭키번호 {{럭키번호}} 티켓 {{티켓링크}}',
    channel: 'SMS',
    ids: people.map((p) => p.id),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.message.status, 'NEEDS_CONNECTION');
  const blocked = await operator(event, 'message.retry', { id: created.json.message.id });
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.json.error), /럭키번호/);

  // After the last number exists, the same campaign enqueues.
  assert.equal((await operator(event, 'lucky.config.save', { min: 1, max: 4 })).status, 200);
  assert.equal((await operator(event, 'lucky.preassign', { participantIds: [people[3].id] })).status, 200);
  const retried = await operator(event, 'message.retry', { id: created.json.message.id });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.message.status, 'NEEDS_CONNECTION');
  } finally {
    delete process.env.EVENTOUCH_PUBLIC_URL;
  }

  // Reload persistence: numbers survive a fresh read.
  const stored = await readWorkspace(event.id);
  assert.equal(stored.luckyNumbers.length, 4);
});

test('lucky-numbers-never-leak-to-other-participants', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'P1'), person(event.id, 'P2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  ws.luckyNumbers = [
    { participantId: people[0].id, number: 11, at: new Date().toISOString() },
    { participantId: people[1].id, number: 22, at: new Date().toISOString() },
  ];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(view.json.workspace.lucky.number, 11);
  assert.doesNotMatch(JSON.stringify(view.json), /"number":22/);
  assert.doesNotMatch(JSON.stringify(view.json), new RegExp(people[1].ticket));
});

// ---------------------------------------------------------------------------
// 4) Stage draws
// ---------------------------------------------------------------------------

test('person-draw-honors-groups-tiers-and-program-overlap-with-single-rewards', async () => {
  const event = await createFixture({});
  const people = [
    person(event.id, 'W1', { group: 'VIP' }),
    person(event.id, 'W2', { group: 'VIP' }),
    person(event.id, 'W3', { group: 'VIP' }),
    person(event.id, 'W4', { group: '일반' }),
  ];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  const saved = await operator(event, 'draw.program.save', {
    name: '개인 추첨', quota: 3, moduleId: module.id, status: 'OPEN',
    eligibility: 'PERSON', eligibleGroups: ['VIP'], overlap: 'PROGRAM',
    prizeTiers: [{ name: '1등', count: 1 }, { name: '2등', count: 2 }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.program.eligibility, 'PERSON');

  const tierMismatch = await operator(event, 'draw.program.save', {
    id: `other-${suffix}`, name: '불일치', quota: 3, moduleId: module.id,
    prizeTiers: [{ name: '1등', count: 1 }],
  });
  assert.equal(tierMismatch.status, 400);

  const runId = commandId();
  const run = await operator(event, 'draw.program.run', { id: saved.json.program.id }, { id: runId });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal(run.json.winners.length, 3);
  assert.ok(run.json.winners.every((w) => ['W1', 'W2', 'W3'].includes(w.name)));
  assert.ok(run.json.winners.some((w) => w.tier === '1등'));
  assert.equal(run.json.winners.filter((w) => w.tier === '2등').length, 2);

  // One fulfillable reward per individual winner, none duplicated on replay.
  const stored = await readWorkspace(event.id);
  const drawRewards = stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${saved.json.program.id}-`));
  assert.equal(drawRewards.length, 3);
  assert.ok(drawRewards.every((item) => item.status === 'READY'));
  const replay = await operator(event, 'draw.program.run', { id: saved.json.program.id }, { id: runId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.winners, run.json.winners);
  assert.equal((await readWorkspace(event.id)).rewards.length, drawRewards.length);

  // Quota met → further runs refuse instead of over-drawing.
  assert.equal((await operator(event, 'draw.program.run', { id: saved.json.program.id })).status, 409);
});

test('company-draw-selects-distinct-companies-and-waits-for-explicit-recipient', async () => {
  const event = await createFixture({});
  const people = [
    person(event.id, '갑돌', { company: '갑사' }),
    person(event.id, '갑순', { company: '갑사' }),
    person(event.id, '을돌', { company: '을사' }),
    person(event.id, '병돌', { company: '병사' }),
  ];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  const saved = await operator(event, 'draw.program.save', {
    name: '업체 추첨', quota: 2, moduleId: module.id, status: 'OPEN',
    eligibility: 'COMPANY',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  const run = await operator(event, 'draw.program.run', { id: saved.json.program.id });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal(run.json.winners.length, 2);
  const companies = run.json.winners.map((w) => w.company);
  assert.equal(new Set(companies).size, 2);
  // No invented representative: company winners carry no participant link.
  // Their public display name is the company itself, marked COMPANY.
  for (const winner of run.json.winners) {
    assert.ok(!('id' in winner));
    assert.equal(winner.name, winner.company);
    assert.equal(winner.kind, 'COMPANY');
  }

  const stored = await readWorkspace(event.id);
  const pending = stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${saved.json.program.id}-`));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((item) => item.status === 'PENDING' && !item.participantId));

  // Nobody can collect a pending company entitlement.
  const collectPending = await operator(event, 'reward.fulfill', { id: pending[0].id });
  assert.equal(collectPending.status, 409);

  // Wrong-company assignment refuses; same-company assignment readies it.
  const winnerCompany = pending[0].company;
  const outsider = people.find((p) => p.company !== winnerCompany);
  const wrongAssign = await operator(event, 'reward.assign', { id: pending[0].id, participantId: outsider.id });
  assert.equal(wrongAssign.status, 400);
  const insider = people.find((p) => p.company === winnerCompany);
  const assigned = await operator(event, 'reward.assign', { id: pending[0].id, participantId: insider.id });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
  assert.equal(assigned.json.reward.participantId, insider.id);
  assert.equal(assigned.json.reward.status, 'READY');
  // Second assignment of the same entitlement refuses.
  assert.equal((await operator(event, 'reward.assign', { id: pending[0].id, participantId: insider.id })).status, 409);
});

test('event-overlap-excludes-earlier-winners-and-publication-gates-hold', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'E1'), person(event.id, 'E2'), person(event.id, 'E3')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  const first = await operator(event, 'draw.program.save', {
    name: '1부', quota: 2, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(first.status, 200);
  const run1 = await operator(event, 'draw.program.run', { id: first.json.program.id });
  assert.equal(run1.status, 200, JSON.stringify(run1.json));

  const second = await operator(event, 'draw.program.save', {
    name: '2부', quota: 2, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(second.status, 200);
  // Default EVENT overlap: only the one remaining person is drawable.
  const run2 = await operator(event, 'draw.program.run', { id: second.json.program.id });
  assert.equal(run2.status, 409);

  // Draft (unpublished) programs never reach the attendee projection.
  const draft = await operator(event, 'draw.program.save', {
    name: '비공개', quota: 1, moduleId: module.id, status: 'DRAFT',
  });
  assert.equal(draft.status, 200);
  const ticketView = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(ticketView.status, 200);
  const ids = ticketView.json.workspace.drawPrograms.map((item) => item.id);
  assert.ok(!ids.includes(draft.json.program.id));
  // Winner identities project as safe display metadata only: name+company
  // stay for compatibility, kind/tier/drawn lucky number aid stage
  // reference, and no participant link, ticket, or contact ever crosses.
  for (const program of ticketView.json.workspace.drawPrograms) {
    for (const winner of program.winners) {
      assert.ok(typeof winner.name === 'string' && typeof winner.company === 'string');
      assert.ok(!('id' in winner) && !('ticket' in winner) && !('phone' in winner) && !('participantId' in winner));
    }
  }
});

// ---------------------------------------------------------------------------
// 5) STAFF OUT scan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6) Public capability views, creation defaults, enqueue coverage
// ---------------------------------------------------------------------------

test('ticket-projection-exposes-safe-vote-and-roulette-views-behind-feature-gates', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'V1'), person(event.id, 'V2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const teams = await seedTeams(event, ['가', '나', '가나']);

  // Legacy row (no stored config): views are null, legacy behavior preserved.
  const legacyView = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(legacyView.status, 200);
  assert.equal(legacyView.json.workspace.voteConfig, null);
  assert.equal(legacyView.json.workspace.rouletteView, null);

  assert.equal((await operator(event, 'vote.config.save', { pickCount: 3, status: 'OPEN' })).status, 200);
  assert.equal((await operator(event, 'roulette.config.save', {
    status: 'OPEN',
    prizes: [{ label: '휠1등', quantity: 2 }, { label: '참가상', quantity: null, weight: 1 }],
  })).status, 200);

  const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.deepEqual(view.json.workspace.voteConfig, { pickCount: 3, status: 'OPEN', resultsPublished: false });
  const roulette = view.json.workspace.rouletteView;
  assert.equal(roulette.status, 'OPEN');
  assert.equal(roulette.startsAt, null);
  assert.equal(roulette.endsAt, null);
  assert.equal(roulette.open, true);
  assert.deepEqual(roulette.prizes, [
    { id: roulette.prizes[0].id, tier: 1, label: '휠1등' },
    { id: roulette.prizes[1].id, tier: 2, label: '참가상' },
  ]);
  // No private inventory counts, weights, or anyone else's results.
  assert.doesNotMatch(JSON.stringify(roulette), /quantity|weight|remaining/i);

  // Own persisted result survives reload with its reward link.
  const spin = await attendee(event, people[0].ticket, 'roulette.spin', {});
  assert.equal(spin.status, 200, JSON.stringify(spin.json));
  const reload = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(reload.json.workspace.roulette.label, spin.json.roulette.label);
  assert.equal(reload.json.workspace.roulette.rewardId, spin.json.roulette.rewardId);

  // Sold out → open flips false server-side without exposing counts.
  const ws2 = await readWorkspace(event.id);
  ws2.rouletteConfig.prizes = [{ id: ws2.rouletteConfig.prizes[0].id, label: '휠1등', quantity: 0 }];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws2)]);
  const soldOut = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[1].ticket,
  });
  assert.equal(soldOut.status, 200);
  assert.equal(soldOut.json.workspace.rouletteView.open, false);
  assert.equal(soldOut.json.workspace.rouletteView.status, 'OPEN');
});

test('capability-views-hide-behind-disabled-features', async () => {
  const event = await createFixture({ features: ['draw'] });
  const people = [person(event.id, 'F1')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  // Operator-only data smuggled in directly still never projects without the feature.
  ws.voteConfig = { pickCount: 3, status: 'OPEN', resultsPublished: true };
  ws.rouletteConfig = { prizes: [], status: 'OPEN', startsAt: null, endsAt: null };
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(view.status, 200);
  assert.equal(view.json.workspace.voteConfig, null);
  assert.ok(view.json.workspace.rouletteView);

  const nodraw = await createFixture({ features: ['poll'] });
  const people2 = [person(nodraw.id, 'F2')];
  const ws2 = await readWorkspace(nodraw.id);
  ws2.participants = people2;
  ws2.rouletteConfig = { prizes: [{ id: 'p1', label: '비밀경품', quantity: 5 }], status: 'OPEN', startsAt: null, endsAt: null };
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [nodraw.id, JSON.stringify(ws2)]);
  const view2 = await requestJson(harness.baseUrl, `/api/public/events/${nodraw.slug}/ticket`, {
    bearer: people2[0].ticket,
  });
  assert.equal(view2.status, 200);
  assert.equal(view2.json.workspace.rouletteView, null);
  assert.doesNotMatch(JSON.stringify(view2.json), /비밀경품/);
});

test('new-events-are-created-vote-closed-while-legacy-rows-stay-open', async () => {
  const slug = `hanwool-created-${suffix}`;
  const created = await requestJson(harness.baseUrl, '/api/events', {
    method: 'POST',
    cookie: cookies.agency,
    body: {
      name: '신규 생성 행사', slug, date: '2026-12-01',
      start: '09:00', end: '17:00', capacity: 50, clientId: null,
      commandId: `hanwool-create-${suffix}`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const eventId = created.json.event.id;
  await insertMembership(harness.database, accounts.manager, eventId, ['all']);

  // Creation stamps closed/bounded configs.
  const stored = await readWorkspace(eventId);
  assert.deepEqual(stored.voteConfig, { pickCount: 5, status: 'CLOSED', resultsPublished: false });
  assert.equal(stored.rouletteConfig.status, 'CLOSED');
  assert.deepEqual(stored.luckyConfig, { min: 1, max: 900 });

  // Bring the event live with teams and a voter through supported paths.
  await harness.database.query(
    `UPDATE events SET payload = jsonb_set(jsonb_set(payload, '{stage}', '"LIVE"'), '{features}', '["poll"]') WHERE id = $1`,
    [eventId]
  );
  const voter = person(eventId, '신규유권자');
  const ws = await readWorkspace(eventId);
  ws.participants = [voter];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [eventId, JSON.stringify(ws)]);
  const team = await operator({ id: eventId }, 'team.save', { name: '신규팀', order: 1 });
  assert.equal(team.status, 200, JSON.stringify(team.json));

  // Closed by default: exact-5 ballot refused until the operator opens.
  const refused = await attendee(
    { id: eventId },
    voter.ticket,
    'vote.ranked',
    { picks: [{ teamId: team.json.team.id }] }
  );
  assert.equal(refused.status, 409);
  assert.match(String(refused.json.error), /투표 기간/);

  // Legacy rows (stored without the keys) still vote without configuration.
  const legacy = await createFixture({});
  const legacyPeople = [person(legacy.id, '구유권자')];
  const legacyWs = await readWorkspace(legacy.id);
  legacyWs.participants = legacyPeople;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [legacy.id, JSON.stringify(legacyWs)]);
  const legacyTeams = await seedTeams(legacy, ['구1', '구2']);
  const legacyVote = await attendee(legacy, legacyPeople[0].ticket, 'vote.ranked', {
    picks: [{ teamId: legacyTeams[0].id }],
  });
  assert.equal(legacyVote.status, 201, JSON.stringify(legacyVote.json));
  // Running commands on a legacy row does not stamp a config onto it.
  assert.equal((await readWorkspace(legacy.id)).voteConfig, null);
});

test('lucky-campaign-creates-no-outbox-row-and-every-enqueue-is-gated', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'Q1')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  const created = await operator(event, 'message.create', {
    title: '초대장',
    body: '럭키번호 {{럭키번호}}를 확인하세요',
    channel: 'SMS',
    ids: people.map((p) => p.id),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  // message.create is never an enqueue path: no outbox row exists yet.
  const queued = await harness.database.query('SELECT message_id FROM message_outbox WHERE message_id = $1', [created.json.message.id]);
  assert.equal(queued.rowCount, 0);

  // The only enqueue path (retry) refuses while the number is absent…
  const blocked = await operator(event, 'message.retry', { id: created.json.message.id });
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.json.error), /럭키번호/);
  const stillQueued = await harness.database.query('SELECT message_id FROM message_outbox WHERE message_id = $1', [created.json.message.id]);
  assert.equal(stillQueued.rowCount, 0);

  // …and enqueues only after preassignment.
  assert.equal((await operator(event, 'lucky.config.save', { min: 1, max: 100 })).status, 200);
  assert.equal((await operator(event, 'lucky.preassign', { participantIds: [people[0].id] })).status, 200);
  const sent = await operator(event, 'message.retry', { id: created.json.message.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
});

test('staff-out-scan-returns-only-the-scanned-person-rewards-and-collects-once', async () => {
  const event = await createFixture({});
  const people = [person(event.id, '퇴장자'), person(event.id, '다른분')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  ws.rewards = [
    { id: 'reward-mine', participantId: people[0].id, name: '한울타리 이용권', method: 'ONSITE', status: 'READY', at: new Date().toISOString(), code: '', claim: null },
    { id: 'reward-theirs', participantId: people[1].id, name: '남의 경품', method: 'ONSITE', status: 'READY', at: new Date().toISOString(), code: '', claim: null },
  ];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  const deskIn = await seedDesk(event, { name: '입구', action: 'IN' });
  const deskOut = await seedDesk(event, { name: '출구', action: 'OUT' });

  // STAFF bootstrap carries no global reward list.
  const bootstrap = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.staff });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.json.state.workspaces[event.id].rewards || [], []);

  const scannedIn = await staffCall(event, 'check.scan', { deskId: deskIn.desk.id, ticket: people[0].ticket }, deskIn.assignmentId);
  assert.equal(scannedIn.status, 200, JSON.stringify(scannedIn.json));

  const scannedOut = await staffCall(event, 'check.scan', { deskId: deskOut.desk.id, ticket: people[0].ticket }, deskOut.assignmentId);
  assert.equal(scannedOut.status, 200, JSON.stringify(scannedOut.json));
  assert.deepEqual(scannedOut.json.rewards, [
    { id: 'reward-mine', name: '한울타리 이용권', status: 'READY', method: 'ONSITE' },
  ]);
  assert.doesNotMatch(JSON.stringify(scannedOut.json), /남의 경품/);

  // Scoped lookup: only the requested person, unknown ids 404.
  const lookup = await staffCall(event, 'reward.lookup', { participantId: people[0].id }, deskOut.assignmentId);
  assert.equal(lookup.status, 200, JSON.stringify(lookup.json));
  assert.equal(lookup.json.participant.id, people[0].id);
  assert.ok(!('phone' in lookup.json.participant) && !('ticket' in lookup.json.participant));
  assert.deepEqual(lookup.json.rewards.map((r) => r.id), ['reward-mine']);
  assert.equal((await staffCall(event, 'reward.lookup', { participantId: 'no-such-person' }, deskOut.assignmentId)).status, 404);

  // Permitted fulfillment once; duplicates and replays refuse.
  const collectId = commandId();
  const collected = await staffCall(event, 'reward.collect', { id: 'reward-mine' }, deskOut.assignmentId, collectId);
  assert.equal(collected.status, 200, JSON.stringify(collected.json));
  assert.equal(collected.json.reward.status, 'RECEIVED');
  assert.equal((await staffCall(event, 'reward.collect', { id: 'reward-mine' }, deskOut.assignmentId)).status, 409);
  const collectReplay = await staffCall(event, 'reward.collect', { id: 'reward-mine' }, deskOut.assignmentId, collectId);
  assert.equal(collectReplay.status, 200);
  assert.equal(collectReplay.json.reward.status, 'RECEIVED');

  // Persisted across a fresh read.
  const stored = await readWorkspace(event.id);
  assert.equal(stored.rewards.find((item) => item.id === 'reward-mine').status, 'RECEIVED');
  assert.equal(stored.rewards.find((item) => item.id === 'reward-theirs').status, 'READY');
});

test('published-company-and-person-outcomes-project-with-safe-stage-metadata', async () => {
  const event = await createFixture({});
  const people = [
    person(event.id, '무대1', { company: '갑사' }),
    person(event.id, '무대2', { company: '갑사' }),
    person(event.id, '무대3', { company: '을사' }),
    person(event.id, '무대4', { company: '을사' }),
  ];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  // Winners hold preassigned lucky numbers before the draw.
  assert.equal((await operator(event, 'lucky.config.save', { min: 1, max: 100 })).status, 200);
  const pre = await operator(event, 'lucky.preassign', { participantIds: people.map((p) => p.id) });
  assert.equal(pre.status, 200, JSON.stringify(pre.json));
  const luckyOf = Object.fromEntries(pre.json.assigned.map((item) => [item.participantId, item.number]));

  const personProgram = await operator(event, 'draw.program.save', {
    name: '개인 본상', quota: 2, moduleId: module.id, status: 'OPEN',
    eligibility: 'PERSON', overlap: 'NONE',
    prizeTiers: [{ name: '대상', count: 1 }, { name: '금상', count: 1 }],
  });
  assert.equal(personProgram.status, 200, JSON.stringify(personProgram.json));
  const personRun = await operator(event, 'draw.program.run', { id: personProgram.json.program.id });
  assert.equal(personRun.status, 200, JSON.stringify(personRun.json));

  const companyProgram = await operator(event, 'draw.program.save', {
    name: '업체 회식비', quota: 1, moduleId: module.id, status: 'OPEN',
    eligibility: 'COMPANY', overlap: 'NONE',
  });
  assert.equal(companyProgram.status, 200, JSON.stringify(companyProgram.json));
  const companyRun = await operator(event, 'draw.program.run', { id: companyProgram.json.program.id });
  assert.equal(companyRun.status, 200, JSON.stringify(companyRun.json));
  assert.equal(companyRun.json.winners.length, 1);

  const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  const programs = Object.fromEntries(view.json.workspace.drawPrograms.map((item) => [item.id, item]));

  // PERSON outcome: identity + drawn lucky number + prize tier, nothing else.
  const personWinners = programs[personProgram.json.program.id].winners;
  assert.equal(personWinners.length, 2);
  const storedPeople = (await readWorkspace(event.id)).participants;
  for (const winner of personWinners) {
    assert.equal(winner.kind, 'PERSON');
    assert.ok(typeof winner.name === 'string' && typeof winner.company === 'string');
    assert.ok(winner.tier === '대상' || winner.tier === '금상');
    const linked = storedPeople.find((p) => p.name === winner.name);
    assert.ok(linked);
    assert.equal(winner.luckyNumber, luckyOf[linked.id]);
    assert.ok(!('id' in winner) && !('ticket' in winner) && !('phone' in winner) && !('participantId' in winner));
  }

  // COMPANY outcome: visible with the company as its own display name, marked
  // COMPANY, and no invented person attached.
  const companyWinners = programs[companyProgram.json.program.id].winners;
  assert.equal(companyWinners.length, 1);
  assert.equal(companyWinners[0].kind, 'COMPANY');
  assert.equal(companyWinners[0].name, companyWinners[0].company);
  assert.ok(['갑사', '을사'].includes(companyWinners[0].company));
  assert.ok(!('id' in companyWinners[0]) && !('luckyNumber' in companyWinners[0]));

  // The linked stage module carries the same safe metadata (no blank rows).
  const drawModule = view.json.workspace.modules.find((item) => item.id === module.id);
  assert.ok(drawModule);
  const histories = drawModule.drawHistory;
  assert.ok(histories.length >= 2);
  for (const entry of histories) {
    assert.ok(entry.winners.length > 0);
    for (const winner of entry.winners) {
      assert.ok(typeof winner.name === 'string' && winner.name.length > 0);
      assert.ok(winner.kind === 'PERSON' || winner.kind === 'COMPANY');
    }
  }
  assert.doesNotMatch(JSON.stringify(view.json.workspace.drawPrograms), /"id":"person-/);
});

test('draw-program-run-count-sequences-single-winners', async () => {
  const event = await createFixture({});
  const people = Array.from({ length: 9 }, (_, i) => person(event.id, `순차${i}`));
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '순차 추첨', quota: 9, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const programId = saved.json.program.id;

  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 0 })).status, 400);
  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 21 })).status, 400);

  // One MC touch draws exactly one winner, one reward, one history entry.
  const firstId = commandId();
  const first = await operator(event, 'draw.program.run', { id: programId, count: 1 }, { id: firstId });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.winners.length, 1);
  assert.equal(first.json.program.winners.length, 1);
  let stored = await readWorkspace(event.id);
  assert.equal(stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${programId}-`)).length, 1);
  assert.equal(stored.modules.find((m) => m.id === module.id).drawHistory.length, 1);

  // Same-ID retry replays: still exactly one of everything.
  const replay = await operator(event, 'draw.program.run', { id: programId, count: 1 }, { id: firstId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.winners, first.json.winners);
  stored = await readWorkspace(event.id);
  assert.equal(stored.drawPrograms.find((p) => p.id === programId).winners.length, 1);
  assert.equal(stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${programId}-`)).length, 1);
  assert.equal(stored.modules.find((m) => m.id === module.id).drawHistory.length, 1);

  // A distinct ID draws exactly one more.
  const second = await operator(event, 'draw.program.run', { id: programId, count: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.winners.length, 1);
  assert.notEqual(second.json.winners[0].id, first.json.winners[0].id);
  stored = await readWorkspace(event.id);
  assert.equal(stored.drawPrograms.find((p) => p.id === programId).winners.length, 2);
  assert.equal(stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${programId}-`)).length, 2);
});

test('draw-program-partial-close-reopen-and-unpublish-syncs-module', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'M1'), person(event.id, 'M2'), person(event.id, 'M3'), person(event.id, 'M4')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '부분 추첨', quota: 3, moduleId: module.id, status: 'OPEN', overlap: 'NONE',
  });
  assert.equal(saved.status, 200);
  const programId = saved.json.program.id;

  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 1 })).status, 200);

  // Config stays frozen after the first draw, but close/reopen works.
  assert.equal((await operator(event, 'draw.program.save', { id: programId, quota: 5, moduleId: module.id })).status, 409);
  assert.equal((await operator(event, 'draw.program.save', { id: programId, name: '부분 추첨', quota: 3, moduleId: module.id })).status, 200);
  assert.equal((await operator(event, 'draw.program.save', { id: programId, status: 'CLOSED' })).status, 200);
  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 1 })).status, 409);
  assert.equal((await operator(event, 'draw.program.save', { id: programId, status: 'OPEN' })).status, 200);
  const second = await operator(event, 'draw.program.run', { id: programId, count: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.json));

  // Unpublish hides the program AND its mirrored module history…
  assert.equal((await operator(event, 'draw.program.save', { id: programId, published: false })).status, 200);
  const hidden = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.json.workspace.drawPrograms, []);
  const hiddenModule = hidden.json.workspace.modules.find((item) => item.id === module.id);
  assert.deepEqual(hiddenModule.drawHistory, []);

  // …while an unrelated legacy draw history stays published.
  const legacyRun = await operator(event, 'draw.run', { id: module.id, count: 1 });
  assert.equal(legacyRun.status, 200, JSON.stringify(legacyRun.json));
  assert.equal((await operator(event, 'draw.publish', { id: module.id })).status, 200);
  const mixed = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(mixed.status, 200);
  const mixedModule = mixed.json.workspace.modules.find((item) => item.id === module.id);
  assert.equal(mixedModule.drawHistory.length, 1);
  assert.ok(!('programId' in mixedModule.drawHistory[0]));

  // Republish restores both surfaces.
  assert.equal((await operator(event, 'draw.program.save', { id: programId, published: true })).status, 200);
  const restored = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.workspace.drawPrograms.length, 1);
  assert.equal(restored.json.workspace.drawPrograms[0].winners.length, 2);
  const restoredModule = restored.json.workspace.modules.find((item) => item.id === module.id);
  assert.equal(restoredModule.drawHistory.length, 3);
});

test('draw-overlap-none-mints-per-occurrence-rewards', async () => {
  const event = await createFixture({});
  const people = [person(event.id, '단골')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const tiers = [{ name: '첫판', count: 1 }, { name: '막판', count: 1 }];

  const none = await operator(event, 'draw.program.save', {
    name: '중복 가능', quota: 2, moduleId: module.id, status: 'OPEN',
    overlap: 'NONE', prizeTiers: tiers,
  });
  assert.equal(none.status, 200, JSON.stringify(none.json));
  const run1 = await operator(event, 'draw.program.run', { id: none.json.program.id, count: 1 });
  assert.equal(run1.status, 200, JSON.stringify(run1.json));
  const run2 = await operator(event, 'draw.program.run', { id: none.json.program.id, count: 1 });
  assert.equal(run2.status, 200, JSON.stringify(run2.json));

  // Same person twice, two distinct correctly-tiered entitlements.
  const stored = await readWorkspace(event.id);
  const rewards = stored.rewards
    .filter((item) => String(item.id).startsWith(`drawreward-${none.json.program.id}-`))
    .sort((a, b) => (a.source.winnerIndex < b.source.winnerIndex ? -1 : 1));
  assert.equal(rewards.length, 2);
  assert.notEqual(rewards[0].id, rewards[1].id);
  assert.equal(rewards[0].name, '첫판');
  assert.equal(rewards[1].name, '막판');
  assert.equal(rewards[0].participantId, people[0].id);
  assert.equal(rewards[1].participantId, people[0].id);

  // PROGRAM scope still excludes repeats: the second run has nobody to draw.
  const prog = await operator(event, 'draw.program.save', {
    name: '중복 불가', quota: 2, moduleId: module.id, status: 'OPEN',
    overlap: 'PROGRAM',
  });
  assert.equal(prog.status, 200, JSON.stringify(prog.json));
  assert.equal((await operator(event, 'draw.program.run', { id: prog.json.program.id, count: 1 })).status, 200);
  assert.equal((await operator(event, 'draw.program.run', { id: prog.json.program.id, count: 1 })).status, 409);
});

test('roulette-unlimited-requires-explicit-policy', async () => {
  const event = await createFixture({});

  const missing = await operator(event, 'roulette.config.save', {
    status: 'DRAFT', prizes: [{ label: '수량 없음' }],
  });
  assert.equal(missing.status, 400);
  const blank = await operator(event, 'roulette.config.save', {
    status: 'DRAFT', prizes: [{ label: '빈 수량', quantity: '' }],
  });
  assert.equal(blank.status, 400);
  const unweighted = await operator(event, 'roulette.config.save', {
    status: 'DRAFT', prizes: [{ label: '가중치 없음', quantity: null }],
  });
  assert.equal(unweighted.status, 400);
  const zeroWeighted = await operator(event, 'roulette.config.save', {
    status: 'OPEN', prizes: [{ label: '가중치 0', quantity: null, weight: 0 }],
  });
  assert.equal(zeroWeighted.status, 400);
  // Nothing actually selectable can never open.
  const depleted = await operator(event, 'roulette.config.save', {
    status: 'OPEN', prizes: [{ label: '빈 재고', quantity: 0 }],
  });
  assert.equal(depleted.status, 400);
  const paused = await operator(event, 'roulette.config.save', {
    status: 'OPEN', prizes: [{ label: '일시정지', quantity: 5, weight: 0 }],
  });
  assert.equal(paused.status, 400);

  // Explicit unlimited policy spins deterministically without false sold-out.
  const event2 = await createFixture({});
  const people = [person(event2.id, 'U1'), person(event2.id, 'U2')];
  const ws = await readWorkspace(event2.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event2.id, JSON.stringify(ws)]);
  assert.equal((await operator(event2, 'roulette.config.save', {
    status: 'OPEN',
    prizes: [{ label: '참가상', quantity: null, weight: 2 }],
  })).status, 200);
  for (const p of people) {
    const spin = await attendee(event2, p.ticket, 'roulette.spin', {});
    assert.equal(spin.status, 200, JSON.stringify(spin.json));
    assert.equal(spin.json.roulette.label, '참가상');
  }
});

test('roulette-issued-results-freeze-prize-identity-but-allow-stock-and-status-edits', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'I1'), person(event.id, 'I2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  assert.equal((await operator(event, 'roulette.config.save', {
    status: 'OPEN',
    prizes: [
      { id: 'prize-alpha', label: '알파', quantity: 5 },
      { id: 'prize-beta', label: '베타', quantity: null, weight: 2 },
    ],
  })).status, 200);

  const spin = await attendee(event, people[0].ticket, 'roulette.spin', {});
  assert.equal(spin.status, 200, JSON.stringify(spin.json));
  const stored = await readWorkspace(event.id);
  const issued = stored.rouletteResults.find((item) => item.participantId === people[0].id);
  assert.ok(issued);
  const issuedPrizeId = issued.prizeId;
  const otherPrizeId = issuedPrizeId === 'prize-alpha' ? 'prize-beta' : 'prize-alpha';

  // Structural edits are refused once spins exist — issued or not, because
  // tiers are positional and any change remaps the wheel.
  const current = (await readWorkspace(event.id)).rouletteConfig.prizes;
  const withoutIssued = current.filter((p) => p.id !== issuedPrizeId);
  assert.equal((await operator(event, 'roulette.config.save', { prizes: withoutIssued })).status, 409);
  const withoutOther = current.filter((p) => p.id !== otherPrizeId);
  assert.equal((await operator(event, 'roulette.config.save', { prizes: withoutOther })).status, 409);
  const reordered = [...current].reverse();
  assert.equal((await operator(event, 'roulette.config.save', { prizes: reordered })).status, 409);
  const renamed = current.map((p) => ({ ...p }));
  renamed[0].label = '바뀐 이름';
  assert.equal((await operator(event, 'roulette.config.save', { prizes: renamed })).status, 409);
  const added = [...current, { id: 'prize-gamma', label: '감마', quantity: 3 }];
  assert.equal((await operator(event, 'roulette.config.save', { prizes: added })).status, 409);

  // Permitted edits: stock increase, valid reduction (>= used), weight,
  // status, schedule.
  const grown = current.map((p) => (p.id === 'prize-alpha' ? { ...p, quantity: 10 } : { ...p }));
  assert.equal((await operator(event, 'roulette.config.save', { prizes: grown })).status, 200);
  const usedAlpha = stored.rouletteResults.filter((item) => item.prizeId === 'prize-alpha').length;
  const shrunk = current.map((p) => (p.id === 'prize-alpha' ? { ...p, quantity: Math.max(usedAlpha, 1) } : { ...p }));
  assert.equal((await operator(event, 'roulette.config.save', { prizes: shrunk })).status, 200);
  if (usedAlpha > 0) {
    const belowUsed = current.map((p) => (p.id === 'prize-alpha' ? { ...p, quantity: usedAlpha - 1 } : { ...p }));
    assert.equal((await operator(event, 'roulette.config.save', { prizes: belowUsed })).status, 409);
  }
  const reweighted = (await readWorkspace(event.id)).rouletteConfig.prizes.map((p) =>
    (p.id === 'prize-beta' ? { ...p, weight: 5 } : { ...p })
  );
  assert.equal((await operator(event, 'roulette.config.save', { prizes: reweighted })).status, 200);
  assert.equal((await operator(event, 'roulette.config.save', { status: 'CLOSED' })).status, 200);
  assert.equal((await operator(event, 'roulette.config.save', {
    status: 'OPEN', startsAt: new Date(Date.now() - 3600000).toISOString(),
  })).status, 200);

  // Own persisted result and reward stay consistent after edits + reload.
  const before = await readWorkspace(event.id);
  const resultBefore = before.rouletteResults.find((item) => item.participantId === people[0].id);
  const rewardBefore = before.rewards.find((item) => item.id === resultBefore.rewardId);
  const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
    bearer: people[0].ticket,
  });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(view.json.workspace.roulette.label, resultBefore.label);
  assert.equal(view.json.workspace.roulette.rewardId, resultBefore.rewardId);
  assert.equal(view.json.workspace.roulette.tier, resultBefore.tier);
  assert.equal(rewardBefore.status, 'READY');
  assert.equal(rewardBefore.name, resultBefore.label);
  const livePrizes = view.json.workspace.rouletteView.prizes;
  assert.deepEqual(livePrizes.map((p) => p.id), ['prize-alpha', 'prize-beta']);
  const ownSlot = livePrizes.find((p) => p.id === issuedPrizeId);
  assert.equal(ownSlot.tier, resultBefore.tier);
  assert.equal(ownSlot.label, resultBefore.label);

  // Genuinely legacy rows (results but never configured) are not locked.
  const legacy = await createFixture({});
  const legacyPeople = [person(legacy.id, 'G1')];
  const legacyWs = await readWorkspace(legacy.id);
  legacyWs.participants = legacyPeople;
  legacyWs.rouletteConfig = null;
  legacyWs.rouletteResults = [{ participantId: 'ghost', prizeId: 'old-prize', tier: 9, label: '옛것', at: new Date().toISOString() }];
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [legacy.id, JSON.stringify(legacyWs)]);
  const fresh = await operator(legacy, 'roulette.config.save', {
    status: 'DRAFT',
    prizes: [{ id: 'brand-new', label: '새 상품', quantity: 4 }],
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
});

test('ticket-link-campaign-refuses-enqueue-without-valid-public-origin', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'T1')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  const created = await operator(event, 'message.create', {
    title: '초대장',
    body: '참여 신청은 여기에서 {{티켓링크}}',
    channel: 'SMS',
    ids: people.map((p) => p.id),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  // Generic campaigns without the variable still retry normally.
  const plain = await operator(event, 'message.create', {
    title: '일반 안내',
    body: '행사 안내입니다 {{이름}}님',
    channel: 'SMS',
    ids: people.map((p) => p.id),
  });
  assert.equal(plain.status, 201);

  try {
    // Absent, blank, and malformed origins (non-http, credentials, query,
    // hash, unparseable) all refuse before enqueue: no attempts increment,
    // no outbox row.
    const cases = [
      ['unset', undefined],
      ['blank', '   '],
      ['non-http', 'ftp://files.example.test/x'],
      ['credentials', 'https://user:pass@invites.example.test/'],
      ['query', 'https://invites.example.test/?from=console'],
      ['hash', 'https://invites.example.test/#top'],
      ['unparseable', '::::'],
      ['no-host', 'http://'],
    ];
    for (const [label, value] of cases) {
      if (value === undefined) delete process.env.EVENTOUCH_PUBLIC_URL;
      else process.env.EVENTOUCH_PUBLIC_URL = value;
      const blocked = await operator(event, 'message.retry', { id: created.json.message.id });
      assert.equal(blocked.status, 409, label);
      assert.match(String(blocked.json.error), /공개 주소/, label);
    }
    const after = await readWorkspace(event.id);
    const campaign = after.messages.find((item) => item.id === created.json.message.id);
    assert.equal(campaign.attempts, 1);
    const queued = await harness.database.query('SELECT message_id FROM message_outbox WHERE message_id = $1', [created.json.message.id]);
    assert.equal(queued.rowCount, 0);

    const plainRetry = await operator(event, 'message.retry', { id: plain.json.message.id });
    assert.equal(plainRetry.status, 200, JSON.stringify(plainRetry.json));
    assert.equal(plainRetry.json.message.status, 'NEEDS_CONNECTION');
  } finally {
    delete process.env.EVENTOUCH_PUBLIC_URL;
  }
});

test('ticket-link-builds-personalized-home-link-and-drain-holds-without-origin', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'D1'), person(event.id, 'D2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);

  const created = await operator(event, 'message.create', {
    title: '초대장',
    body: '{{이름}}님 {{티켓링크}}',
    channel: 'SMS',
    ids: people.map((p) => p.id),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  try {
    // Trailing slashes and subpaths normalize; each recipient gets ONLY
    // their own bearer on the attendee home path.
    process.env.EVENTOUCH_PUBLIC_URL = 'https://invites.example.test/base//';
    const stored = await readWorkspace(event.id);
    const message = stored.messages.find((item) => item.id === created.json.message.id);
    const dispatch = buildMessageDispatch(
      { id: event.id, slug: event.slug, name: '행사', date: '2026-12-01' },
      stored,
      message
    );
    assert.equal(dispatch.recipients.length, 2);
    for (const recipient of dispatch.recipients) {
      const own = people.find((p) => p.id === recipient.participantId);
      assert.equal(
        recipient.variables.티켓링크,
        `https://invites.example.test/base/event/${event.slug}/home?ticket=${encodeURIComponent(own.ticket)}`
      );
    }
    assert.notEqual(dispatch.recipients[0].variables.티켓링크, dispatch.recipients[1].variables.티켓링크);
    // No rendered variable carries an unresolved placeholder (the raw
    // template text itself keeps tokens for provider-side substitution).
    assert.doesNotMatch(JSON.stringify(dispatch.recipients.map((r) => r.variables)), /{{[^{}]*}}/);

    // Environment lost after enqueue: the drain must hold the row queued
    // (retryable) instead of sending the literal placeholder.
    const wsSending = await readWorkspace(event.id);
    wsSending.messages.find((item) => item.id === created.json.message.id).status = 'SENDING';
    await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(wsSending)]);
    await harness.database.query(
      `INSERT INTO message_outbox (message_id, event_id, status, attempts, next_attempt_at)
       VALUES ($1, $2, 'PENDING', 0, now())
       ON CONFLICT (message_id) DO UPDATE SET status = 'PENDING', updated_at = now()`,
      [created.json.message.id, event.id]
    );
    delete process.env.EVENTOUCH_PUBLIC_URL;
    let providerCalls = 0;
    const result = await drainMessageOutbox(harness.database, {
      state: { connected: true },
      sendBatch: async () => { providerCalls += 1; return { accepted: true, registered: [] }; },
    });
    assert.equal(result.dispatched, 0);
    assert.equal(providerCalls, 0);
    const held = await harness.database.query('SELECT message_id FROM message_outbox WHERE message_id = $1', [created.json.message.id]);
    assert.equal(held.rowCount, 1);
  } finally {
    delete process.env.EVENTOUCH_PUBLIC_URL;
  }
});

test('company-event-scope-draws-distinct-companies-across-sequential-runs', async () => {
  const event = await createFixture({});
  const companies = ['갑사', '을사', '병사', '정사'];
  const people = companies.flatMap((company, i) => [
    person(event.id, `직원${i}A`, { company }),
    person(event.id, `직원${i}B`, { company }),
  ]);
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '4개 업체 추첨', quota: 4, moduleId: module.id, status: 'OPEN',
    eligibility: 'COMPANY',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.program.overlap, 'EVENT');
  const programId = saved.json.program.id;

  // Four MC touches draw four distinct companies — exclusion holds across
  // runs, not just inside one batch.
  const drawn = [];
  for (let i = 0; i < 4; i += 1) {
    const run = await operator(event, 'draw.program.run', { id: programId, count: 1 });
    assert.equal(run.status, 200, JSON.stringify(run.json));
    assert.equal(run.json.winners.length, 1);
    drawn.push(run.json.winners[0].company);
  }
  assert.deepEqual([...drawn].sort(), [...companies].sort());

  const stored = await readWorkspace(event.id);
  const entitlements = stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${programId}-`));
  assert.equal(entitlements.length, 4);
  assert.deepEqual(entitlements.map((item) => item.company).sort(), [...companies].sort());
  assert.ok(entitlements.every((item) => item.status === 'PENDING' && !item.participantId));

  // Quota met: a fifth touch refuses instead of repeating a company.
  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 1 })).status, 409);
});

test('company-program-and-event-scopes-differ-across-programs', async () => {
  const event = await createFixture({});
  const people = [person(event.id, '갑돌', { company: '갑사' }), person(event.id, '을돌', { company: '을사' })];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  const progA = await operator(event, 'draw.program.save', {
    name: 'A사 추첨', quota: 1, moduleId: module.id, status: 'OPEN',
    eligibility: 'COMPANY', overlap: 'PROGRAM',
  });
  assert.equal(progA.status, 200);
  const runA = await operator(event, 'draw.program.run', { id: progA.json.program.id, count: 1 });
  assert.equal(runA.status, 200, JSON.stringify(runA.json));
  const wonA = runA.json.winners[0].company;
  const other = wonA === '갑사' ? '을사' : '갑사';

  // EVENT scope sees the other program's winner: only the remaining company.
  const progB = await operator(event, 'draw.program.save', {
    name: 'B사 추첨', quota: 1, moduleId: module.id, status: 'OPEN',
    eligibility: 'COMPANY', overlap: 'EVENT',
  });
  assert.equal(progB.status, 200);
  const runB = await operator(event, 'draw.program.run', { id: progB.json.program.id, count: 1 });
  assert.equal(runB.status, 200, JSON.stringify(runB.json));
  assert.equal(runB.json.winners[0].company, other);

  // PROGRAM scope stays independent: its own empty history means both
  // companies are drawable, so the run succeeds.
  const progC = await operator(event, 'draw.program.save', {
    name: 'C사 추첨', quota: 1, moduleId: module.id, status: 'OPEN',
    eligibility: 'COMPANY', overlap: 'PROGRAM',
  });
  assert.equal(progC.status, 200);
  const runC = await operator(event, 'draw.program.run', { id: progC.json.program.id, count: 1 });
  assert.equal(runC.status, 200, JSON.stringify(runC.json));
  assert.ok(['갑사', '을사'].includes(runC.json.winners[0].company));
});

test('event-scope-excludes-legacy-stage-winners-program-stays-independent', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'L1'), person(event.id, 'L2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  // A pre-existing legacy stage draw (no programId) crowns one winner.
  const legacyRun = await operator(event, 'draw.run', { id: module.id, count: 1 });
  assert.equal(legacyRun.status, 200, JSON.stringify(legacyRun.json));
  const legacyWinner = legacyRun.json.winners[0];
  const other = people.find((p) => p.id !== legacyWinner.id);
  assert.ok(other);

  // A new EVENT program cannot reselect the legacy winner…
  const progE = await operator(event, 'draw.program.save', {
    name: '전체 추첨', quota: 1, moduleId: module.id, status: 'OPEN',
    eligibility: 'PERSON', overlap: 'EVENT',
  });
  assert.equal(progE.status, 200);
  const runE = await operator(event, 'draw.program.run', { id: progE.json.program.id, count: 1 });
  assert.equal(runE.status, 200, JSON.stringify(runE.json));
  assert.equal(runE.json.winners[0].id, other.id);

  // …while a PROGRAM program remains independent of both.
  const progP = await operator(event, 'draw.program.save', {
    name: '독립 추첨', quota: 1, moduleId: module.id, status: 'OPEN',
    eligibility: 'PERSON', overlap: 'PROGRAM',
  });
  assert.equal(progP.status, 200);
  const runP = await operator(event, 'draw.program.run', { id: progP.json.program.id, count: 1 });
  assert.equal(runP.status, 200, JSON.stringify(runP.json));
  assert.ok(people.some((p) => p.id === runP.json.winners[0].id));

  // A company award does not disqualify employees from PERSON draws.
  const solo = await createFixture({});
  const soloPeople = [person(solo.id, '갑돌', { company: '갑사' }), person(solo.id, '갑순', { company: '갑사' })];
  const soloWs = await readWorkspace(solo.id);
  soloWs.participants = soloPeople;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [solo.id, JSON.stringify(soloWs)]);
  const soloModule = await seedDrawModule(solo);
  const soloCompany = await operator(solo, 'draw.program.save', {
    name: '업체상', quota: 1, moduleId: soloModule.id, status: 'OPEN',
    eligibility: 'COMPANY', overlap: 'EVENT',
  });
  assert.equal(soloCompany.status, 200);
  assert.equal((await operator(solo, 'draw.program.run', { id: soloCompany.json.program.id, count: 1 })).status, 200);
  const soloPerson = await operator(solo, 'draw.program.save', {
    name: '개인상', quota: 1, moduleId: soloModule.id, status: 'OPEN',
    eligibility: 'PERSON', overlap: 'EVENT',
  });
  assert.equal(soloPerson.status, 200);
  const soloRun = await operator(solo, 'draw.program.run', { id: soloPerson.json.program.id, count: 1 });
  assert.equal(soloRun.status, 200, JSON.stringify(soloRun.json));
  assert.ok(soloPeople.some((p) => p.id === soloRun.json.winners[0].id));
});

test('draw-run-show-on-screen-selects-stage-display-in-the-same-transaction', async () => {
  const event = await createFixture({ features: ['draw', 'screen'] });
  const people = [person(event.id, 'S1'), person(event.id, 'S2'), person(event.id, 'S3')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '무대 추첨', quota: 3, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(saved.status, 200);
  const programId = saved.json.program.id;

  // One touch draws one winner AND selects the stage display atomically.
  const touchId = commandId();
  const touch = await operator(event, 'draw.program.run', { id: programId, count: 1, showOnScreen: true }, { id: touchId });
  assert.equal(touch.status, 200, JSON.stringify(touch.json));
  assert.equal(touch.json.winners.length, 1);
  assert.deepEqual(touch.json.display, { type: 'draw', moduleId: module.id, noticeId: null, at: touch.json.display.at });
  const stored = await readWorkspace(event.id);
  assert.equal(stored.drawPrograms.find((p) => p.id === programId).winners.length, 1);
  assert.equal(stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${programId}-`)).length, 1);
  assert.deepEqual(stored.display, touch.json.display);

  // Same-ID replay returns the identical outcome without duplicating.
  const replay = await operator(event, 'draw.program.run', { id: programId, count: 1, showOnScreen: true }, { id: touchId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, touch.json);
  const storedAgain = await readWorkspace(event.id);
  assert.equal(storedAgain.drawPrograms.find((p) => p.id === programId).winners.length, 1);

  // Omitted opt-in keeps legacy headless behavior: no display key at all.
  const headless = await operator(event, 'draw.program.run', { id: programId, count: 1 });
  assert.equal(headless.status, 200, JSON.stringify(headless.json));
  assert.ok(!('display' in headless.json));
});

test('draw-run-show-on-screen-rejects-atomically-without-screen-setup', async () => {
  const event = await createFixture({ features: ['draw'] });
  const people = [person(event.id, 'N1'), person(event.id, 'N2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '무대 없음', quota: 2, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(saved.status, 200);
  const programId = saved.json.program.id;

  // Screen feature off: the draw commits nothing — no winners, rewards,
  // history, or display selection.
  const refused = await operator(event, 'draw.program.run', { id: programId, count: 1, showOnScreen: true });
  assert.equal(refused.status, 409);
  const stored = await readWorkspace(event.id);
  assert.deepEqual(stored.drawPrograms.find((p) => p.id === programId).winners, []);
  assert.equal(stored.rewards.filter((item) => String(item.id).startsWith(`drawreward-${programId}-`)).length, 0);
  assert.deepEqual(stored.modules.find((m) => m.id === module.id).drawHistory || [], []);
  assert.equal(stored.display.type, 'idle');

  // Headless run without the opt-in still works: screen is not required.
  const headless = await operator(event, 'draw.program.run', { id: programId, count: 1 });
  assert.equal(headless.status, 200, JSON.stringify(headless.json));
});

test('draw-run-show-on-screen-rejects-private-module-without-auto-publish', async () => {
  const event = await createFixture({ features: ['draw', 'screen'] });
  const people = [person(event.id, 'P1'), person(event.id, 'P2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  assert.equal((await operator(event, 'module.status', { id: module.id, status: 'DRAFT' })).status, 200);
  const saved = await operator(event, 'draw.program.save', {
    name: '비공개 모듈', quota: 2, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(saved.status, 200);
  const programId = saved.json.program.id;

  // Unpublished module: opt-in fails and flips no flag to make it showable.
  const refused = await operator(event, 'draw.program.run', { id: programId, count: 1, showOnScreen: true });
  assert.equal(refused.status, 409);
  const stored = await readWorkspace(event.id);
  assert.deepEqual(stored.drawPrograms.find((p) => p.id === programId).winners, []);
  assert.equal(stored.modules.find((m) => m.id === module.id).published, false);
  assert.equal(stored.display.type, 'idle');

  // Headless draw on the same setup commits normally (module privacy is a
  // display concern, not a draw blocker).
  const headless = await operator(event, 'draw.program.run', { id: programId, count: 1 });
  assert.equal(headless.status, 200, JSON.stringify(headless.json));
});

test('draw-program-run-denies-staff-per-existing-access-model', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'X1')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '권한 추첨', quota: 1, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(saved.status, 200);
  const desk = await seedDesk(event, { name: '입구', action: 'IN' });
  const denied = await staffCall(event, 'draw.program.run', { id: saved.json.program.id, count: 1, showOnScreen: true }, desk.assignmentId);
  assert.equal(denied.status, 403);
  const stored = await readWorkspace(event.id);
  assert.deepEqual(stored.drawPrograms.find((p) => p.id === saved.json.program.id).winners, []);
});

test('explicit-unpublish-survives-status-only-close-and-reopen', async () => {
  const event = await createFixture({});
  const people = [person(event.id, 'U1'), person(event.id, 'U2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);
  const saved = await operator(event, 'draw.program.save', {
    name: '공개 전환', quota: 2, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(saved.status, 200);
  const programId = saved.json.program.id;
  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 1 })).status, 200);

  async function ticketPrograms() {
    const view = await requestJson(harness.baseUrl, `/api/public/events/${event.slug}/ticket`, {
      bearer: people[0].ticket,
    });
    assert.equal(view.status, 200);
    return view.json.workspace;
  }
  async function moduleEntries() {
    const stored = await readWorkspace(event.id);
    return stored.modules.find((m) => m.id === module.id).drawHistory.filter((e) => e.programId === programId);
  }

  // Explicit unpublish hides the slot and its mirrored history…
  assert.equal((await operator(event, 'draw.program.save', { id: programId, published: false })).status, 200);
  assert.equal((await readWorkspace(event.id)).drawPrograms.find((p) => p.id === programId).published, false);
  assert.ok((await moduleEntries()).every((e) => e.published === false));
  assert.deepEqual((await ticketPrograms()).drawPrograms, []);

  // …and a status-only close keeps it private…
  assert.equal((await operator(event, 'draw.program.save', { id: programId, status: 'CLOSED' })).status, 200);
  assert.equal((await readWorkspace(event.id)).drawPrograms.find((p) => p.id === programId).published, false);
  assert.ok((await moduleEntries()).every((e) => e.published === false));
  assert.deepEqual((await ticketPrograms()).drawPrograms, []);

  // …as does a status-only reopen — no silent republication anywhere.
  assert.equal((await operator(event, 'draw.program.save', { id: programId, status: 'OPEN' })).status, 200);
  const reopened = await readWorkspace(event.id);
  assert.equal(reopened.drawPrograms.find((p) => p.id === programId).published, false);
  assert.ok((await moduleEntries()).every((e) => e.published === false));
  assert.deepEqual((await ticketPrograms()).drawPrograms, []);
  assert.ok(!(await ticketPrograms()).modules.find((m) => m.id === module.id).drawHistory.some((e) => e.winners && e.winners.length));

  // A new explicit published:true deliberately republishes both surfaces.
  assert.equal((await operator(event, 'draw.program.save', { id: programId, published: true })).status, 200);
  assert.equal((await readWorkspace(event.id)).drawPrograms.find((p) => p.id === programId).published, true);
  assert.ok((await moduleEntries()).every((e) => e.published === true));
  assert.equal((await ticketPrograms()).drawPrograms.length, 1);

  // Legacy slots without a recorded choice keep status-derived publication:
  // DRAFT -> OPEN auto-publishes (full payload, no published key).
  const legacy = await operator(event, 'draw.program.save', {
    name: '구 슬롯', quota: 1, moduleId: module.id, status: 'DRAFT',
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.program.published, false);
  const opened = await operator(event, 'draw.program.save', {
    id: legacy.json.program.id, name: '구 슬롯', quota: 1, moduleId: module.id, status: 'OPEN',
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.program.published, true);
});

test('draw-program-status-only-saves-default-to-stored-config', async () => {
  const event = await createFixture({ features: ['draw', 'screen'] });
  const people = [person(event.id, 'O1'), person(event.id, 'O2')];
  const ws = await readWorkspace(event.id);
  ws.participants = people;
  await harness.database.query('UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1', [event.id, JSON.stringify(ws)]);
  const module = await seedDrawModule(event);

  // New slots still require every field…
  assert.equal((await operator(event, 'draw.program.save', { quota: 2, moduleId: module.id })).status, 400);
  const created = await operator(event, 'draw.program.save', {
    name: '상태 전환', quota: 2, moduleId: module.id, status: 'DRAFT',
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const programId = created.json.program.id;

  // …but an existing unstarted slot opens on status/publication alone — the
  // exact frontend contract — keeping every stored config value…
  const opened = await operator(event, 'draw.program.save', { id: programId, status: 'OPEN', published: true });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.program.status, 'OPEN');
  assert.equal(opened.json.program.published, true);
  assert.equal(opened.json.program.name, '상태 전환');
  assert.equal(opened.json.program.quota, 2);
  assert.equal(opened.json.program.moduleId, module.id);

  // …and explicit empty/invalid values still reject instead of clearing.
  assert.equal((await operator(event, 'draw.program.save', { id: programId, name: '' })).status, 400);
  assert.equal((await operator(event, 'draw.program.save', { id: programId, quota: 0 })).status, 400);

  // Status-only CLOSED before the first win works and blocks the run…
  assert.equal((await operator(event, 'draw.program.save', { id: programId, status: 'CLOSED' })).status, 200);
  assert.equal((await operator(event, 'draw.program.run', { id: programId, count: 1 })).status, 409);
  // …reopen runs, and the stage touch draws plus displays atomically.
  assert.equal((await operator(event, 'draw.program.save', { id: programId, status: 'OPEN' })).status, 200);
  const touch = await operator(event, 'draw.program.run', { id: programId, count: 1, showOnScreen: true });
  assert.equal(touch.status, 200, JSON.stringify(touch.json));
  assert.equal(touch.json.winners.length, 1);
  assert.equal(touch.json.display.type, 'draw');
  assert.equal(touch.json.display.moduleId, module.id);
  const stored = await readWorkspace(event.id);
  assert.deepEqual(stored.display, touch.json.display);
});
