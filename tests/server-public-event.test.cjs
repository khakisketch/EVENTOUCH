'use strict';

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertEvent,
  requestJson,
  deleteFixtureRows,
} = require('./helpers/postgres-api-server.cjs');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const eventIds = {
  live: `public-live-${suffix}`,
  draft: `public-draft-${suffix}`,
  other: `public-other-${suffix}`,
};
const slugs = {
  live: `public-live-${suffix}`,
  draft: `public-draft-${suffix}`,
  other: `public-other-${suffix}`,
};
const ticketTokens = {
  own: crypto.randomBytes(32).toString('base64url'),
  other: crypto.randomBytes(32).toString('base64url'),
  crossEvent: crypto.randomBytes(32).toString('base64url'),
  revoked: crypto.randomBytes(32).toString('base64url'),
  expired: crypto.randomBytes(32).toString('base64url'),
};
let harness;

function participant(id, name, ticket, extra = {}) {
  return {
    id,
    name,
    company: `${name} 회사`,
    phone: '01012345678',
    email: `${id}@example.test`,
    group: '일반',
    status: 'APPROVED',
    inside: false,
    everIn: false,
    registrationType: 'PRE',
    ticket,
    ticketExpiresAt: '2026-12-31T23:59:59.000Z',
    revoked: false,
    paymentStatus: 'FREE',
    answers: { dietary: '채식' },
    consent: { version: 2, at: '2026-10-01T12:00:00.000Z' },
    createdAt: '2026-10-01T12:00:00.000Z',
    privateNote: `private-${name}`,
    ...extra,
  };
}

function publicWorkspace() {
  return {
    registrationOpen: true,
    approvalRequired: true,
    publishedVersion: 4,
    formVersion: 9,
    fields: [{ id: 'draft-secret', label: '초안 전용 질문', type: 'text', required: true }],
    publishedFields: [
      { id: 'name', label: '이름', type: 'text', required: true, options: [] },
      { id: 'company', label: '소속', type: 'text', required: false, options: [] },
    ],
    consentText: '게시된 수집 동의 안내',
    consentVersion: 2,
    price: 0,
    pageExperience: {
      draft: { intro: '초안에만 있는 비공개 소개', accent: '#000000', showAnnouncements: false },
      published: {
        intro: '게시된 행사 소개',
        accent: '#E76D26',
        showAnnouncements: true,
        showSchedule: true,
        showVenue: true,
        showPrograms: true,
        logo: null,
        keyvisual: null,
      },
      publishedAt: '2026-10-02T00:00:00.000Z',
    },
    branding: { tagline: '관리자 초안 안내', logo: null, keyvisual: null, privateBrandKey: 'secret' },
    notices: [
      { id: 'notice-public', title: '게시 공지', body: '참가 안내', published: true, pinned: true },
      { id: 'notice-draft', title: '비공개 초안 공지', body: '숨김', published: false },
    ],
    program: [
      { id: 'program-public', title: '게시 일정', date: '2026-10-20', start: '09:00', end: '10:00', place: '홀 A', published: true },
      { id: 'program-draft', title: '비공개 초안 일정', published: false },
    ],
    venue: { name: '공개 행사장', address: '서울', directions: '정문', contact: '안내 데스크', internalMemo: 'secret' },
    participants: [
      participant('person-own', '본인 참가자', ticketTokens.own),
      participant('person-other', '다른 참가자', ticketTokens.other),
      participant('person-revoked', '철회 참가자', ticketTokens.revoked, { revoked: true }),
      participant('person-expired', '만료 참가자', ticketTokens.expired, { ticketExpiresAt: '2020-01-01T00:00:00.000Z' }),
    ],
    desks: [{ id: 'desk-in', name: '등록 데스크', action: 'IN', actor: 'private-staff' }],
    assignments: [{ id: 'assignment-private', accountId: 'private-staff' }],
    checks: [{ id: 'check-private', participantId: 'person-other' }],
    visits: [{ id: 'visit-own', boothId: 'booth-1', participantId: 'person-own' }, { id: 'visit-other', participantId: 'person-other' }],
    booths: [{ id: 'booth-1', name: '체험 부스', zone: '로비', status: 'OPEN', capacity: 50, limit: 1, used: 2, code: 'private-booth-code' }],
    modules: [
      { id: 'poll-public', type: 'poll', title: '게시 투표', status: 'OPEN', options: ['A', 'B'], published: true, answer: 'private' },
      { id: 'qa-public', type: 'qa', title: '게시 Q&A', status: 'OPEN', published: true },
      { id: 'survey-draft', type: 'survey', title: '비공개 설문', status: 'DRAFT', published: false, questions: ['secret'] },
    ],
    responses: [
      { id: 'response-own', moduleId: 'poll-public', participantId: 'person-own', answer: 'A' },
      { id: 'response-other', moduleId: 'poll-public', participantId: 'person-other', answer: 'B' },
    ],
    questions: [
      { id: 'question-public', moduleId: 'qa-public', participantId: 'person-other', name: '공개 이름', text: '공개 질문', answer: '공개 답변', approved: true, likes: ['person-own', 'person-other'] },
      { id: 'question-draft', moduleId: 'qa-public', participantId: null, text: '검토 전 비공개 질문', approved: false },
    ],
    photos: [
      { id: 'photo-public', participantId: 'person-other', name: '사진 공개 이름', image: { data: 'data:image/png;base64,ZmFrZQ==' }, caption: '게시 사진', status: 'APPROVED' },
      { id: 'photo-draft', participantId: null, image: { data: 'data:image/png;base64,ZmFrZQ==' }, status: 'PENDING' },
      { id: 'photo-own-pending', participantId: 'person-own', name: '본인 참가자', image: { data: 'data:image/png;base64,ZmFrZQ==' }, caption: '본인 검토 사진', status: 'PENDING' },
    ],
    posts: [
      { id: 'post-public', participantId: 'person-other', name: '게시자', body: '공개 글', status: 'APPROVED' },
      { id: 'post-draft', participantId: null, body: '검토 전 비공개 글', status: 'PENDING' },
      { id: 'post-own-pending', participantId: 'person-own', name: '본인 참가자', body: '본인 검토 글', status: 'PENDING' },
    ],
    reports: [{ id: 'private-report', summary: 'secret report' }],
    payments: [{ id: 'payment-own', participantId: 'person-own', amount: 0, status: 'FREE' }, { id: 'payment-other', participantId: 'person-other', amount: 9999 }],
    rewards: [{ id: 'reward-own', participantId: 'person-own', name: '내 경품', status: 'READY' }, { id: 'reward-other', participantId: 'person-other', name: '다른 사람 경품' }],
    audit: [{ id: 'private-audit' }],
  };
}

