'use strict';

// BACKEND-ONLY behavioral coverage for event-scoped participant-home
// customization (pageExperience.homeStyle + draftVersion concurrency).
//
// No frontend, legacy-asset, docs, or script edits here: pure API +
// PostgreSQL behavior through the existing command routes.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  databaseUrl,
  startApiHarness,
  insertAccount,
  insertEvent,
  insertMembership,
  sessionCookie,
  requestJson,
  LEGACY_ORG,
} = require('./helpers/postgres-api-server.cjs');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');
const { DEFAULT_HOME_STYLE } = require('../server/attendee-home-style');

const test = databaseUrl
  ? nodeTest
  : (name, fn) => nodeTest(name, { skip: 'set EVENTOUCH_TEST_DATABASE_URL to an isolated PostgreSQL test database' }, fn);

const suffix = crypto.randomUUID().replace(/-/g, '');
const png = floorplanPng();
let harness;
const cookies = {};

const TICKET_A = `ET:themea:T-${'t'.repeat(40)}`;

function commandId() {
  return `theme-${crypto.randomUUID()}`;
}

function eventRef(tag) {
  return { id: `theme-${tag}-${suffix}`, slug: `theme-${tag}-${suffix}` };
}
const eventA = eventRef('a');
const eventB = eventRef('b');
const eventC = eventRef('c');

function participant(ticket) {
  return {
    id: `theme-person-${suffix}`,
    name: '테마 참가자',
    phone: '01012345678',
    email: '',
    company: '검증 소속',
    group: '일반',
    status: 'APPROVED',
    inside: false,
    everIn: false,
    revoked: false,
    ticket,
    ticketExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    registrationType: 'PRE',
    paymentStatus: 'FREE',
    answers: {},
    consent: null,
    createdAt: new Date().toISOString(),
  };
}

function pagePayload(overrides = {}) {
  return {
    intro: '홈 소개 문구',
    accent: '#123456',
    showAnnouncements: true,
    showSchedule: true,
    showVenue: true,
    showPrograms: true,
    ...overrides,
  };
}

const customStyle = {
  backgroundColor: '#112233',
  heroTitle: '한울의 밤',
  heroSubtitle: '함께 즐기는 축제',
  heroLayout: 'bottom-overlay',
  titleScale: 'large',
  imageFocus: 'top',
  textAlign: 'left',
  textTone: 'dark',
  overlay: 'soft',
};

async function createEvent(ref, { stage = 'READY', participants = [] } = {}) {
  await insertEvent(harness.database, {orgId: LEGACY_ORG,
    id: ref.id,
    slug: ref.slug,
    payload: {
      id: ref.id,
      slug: ref.slug,
      name: `테마 검증 행사 ${ref.id}`,
      clientId: null,
      date: '2026-12-01',
      start: '09:00',
      end: '17:00',
      capacity: 100,
      stage,
      features: [],
    },
    workspace: {
      participants,
      branding: { tagline: '행사 안내', logo: null, keyvisual: null },
    },
  });
}

async function readWorkspace(eventId) {
  const result = await harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id = $1',
    [eventId]
  );
  return result.rows[0].payload;
}

async function writeWorkspace(eventId, workspace) {
  await harness.database.query(
    'UPDATE event_workspaces SET payload = $2::jsonb WHERE event_id = $1',
    [eventId, JSON.stringify(workspace)]
  );
}

function managerCommand(eventId, command, payload, { actor = 'manager', id = commandId() } = {}) {
  return requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie: cookies[actor],
    body: { commandId: id, command, payload },
  });
}

async function uploadFile({ eventId, name = 'home.png', bytes = png, type = 'image/png', actor = 'manager', id = commandId() } = {}) {
  const headers = { 'content-type': type };
  if (cookies[actor]) headers.cookie = cookies[actor];
  const res = await fetch(
    `${harness.baseUrl}/api/events/${eventId}/files?name=${encodeURIComponent(name)}&commandId=${encodeURIComponent(id)}`,
    { method: 'POST', headers, body: bytes }
  );
  return { status: res.status, json: await res.json() };
}

