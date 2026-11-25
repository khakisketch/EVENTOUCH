'use strict';

// The participant side of a venue arrival: a phone that scanned a desk poster. Identity comes
// from this browser's attendee session (set at signup or phone verification), or else from the
// name and phone number together. Name and phone are weak proof, so that path never returns a
// ticket; the person is confirmed in front of the desk. Every refusal reads the same, so the
// page never tells a stranger whether someone is registered.

const crypto = require('node:crypto');
const { failure, list, clean, commandIdentifier, ticketHash } = require('./commands/shared.ts');
const { normalizeEvent, normalizeWorkspace, workspaceChangesForSave } = require('./state');
const { createClientAddressResolver } = require('./runtime-security.ts');
const { cookieToken } = require('./attendees');
const {
  arrivalBlockedOut, arrivalReview, closeArrivals, deskTakesArrivals, openArrivalFor, recordArrival,
} = require('./arrivals');

const NOT_FOUND = '접수할 수 없습니다. 데스크에 말씀해 주세요.';
const WINDOW_MS = 10 * 60_000;
// Per phone number and per network address. A venue shares one address, so that limit is wide.
const PHONE_LIMIT = 6;
const ADDRESS_LIMIT = 120;

const digits = (value) => String(value || '').replace(/\D/g, '');
const sameName = (left, right) => String(left || '').trim().replace(/\s+/g, '').toLowerCase() ===
  String(right || '').trim().replace(/\s+/g, '').toLowerCase();

function createFailureWindow(limit, now = () => Date.now()) {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (entry && now() - entry.since < WINDOW_MS) return entry;
    entries.delete(key);
    return null;
  };
  return {
    blocked: (key) => (live(key)?.count || 0) >= limit,
    record(key) {
      if (entries.size > 5000) for (const [name] of entries) live(name);
      const entry = live(key) || { since: now(), count: 0 };
      entry.count += 1;
      entries.set(key, entry);
    },
  };
}