function publicEvent(id, slug, name, stage) {
  return {
    id,
    slug,
    name,
    date: '2026-10-20',
    start: '09:00',
    end: '17:00',
    capacity: 20,
    stage,
    features: ['poll', 'qa', 'stamp', 'venue'],
    clientId: 'private-client-id',
    internalMemo: `private-event-${name}`,
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  await insertEvent(harness.database, {
    id: eventIds.live,
    slug: slugs.live,
    payload: publicEvent(eventIds.live, slugs.live, '공개 행사', 'LIVE'),
    workspace: publicWorkspace(),
  });
  await insertEvent(harness.database, {
    id: eventIds.draft,
    slug: slugs.draft,
    payload: publicEvent(eventIds.draft, slugs.draft, '초안 행사', 'DRAFT'),
    workspace: publicWorkspace(),
  });
  await insertEvent(harness.database, {
    id: eventIds.other,
    slug: slugs.other,
    payload: publicEvent(eventIds.other, slugs.other, '다른 행사', 'LIVE'),
    workspace: {
      ...publicWorkspace(),
      participants: [participant('person-cross-event', '행사 밖 참가자', ticketTokens.crossEvent)],
    },
  });
});

after(async () => {
  if (!harness) return;
  try {
    await deleteFixtureRows(harness.database, { eventIds: Object.values(eventIds) });
  } finally {
    await harness.close();
  }
});