async function publicEvent(slug) {
  return requestJson(harness.baseUrl, `/api/public/events/${slug}`);
}

async function ticketEvent(slug, ticket) {
  return requestJson(harness.baseUrl, `/api/public/events/${slug}/ticket`, { bearer: ticket });
}

async function bootstrap() {
  return requestJson(harness.baseUrl, '/api/bootstrap', { cookie: cookies.manager });
}

before(async () => {
  if (!databaseUrl) return;
  harness = await startApiHarness();
  for (const [key, role] of [
    ['agency', 'AGENCY'],
    ['manager', 'MANAGER'],
    ['other', 'MANAGER'],
    ['staff', 'STAFF'],
  ]) {
    await insertAccount(harness.database, {orgId: LEGACY_ORG,
      id: `theme-${key}-${suffix}`,
      role,
      name: `테마 ${key}`,
      email: `theme-${key}-${suffix}@example.test`,
    });
    cookies[key] = await sessionCookie(harness, `theme-${key}-${suffix}`);
  }
  await createEvent(eventA, { participants: [participant(TICKET_A)] });
  await createEvent(eventB);
  await createEvent(eventC);
  await insertMembership(harness.database, `theme-manager-${suffix}`, eventA.id, ['all']);
  await insertMembership(harness.database, `theme-manager-${suffix}`, eventB.id, ['all']);
  await insertMembership(harness.database, `theme-manager-${suffix}`, eventC.id, ['all']);
});

after(async () => {
  if (harness) await harness.close();
});

test('legacy events project the default homeStyle and hide draft state', async () => {
  for (const ref of [eventA, eventB]) {
    const res = await publicEvent(ref.slug);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json.workspace.pageExperience.published.homeStyle, DEFAULT_HOME_STYLE);
    assert.ok(!Object.hasOwn(res.json.workspace.pageExperience, 'draft'));
    assert.ok(!Object.hasOwn(res.json.workspace.pageExperience, 'draftVersion'));
    assert.ok(!Object.hasOwn(res.json.workspace.pageExperience, 'publishedVersion'));
  }
  const state = await readWorkspace(eventA.id);
  assert.equal(state.pageExperience, undefined);
});

test('manager save stages a draft while anon and ticket holders keep the old published theme', async () => {
  const saved = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ homeStyle: customStyle }));
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.draft.homeStyle, customStyle);
  assert.equal(saved.json.draftVersion, 1);

  const boot = await bootstrap();
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.json.state.workspaces[eventA.id].pageExperience.draft.homeStyle, customStyle);

  const anon = await publicEvent(eventA.slug);
  assert.deepEqual(anon.json.workspace.pageExperience.published.homeStyle, DEFAULT_HOME_STYLE);
  const ticket = await ticketEvent(eventA.slug, TICKET_A);
  assert.equal(ticket.status, 200, JSON.stringify(ticket.json));
  assert.deepEqual(ticket.json.workspace.pageExperience.published.homeStyle, DEFAULT_HOME_STYLE);
});

