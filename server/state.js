'use strict';

const crypto = require('node:crypto');
const { publicWorkspace } = require('./public-events');
const { isCalendarDate, toCapacityNumber, isSafeIntegerCapacity } = require('./validation');

const ROLES = new Set(['AGENCY', 'MANAGER', 'STAFF']);
const ARRAY_FIELDS = [
  'participants', 'fields', 'publishedFields', 'notices', 'program', 'groups', 'desks', 'booths',
  'assignments', 'checks', 'visits', 'modules', 'responses', 'questions', 'photos', 'posts',
  'messages', 'reports', 'payments', 'rewards', 'audit',
];

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function denied() {
  return Object.assign(new Error('로그인이 필요합니다'), { status: 401 });
}

function rejected(status, message, field) {
  const error = new Error(message);
  error.status = status;
  if (field) error.field = field;
  return error;
}

function emptyWorkspace() {
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
    consentText: '행사 신청과 입장 확인을 위해 이름과 연락처를 사용합니다.',
    consentVersion: 1,
    notices: [],
    program: [],
    venue: { name: '', address: '', directions: '', contact: '', description: '' },
    groups: ['일반', 'VIP', '스태프'],
    desks: [],
    booths: [],
    boothMap: { draft: null, published: null },
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
    branding: { tagline: '행사 안내를 확인하세요.', logo: null, keyvisual: null },
    stampMode: 'STAFF',
    allowReentry: true,
    price: 0,
  };
}

function normalizeEvent(row) {
  const event = {
    id: String(row.id),
    name: '',
    slug: String(row.slug),
    clientId: row.client_id || null,
    date: '',
    start: '09:00',
    end: '17:00',
    capacity: 0,
    stage: 'DRAFT',
    features: [],
    ...object(row.payload),
    id: String(row.id),
    slug: String(row.slug),
    clientId: row.client_id || null,
    revision: Number(row.revision) || 0,
  };
  event.features = array(event.features).filter((feature) => typeof feature === 'string');
  return event;
}

function staffEvent(event) {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    date: event.date,
    start: event.start,
    end: event.end,
    capacity: event.capacity,
    stage: event.stage,
    features: copy(event.features),
    revision: event.revision,
  };
}

function normalizeWorkspace(value) {
  const source = object(value);
  const defaults = emptyWorkspace();
  const workspace = { ...defaults, ...copy(source) };
  for (const key of ARRAY_FIELDS) {
    workspace[key] = Array.isArray(source[key]) ? copy(source[key]) : copy(defaults[key]);
  }
  workspace.venue = { ...defaults.venue, ...object(source.venue) };
  workspace.branding = { ...defaults.branding, ...object(source.branding) };
  workspace.display = { ...defaults.display, ...object(source.display) };
  workspace.boothMap = { draft: null, published: null, ...object(source.boothMap) };
  return workspace;
}

function projectParticipant(workspace, event, participant) {
  if (!participant) return null;
  return publicWorkspace(workspace, event, participant).participants[0] || null;
}

function accountProjection(row, fullOrganization) {
  return {
    id: String(row.id),
    email: String(row.email || ''),
    name: String(row.name || ''),
    role: String(row.role),
    active: row.active === true,
    orgOwner: row.role === 'AGENCY',
    orgPermissions: fullOrganization && Array.isArray(row.org_permissions) ? copy(row.org_permissions) : [],
  };
}