function createPublicArrival({ database, env = process.env, appendCheck }) {
  const clientAddress = createClientAddressResolver(env);
  const byPhone = createFailureWindow(PHONE_LIMIT);
  const byAddress = createFailureWindow(ADDRESS_LIMIT);

  async function sessionGrant(client, eventId, cookieHeader) {
    const token = cookieToken(cookieHeader, eventId);
    if (!token) return null;
    const found = await client.query(
      'SELECT grants FROM attendee_sessions WHERE token_hash = $1 AND expires_at > now() LIMIT 1',
      [crypto.createHash('sha256').update(token).digest('hex')]
    );
    return list(found.rows[0]?.grants).find((grant) => grant && String(grant.eventId) === String(eventId)) || null;
  }

  // The session's participant, only while the stored phone still matches.
  function granted(workspace, grant) {
    if (!grant) return null;
    const person = list(workspace.participants).find((item) => item && String(item.id) === String(grant.participantId));
    return person && !arrivalBlockedOut(person) && digits(person.phone) === digits(grant.phone) ? person : null;
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
    return { row, event, workspace: normalizeWorkspace(row.workspace_payload) };
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

  // Opening the poster page: which desk this is, and who this browser belongs to (if anyone).
  async function view({ slug, deskId, cookieHeader }) {
    return database.transaction(async (client) => {
      const loaded = await loadEvent(client, slug, false);
      const desk = loaded && entryDesk(loaded.workspace, deskId);
      if (!desk) throw failure(404, '안내판의 QR을 다시 확인해 주세요.', undefined, 'ARRIVAL_DESK_NOT_FOUND');
      const person = granted(loaded.workspace, await sessionGrant(client, loaded.event.id, cookieHeader));
      if (!person) return { ...status(loaded.event, desk), known: null };
      // Already waiting at this desk (a reload, or a signup made here): show that, not the button.
      const waiting = openArrivalFor(loaded.workspace, person.id);
      const state = person.inside === true ? 'inside'
        : waiting && String(waiting.deskId) === String(desk.id)
          ? (arrivalReview(loaded.workspace, person) ? 'review' : 'waiting') : null;
      return { ...status(loaded.event, desk), known: { ...identity(person), state } };
    });
  }

  async function arrive({ slug, deskId, commandId: rawId, name, phone, cookieHeader, address }) {
    const id = commandIdentifier(rawId);
    const typed = name !== undefined || phone !== undefined;
    const typedName = clean(name, 60);
    const typedPhone = digits(phone);
    if (typed && (!typedName || typedPhone.length < 9 || typedPhone.length > 15)) {
      throw failure(400, '이름과 휴대폰 번호를 확인해 주세요.', !typedName ? 'name' : 'phone');
    }
    const phoneKey = `${slug}:${typedPhone}`;
    if (typed && (byPhone.blocked(phoneKey) || byAddress.blocked(address))) {
      throw failure(429, '잠시 후 다시 시도하거나 데스크에 말씀해 주세요.', undefined, 'ARRIVAL_THROTTLED');
    }
    const proof = ticketHash(JSON.stringify([slug, deskId, typed ? [typedName.toLowerCase(), typedPhone] : 'SESSION']));
    const outcome = await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      const loaded = await loadEvent(client, slug, true);
      const desk = loaded && entryDesk(loaded.workspace, deskId);
      if (!desk) throw failure(404, '안내판의 QR을 다시 확인해 주세요.', undefined, 'ARRIVAL_DESK_NOT_FOUND');
      const { row, event, workspace } = loaded;
      const receipt = (await client.query('SELECT event_id, result FROM command_receipts WHERE command_id = $1', [id])).rows[0];
      if (receipt) {
        if (String(receipt.event_id) !== String(event.id) || receipt.result?.command !== 'arrival.self' || receipt.result.proof !== proof) {
          throw failure(409, '같은 요청이 이미 다른 내용으로 처리되었습니다. 화면을 새로 고치세요.');
        }
        return { body: receipt.result.response };
      }
      if (!status(event, desk).open) throw failure(409, '지금은 이 데스크에서 접수를 받지 않습니다. 데스크에 말씀해 주세요.', undefined, 'DESK_CLOSED');

      let person = null;
      if (typed) {
        const matches = list(workspace.participants).filter((item) => item && !arrivalBlockedOut(item) &&
          digits(item.phone) === typedPhone && sameName(item.name, typedName));
        person = matches.length === 1 ? matches[0] : null;
      } else {
        person = granted(workspace, await sessionGrant(client, event.id, cookieHeader));
      }
      // Counted after the transaction: a rolled-back attempt must still count.
      if (!person) return { miss: true };

      const now = new Date().toISOString();
      const before = structuredClone(workspace);
      const review = arrivalReview(workspace, person);
      let result;
      if (person.inside === true) {
        result = 'inside';
      } else if (desk.nametag === false && !review) {
        // Nothing to hand over at this desk: the arrival is the entry.
        await appendCheck(client, workspace, event, { person, desk, id, now });
        closeArrivals(workspace, person.id, { checkId: id, now });
        result = 'entered';
      } else {
        recordArrival(workspace, { participantId: person.id, deskId: desk.id, source: 'SELF', now });
        result = review ? 'review' : 'waiting';
      }
      const body = { result, deskName: String(desk.name || ''), ...identity(person) };
      if (result !== 'inside') {
        if (!Array.isArray(workspace.audit)) workspace.audit = [];
        workspace.audit.unshift({ id, type: 'arrival.self', actor: String(person.id), at: now, detail: '', eventId: event.id });
        await client.query(
          `UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1`,
          [event.id, JSON.stringify(workspaceChangesForSave(row.workspace_payload, before, workspace))]
        );
      }
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result) VALUES ($1, $2, NULL, $3, $4::jsonb)`,
        [id, event.id, event.orgId || null, JSON.stringify({ command: 'arrival.self', proof, participantId: String(person.id), response: body })]
      );
      return { body };
    });
    if (outcome.miss) {
      if (typed) { byPhone.record(phoneKey); byAddress.record(address); }
      throw failure(404, NOT_FOUND, undefined, 'ARRIVAL_NOT_MATCHED');
    }
    return outcome.body;
  }

  async function handle({ slug, body, req }) {
    const input = body && typeof body === 'object' ? body : {};
    const deskId = clean(input.deskId, 120);
    const cookieHeader = req.headers.cookie;
    if (input.action === 'view') return view({ slug, deskId, cookieHeader });
    if (input.action !== 'arrive') throw failure(400, '지원하지 않는 요청입니다.');
    return arrive({ slug, deskId, commandId: input.commandId, name: input.name, phone: input.phone, cookieHeader,
      address: clientAddress(req) });
  }

  return { handle };
}

module.exports = { createPublicArrival, createFailureWindow };