test('invalid homeStyle values reject with field errors and keep the draft version', async () => {
  const versionBefore = (await readWorkspace(eventA.id)).pageExperience.draftVersion;
  const cases = [
    [{ backgroundColor: 'red' }, 'homeStyle.backgroundColor'],
    [{ backgroundColor: '#GGGGGG' }, 'homeStyle.backgroundColor'],
    [{ backgroundColor: '#12345' }, 'homeStyle.backgroundColor'],
    [{ backgroundColor: 123456 }, 'homeStyle.backgroundColor'],
    [{ heroTitle: '가'.repeat(81) }, 'homeStyle.heroTitle'],
    [{ heroTitle: 'ok\x07bad' }, 'homeStyle.heroTitle'],
    [{ heroTitle: 123 }, 'homeStyle.heroTitle'],
    [{ heroSubtitle: '나'.repeat(101) }, 'homeStyle.heroSubtitle'],
    [{ heroSubtitle: 'bad\x1btext' }, 'homeStyle.heroSubtitle'],
    [{ heroSubtitle: null }, 'homeStyle.heroSubtitle'],
    [{ heroLayout: 'diagonal' }, 'homeStyle.heroLayout'],
    [{ titleScale: 'huge' }, 'homeStyle.titleScale'],
    [{ imageFocus: 'left' }, 'homeStyle.imageFocus'],
    [{ textAlign: 'justify' }, 'homeStyle.textAlign'],
    [{ textTone: 'neon' }, 'homeStyle.textTone'],
    [{ overlay: 'blur' }, 'homeStyle.overlay'],
    [{ heroLayout: null }, 'homeStyle.heroLayout'],
  ];
  for (const [style, field] of cases) {
    const res = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ homeStyle: style }));
    assert.equal(res.status, 400, JSON.stringify({ style, res: res.json }));
    assert.equal(res.json.field, field, JSON.stringify({ style, res: res.json }));
  }
  for (const bad of ['just-a-string', 42, ['centered']]) {
    const res = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ homeStyle: bad }));
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.field, 'homeStyle');
  }
  assert.equal((await readWorkspace(eventA.id)).pageExperience.draftVersion, versionBefore);
});

test('unknown homeStyle keys are ignored and lowercase hex is uppercased', async () => {
  const res = await managerCommand(
    eventA.id,
    'attendee.page.save',
    pagePayload({ homeStyle: { backgroundColor: '#b9def0', overlay: 'strong', injected: '<script>' } })
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.draft.homeStyle.backgroundColor, '#B9DEF0');
  assert.equal(res.json.draft.homeStyle.overlay, 'strong');
  assert.ok(!Object.hasOwn(res.json.draft.homeStyle, 'injected'));
  // Unrelated stored fields merge instead of resetting.
  assert.equal(res.json.draft.homeStyle.heroLayout, 'bottom-overlay');
  assert.equal(res.json.draftVersion, 2);
});

test('publish mirrors the draft theme to every viewer of the event only', async () => {
  // Restore the full custom style before publishing.
  const saved = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ homeStyle: customStyle }));
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const published = await managerCommand(eventA.id, 'attendee.page.publish', {});
  assert.equal(published.status, 200, JSON.stringify(published.json));
  assert.deepEqual(published.json.published.homeStyle, customStyle);
  assert.equal(published.json.publishedVersion, 3);
  assert.equal(published.json.draftVersion, 3);

  const first = await publicEvent(eventA.slug);
  const second = await publicEvent(eventA.slug);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, second.json);
  assert.deepEqual(first.json.workspace.pageExperience.published.homeStyle, customStyle);
  const ticket = await ticketEvent(eventA.slug, TICKET_A);
  assert.deepEqual(ticket.json.workspace.pageExperience.published.homeStyle, customStyle);

  const other = await publicEvent(eventB.slug);
  assert.deepEqual(other.json.workspace.pageExperience.published.homeStyle, DEFAULT_HOME_STYLE);
});

test('partial homeStyle updates merge and explicit null resets to defaults', async () => {
  const partial = await managerCommand(
    eventA.id, 'attendee.page.save', pagePayload({ homeStyle: { textAlign: 'right' } })
  );
  assert.equal(partial.status, 200, JSON.stringify(partial.json));
  assert.equal(partial.json.draft.homeStyle.textAlign, 'right');
  assert.equal(partial.json.draft.homeStyle.heroLayout, 'bottom-overlay');
  assert.equal(partial.json.draft.homeStyle.backgroundColor, '#112233');

  const reset = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ homeStyle: null }));
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.deepEqual(reset.json.draft.homeStyle, DEFAULT_HOME_STYLE);

  // The published theme is untouched until the next publish.
  const anon = await publicEvent(eventA.slug);
  assert.deepEqual(anon.json.workspace.pageExperience.published.homeStyle, customStyle);
});

