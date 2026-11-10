'use strict';

// Two simultaneous first-time requests have no common cookie. Their
// independent event grants must both survive the browser's Set-Cookie writes.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { databaseUrl, startApiHarness, insertEvent, requestJson, LEGACY_ORG } = require('./helpers/postgres-api-server.cjs');
const { createAttendeeAccess, attendeeCookieName } = require('../server/attendees');
const { mockOutbox, clearMockOutbox } = require('../server/verification-transport');
const test = databaseUrl ? nodeTest : (name, fn) => nodeTest(name, { skip: 'isolated PostgreSQL required' }, fn);

test('simultaneous first signups preserve independently restorable events', async () => {
  const h = await startApiHarness();
  try {
    const fields = [{ id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true }];
    for (const id of ['cookie-first-a', 'cookie-first-b']) {
      await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG,
        payload: { id, slug: id, name: id, date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
          consentVersion: 1, price: 0, verificationRequired: false } });
    }
    const sign = (slug) => requestJson(h.baseUrl, `/api/events/${slug}/signup`, {
      method: 'POST', body: { commandId: crypto.randomUUID(), formVersion: 1, consent: true,
        name: `합성 ${slug}`, phone: '01089004444' },
    });
    const results = await Promise.all(['cookie-first-a', 'cookie-first-b'].map(sign));
    assert.deepEqual(results.map(r => r.status), [201, 201]);
    const pairs = results.map(r => (r.headers.get('set-cookie') || '').split(';')[0]);
    assert.ok(pairs.every(Boolean));
    assert.notEqual(pairs[0].split('=')[0], pairs[1].split('=')[0], 'different event cookies must not overwrite one another');
    const cookie = pairs.join('; ');
    for (const [i, slug] of ['cookie-first-a', 'cookie-first-b'].entries()) {
      const response = await requestJson(h.baseUrl, `/api/public/events/${slug}/ticket`, { cookie });
      assert.equal(response.status, 200);
      assert.equal(response.json.participant.id, results[i].json.participant.id);
    }
    // A stable internal id, not a mutable slug, owns the cookie name.
    await h.database.query("UPDATE events SET slug=$2, payload=jsonb_set(payload, '{slug}', to_jsonb($2::text)) WHERE id=$1", ['cookie-first-a', 'cookie-first-renamed']);
    assert.equal((await requestJson(h.baseUrl, '/api/public/events/cookie-first-renamed/ticket', { cookie })).json.participant.id, results[0].json.participant.id);
    assert.equal((await requestJson(h.baseUrl, '/api/public/events/cookie-first-a/ticket', { cookie })).status, 404);
  } finally { await h.close(); }
});

test('concurrent verified identities keep their own bearer even when a same-event browser cookie changes', async () => {
  const h = await startApiHarness({ env: { EVENTOUCH_SMS_MOCK: '1' } });
  try {
    clearMockOutbox();
    const fields = [{ id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true }];
    for (const id of ['identity-race-a', 'identity-race-b']) {
      await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG,
        payload: { id, slug: id, name: id, date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
          consentVersion: 1, price: 0, verificationRequired: true } });
    }
    const people = [
      { slug: 'identity-race-a', phone: '01088001111', name: '합성 참가자 갑' },
      { slug: 'identity-race-a', phone: '01088002222', name: '합성 참가자 을' },
      { slug: 'identity-race-b', phone: '01088003333', name: '다른 행사 참가자' },
    ];
    const post = (slug, route, body, cookie) => requestJson(h.baseUrl, `/api/${route === 'signup' ? 'events' : 'public/events'}/${slug}/${route}`,
      { method: 'POST', body, cookie });
    const challenges = await Promise.all(people.map(p => post(p.slug, 'verification/request', { phone: p.phone, purpose: 'ENROLL' })));
    assert.deepEqual(challenges.map(r => r.status), [200, 200, 200]);
    const codes = people.map(p => mockOutbox.find(item => item.to === p.phone)?.code);
    assert.ok(codes.every(Boolean));
    const confirms = await Promise.all(people.map((p, i) => post(p.slug, 'verification/confirm', { phone: p.phone, code: codes[i] })));
    assert.deepEqual(confirms.map(r => r.status), [200, 200, 200]);
    assert.ok(confirms.every(r => typeof r.json.grant === 'string'));
    // A proof for another phone/event must neither create a participant nor
    // consume the proof intended for its real owner.
    const body = (p, grant) => ({ commandId: crypto.randomUUID(), formVersion: 1, consent: true,
      name: p.name, phone: p.phone, verificationGrant: grant });
    assert.equal((await post(people[0].slug, 'signup', body(people[0], confirms[1].json.grant))).status, 409);
    assert.equal((await post(people[2].slug, 'signup', body(people[2], confirms[0].json.grant))).status, 409);
    const signed = await Promise.all(people.map((p, i) => post(p.slug, 'signup', body(p, confirms[i].json.grant))));
    assert.deepEqual(signed.map(r => r.status), [201, 201, 201]);
    const pairs = signed.map(r => (r.headers.get('set-cookie') || '').split(';')[0]);
    assert.equal(pairs[0].split('=')[0], pairs[1].split('=')[0]);
    assert.notEqual(pairs[0].split('=')[0], pairs[2].split('=')[0]);
    const read = (slug, options) => requestJson(h.baseUrl, `/api/public/events/${slug}/ticket`, options);
    for (const last of [0, 1]) {
      const cookie = `${pairs[last]}; ${pairs[2]}`;
      assert.equal((await read(people[0].slug, { cookie })).json.participant.id, signed[last].json.participant.id,
        'session-only restoration reflects the last same-event cookie');
      assert.equal((await read(people[2].slug, { cookie })).json.participant.id, signed[2].json.participant.id);
      for (const i of [0, 1, 2]) {
        const result = await read(people[i].slug, { cookie, bearer: signed[i].json.participant.ticket });
        assert.equal(result.status, 200);
        assert.equal(result.json.participant.id, signed[i].json.participant.id, 'explicit ticket must choose its original identity');
      }
      assert.equal((await read(people[0].slug, { cookie, bearer: signed[2].json.participant.ticket })).status, 404,
        'another event bearer must never fall back to the session identity');
    }
    const state = (await h.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', ['identity-race-a'])).rows[0].payload;
    assert.equal(state.participants.length, 2);
  } finally { clearMockOutbox(); await h.close(); }
});

