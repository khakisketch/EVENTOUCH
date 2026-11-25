'use strict';

// The participant side of a venue arrival: a phone that scanned a desk poster. Identity comes
// from this browser's attendee session (set at signup or phone verification), or else from the
// name and phone number together. Name and phone are weak proof, so that path never returns a
// ticket; the person is confirmed in front of the desk. Every refusal reads the same, so the
// page never tells a stranger whether someone is registered.
//
// A venue sends these all at once, so requests for one event are handled in batches: reads
// share one load, and arrivals share one locked write.

const crypto = require('node:crypto');
const { failure, list, clean, commandIdentifier, ticketHash } = require('./commands/shared.ts');
const { normalizeEvent, normalizeWorkspace, workspaceChangesForSave } = require('./state');
const { createClientAddressResolver } = require('./runtime-security.ts');
const { cookieToken } = require('./attendees');
const { createBatchQueue } = require('./event-queue');
const { indexLatestChecks } = require('../apps/web/lib/attendance-state.cjs');
const { normalizeContactPhone } = require('../apps/web/lib/contact-normalize.cjs');
const {
  arrivalBlockedOut, arrivalReview, deskTakesArrivals, openArrivalFor, recordArrival,
} = require('./arrivals');

const NOT_FOUND = '접수할 수 없습니다. 데스크에 말씀해 주세요.';
const SLOW_DOWN = '잠시 후 다시 시도하거나 데스크에 말씀해 주세요.';
const WINDOW_MS = 10 * 60_000;
// Wrong name-and-phone attempts. The tight limit is per address and number, so a stranger
// elsewhere cannot lock someone out with a few guesses; the per-number ceiling bounds guessing
// from many addresses. A venue (or a tunnel) shares one address, so that ceiling is wide.
const PAIR_LIMIT = 6;
const PHONE_LIMIT = 30;
const ADDRESS_LIMIT = 600;
// Pressing again at the same desk within this time changes nothing and writes nothing.
const REPEAT_QUIET_MS = 5 * 60_000;
// Desk changes one participant can cause in a window.
const MOVE_LIMIT = 6;

const phoneOf = (value) => normalizeContactPhone(value);
const sameName = (value) => String(value || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

// Counts attempts as they start, so a burst cannot slip past before any of them finishes.
function createAttemptWindow(limit, now = () => Date.now()) {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (entry && now() - entry.since < WINDOW_MS) return entry;
    entries.delete(key);
    return null;
  };
  return {
    full: (key) => (live(key)?.count || 0) >= limit,
    add(key) {
      if (entries.size > 5000) for (const [name] of entries) live(name);
      const entry = live(key) || { since: now(), count: 0 };
      entry.count += 1;
      entries.set(key, entry);
    },
    refund(key) {
      const entry = live(key);
      if (entry && entry.count > 0) entry.count -= 1;
    },
  };
}