test('page image upload, replace, and remove gate on publish with size, type, and scope checks', async () => {
  const up = await uploadFile({ eventId: eventA.id });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const fileId = up.json.file.fileId;

  // Private operator preview works on the stored file; the public gate stays closed on draft refs.
  const priv = await fetch(`${harness.baseUrl}/api/events/${eventA.id}/files/${fileId}`, {
    headers: { cookie: cookies.manager },
  });
  assert.equal(priv.status, 200);
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/${eventA.slug}/files/${fileId}`)).status,
    404
  );

  const drafted = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ keyvisual: { fileId } }));
  assert.equal(drafted.status, 200, JSON.stringify(drafted.json));
  assert.equal(drafted.json.draft.keyvisual.fileId, fileId);
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/${eventA.slug}/files/${fileId}`)).status,
    404
  );

  assert.equal((await managerCommand(eventA.id, 'attendee.page.publish', {})).status, 200);
  const pub = await fetch(`${harness.baseUrl}/api/public/events/${eventA.slug}/files/${fileId}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(Buffer.from(await pub.arrayBuffer()), png);

  // Replace: the new file stays private until the next publish.
  const up2 = await uploadFile({ eventId: eventA.id, name: 'home-2.png' });
  assert.equal(up2.status, 201);
  const fileId2 = up2.json.file.fileId;
  const replaced = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ keyvisual: { fileId: fileId2 } }));
  assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/${eventA.slug}/files/${fileId2}`)).status,
    404
  );
  assert.equal((await managerCommand(eventA.id, 'attendee.page.publish', {})).status, 200);
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/${eventA.slug}/files/${fileId2}`)).status,
    200
  );

  // Remove: clearing and publishing closes the public gate again.
  const cleared = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ clearKeyvisual: true }));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal((await managerCommand(eventA.id, 'attendee.page.publish', {})).status, 200);
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/${eventA.slug}/files/${fileId}`)).status,
    404
  );
  assert.equal(
    (await requestJson(harness.baseUrl, `/api/public/events/${eventA.slug}/files/${fileId2}`)).status,
    404
  );

  // Oversize (>600KB valid PNG) uploads but cannot be referenced.
  const oversize = await uploadFile({
    eventId: eventA.id, name: 'huge.png', bytes: Buffer.concat([png, Buffer.alloc(700000)]),
  });
  assert.equal(oversize.status, 201, JSON.stringify(oversize.json));
  const tooBig = await managerCommand(
    eventA.id, 'attendee.page.save', pagePayload({ keyvisual: { fileId: oversize.json.file.fileId } })
  );
  assert.equal(tooBig.status, 400);

  // Wrong types: raw text never uploads; a PDF uploads but cannot back a page image.
  assert.equal((await uploadFile({ eventId: eventA.id, name: 'note.txt', bytes: Buffer.from('hello'), type: 'text/plain' })).status, 400);
  const pdf = await uploadFile({
    eventId: eventA.id, name: 'doc.pdf', bytes: Buffer.from('%PDF-1.4 tiny'), type: 'application/pdf',
  });
  assert.equal(pdf.status, 201, JSON.stringify(pdf.json));
  const pdfRef = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ keyvisual: { fileId: pdf.json.file.fileId } }));
  assert.equal(pdfRef.status, 400);

  // Cross-event references are rejected.
  const foreign = await uploadFile({ eventId: eventB.id, name: 'foreign.png' });
  assert.equal(foreign.status, 201);
  const foreignRef = await managerCommand(eventA.id, 'attendee.page.save', pagePayload({ keyvisual: { fileId: foreign.json.file.fileId } }));
  assert.equal(foreignRef.status, 404);
});