test('legacy common session coexists safely with a newer per-event identity', async () => {
  const h = await startApiHarness();
  try {
    const fields = [{ id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true }];
    for (const id of ['cookie-legacy-a', 'cookie-legacy-b']) {
      await insertEvent(h.database, { id, slug: id, orgId: LEGACY_ORG,
        payload: { id, slug: id, name: id, date: '2099-01-01', stage: 'READY', capacity: 20 },
        workspace: { participants: [], payments: [], registrationOpen: true, approvalRequired: false,
          formVersion: 1, publishedVersion: 1, fields, publishedFields: fields, consentText: '동의',
          consentVersion: 1, price: 0, verificationRequired: false } });
    }
    const sign = (slug, name, phone, cookie) => requestJson(h.baseUrl, `/api/events/${slug}/signup`, {
      method: 'POST', cookie, body: { commandId: crypto.randomUUID(), formVersion: 1, consent: true, name, phone },
    });
    const a = await sign('cookie-legacy-a', '이전 참가자', '01089004441');
    const b = await sign('cookie-legacy-b', '다른 행사 참가자', '01089004442');
    const current = await sign('cookie-legacy-a', '새 참가자', '01089004443');
    assert.deepEqual([a.status, b.status, current.status], [201, 201, 201]);
    const access = createAttendeeAccess(h.database);
    const eventA = { id: 'cookie-legacy-a', payload: { date: '2099-01-01' } };
    const eventB = { id: 'cookie-legacy-b', payload: { date: '2099-01-01' } };
    const common = await access.grantAccess({ event: eventA, participantId: a.json.participant.id, phone: '01089004441' });
    const legacyCookie = `etko_attendee=${common.token}`;
    await access.mergeGrant({ cookieHeader: legacyCookie, event: eventB, participantId: b.json.participant.id, phone: '01089004442' });
    const read = (slug, cookie) => requestJson(h.baseUrl, `/api/public/events/${slug}/ticket`, { cookie });
    assert.equal((await read('cookie-legacy-a', legacyCookie)).json.participant.id, a.json.participant.id);
    assert.equal((await read('cookie-legacy-b', legacyCookie)).json.participant.id, b.json.participant.id);
    const scoped = (current.headers.get('set-cookie') || '').split(';')[0];
    const combined = `${scoped}; ${legacyCookie}`;
    assert.equal((await read('cookie-legacy-a', combined)).json.participant.id, current.json.participant.id);
    // A supplied but invalid specific cookie must never select the common identity.
    assert.equal((await read('cookie-legacy-a', `${attendeeCookieName('cookie-legacy-a')}=invalid; ${legacyCookie}`)).status, 404);
    const changed = await sign('cookie-legacy-a', '다시 신청한 참가자', '01089004444', combined);
    assert.equal(changed.status, 201);
    const latest = (changed.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await read('cookie-legacy-a', `${latest}; ${legacyCookie}`)).json.participant.id, changed.json.participant.id);
    assert.equal((await read('cookie-legacy-a', legacyCookie)).status, 404, 'old common grant must not revive after the newer cookie disappears');
    assert.equal((await read('cookie-legacy-b', legacyCookie)).json.participant.id, b.json.participant.id, 'other event in the common session remains usable');
    // Two event updates sharing the old common session must not deadlock or
    // overwrite each other while each promotes its own scoped session.
    const previousB = (b.headers.get('set-cookie') || '').split(';')[0];
    const cookieJar = `${latest}; ${previousB}; ${legacyCookie}`;
    const both = await Promise.all([
      sign('cookie-legacy-a', '동시 전환 A', '01089004445', cookieJar),
      sign('cookie-legacy-b', '동시 전환 B', '01089004446', cookieJar),
    ]);
    assert.deepEqual(both.map(item => item.status), [201, 201]);
    const pairA = (both[0].headers.get('set-cookie') || '').split(';')[0];
    const pairB = (both[1].headers.get('set-cookie') || '').split(';')[0];
    const updatedJar = `${pairA}; ${pairB}; ${legacyCookie}`;
    assert.equal((await read('cookie-legacy-a', updatedJar)).json.participant.id, both[0].json.participant.id);
    assert.equal((await read('cookie-legacy-b', updatedJar)).json.participant.id, both[1].json.participant.id);
    assert.equal((await read('cookie-legacy-b', legacyCookie)).status, 404, 'promotion retires only the corresponding old grant');
    // A browser that only has an older common cookie can still migrate its
    // next verified event without losing the shared session.
    const legacyOnly = await sign('cookie-legacy-b', '이전 브라우저', '01089004447', legacyCookie);
    assert.equal(legacyOnly.status, 201);
    const migrated = (legacyOnly.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await read('cookie-legacy-b', migrated)).json.participant.id, legacyOnly.json.participant.id);
    assert.equal((await read('cookie-legacy-b', legacyCookie)).json.participant.id, legacyOnly.json.participant.id);
  } finally { await h.close(); }
});