test('public-event-api-returns-only-published-attendee-content-and-hides-drafts', async () => {
  const visible = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}`);
  assert.equal(visible.status, 200);
  assert.equal(visible.json.event.name, '공개 행사');
  assert.ok(!Object.hasOwn(visible.json.event, 'clientId'));
  assert.ok(!Object.hasOwn(visible.json.event, 'internalMemo'));
  assert.equal(visible.json.workspace.pageExperience.published.intro, '게시된 행사 소개');
  assert.ok(!Object.hasOwn(visible.json.workspace.pageExperience, 'draft'));
  assert.deepEqual(visible.json.workspace.notices.map((notice) => notice.title), ['게시 공지']);
  assert.deepEqual(visible.json.workspace.program.map((item) => item.title), ['게시 일정']);
  assert.deepEqual(visible.json.workspace.publishedFields.map((field) => field.id), ['name', 'company']);
  assert.deepEqual(visible.json.workspace.questions.map((question) => question.id), ['question-public']);
  assert.deepEqual(visible.json.workspace.photos.map((photo) => photo.id), ['photo-public']);
  assert.deepEqual(visible.json.workspace.posts.map((post) => post.id), ['post-public']);
  assert.deepEqual(visible.json.workspace.participants, []);
  assert.deepEqual(visible.json.workspace.assignments, []);
  assert.deepEqual(visible.json.workspace.checks, []);
  assert.deepEqual(visible.json.workspace.responses, []);
  assert.deepEqual(visible.json.workspace.payments, []);
  assert.ok(!JSON.stringify(visible.json).includes('비공개 초안'));
  assert.ok(!JSON.stringify(visible.json).includes('검토 전 비공개'));
  assert.ok(!visible.json.workspace.photos.some((photo) => photo.status !== 'APPROVED'));
  assert.ok(!visible.json.workspace.posts.some((post) => post.status !== 'APPROVED'));
  assert.ok(!JSON.stringify(visible.json).includes('private-report'));

  const draft = await requestJson(harness.baseUrl, `/api/public/events/${slugs.draft}`);
  assert.equal(draft.status, 404);
});

test('public-ticket-api-returns-only-the-matching-participant-and-their-own-data', async () => {
  const response = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.live}/ticket`,
    { bearer: ticketTokens.own }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.json.participant.id, 'person-own');
  assert.equal(response.json.participant.email, 'person-own@example.test');
  assert.deepEqual(response.json.workspace.participants.map((person) => person.id), ['person-own']);
  assert.deepEqual(response.json.workspace.responses.map((item) => item.id), ['response-own']);
  assert.deepEqual(response.json.workspace.visits.map((item) => item.id), ['visit-own']);
  assert.deepEqual(response.json.workspace.payments.map((item) => item.id), ['payment-own']);
  assert.deepEqual(response.json.workspace.rewards.map((item) => item.id), ['reward-own']);
  assert.ok(!JSON.stringify(response.json).includes('다른 참가자'));
  assert.ok(!JSON.stringify(response.json).includes('private-person-own'));
  assert.ok(!JSON.stringify(response.json).includes('private-audit'));
  assert.deepEqual(response.json.workspace.assignments, []);
  assert.deepEqual(response.json.workspace.checks, []);
  assert.deepEqual(response.json.workspace.photos.map((photo) => photo.id).sort(), ['photo-own-pending', 'photo-public']);
  assert.deepEqual(response.json.workspace.posts.map((post) => post.id).sort(), ['post-own-pending', 'post-public']);
  assert.equal(response.json.workspace.photos.find((photo) => photo.id === 'photo-own-pending').participantId, 'person-own');
  assert.equal(response.json.workspace.posts.find((post) => post.id === 'post-own-pending').participantId, 'person-own');
  assert.ok(!Object.hasOwn(response.json.workspace.photos.find((photo) => photo.id === 'photo-public'), 'participantId'));
  assert.ok(!Object.hasOwn(response.json.workspace.posts.find((post) => post.id === 'post-public'), 'participantId'));
});

test('public-ticket-api-rejects-missing-invalid-revoked-expired-and-cross-event-tickets', async () => {
  const valid = await requestJson(
    harness.baseUrl,
    `/api/public/events/${slugs.live}/ticket`,
    { bearer: ticketTokens.own }
  );
  assert.equal(valid.status, 200);
  const missing = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}/ticket`);
  assert.equal(missing.status, 404);
  const invalid = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}/ticket`, { bearer: 'not-a-ticket' });
  assert.equal(invalid.status, 404);
  const revoked = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}/ticket`, { bearer: ticketTokens.revoked });
  assert.equal(revoked.status, 404);
  const expired = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}/ticket`, { bearer: ticketTokens.expired });
  assert.equal(expired.status, 404);
  const crossEvent = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}/ticket`, { bearer: ticketTokens.crossEvent });
  assert.equal(crossEvent.status, 404);
});

test('public-event-api-projects-only-the-operator-display-selection', async () => {
  const idle = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}`);
  assert.deepEqual(idle.json.workspace.display, { type: 'idle', moduleId: null });

  await harness.database.query(
    `UPDATE event_workspaces
     SET payload = jsonb_set(payload, '{display}', $2::jsonb)
     WHERE event_id = $1`,
    [eventIds.live, JSON.stringify({
      type: 'notice', moduleId: null, noticeId: 'notice-public',
      at: '2026-10-20T00:00:00.000Z', internalFlag: 'secret',
    })]
  );
  const notice = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}`);
  assert.deepEqual(notice.json.workspace.display, {
    type: 'notice', moduleId: null, noticeId: 'notice-public',
  });

  await harness.database.query(
    `UPDATE event_workspaces
     SET payload = jsonb_set(payload, '{display}', $2::jsonb)
     WHERE event_id = $1`,
    [eventIds.live, JSON.stringify({ type: 'bogus', moduleId: 'x'.repeat(500), at: 'now' })]
  );
  const fallback = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}`);
  assert.deepEqual(fallback.json.workspace.display, { type: 'idle', moduleId: null });
});

test('public-poll-projection-carries-aggregate-counts-only', async () => {
  const event = await requestJson(harness.baseUrl, `/api/public/events/${slugs.live}`);
  const poll = event.json.workspace.modules.find((module) => module.id === 'poll-public');
  assert.ok(poll, 'the published poll is projected');
  // poll-public has response-other (B) and, for the ticket view, response-own (A);
  // the anonymous view counts both but never exposes who voted.
  assert.deepEqual(poll.options, ['A', 'B']);
  assert.deepEqual(poll.counts, [1, 1]);
  assert.ok(!JSON.stringify(event.json).includes('response-own'));
  assert.ok(!JSON.stringify(event.json).includes('response-other'));
});