function createPublicArrival({ database, env = process.env }) {
  const clientAddress = createClientAddressResolver(env);
  const byPair = createAttemptWindow(PAIR_LIMIT);
  const byPhone = createAttemptWindow(PHONE_LIMIT);
  const byAddress = createAttemptWindow(ADDRESS_LIMIT);
  const moves = createAttemptWindow(MOVE_LIMIT);

  // Returns the refund for a successful attempt, or null when a limit is reached.
  function attempt(slug, address, phone) {
    const counted = [[byPair, `${slug}|${address}|${phone}`], [byPhone, `${slug}|${phone}`], [byAddress, `${slug}|${address}`]];
    if (counted.some(([window, key]) => window.full(key))) return null;
    for (const [window, key] of counted) window.add(key);
    return () => { for (const [window, key] of counted) window.refund(key); };
  }

  async function sessionGrant(client, eventId, cookieHeader) {
    const token = cookieToken(cookieHeader, eventId);
    if (!token) return null;
    const found = await client.query(
      'SELECT grants FROM attendee_sessions WHERE token_hash = $1 AND expires_at > now() LIMIT 1',
      [crypto.createHash('sha256').update(token).digest('hex')]
    );
    return list(found.rows[0]?.grants).find((grant) => grant && String(grant.eventId) === String(eventId)) || null;
  }

  async function loadEvent(client, slug, lock) {
    const found = await client.query(
      `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision,
              w.payload AS workspace_payload, w.revision AS workspace_revision
       FROM events e JOIN event_workspaces w ON w.event_id = e.id
       WHERE e.slug = $1 ${lock ? 'FOR UPDATE OF e, w' : ''}`,
      [slug]
    );
    const row = found.rows[0];
    if (!row) return null;
    const event = normalizeEvent(row);
    if (!['READY', 'LIVE'].includes(String(event.stage || '').toUpperCase())) return null;
    const workspace = normalizeWorkspace(row.workspace_payload);
    const byId = new Map();
    const byNumber = new Map();
    for (const person of list(workspace.participants)) {
      if (!person || arrivalBlockedOut(person)) continue;
      byId.set(String(person.id), person);
      const number = phoneOf(person.phone);
      if (!number) continue;
      if (!byNumber.has(number)) byNumber.set(number, []);
      byNumber.get(number).push(person);
    }
    return { row, event, workspace, byId, byNumber, checkIndex: indexLatestChecks(workspace.checks) };
  }

  const entryDesk = (workspace, deskId) => list(workspace.desks).find((desk) => desk && String(desk.id) === deskId &&
    String(desk.action || '').toUpperCase() === 'IN') || null;

  function status(event, desk) {
    return {
      eventName: String(event.name || ''),
      deskName: String(desk.name || ''),
      open: String(event.stage || '').toUpperCase() === 'LIVE' && deskTakesArrivals(desk),
      nametag: desk.nametag !== false,
    };
  }

  const identity = (person) => ({ name: String(person.name || ''), company: String(person.company || '') });

  // The session's participant (only while the stored phone still matches), or the one person
  // whose name and phone both match.
  async function findPerson(client, loaded, request) {
    if (request.typed) {
      const matches = (loaded.byNumber.get(request.phone) || [])
        .filter((person) => sameName(person.name) === sameName(request.name));
      return matches.length === 1 ? matches[0] : null;
    }
    const grant = await sessionGrant(client, loaded.event.id, request.cookieHeader);
    const person = grant && loaded.byId.get(String(grant.participantId));
    return person && phoneOf(person.phone) === phoneOf(grant.phone) ? person : null;
  }

  const deskNotFound = () => failure(404, '안내판의 QR을 다시 확인해 주세요.', undefined, 'ARRIVAL_DESK_NOT_FOUND');
  const notMatched = () => failure(404, NOT_FOUND, undefined, 'ARRIVAL_NOT_MATCHED');
  const replayMismatch = () => failure(409, '같은 요청이 이미 다른 내용으로 처리되었습니다. 화면을 새로 고치세요.');

  // Unlocked: page openings, and the identity check before anything may take the event lock.
  const read = createBatchQueue((slug, requests) => database.transaction(async (client) => {
    const loaded = await loadEvent(client, slug, false);
    const outcomes = [];
    for (const request of requests) {
      const desk = loaded && entryDesk(loaded.workspace, request.deskId);
      if (!desk) { outcomes.push({ error: deskNotFound() }); continue; }
      const person = await findPerson(client, loaded, request);
      if (request.view) {
        // Opening the poster page: which desk this is, and who this browser belongs to.
        if (!person) { outcomes.push({ value: { ...status(loaded.event, desk), known: null } }); continue; }
        // Already waiting at this desk (a reload, or a signup made here): show that, not the button.
        const waiting = openArrivalFor(loaded.workspace, person.id);
        const state = person.inside === true ? 'inside'
          : waiting && String(waiting.deskId) === String(desk.id)
            ? (arrivalReview(loaded.workspace, person, loaded.checkIndex) ? 'review' : 'waiting') : null;
        outcomes.push({ value: { ...status(loaded.event, desk), known: { ...identity(person), state } } });
        continue;
      }
      outcomes.push({ value: { matched: Boolean(person) } });
    }
    return outcomes;
  }));

  // Locked: every arrival waiting for this event, in one transaction.
  const write = createBatchQueue((slug, requests) => database.transaction(async (client) => {
    const ids = [...new Set(requests.map((request) => request.id))].sort();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended(id, 0)) FROM unnest($1::text[]) AS id', [ids]);
    const loaded = await loadEvent(client, slug, true);
    if (!loaded) return requests.map(() => ({ error: deskNotFound() }));
    const { row, event, workspace } = loaded;
    const found = await client.query(
      'SELECT command_id, event_id, result FROM command_receipts WHERE command_id = ANY($1::text[])', [ids]);
    const receipts = new Map(found.rows.map((receipt) => [receipt.command_id, receipt]));
    const handled = new Map();
    const newReceipts = [];
    const now = new Date().toISOString();
    const before = structuredClone(workspace);
    let changed = false;

    async function arriveOne(request) {
      const desk = entryDesk(workspace, request.deskId);
      if (!desk) throw deskNotFound();
      const person = await findPerson(client, loaded, request);
      if (!person) throw notMatched();
      // The receipt stores no name or phone, so erasing a participant leaves nothing behind;
      // a replay is answered from the current record.
      const proof = ticketHash(JSON.stringify([slug, request.deskId, request.typed ? 'TYPED' : 'SESSION']));
      const earlier = handled.get(request.id);
      const receipt = receipts.get(request.id);
      if (earlier || receipt) {
        const saved = earlier || receipt.result;
        if ((receipt && String(receipt.event_id) !== String(event.id)) || saved.command !== 'arrival.self' ||
            saved.proof !== proof || String(saved.participantId) !== String(person.id)) throw replayMismatch();
        return { ...saved.response, ...identity(person) };
      }
      if (!status(event, desk).open) {
        throw failure(409, '지금은 이 데스크에서 접수를 받지 않습니다. 데스크에 말씀해 주세요.', undefined, 'DESK_CLOSED');
      }
      const answer = (result, at) => ({ result, deskName: String(at.name || ''), ...identity(person) });
      if (person.inside === true) return answer('inside', desk);
      const review = arrivalReview(workspace, person, loaded.checkIndex);
      const waitingResult = review ? 'review' : 'waiting';
      const current = openArrivalFor(workspace, person.id);
      if (current) {
        const holder = entryDesk(workspace, String(current.deskId));
        const sameDesk = String(current.deskId) === String(desk.id);
        // A tag already printed (or printing) elsewhere stays there: a phone must not print a second one.
        if (!sameDesk && (current.printedAt || current.printClaim) && deskTakesArrivals(holder)) {
          return answer(waitingResult, holder);
        }
        if (sameDesk && Date.parse(now) - Date.parse(current.at) < REPEAT_QUIET_MS) return answer(waitingResult, desk);
      }
      const moveKey = `${event.id}|${person.id}`;
      if (moves.full(moveKey)) throw failure(429, SLOW_DOWN, undefined, 'ARRIVAL_THROTTLED');
      moves.add(moveKey);
      // A phone only announces arrival, at every desk: the poster can be photographed, so
      // entry always needs the staff in front of the person (owner decision 2026-11-25).
      recordArrival(workspace, { participantId: person.id, deskId: desk.id, source: 'SELF', now });
      if (!Array.isArray(workspace.audit)) workspace.audit = [];
      workspace.audit.unshift({ id: request.id, type: 'arrival.self', actor: String(person.id), at: now, detail: '', eventId: event.id });
      changed = true;
      const saved = { command: 'arrival.self', proof, participantId: String(person.id),
        response: { result: waitingResult, deskName: String(desk.name || '') } };
      handled.set(request.id, saved);
      newReceipts.push({ command_id: request.id, result: saved });
      return answer(waitingResult, desk);
    }

    const outcomes = [];
    for (const request of requests) {
      try {
        outcomes.push({ value: await arriveOne(request) });
      } catch (error) {
        // Refusals are raised before anything changes; a database failure ends the batch.
        if (!error.status) throw error;
        outcomes.push({ error });
      }
    }
    if (changed) {
      await client.query(
        `UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1`,
        [event.id, JSON.stringify(workspaceChangesForSave(row.workspace_payload, before, workspace))]
      );
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         SELECT added.command_id, $1, NULL, $2, added.result
         FROM jsonb_to_recordset($3::jsonb) AS added(command_id text, result jsonb)`,
        [event.id, event.orgId || null, JSON.stringify(newReceipts)]
      );
    }
    return outcomes;
  }));

  async function arrive({ slug, deskId, commandId: rawId, name, phone, cookieHeader, address }) {
    const id = commandIdentifier(rawId);
    const typed = name !== undefined || phone !== undefined;
    const typedName = clean(name, 60);
    const typedPhone = phoneOf(phone);
    if (typed && (!typedName || typedPhone.length < 9 || typedPhone.length > 15)) {
      throw failure(400, '이름과 휴대폰 번호를 확인해 주세요.', !typedName ? 'name' : 'phone');
    }
    const request = { id, deskId, typed, name: typedName, phone: typedPhone, cookieHeader };
    let refund = () => {};
    if (typed) {
      refund = attempt(slug, address, typedPhone);
      if (!refund) {
        // A retry of an arrival already recorded must still learn its result.
        const done = await database.query(`SELECT 1 FROM command_receipts WHERE command_id = $1`, [id]);
        if (!done.rowCount) throw failure(429, SLOW_DOWN, undefined, 'ARRIVAL_THROTTLED');
        refund = () => {};
      }
    }
    // Only a request that names a real person may queue for the event lock.
    const { matched } = await read(slug, request);
    if (!matched) throw notMatched();
    refund();
    return write(slug, request);
  }

  async function handle({ slug, body, req }) {
    const input = body && typeof body === 'object' ? body : {};
    const deskId = clean(input.deskId, 120);
    const cookieHeader = req.headers.cookie;
    if (input.action === 'view') return read(slug, { view: true, deskId, typed: false, cookieHeader });
    if (input.action !== 'arrive') throw failure(400, '지원하지 않는 요청입니다.');
    return arrive({ slug, deskId, commandId: input.commandId, name: input.name, phone: input.phone, cookieHeader,
      address: clientAddress(req) });
  }

  return { handle };
}

module.exports = { createPublicArrival, createAttemptWindow };