test('optimistic concurrency rejects stale versions and replays stay byte-identical', async () => {
  const current = (await readWorkspace(eventA.id)).pageExperience.draftVersion;
  const staleSave = await managerCommand(
    eventA.id, 'attendee.page.save', pagePayload({ homeStyle: { overlay: 'soft' }, expectedDraftVersion: current - 1 })
  );
  assert.equal(staleSave.status, 409);
  assert.equal(staleSave.json.field, 'expectedDraftVersion');
  assert.equal(
    (await managerCommand(eventA.id, 'attendee.page.publish', { expectedDraftVersion: current - 1 })).status,
    409
  );

  const id = commandId();
  const first = await managerCommand(
    eventA.id, 'attendee.page.save', pagePayload({ homeStyle: { overlay: 'soft' }, expectedDraftVersion: current }), { id }
  );
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.draftVersion, current + 1);
  const replay = await managerCommand(
    eventA.id, 'attendee.page.save', pagePayload({ homeStyle: { overlay: 'soft' }, expectedDraftVersion: current }), { id }
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, first.json);
  assert.equal((await readWorkspace(eventA.id)).pageExperience.draftVersion, current + 1);

  const publishId = commandId();
  const published = await managerCommand(
    eventA.id, 'attendee.page.publish', { expectedDraftVersion: current + 1 }, { id: publishId }
  );
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const publishReplay = await managerCommand(
    eventA.id, 'attendee.page.publish', { expectedDraftVersion: current + 1 }, { id: publishId }
  );
  assert.equal(publishReplay.status, 200);
  assert.deepEqual(publishReplay.json, published.json);
});

test('staff, non-member, and anonymous writes are denied', async () => {
  assert.equal(
    (await managerCommand(eventA.id, 'attendee.page.save', pagePayload(), { actor: 'staff' })).status,
    403
  );
  assert.equal(
    (await managerCommand(eventA.id, 'attendee.page.publish', {}, { actor: 'staff' })).status,
    403
  );
  assert.equal(
    (await managerCommand(eventA.id, 'attendee.page.save', pagePayload(), { actor: 'other' })).status,
    403
  );
  assert.equal(
    (await managerCommand(eventA.id, 'attendee.page.publish', {}, { actor: 'other' })).status,
    403
  );
  const anonSave = await requestJson(harness.baseUrl, `/api/events/${eventA.id}/commands`, {
    method: 'POST',
    body: { commandId: commandId(), command: 'attendee.page.save', payload: pagePayload() },
  });
  assert.equal(anonSave.status, 401);
  const anonPublish = await requestJson(harness.baseUrl, `/api/events/${eventA.id}/commands`, {
    method: 'POST',
    body: { commandId: commandId(), command: 'attendee.page.publish', payload: {} },
  });
  assert.equal(anonPublish.status, 401);
});

test('publish validates a malicious stored draft instead of silently publishing it', async () => {
  const state = await readWorkspace(eventB.id);
  state.pageExperience = {
    draft: { intro: '소개', accent: '#123456', homeStyle: { heroLayout: 'evil', backgroundColor: 'red' } },
    draftVersion: 1,
  };
  await writeWorkspace(eventB.id, state);
  const rejected = await managerCommand(eventB.id, 'attendee.page.publish', {});
  assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
  assert.ok(String(rejected.json.field).startsWith('homeStyle'));

  // The public projection sanitizes the same row to defaults instead of failing.
  const anon = await publicEvent(eventB.slug);
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.json.workspace.pageExperience.published.homeStyle, DEFAULT_HOME_STYLE);

  // Resetting through the documented null contract recovers the draft.
  const recovered = await managerCommand(eventB.id, 'attendee.page.save', pagePayload({ homeStyle: null }));
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  assert.equal((await managerCommand(eventB.id, 'attendee.page.publish', {})).status, 200);
  assert.deepEqual((await publicEvent(eventB.slug)).json.workspace.pageExperience.published.homeStyle, DEFAULT_HOME_STYLE);
});

test('archived events deny page writes', async () => {
  assert.equal((await managerCommand(eventC.id, 'event.stage', { stage: 'ARCHIVED' })).status, 200);
  assert.equal((await managerCommand(eventC.id, 'attendee.page.save', pagePayload())).status, 409);
  assert.equal((await managerCommand(eventC.id, 'attendee.page.publish', {})).status, 409);
});

test('theme state survives an HTTP restart', async () => {
  const beforePublic = await publicEvent(eventA.slug);
  const beforeWorkspace = await readWorkspace(eventA.id);
  await harness.restartHttp();
  const afterPublic = await publicEvent(eventA.slug);
  assert.deepEqual(afterPublic.json, beforePublic.json);
  assert.deepEqual(await readWorkspace(eventA.id), beforeWorkspace);
});