function createState(database) {
  async function createEvent(account, input = {}) {
    const idempotencyKey = String(input.commandId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      throw rejected(400, '요청 식별자를 확인하세요', 'commandId');
    }

    const name = String(input.name || '').trim();
    const slug = String(input.slug || '').trim();
    const eventDate = String(input.date || '').trim();
    const start = String(input.start || '').trim();
    const end = String(input.end || '').trim();
    const capacity = toCapacityNumber(input.capacity);
    const clientId = input.clientId == null || input.clientId === '' ? null : String(input.clientId).trim();
    if (!name || name.length > 100) throw rejected(400, '행사명을 1~100자로 입력하세요', 'name');
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug)) throw rejected(400, '행사 주소 코드를 확인하세요', 'slug');
    if (!isCalendarDate(eventDate)) throw rejected(400, '행사 날짜 형식이 올바르지 않습니다', 'date');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
      throw rejected(400, '종료 시간은 시작 시간보다 늦어야 합니다', 'end');
    }
    if (!isSafeIntegerCapacity(capacity)) throw rejected(400, '정원은 0 이상의 정수로 입력하세요', 'capacity');
    if (clientId && clientId.length > 160) throw rejected(400, '고객사를 확인하세요', 'clientId');

    const request = { name, slug, date: eventDate, start, end, capacity, clientId };
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
        const accountResult = await client.query(
          'SELECT role, active FROM accounts WHERE id = $1 LIMIT 1 FOR SHARE',
          [String(account && account.id || '')]
        );
        const actor = accountResult.rows[0];
        if (!actor || actor.active !== true || !ROLES.has(actor.role)) throw denied();
        if (actor.role !== 'AGENCY') throw rejected(403, '행사 생성 권한을 확인하세요');

        const receiptResult = await client.query(
          'SELECT event_id, actor_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [idempotencyKey]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          const stored = object(receipt.result);
          const storedRequest = object(stored.request);
          const sameRequest = Object.keys(storedRequest).length === Object.keys(request).length &&
            Object.entries(request).every(([key, value]) => storedRequest[key] === value);
          if (String(receipt.actor_id || '') !== String(account.id) || stored.command !== 'event.create' ||
              !sameRequest || !stored.response?.event ||
              String(receipt.event_id || '') !== String(stored.response.event.id)) {
            throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
          }
          return { event: copy(stored.response.event), replayed: true };
        }

        if (clientId) {
          const clientResult = await client.query('SELECT 1 FROM clients WHERE id = $1 LIMIT 1', [clientId]);
          if (!clientResult.rowCount) throw rejected(400, '고객사를 확인하세요', 'clientId');
        }
        const duplicateSlug = await client.query('SELECT 1 FROM events WHERE slug = $1 LIMIT 1', [slug]);
        if (duplicateSlug.rowCount) throw rejected(409, '행사 주소 코드가 이미 사용 중입니다', 'slug');

        const eventId = `event-${crypto.randomUUID()}`;
        const payload = {
          id: eventId,
          name,
          slug,
          clientId,
          date: eventDate,
          start,
          end,
          capacity,
          stage: 'DRAFT',
          features: [],
        };
        const event = normalizeEvent({ id: eventId, slug, client_id: clientId, payload, revision: 0 });
        await client.query(
          'INSERT INTO events (id, slug, client_id, payload) VALUES ($1, $2, $3, $4::jsonb)',
          [eventId, slug, clientId, JSON.stringify(payload)]
        );
        await client.query(
          'INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)',
          [eventId, JSON.stringify(emptyWorkspace())]
        );
        const response = { event };
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, result)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [idempotencyKey, eventId, account.id, JSON.stringify({ command: 'event.create', request, response })]
        );
        return { event, replayed: false };
      });
    } catch (error) {
      if (error && error.code === '23505') throw rejected(409, '행사 주소 코드가 이미 사용 중입니다', 'slug');
      throw error;
    }
  }

  async function loadBootstrap(account) {
    const accountId = account && typeof account.id === 'string' ? account.id.trim() : '';
    if (!accountId) throw denied();

    return database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const accountResult = await client.query(
        `SELECT id, email, name, role, active, org_permissions
         FROM accounts WHERE id = $1 LIMIT 1`,
        [accountId]
      );
      const actor = accountResult.rows[0];
      if (!actor || actor.active !== true || !ROLES.has(actor.role)) throw denied();

      let eventQuery;
      let eventValues = [];
      if (actor.role === 'AGENCY') {
        eventQuery = `SELECT e.id, e.slug, e.client_id, e.payload, e.revision, e.created_at,
                             w.payload AS workspace_payload, w.revision AS workspace_revision
                      FROM events e LEFT JOIN event_workspaces w ON w.event_id = e.id
                      ORDER BY e.created_at, e.id`;
      } else if (actor.role === 'MANAGER') {
        eventQuery = `SELECT DISTINCT e.id, e.slug, e.client_id, e.payload, e.revision, e.created_at,
                             w.payload AS workspace_payload, w.revision AS workspace_revision
                      FROM events e JOIN memberships m ON m.event_id = e.id
                      LEFT JOIN event_workspaces w ON w.event_id = e.id
                      WHERE m.account_id = $1 ORDER BY e.created_at, e.id`;
        eventValues = [actor.id];
      } else {
        eventQuery = `SELECT DISTINCT e.id, e.slug, e.client_id, e.payload, e.revision, e.created_at,
                             w.payload AS workspace_payload, w.revision AS workspace_revision
                      FROM events e JOIN staff_assignments a ON a.event_id = e.id
                      LEFT JOIN event_workspaces w ON w.event_id = e.id
                      WHERE a.account_id = $1 AND a.active = true ORDER BY e.created_at, e.id`;
        eventValues = [actor.id];
      }
      const eventResult = await client.query(eventQuery, eventValues);
      const rows = eventResult.rows;
      const events = rows.map(normalizeEvent);
      const projectedEvents = actor.role === 'STAFF' ? events.map(staffEvent) : events;
      const eventIds = events.map((event) => event.id);

      let assignmentResult;
      if (actor.role === 'AGENCY') {
        assignmentResult = await client.query(
          `SELECT id, account_id, event_id, type, target_id
           FROM staff_assignments WHERE active = true ORDER BY event_id, id`
        );
      } else if (actor.role === 'MANAGER') {
        assignmentResult = await client.query(
          `SELECT id, account_id, event_id, type, target_id
           FROM staff_assignments WHERE active = true AND event_id = ANY($1::text[]) ORDER BY event_id, id`,
          [eventIds]
        );
      } else {
        assignmentResult = await client.query(
          `SELECT id, account_id, event_id, type, target_id
           FROM staff_assignments WHERE active = true AND account_id = $1 AND event_id = ANY($2::text[]) ORDER BY event_id, id`,
          [actor.id, eventIds]
        );
      }
      const assignments = assignmentResult.rows.map((row) => ({
        id: String(row.id),
        accountId: String(row.account_id),
        type: String(row.type),
        targetId: String(row.target_id),
      }));
      const assignmentsByEvent = new Map();
      for (const assignment of assignments) {
        const row = assignmentResult.rows.find((item) => String(item.id) === assignment.id);
        const list = assignmentsByEvent.get(String(row.event_id)) || [];
        list.push(assignment);
        assignmentsByEvent.set(String(row.event_id), list);
      }

      let membershipQuery;
      let membershipValues;
      if (actor.role === 'AGENCY') {
        membershipQuery = 'SELECT account_id, event_id, write_permissions FROM memberships ORDER BY event_id, account_id';
        membershipValues = [];
      } else if (actor.role === 'MANAGER') {
        membershipQuery = `SELECT account_id, event_id, write_permissions
                            FROM memberships WHERE event_id = ANY($1::text[]) ORDER BY event_id, account_id`;
        membershipValues = [eventIds];
      } else {
        membershipQuery = `SELECT account_id, event_id, write_permissions
                            FROM memberships WHERE account_id = $1 AND event_id = ANY($2::text[]) ORDER BY event_id`;
        membershipValues = [actor.id, eventIds];
      }
      const membershipResult = await client.query(membershipQuery, membershipValues);
      const memberships = membershipResult.rows.map((row) => ({
        accountId: String(row.account_id),
        eventId: String(row.event_id),
        write: Array.isArray(row.write_permissions) ? copy(row.write_permissions) : [],
      }));

      let accountQuery;
      let accountValues;
      if (actor.role === 'AGENCY') {
        accountQuery = `SELECT id, email, name, role, active, org_permissions
                        FROM accounts ORDER BY created_at, id`;
        accountValues = [];
      } else if (actor.role === 'MANAGER') {
        accountQuery = `SELECT DISTINCT a.id, a.email, a.name, a.role, a.active, a.org_permissions
                        FROM accounts a
                        WHERE a.id = $1
                           OR a.id IN (SELECT account_id FROM memberships WHERE event_id = ANY($2::text[]))
                           OR a.id IN (SELECT account_id FROM staff_assignments WHERE event_id = ANY($2::text[]))
                        ORDER BY a.id`;
        accountValues = [actor.id, eventIds];
      } else {
        accountQuery = `SELECT id, email, name, role, active, org_permissions
                        FROM accounts WHERE id = $1 LIMIT 1`;
        accountValues = [actor.id];
      }
      const accountRows = (await client.query(accountQuery, accountValues)).rows;
      const accounts = accountRows.map((row) => accountProjection(row, actor.role === 'AGENCY'));

      const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean).map(String))];
      let clients = [];
      if (actor.role === 'AGENCY') {
        clients = (await client.query('SELECT id, payload FROM clients ORDER BY id')).rows.map((row) => ({
          ...object(copy(row.payload)),
          id: String(row.id),
        }));
      } else if (clientIds.length) {
        clients = (await client.query('SELECT id, payload FROM clients WHERE id = ANY($1::text[]) ORDER BY id', [clientIds])).rows.map((row) => ({
          id: String(row.id),
          name: String(object(row.payload).name || ''),
        }));
      }

      let invitations = [];
      if (actor.role === 'AGENCY') {
        invitations = (await client.query(
          `SELECT id, email, name, role, event_id, status, expires_at, created_at
           FROM invitations ORDER BY created_at, id`
        )).rows.map((row) => ({
          id: String(row.id),
          email: String(row.email),
          name: String(row.name),
          role: String(row.role),
          eventId: row.event_id ? String(row.event_id) : null,
          status: String(row.status),
          expiresAt: new Date(row.expires_at).toISOString(),
          at: new Date(row.created_at).toISOString(),
        }));
      }

      const workspaces = {};
      for (const row of rows) {
        const event = events.find((item) => item.id === String(row.id));
        const workspace = normalizeWorkspace(row.workspace_payload);
        const eventAssignments = assignmentsByEvent.get(String(row.id)) || [];
        workspace.assignments = copy(eventAssignments);
        if (actor.role === 'STAFF') {
          const deskIds = new Set(eventAssignments.filter((item) => item.type === 'DESK').map((item) => item.targetId));
          const boothIds = new Set(eventAssignments.filter((item) => item.type === 'BOOTH').map((item) => item.targetId));
          const projected = publicWorkspace(workspace, event);
          projected.participants = deskIds.size ? array(workspace.participants).map((person) => ({
            id: String(person.id || ''),
            name: String(person.name || ''),
            company: String(person.company || ''),
            group: String(person.group || ''),
            status: String(person.status || ''),
            inside: person.inside === true,
            everIn: person.everIn === true,
            paymentStatus: String(person.paymentStatus || ''),
          })) : [];
          projected.desks = array(workspace.desks).filter((desk) => deskIds.has(String(desk.id))).map((desk) => ({
            id: String(desk.id), name: String(desk.name || ''), action: String(desk.action || ''),
          }));
          projected.booths = array(workspace.booths).filter((booth) => boothIds.has(String(booth.id))).map((booth) => ({
            id: String(booth.id), name: String(booth.name || ''), zone: String(booth.zone || ''), status: String(booth.status || ''),
          }));
          projected.assignments = copy(eventAssignments);
          projected.checks = deskIds.size ? array(workspace.checks).filter((check) => deskIds.has(String(check.deskId))).map((check) => ({
            id: String(check.id || ''), participantId: String(check.participantId || ''), name: String(check.name || ''),
            action: String(check.action || ''), deskId: String(check.deskId || ''), at: String(check.at || ''), corrected: check.corrected === true,
          })) : [];
          projected.visits = boothIds.size ? array(workspace.visits).filter((visit) => boothIds.has(String(visit.boothId))).map((visit) => ({
            id: String(visit.id || ''), boothId: String(visit.boothId || ''), participantId: String(visit.participantId || ''), at: String(visit.at || ''),
          })) : [];
          workspaces[String(row.id)] = projected;
        } else {
          workspaces[String(row.id)] = workspace;
        }
      }

      const revision = rows.reduce((max, row) => Math.max(max, Number(row.revision) || 0, Number(row.workspace_revision) || 0), 0);
      return {
        version: 9,
        revision,
        activeEventId: projectedEvents[0] ? projectedEvents[0].id : null,
        events: projectedEvents,
        workspaces,
        clients,
        accounts,
        memberships,
        invitations,
        globalAudit: [],
        commands: [],
      };
    });
  }

  return { loadBootstrap, createEvent };
}

module.exports = { createState, emptyWorkspace, normalizeEvent, normalizeWorkspace, projectParticipant };
