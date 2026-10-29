'use strict';

const crypto = require('node:crypto');
const { publicWorkspace } = require('./public-events');
const { isCalendarDate, toCapacityNumber, isSafeIntegerCapacity } = require('./validation');

const ROLES = new Set(['AGENCY', 'MANAGER', 'STAFF']);
// Mirrors the console's permission vocabulary so a stored grant can never be
// one the UI cannot name.
const ORG_PERMISSIONS = new Set(['events.all', 'events.view', 'events.create', 'clients.manage', 'team.manage', 'integrations.manage']);
const { EVENT_PERMISSIONS } = require('./event-permissions');
const ARRAY_FIELDS = [
  'participants', 'fields', 'publishedFields', 'notices', 'program', 'groups', 'desks', 'booths',
  'assignments', 'checks', 'visits', 'modules', 'responses', 'questions', 'photos', 'posts',
  'messages', 'reports', 'payments', 'rewards', 'audit', 'evidencePhotos',
  'luckyNumbers', 'rouletteResults', 'teams', 'votes', 'drawPrograms',
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
    evidencePhotos: [],
    luckyNumbers: [],
    rouletteResults: [],
    teams: [],
    votes: [],
    // New events start closed/bounded: voting needs an explicit OPEN, the
    // roulette needs configured prizes, lucky numbers stay in a bounded pool.
    // Genuinely legacy rows (stored before these keys existed) keep behaving
    // as before — see normalizeWorkspace, which maps absent keys to null.
    voteConfig: { pickCount: 5, status: 'CLOSED', resultsPublished: false },
    rouletteConfig: { prizes: [], status: 'CLOSED', startsAt: null, endsAt: null },
    luckyConfig: { min: 1, max: 900 },
    drawPrograms: [],
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
    orgId: row.org_id !== undefined && row.org_id !== null ? String(row.org_id) : null,
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
    orgId: row.org_id === undefined || row.org_id === null ? null : String(row.org_id),
    revision: Number(row.revision) || 0,
  };
  event.features = array(event.features).filter((feature) => typeof feature === 'string');
  return event;
}

// Event format is display metadata only ('진행 형태(선택)'): offline (현장),
// online, hybrid, or an absent key when unspecified. It never changes URLs,
// streaming, features, venue requirements, or stages, and the normalizer
// never invents a value for legacy rows that predate the key.
const EVENT_FORMATS = new Set(['offline', 'online', 'hybrid']);

function normalizeEventFormat(value) {
  return typeof value === 'string' && EVENT_FORMATS.has(value) ? value : null;
}

// Write-side parsing. Returns undefined for "not provided" (the caller
// decides keep-vs-clear), null for an explicit '' clear, or the stored
// value. Only the exact lowercase kinds store; anything else is a 400 with
// field=format.
function parseEventFormatInput(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw rejected(400, '진행 형태를 확인하세요', 'format');
  if (value === '') return null;
  if (!EVENT_FORMATS.has(value)) throw rejected(400, '진행 형태를 확인하세요', 'format');
  return value;
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
  // Absent capability config means "never configured" (a row stored before
  // the keys existed): keep it null so legacy behavior is preserved in
  // memory and on save. Only an explicitly stored object engages the gates.
  for (const key of ['voteConfig', 'rouletteConfig', 'luckyConfig']) {
    if (!Object.hasOwn(source, key)) workspace[key] = null;
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
    // Shared global identity (memberships in more than one org, however
    // flagged): boolean only, never the other orgs' names. Lets the console
    // explain why a global reset is blocked without leaking anything.
    ...(fullOrganization && row.shared_account !== undefined
      ? { sharedAccount: row.shared_account === true }
      : {}),
    // The target membership row's revision is the expected-version guard for
    // role/active writes (server/auth.js setOrgMembership). It is scoped to
    // this org and is not the session's organization selection revision.
    ...(row.membership_version !== undefined && row.membership_version !== null
      ? { membershipVersion: Number(row.membership_version) || 0 }
      : {}),
  };
}

function createState(database) {
  // Duplicating an event copies configuration and program definitions — never
  // runtime records. Participants, tickets, check-ins, visits, messages,
  // responses, rewards, audit entries and lucky numbers stay with the source
  // event. Stored files are addressed per event, so copied content never keeps
  // a file reference (branding logo/keyvisual, program attachments, booth-map
  // images); those are cleared instead of producing a 404 in the new event.
  // Copied content also starts closed: DRAFT stage, registrationOpen false,
  // booths closed, modules DRAFT/unpublished.
  const DUPLICATE_WORKSPACE_KEYS = [
    'fields', 'publishedFields', 'consentText', 'consentVersion', 'groups',
    'venue', 'stampMode', 'allowReentry', 'price',
  ];

  function duplicatedNotice(item) {
    const notice = copy(object(item));
    delete notice.attachment;
    delete notice.fileId;
    notice.published = false;
    return notice;
  }

  function duplicatedProgram(item) {
    const program = copy(object(item));
    program.attachment = null;
    delete program.fileId;
    program.published = false;
    return program;
  }

  function duplicatedModule(item) {
    const module = copy(object(item));
    module.status = 'DRAFT';
    module.published = false;
    module.revealed = false;
    delete module.attachment;
    delete module.fileId;
    delete module.image;
    return module;
  }

  function duplicatedDesk(item) {
    const desk = copy(object(item));
    desk.open = false;
    return desk;
  }

  function duplicatedBooth(item) {
    const booth = copy(object(item));
    booth.used = 0;
    booth.status = 'CLOSED';
    return booth;
  }

  function duplicatedWorkspace(source) {
    const target = emptyWorkspace();
    for (const key of DUPLICATE_WORKSPACE_KEYS) {
      if (source[key] !== undefined) target[key] = copy(source[key]);
    }
    target.formVersion = Number(source.formVersion) || 1;
    target.publishedVersion = Number(source.publishedVersion) || 0;
    target.registrationOpen = false;
    if (source.verificationRequired === true) target.verificationRequired = true;
    const branding = object(source.branding);
    if (typeof branding.tagline === 'string' && branding.tagline) {
      target.branding = { ...target.branding, tagline: branding.tagline };
    }
    target.notices = array(source.notices).map(duplicatedNotice);
    target.program = array(source.program).map(duplicatedProgram);
    target.modules = array(source.modules).map(duplicatedModule);
    target.desks = array(source.desks).map(duplicatedDesk);
    target.booths = array(source.booths).map(duplicatedBooth);
    return target;
  }

  // Per-request org authority for reads and writes. The session account
  // carries header hints (requestedOrgId/expectedVersion); the membership
  // table decides. Errors keep their {status, code} for the UI contract.
  async function resolveStateOrg(client, account, forWrite = true) {
    const { resolveActorOrg } = require('./tenancy');
    try {
      return await resolveActorOrg(client, account, { requireHeaders: forWrite });
    } catch (error) {
      throw withOrgCode(error);
    }
  }

  // Normalizes an org-authority failure onto rejected() without dropping the
  // machine code the UI contract keys on (ORGANIZATION_CONTEXT_CHANGED etc.).
  function withOrgCode(error) {
    if (!error || !error.status) return error;
    const mapped = rejected(error.status, error.message, error.field);
    if (error.code) mapped.code = error.code;
    return mapped;
  }

  // Provider credentials bound to this deployment belong to the legacy org
  // only and are never inherited by new orgs: their console reports
  // disconnected until an explicit per-org credential story ships.
  function integrationsForOrg(orgId) {
    const { LEGACY_ORG_ID } = require('./tenancy');
    if (String(orgId) === String(LEGACY_ORG_ID)) return require('./messaging').activeMessagingState();
    return { connected: false, sender: null, orgIsolated: true };
  }

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
    const formatInput = parseEventFormatInput(input.format);
    // Unspecified stays exactly the legacy 7-field shape: no unconditional
    // format:null, so an old nonce retried without format still replays.
    // A specified format joins the fingerprint, so the same nonce with a
    // different format is a 409 conflict, not a silent overwrite.
    const format = formatInput === undefined ? null : formatInput;

    const request = { name, slug, date: eventDate, start, end, capacity, clientId };
    if (format !== null) request.format = format;
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
        const { resolveActorOrg, checkReceiptScope, requireClientInOrg, requireEventInOrg } = require('./tenancy');
        let org;
        try {
          org = await resolveActorOrg(client, account);
        } catch (error) {
          throw withOrgCode(error);
        }
        const receiptResult = await client.query(
          'SELECT event_id, actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [idempotencyKey]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          try {
            checkReceiptScope(receipt, org.orgId);
          } catch (scopeError) {
            throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
          }
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
        if (org.role !== 'AGENCY') throw rejected(403, '행사 생성 권한을 확인하세요');

        if (clientId) {
          try {
            await requireClientInOrg(client, clientId, org.orgId);
          } catch (error) {
            if (error && error.code === 'ORGANIZATION_CONTEXT_CHANGED') throw error;
            throw rejected(400, '고객사를 확인하세요', 'clientId');
          }
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
          ...(format !== null ? { format } : {}),
        };
        const event = normalizeEvent({ id: eventId, slug, client_id: clientId, org_id: org.orgId, payload, revision: 0 });
        await client.query(
          'INSERT INTO events (id, slug, client_id, org_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [eventId, slug, clientId, org.orgId, JSON.stringify(payload)]
        );
        await client.query(
          'INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)',
          [eventId, JSON.stringify(emptyWorkspace())]
        );
        const response = { event };
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [idempotencyKey, eventId, account.id, org.orgId, JSON.stringify({ command: 'event.create', request, response })]
        );
        return { event, replayed: false };
      });
    } catch (error) {
      if (error && error.code === '23505') throw rejected(409, '행사 주소 코드가 이미 사용 중입니다', 'slug');
      throw error;
    }
  }

  // Organization-scope write like event.create: AGENCY only, one idempotency
  // receipt per commandId, and a request fingerprint that lets a lost-response
  // retry replay the same duplicate instead of creating a second copy.
  async function duplicateEvent(account, sourceEventId, input = {}) {
    const idempotencyKey = String(input.commandId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      throw rejected(400, '요청 식별자를 확인하세요', 'commandId');
    }
    const sourceId = String(sourceEventId || '').trim();
    if (!sourceId || sourceId.length > 160) throw rejected(404, '행사를 찾을 수 없습니다');
    const request = {
      sourceId,
      name: input.name === undefined ? '' : String(input.name || '').trim(),
      slug: input.slug === undefined ? '' : String(input.slug || '').trim(),
      date: input.date === undefined ? '' : String(input.date || '').trim(),
      start: input.start === undefined ? '' : String(input.start || '').trim(),
      end: input.end === undefined ? '' : String(input.end || '').trim(),
      capacity: input.capacity === undefined ? null : toCapacityNumber(input.capacity),
    };
    try {
      return await database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
        const { resolveActorOrg, checkReceiptScope, requireClientInOrg, requireEventInOrg } = require('./tenancy');
        let org;
        try {
          org = await resolveActorOrg(client, account);
        } catch (error) {
          throw withOrgCode(error);
        }
        const receiptResult = await client.query(
          'SELECT event_id, actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
          [idempotencyKey]
        );
        if (receiptResult.rowCount) {
          const receipt = receiptResult.rows[0];
          try {
            checkReceiptScope(receipt, org.orgId);
          } catch (scopeError) {
            throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
          }
          const stored = object(receipt.result);
          const storedRequest = object(stored.request);
          const sameRequest = Object.keys(storedRequest).length === Object.keys(request).length &&
            Object.entries(request).every(([key, value]) => storedRequest[key] === value);
          if (String(receipt.actor_id || '') !== String(account.id) || stored.command !== 'event.duplicate' ||
              !sameRequest || !stored.response?.event ||
              String(receipt.event_id || '') !== String(stored.response.event.id)) {
            throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
          }
          return { event: copy(stored.response.event), replayed: true };
        }
        if (org.role !== 'AGENCY') throw rejected(403, '행사 복제 권한을 확인하세요');

        try {
          await requireEventInOrg(client, sourceId, org.orgId);
        } catch (error) {
          if (error && error.code === 'ORGANIZATION_CONTEXT_CHANGED') throw error;
          throw rejected(404, '행사를 찾을 수 없습니다');
        }
        const sourceResult = await client.query(
          `SELECT e.id, e.slug, e.client_id, e.payload, w.payload AS workspace_payload
           FROM events e JOIN event_workspaces w ON w.event_id = e.id
           WHERE e.id = $1 FOR SHARE OF e, w`,
          [sourceId]
        );
        if (!sourceResult.rowCount) throw rejected(404, '행사를 찾을 수 없습니다');
        const source = normalizeEvent(sourceResult.rows[0]);
        const sourceWorkspace = normalizeWorkspace(sourceResult.rows[0].workspace_payload);

        const name = request.name || `${source.name} (복사)`.slice(0, 100);
        const slugBase = String(source.slug).slice(0, 45).replace(/-+$/, '');
        const slug = request.slug || `${slugBase}-copy`;
        const eventDate = request.date || source.date;
        const start = request.start || source.start;
        const end = request.end || source.end;
        const capacity = request.capacity === null ? toCapacityNumber(source.capacity) : request.capacity;
        if (!name || name.length > 100) throw rejected(400, '행사명을 1~100자로 입력하세요', 'name');
        if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug)) throw rejected(400, '행사 주소 코드를 확인하세요', 'slug');
        if (!isCalendarDate(eventDate)) throw rejected(400, '행사 날짜 형식이 올바르지 않습니다', 'date');
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
          throw rejected(400, '종료 시간은 시작 시간보다 늦어야 합니다', 'end');
        }
        if (!isSafeIntegerCapacity(capacity)) throw rejected(400, '정원은 0 이상의 정수로 입력하세요', 'capacity');

        const duplicateSlug = await client.query('SELECT 1 FROM events WHERE slug = $1 LIMIT 1', [slug]);
        if (duplicateSlug.rowCount) throw rejected(409, '행사 주소 코드가 이미 사용 중입니다', 'slug');

        const eventId = `event-${crypto.randomUUID()}`;
        // Format copies as setting metadata; stage/registration/files rules below stay untouched.
        const copiedFormat = normalizeEventFormat(source.format);
        const payload = {
          id: eventId,
          name,
          slug,
          clientId: source.clientId,
          date: eventDate,
          start,
          end,
          capacity,
          stage: 'DRAFT',
          features: copy(source.features),
          ...(copiedFormat ? { format: copiedFormat } : {}),
        };
        const event = normalizeEvent({ id: eventId, slug, client_id: source.clientId, org_id: org.orgId, payload, revision: 0 });
        await client.query(
          'INSERT INTO events (id, slug, client_id, org_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [eventId, slug, source.clientId, org.orgId, JSON.stringify(payload)]
        );
        await client.query(
          'INSERT INTO event_workspaces (event_id, payload) VALUES ($1, $2::jsonb)',
          [eventId, JSON.stringify(duplicatedWorkspace(sourceWorkspace))]
        );
        const response = { event };
        await client.query(
          `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [idempotencyKey, eventId, account.id, org.orgId, JSON.stringify({ command: 'event.duplicate', request, response })]
        );
        return { event, replayed: false };
      });
    } catch (error) {
      if (error && error.code === '23505') throw rejected(409, '행사 주소 코드가 이미 사용 중입니다', 'slug');
      throw error;
    }
  }

  async function saveClient(account, input = {}) {
    const idempotencyKey = String(input.commandId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      throw rejected(400, '요청 식별자를 확인하세요', 'commandId');
    }

    const requestedId = String(input.id || '').trim();
    const name = String(input.name || '').trim();
    const contact = String(input.contact || '').trim();
    const email = String(input.email || '').trim();
    if (!name || name.length > 80) throw rejected(400, '고객사명을 1~80자로 입력하세요', 'name');
    if (contact.length > 60) throw rejected(400, '담당자 이름을 60자 이내로 입력하세요', 'contact');
    if (email && (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120)) {
      throw rejected(400, '담당자 이메일 형식을 확인하세요', 'email');
    }
    if (requestedId.length > 160) throw rejected(400, '고객사를 확인하세요', 'id');
    const logoFileId = String(input.logoFileId || '').trim();
    const docFileId = String(input.docFileId || '').trim();
    if (logoFileId.length > 160 || docFileId.length > 160) throw rejected(400, '첨부 파일을 확인하세요', 'logoFileId');

    return database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const { resolveActorOrg: resolveOrg, checkReceiptScope: checkScope, requireClientInOrg: requireClient } = require('./tenancy');
      let org;
      try {
        org = await resolveOrg(client, account);
      } catch (error) {
        throw withOrgCode(error);
      }
      const receiptResult = await client.query(
        'SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE',
        [idempotencyKey]
      );
      if (receiptResult.rowCount) {
        const receipt = receiptResult.rows[0];
        try {
          checkScope(receipt, org.orgId);
        } catch (scopeError) {
          throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        const stored = object(receipt.result);
        if (String(receipt.actor_id || '') !== String(account.id) || stored.command !== 'client.save' || !stored.response?.client) {
          throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        return { client: copy(stored.response.client), replayed: true };
      }
      // Client records are organisation-level: a manager scoped to one event
      // must not be able to add or rewrite the customer list.
      if (org.role !== 'AGENCY') throw rejected(403, '고객사 관리 권한을 확인하세요');

      if (requestedId) {
        try {
          await requireClient(client, requestedId, org.orgId);
        } catch (error) {
          if (error && error.code === 'ORGANIZATION_CONTEXT_CHANGED') throw error;
          throw rejected(404, '고객사를 찾을 수 없습니다');
        }
      }
      const existing = requestedId
        ? (await client.query('SELECT payload FROM clients WHERE id = $1 LIMIT 1 FOR UPDATE', [requestedId])).rows[0]
        : null;
      if (requestedId && !existing) throw rejected(404, '고객사를 찾을 수 없습니다');

      const clientId = requestedId || `client-${crypto.randomUUID()}`;
      // Attached files stay owned by their stored rows: the record keeps the
      // reference, and each id must resolve to a file of this client, so a
      // logo can never point at another record's document.
      for (const [field, fileId] of [['logoFileId', logoFileId], ['docFileId', docFileId]]) {
        if (!fileId) continue;
        const fileRow = await client.query(
          'SELECT original_name, content_type, size_bytes FROM stored_files WHERE id = $1 AND client_id = $2 LIMIT 1',
          [fileId, clientId]
        );
        if (!fileRow.rowCount) throw rejected(404, '첨부 파일 정보를 찾을 수 없습니다', field);
      }
      // Keep fields this command does not own (a linked contact, for example)
      // so editing a name never silently unlinks anything.
      const payload = {
        ...object(existing && existing.payload), name, contact, email,
        ...(logoFileId || (existing && Object.hasOwn(object(existing.payload), 'logoFileId')) ? { logoFileId } : {}),
        ...(docFileId || (existing && Object.hasOwn(object(existing.payload), 'docFileId')) ? { docFileId } : {}),
      };
      if (existing) {
        await client.query(
          'UPDATE clients SET payload = $2::jsonb, updated_at = now() WHERE id = $1',
          [clientId, JSON.stringify(payload)]
        );
      } else {
        await client.query(
          'INSERT INTO clients (id, org_id, payload) VALUES ($1, $2, $3::jsonb)',
          [clientId, org.orgId, JSON.stringify(payload)]
        );
      }
      const saved = { ...payload, id: clientId };
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, NULL, $2, $3, $4::jsonb)`,
        [idempotencyKey, account.id, org.orgId, JSON.stringify({ command: 'client.save', response: { client: saved } })]
      );
      return { client: saved, replayed: false };
    });
  }

  async function saveOrgPermissions(account, accountId, input = {}) {
    const idempotencyKey = String(input.commandId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw rejected(400, '요청 식별자를 확인하세요', 'commandId');
    const targetId = String(accountId || '').trim();
    if (!targetId || targetId.length > 160) throw rejected(400, '구성원을 확인하세요', 'accountId');
    const requested = Array.isArray(input.orgPermissions) ? input.orgPermissions.map((value) => String(value)) : [];
    const unknown = requested.filter((value) => !ORG_PERMISSIONS.has(value));
    if (unknown.length) throw rejected(400, '허용할 수 없는 조직 권한이 포함되어 있습니다', 'orgPermissions');
    const permissions = [...new Set(requested)];

    return database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const { resolveActorOrg: resolveOrgPerms, checkReceiptScope: checkPermScope, bumpOrgContext: bumpPerms } = require('./tenancy');
      let org;
      try {
        org = await resolveOrgPerms(client, account);
      } catch (error) {
        throw withOrgCode(error);
      }
      const receipt = await client.query('SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE', [idempotencyKey]);
      if (receipt.rowCount) {
        try {
          checkPermScope(receipt.rows[0], org.orgId);
        } catch (scopeError) {
          throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        const stored = object(receipt.rows[0].result);
        if (String(receipt.rows[0].actor_id || '') !== String(account.id) || stored.command !== 'org.permissions.save') {
          throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        return { account: copy(stored.response.account), replayed: true };
      }
      if (org.role !== 'AGENCY') throw rejected(403, '조직 권한을 변경할 권한이 없습니다');


      // Permission truth lives in the org membership, so the target must
      // belong to THIS org (404 otherwise: no cross-org probing). The grant
      // touches only this membership; other orgs of a shared account keep
      // their own grants.
      const targetResult = await client.query(
        `SELECT a.id, a.name, a.email, a.active, m.role, m.permissions
         FROM accounts a JOIN organization_memberships m
           ON m.account_id = a.id AND m.org_id = $2
         WHERE a.id = $1 LIMIT 1 FOR UPDATE OF a, m`,
        [targetId, org.orgId]
      );
      const target = targetResult.rows[0];
      if (!target || target.active !== true) throw rejected(404, '구성원을 찾을 수 없습니다');
      // The organisation owner's own scope is not editable through this command.
      if (target.role === 'AGENCY') throw rejected(403, '조직 소유자의 권한은 변경할 수 없습니다');

      await client.query(
        'UPDATE organization_memberships SET permissions = $3::jsonb, revision = revision + 1 WHERE org_id = $1 AND account_id = $2',
        [org.orgId, targetId, JSON.stringify(permissions)]
      );
      await bumpPerms(client, org.orgId);
      const projection = accountProjection({ id: target.id, name: target.name, email: target.email, role: target.role, active: true, org_permissions: permissions }, true);
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, NULL, $2, $3, $4::jsonb)`,
        [idempotencyKey, account.id, org.orgId, JSON.stringify({ command: 'org.permissions.save', response: { account: projection } })]
      );
      return { account: projection, replayed: false };
    });
  }

  async function assignMember(account, eventId, input = {}) {
    const idempotencyKey = String(input.commandId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw rejected(400, '요청 식별자를 확인하세요', 'commandId');
    const targetId = String(input.accountId || '').trim();
    if (!targetId || targetId.length > 160) throw rejected(400, '구성원을 확인하세요', 'accountId');
    // An omitted `write` keeps the pre-allow-list behaviour (full access);
    // only an explicit array — including an explicit [] for read-only —
    // narrows the grant.
    const requested = input.write === undefined
      ? ['all']
      : Array.isArray(input.write) ? input.write.map((value) => String(value)) : [];
    const unknown = requested.filter((value) => !EVENT_PERMISSIONS.has(value));
    if (unknown.length) throw rejected(400, '허용할 수 없는 행사 권한이 포함되어 있습니다', 'write');
    const write = [...new Set(requested)];
    const enabled = input.enabled !== false;

    return database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const { resolveActorOrg: resolveAssignOrg, checkReceiptScope: checkAssignScope, requireEventInOrg: requireAssignEvent } = require('./tenancy');
      let org;
      try {
        org = await resolveAssignOrg(client, account);
      } catch (error) {
        throw withOrgCode(error);
      }
      try {
        await requireAssignEvent(client, String(eventId || ''), org.orgId);
      } catch (error) {
        if (error && error.code === 'ORGANIZATION_CONTEXT_CHANGED') throw error;
        throw rejected(404, '행사를 찾을 수 없습니다');
      }

      const receipt = await client.query('SELECT actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1 FOR UPDATE', [idempotencyKey]);
      if (receipt.rowCount) {
        try {
          checkAssignScope(receipt.rows[0], org.orgId);
        } catch (scopeError) {
          throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        const stored = object(receipt.rows[0].result);
        if (String(receipt.rows[0].actor_id || '') !== String(account.id) || stored.command !== 'member.assign') {
          throw rejected(409, '요청 식별자가 이미 다른 작업에 사용되었습니다');
        }
        return { membership: copy(stored.response.membership), replayed: true };
      }
      if (org.role !== 'AGENCY') throw rejected(403, '행사 권한을 변경할 권한이 없습니다');

      // Event grants stay inside the org: the target must hold an active
      // membership HERE (404 otherwise — other-org accounts are invisible).
      const targetResult = await client.query(
        `SELECT a.id, m.role, m.active AS active FROM accounts a
         JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $2
         WHERE a.id = $1 AND a.active = true LIMIT 1 FOR UPDATE OF a, m`,
        [targetId, org.orgId]
      );
      const target = targetResult.rows[0];
      if (!target || target.active !== true || !ROLES.has(target.role)) throw rejected(404, '구성원을 찾을 수 없습니다');
      if (target.role === 'AGENCY') throw rejected(403, '조직 소유자는 모든 행사에 접근합니다');

      let membership = null;
      if (enabled) {
        await client.query(
          `INSERT INTO memberships (account_id, event_id, write_permissions)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (account_id, event_id) DO UPDATE SET write_permissions = EXCLUDED.write_permissions`,
          [target.id, String(eventId), JSON.stringify(write)]
        );
        membership = { accountId: String(target.id), eventId: String(eventId), write };
      } else {
        await client.query('DELETE FROM memberships WHERE account_id = $1 AND event_id = $2', [target.id, String(eventId)]);
      }
      await client.query(
        `INSERT INTO command_receipts (command_id, event_id, actor_id, org_id, result)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [idempotencyKey, String(eventId), account.id, org.orgId, JSON.stringify({ command: 'member.assign', response: { membership } })]
      );
      return { membership, replayed: false };
    });
  }

  async function loadBootstrap(account) {
    const accountId = account && typeof account.id === 'string' ? account.id.trim() : '';
    if (!accountId) throw denied();

    return database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const accountResult = await client.query(
        'SELECT id, email, name, active FROM accounts WHERE id = $1 LIMIT 1',
        [accountId]
      );
      const identity = accountResult.rows[0];
      if (!identity || identity.active !== true) throw denied();
      const org = await resolveStateOrg(client, account, false);
      const actor = { id: identity.id, email: identity.email, name: identity.name, active: true, role: org.role };

      let eventQuery;
      let eventValues = [];
      if (actor.role === 'AGENCY') {
        eventQuery = `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision, e.created_at,
                             w.payload AS workspace_payload, w.revision AS workspace_revision
                      FROM events e LEFT JOIN event_workspaces w ON w.event_id = e.id
                      WHERE e.org_id = $1
                      ORDER BY e.created_at, e.id`;
        eventValues = [org.orgId];
      } else if (actor.role === 'MANAGER') {
        eventQuery = `SELECT DISTINCT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision, e.created_at,
                             w.payload AS workspace_payload, w.revision AS workspace_revision
                      FROM events e JOIN memberships m ON m.event_id = e.id
                      LEFT JOIN event_workspaces w ON w.event_id = e.id
                      WHERE m.account_id = $1 AND e.org_id = $2 ORDER BY e.created_at, e.id`;
        eventValues = [actor.id, org.orgId];
      } else {
        eventQuery = `SELECT DISTINCT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision, e.created_at,
                             w.payload AS workspace_payload, w.revision AS workspace_revision
                      FROM events e JOIN staff_assignments a ON a.event_id = e.id
                      LEFT JOIN event_workspaces w ON w.event_id = e.id
                      WHERE a.account_id = $1 AND a.active = true AND e.org_id = $2 ORDER BY e.created_at, e.id`;
        eventValues = [actor.id, org.orgId];
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
           FROM staff_assignments
           WHERE active = true AND event_id IN (SELECT id FROM events WHERE org_id = $1)
           ORDER BY event_id, id`,
          [org.orgId]
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
        membershipQuery = `SELECT account_id, event_id, write_permissions FROM memberships
                           WHERE event_id IN (SELECT id FROM events WHERE org_id = $1)
                           ORDER BY event_id, account_id`;
        membershipValues = [org.orgId];
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

      // Role/active/permissions truth is the org membership, joined here so
      // the console keeps seeing the same permission signals per org. Only
      // members of THIS org are ever listed: other-org accounts are invisible.
      const membershipColumns = `m.role AS role, m.active AS active, m.revision AS membership_version,
        COALESCE(m.permissions, a.org_permissions, '[]'::jsonb) AS org_permissions`;
      let accountQuery;
      let accountValues;
      if (actor.role === 'AGENCY') {
        accountQuery = `SELECT a.id, a.email, a.name, ${membershipColumns},
                         EXISTS (SELECT 1 FROM organization_memberships m2 WHERE m2.account_id = a.id AND m2.org_id <> $1) AS shared_account
                        FROM accounts a
                        JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $1
                        ORDER BY a.created_at, a.id`;
        accountValues = [org.orgId];
      } else if (actor.role === 'MANAGER') {
        // The assignment dialog is how a staff account gets attached to an
        // event, so a manager also sees staff accounts that are not attached
        // to any event yet. Without this the flow deadlocks: an account only
        // became visible after it had an assignment, and the assignment is
        // what the manager was trying to make.
        accountQuery = `SELECT DISTINCT a.id, a.email, a.name, ${membershipColumns}
                        FROM accounts a
                        JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $3
                        WHERE a.id = $1
                           OR a.id IN (SELECT account_id FROM memberships WHERE event_id = ANY($2::text[]))
                           OR a.id IN (SELECT account_id FROM staff_assignments WHERE event_id = ANY($2::text[]))
                           OR (m.role = 'STAFF'
                               AND NOT EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.account_id = a.id))
                        ORDER BY a.id`;
        accountValues = [actor.id, eventIds, org.orgId];
      } else {
        accountQuery = `SELECT a.id, a.email, a.name, ${membershipColumns}
                        FROM accounts a
                        JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $2 AND m.active = true
                        WHERE a.id = $1 LIMIT 1`;
        accountValues = [actor.id, org.orgId];
      }
      const accountRows = (await client.query(accountQuery, accountValues)).rows;
      const accounts = accountRows.map((row) => accountProjection(row, actor.role === 'AGENCY'));

      const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean).map(String))];
      let clients = [];
      if (actor.role === 'AGENCY') {
        clients = (await client.query('SELECT id, payload FROM clients WHERE org_id = $1 ORDER BY id', [org.orgId])).rows.map((row) => ({
          ...object(copy(row.payload)),
          id: String(row.id),
        }));
      } else if (clientIds.length) {
        clients = (await client.query('SELECT id, payload FROM clients WHERE id = ANY($1::text[]) AND org_id = $2 ORDER BY id', [clientIds, org.orgId])).rows.map((row) => ({
          id: String(row.id),
          name: String(object(row.payload).name || ''),
        }));
      }

      let invitations = [];
      if (actor.role === 'AGENCY') {
        invitations = (await client.query(
          `SELECT id, email, name, role, event_id, status, expires_at, created_at
           FROM invitations WHERE org_id = $1 ORDER BY created_at, id`,
          [org.orgId]
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
        viewer: {
          id: String(actor.id),
          name: String(actor.name || ''),
          role: String(actor.role),
          organizationId: org.orgId,
          organizationName: org.orgName,
          contextVersion: account.sessionRevision ?? null,
          orgPermissions: Array.isArray(org.permissions) ? copy(org.permissions) : [],
        },
        events: projectedEvents,
        workspaces,
        clients,
        accounts,
        memberships,
        invitations,
        globalAudit: [],
        commands: [],
        integrations: integrationsForOrg(org.orgId),
      };
    });
  }

  const DIRECTORY_HEX_COLOR = /^#[0-9a-f]{6}$/i;

  // Published card tint marker, same rule as the console's readPublishedCardColor:
  // a non-empty publishedAt next to the published block plus a valid hex.
  // Drafts never contribute.
  function publishedThemeColor(publishedAt, rawColor) {
    if (typeof publishedAt !== 'string' || !publishedAt.trim()) return null;
    if (typeof rawColor !== 'string' || !DIRECTORY_HEX_COLOR.test(rawColor.trim())) return null;
    return rawColor.trim().toUpperCase();
  }

  // Lightweight shell/directory read (additive; loadBootstrap is untouched).
  //
  // Contract:
  // - Same session/role scoping as loadBootstrap (AGENCY all events, MANAGER
  //   membership events, STAFF actively assigned events). No new isolation.
  // - Never selects event_workspaces.payload: per-event venue, PENDING and
  //   message-attention counts, and the published card color are extracted in
  //   SQL as scalars. Participant rows, tickets, contact secrets, message
  //   bodies, reports and global prizes never leave the database here.
  // - Membership/account/client/invitation scoping mirrors loadBootstrap so
  //   the shell keeps seeing the same permission signals, only the workspace
  //   weight is gone. Freshness matches bootstrap: READ ONLY transaction,
  //   `cache-control: no-store` (set by the route layer).
  async function loadDirectory(account) {
    const accountId = account && typeof account.id === 'string' ? account.id.trim() : '';
    if (!accountId) throw denied();

    return database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const accountResult = await client.query(
        'SELECT id, email, name, active FROM accounts WHERE id = $1 LIMIT 1',
        [accountId]
      );
      const identity = accountResult.rows[0];
      if (!identity || identity.active !== true) throw denied();
      const org = await resolveStateOrg(client, account, false);
      const actor = { id: identity.id, email: identity.email, name: identity.name, active: true, role: org.role };

      let eventIds;
      if (actor.role === 'AGENCY') {
        const all = await client.query('SELECT id FROM events WHERE org_id = $1 ORDER BY created_at, id', [org.orgId]);
        eventIds = all.rows.map((row) => String(row.id));
      } else if (actor.role === 'MANAGER') {
        const memberRows = await client.query(
          `SELECT m.event_id FROM memberships m JOIN events e ON e.id = m.event_id
           WHERE m.account_id = $1 AND e.org_id = $2 ORDER BY m.event_id`,
          [actor.id, org.orgId]
        );
        eventIds = memberRows.rows.map((row) => String(row.event_id));
      } else {
        const assignedRows = await client.query(
          `SELECT DISTINCT a.event_id FROM staff_assignments a JOIN events e ON e.id = a.event_id
           WHERE a.account_id = $1 AND a.active = true AND e.org_id = $2 ORDER BY a.event_id`,
          [actor.id, org.orgId]
        );
        eventIds = assignedRows.rows.map((row) => String(row.event_id));
      }

      let summaryRows = [];
      if (actor.role === 'AGENCY' || eventIds.length) {
        const filter = actor.role === 'AGENCY' ? 'WHERE e.org_id = $1' : 'WHERE e.id = ANY($1::text[]) AND e.org_id = $2';
        const values = actor.role === 'AGENCY' ? [org.orgId] : [eventIds, org.orgId];
        summaryRows = (await client.query(
          `SELECT e.id, e.slug, e.client_id, e.payload, e.revision,
                  w.revision AS workspace_revision,
                  NULLIF(w.payload->'venue'->>'name', '') AS venue,
                  CASE WHEN jsonb_typeof(COALESCE(w.payload->'participants', '[]'::jsonb)) = 'array'
                       THEN (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(w.payload->'participants', '[]'::jsonb)) AS p
                             WHERE p->>'status' = 'PENDING')
                       ELSE 0 END::int AS pending,
                  CASE WHEN jsonb_typeof(COALESCE(w.payload->'messages', '[]'::jsonb)) = 'array'
                       THEN (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(w.payload->'messages', '[]'::jsonb)) AS m
                             WHERE m->>'status' IN ('FAILED', 'PARTIAL', 'NEEDS_CONNECTION'))
                        ELSE 0 END::int AS attention,
                   CASE WHEN jsonb_typeof(COALESCE(w.payload->'messages', '[]'::jsonb)) = 'array'
                        THEN ARRAY(SELECT m->>'scheduled' FROM jsonb_array_elements(COALESCE(w.payload->'messages', '[]'::jsonb)) AS m
                                   WHERE m->>'status' = 'SCHEDULED')
                        ELSE ARRAY[]::text[] END AS scheduled_times,
                  w.payload->'pageExperience'->>'publishedAt' AS published_at,
                  w.payload->'pageExperience'->'published'->'homeStyle'->>'backgroundColor' AS theme_color
           FROM events e LEFT JOIN event_workspaces w ON w.event_id = e.id
           ${filter}
           ORDER BY e.created_at, e.id`,
          values
        )).rows;
      }

      const events = summaryRows.map((row) => {
        const event = normalizeEvent(row);
        const eventRevision = Math.max(Number(row.revision) || 0, Number(row.workspace_revision) || 0);
        return {
          id: event.id,
          name: event.name,
          slug: event.slug,
          clientId: event.clientId,
          date: event.date,
          start: event.start,
          end: event.end,
          capacity: event.capacity,
          stage: event.stage,
          features: event.features,
          // Format rides only when set: unspecified stays absent here exactly
          // as in full/detail reads, and legacy summaries keep their shape.
          ...(event.format ? { format: event.format } : {}),
          revision: eventRevision,
          venue: typeof row.venue === 'string' ? row.venue : '',
          pending: Number(row.pending) || 0,
          messageAttention: Number(row.attention) || 0,
          manualDue: (Array.isArray(row.scheduled_times) ? row.scheduled_times : []).filter(time => {
            const scheduled = Date.parse(time);
            return Number.isFinite(scheduled) && scheduled <= Date.now();
          }).length,
          themeColor: publishedThemeColor(row.published_at, row.theme_color),
        };
      });

      let membershipResult;
      if (actor.role === 'AGENCY') {
        membershipResult = await client.query(
          `SELECT m.account_id, m.event_id, m.write_permissions FROM memberships m
           JOIN events e ON e.id = m.event_id
           WHERE e.org_id = $1 ORDER BY m.event_id, m.account_id`,
          [org.orgId]
        );
      } else if (actor.role === 'MANAGER' && eventIds.length) {
        membershipResult = await client.query(
          `SELECT account_id, event_id, write_permissions
           FROM memberships WHERE event_id = ANY($1::text[]) ORDER BY event_id, account_id`,
          [eventIds]
        );
      } else if (actor.role === 'STAFF' && eventIds.length) {
        // Same as loadBootstrap: staff see only their own membership rows.
        membershipResult = await client.query(
          `SELECT account_id, event_id, write_permissions
           FROM memberships WHERE account_id = $1 AND event_id = ANY($2::text[]) ORDER BY event_id`,
          [actor.id, eventIds]
        );
      } else {
        membershipResult = { rows: [] };
      }
      // Stored grants ride through verbatim: an omitted grant was stored as
      // ['all'] at assign time, an explicit [] stays [] (read-only).
      const memberships = membershipResult.rows.map((row) => ({
        accountId: String(row.account_id),
        eventId: String(row.event_id),
        write: Array.isArray(row.write_permissions) ? copy(row.write_permissions) : [],
      }));

      const directoryColumns = `m.role AS role, m.active AS active, m.revision AS membership_version,
        COALESCE(m.permissions, a.org_permissions, '[]'::jsonb) AS org_permissions`;
      let accountRows;
      if (actor.role === 'AGENCY') {
        accountRows = (await client.query(
          `SELECT a.id, a.email, a.name, ${directoryColumns},
           EXISTS (SELECT 1 FROM organization_memberships m2 WHERE m2.account_id = a.id AND m2.org_id <> $1) AS shared_account
           FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $1
           ORDER BY a.created_at, a.id`,
          [org.orgId]
        )).rows;
      } else if (actor.role === 'MANAGER') {
        accountRows = (await client.query(
          `SELECT DISTINCT a.id, a.email, a.name, ${directoryColumns}
           FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $3
           WHERE a.id = $1
              OR a.id IN (SELECT account_id FROM memberships WHERE event_id = ANY($2::text[]))
              OR a.id IN (SELECT account_id FROM staff_assignments WHERE event_id = ANY($2::text[]))
              OR (m.role = 'STAFF'
                  AND NOT EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.account_id = a.id))
           ORDER BY a.id`,
          [actor.id, eventIds, org.orgId]
        )).rows;
      } else {
        accountRows = (await client.query(
          `SELECT a.id, a.email, a.name, ${directoryColumns}
           FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $2 AND m.active = true
           WHERE a.id = $1 LIMIT 1`,
          [actor.id, org.orgId]
        )).rows;
      }
      const accounts = accountRows.map((row) => accountProjection(row, actor.role === 'AGENCY'));

      const clientIds = [...new Set(summaryRows.map((row) => row.client_id).filter(Boolean).map(String))];
      let clients = [];
      if (actor.role === 'AGENCY') {
        clients = (await client.query('SELECT id, payload FROM clients WHERE org_id = $1 ORDER BY id', [org.orgId])).rows.map((row) => ({
          ...object(copy(row.payload)),
          id: String(row.id),
        }));
      } else if (clientIds.length) {
        clients = (await client.query(
          'SELECT id, payload FROM clients WHERE id = ANY($1::text[]) AND org_id = $2 ORDER BY id', [clientIds, org.orgId]
        )).rows.map((row) => ({
          id: String(row.id),
          name: String(object(row.payload).name || ''),
        }));
      }

      let invitations = [];
      if (actor.role === 'AGENCY') {
        invitations = (await client.query(
          `SELECT id, email, name, role, event_id, status, expires_at, created_at
           FROM invitations WHERE org_id = $1 ORDER BY created_at, id`,
          [org.orgId]
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

      const revision = summaryRows.reduce(
        (max, row) => Math.max(max, Number(row.revision) || 0, Number(row.workspace_revision) || 0), 0
      );
      return {
        version: 1,
        revision,
        activeEventId: events[0] ? events[0].id : null,
        viewer: {
          id: String(actor.id),
          name: String(actor.name || ''),
          role: String(actor.role),
          orgOwner: actor.role === 'AGENCY',
          organizationId: org.orgId,
          organizationName: org.orgName,
          contextVersion: account.sessionRevision ?? null,
          orgPermissions: Array.isArray(org.permissions) ? copy(org.permissions) : [],
        },
        events,
        clients,
        accounts,
        memberships,
        invitations,
        integrations: integrationsForOrg(org.orgId),
      };
    });
  }

  // Event-scoped detail read (additive; loadBootstrap is untouched).
  //
  // Contract:
  // - Same `{ state }` shape as GET /api/bootstrap (version 9, same keys) so
  //   event screens can migrate one by one, but `events` holds exactly the
  //   one event and `workspaces` exactly its workspace.
  // - Same role scoping and STAFF projection as loadBootstrap. A caller with
  //   no visibility into the event gets 404 ('행사를 찾을 수 없습니다'), the
  //   same as an unknown id, so membership cannot be probed.
  // - `clients`/`accounts`/`memberships`/`invitations` carry only what the
  //   event screen needs: the event's client, the event's members and
  //   assignees (plus unassigned STAFF for managers, the full list for
  //   AGENCY), the event's memberships, and (AGENCY only) the event's and
  //   global invitations.
  async function loadEventBootstrap(account, eventId) {
    const accountId = account && typeof account.id === 'string' ? account.id.trim() : '';
    if (!accountId) throw denied();
    const targetId = String(eventId || '').trim();
    if (!targetId || targetId.length > 160) throw rejected(404, '행사를 찾을 수 없습니다');

    return database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const accountResult = await client.query(
        'SELECT id, email, name, active FROM accounts WHERE id = $1 LIMIT 1',
        [accountId]
      );
      const identity = accountResult.rows[0];
      if (!identity || identity.active !== true) throw denied();
      const org = await resolveStateOrg(client, account, false);
      const actor = { id: identity.id, email: identity.email, name: identity.name, active: true, role: org.role };

      // Ownership first: another org's event is 404 (no probing oracle),
      // even for an org owner. Visibility inside the org follows.
      const ownerCheck = await client.query('SELECT org_id FROM events WHERE id = $1 LIMIT 1', [targetId]);
      if (!ownerCheck.rowCount || String(ownerCheck.rows[0].org_id || '') !== String(org.orgId)) {
        throw rejected(404, '행사를 찾을 수 없습니다');
      }

      if (actor.role === 'MANAGER') {
        const visible = await client.query(
          `SELECT 1 FROM memberships m JOIN events e ON e.id = m.event_id
           WHERE m.account_id = $1 AND m.event_id = $2 LIMIT 1`,
          [actor.id, targetId]
        );
        if (!visible.rowCount) throw rejected(404, '행사를 찾을 수 없습니다');
      } else if (actor.role === 'STAFF') {
        const visible = await client.query(
          `SELECT 1 FROM staff_assignments a JOIN events e ON e.id = a.event_id
           WHERE a.account_id = $1 AND a.event_id = $2 AND a.active = true LIMIT 1`,
          [actor.id, targetId]
        );
        if (!visible.rowCount) throw rejected(404, '행사를 찾을 수 없습니다');
      }

      const eventResult = await client.query(
        `SELECT e.id, e.slug, e.client_id, e.org_id, e.payload, e.revision,
                w.payload AS workspace_payload, w.revision AS workspace_revision
         FROM events e LEFT JOIN event_workspaces w ON w.event_id = e.id
         WHERE e.id = $1 LIMIT 1`,
        [targetId]
      );
      if (!eventResult.rowCount) throw rejected(404, '행사를 찾을 수 없습니다');
      const row = eventResult.rows[0];
      const event = normalizeEvent(row);
      const projectedEvent = actor.role === 'STAFF' ? staffEvent(event) : event;

      const assignmentResult = actor.role === 'AGENCY'
        ? await client.query(
          `SELECT id, account_id, event_id, type, target_id
           FROM staff_assignments WHERE active = true AND event_id = $1 ORDER BY event_id, id`,
          [targetId]
        )
        : await client.query(
          `SELECT id, account_id, event_id, type, target_id
           FROM staff_assignments WHERE active = true AND event_id = $1
             AND ($2::text = 'MANAGER' OR account_id = $3)
           ORDER BY event_id, id`,
          [targetId, actor.role, actor.id]
        );
      const assignments = assignmentResult.rows.map((item) => ({
        id: String(item.id),
        accountId: String(item.account_id),
        type: String(item.type),
        targetId: String(item.target_id),
      }));

      const membershipResult = actor.role === 'STAFF'
        ? await client.query(
          `SELECT account_id, event_id, write_permissions FROM memberships
           WHERE account_id = $1 AND event_id = $2 ORDER BY event_id`,
          [actor.id, targetId]
        )
        : await client.query(
          `SELECT account_id, event_id, write_permissions FROM memberships
           WHERE event_id = $1 ORDER BY event_id, account_id`,
          [targetId]
        );
      const memberships = membershipResult.rows.map((item) => ({
        accountId: String(item.account_id),
        eventId: String(item.event_id),
        write: Array.isArray(item.write_permissions) ? copy(item.write_permissions) : [],
      }));

      const eventMemberColumns = `m.role AS role, m.active AS active, m.revision AS membership_version,
        COALESCE(m.permissions, a.org_permissions, '[]'::jsonb) AS org_permissions`;
      let accountRows;
      if (actor.role === 'AGENCY') {
        accountRows = (await client.query(
          `SELECT a.id, a.email, a.name, ${eventMemberColumns},
           EXISTS (SELECT 1 FROM organization_memberships m2 WHERE m2.account_id = a.id AND m2.org_id <> $1) AS shared_account
           FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $1
           ORDER BY a.created_at, a.id`,
          [org.orgId]
        )).rows;
      } else if (actor.role === 'MANAGER') {
        accountRows = (await client.query(
          `SELECT DISTINCT a.id, a.email, a.name, ${eventMemberColumns}
           FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $3
           WHERE a.id = $1
              OR a.id IN (SELECT account_id FROM memberships WHERE event_id = $2)
              OR a.id IN (SELECT account_id FROM staff_assignments WHERE event_id = $2)
              OR (m.role = 'STAFF'
                  AND NOT EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.account_id = a.id))
           ORDER BY a.id`,
          [actor.id, targetId, org.orgId]
        )).rows;
      } else {
        accountRows = (await client.query(
          `SELECT a.id, a.email, a.name, ${eventMemberColumns}
           FROM accounts a
           JOIN organization_memberships m ON m.account_id = a.id AND m.org_id = $2 AND m.active = true
           WHERE a.id = $1 LIMIT 1`,
          [actor.id, org.orgId]
        )).rows;
      }
      const accounts = accountRows.map((item) => accountProjection(item, actor.role === 'AGENCY'));

      let clients = [];
      if (row.client_id) {
        const clientRows = (await client.query('SELECT id, payload FROM clients WHERE id = $1 AND org_id = $2 LIMIT 1', [String(row.client_id), org.orgId])).rows;
        if (clientRows.length) {
          clients = actor.role === 'AGENCY'
            ? [{ ...object(copy(clientRows[0].payload)), id: String(clientRows[0].id) }]
            : [{ id: String(clientRows[0].id), name: String(object(clientRows[0].payload).name || '') }];
        }
      } else if (actor.role === 'AGENCY') {
        clients = [];
      }

      let invitations = [];
      if (actor.role === 'AGENCY') {
        invitations = (await client.query(
          `SELECT id, email, name, role, event_id, status, expires_at, created_at
           FROM invitations WHERE org_id = $2 AND (event_id IS NULL OR event_id = $1) ORDER BY created_at, id`,
          [targetId, org.orgId]
        )).rows.map((item) => ({
          id: String(item.id),
          email: String(item.email),
          name: String(item.name),
          role: String(item.role),
          eventId: item.event_id ? String(item.event_id) : null,
          status: String(item.status),
          expiresAt: new Date(item.expires_at).toISOString(),
          at: new Date(item.created_at).toISOString(),
        }));
      }

      const workspace = normalizeWorkspace(row.workspace_payload);
      workspace.assignments = copy(assignments);
      let projectedWorkspace;
      if (actor.role === 'STAFF') {
        // Same minimal projection as loadBootstrap: assigned targets only,
        // no tickets, phones, emails, unassigned checks/visits, reports or
        // global prize state.
        const deskIds = new Set(assignments.filter((item) => item.type === 'DESK').map((item) => item.targetId));
        const boothIds = new Set(assignments.filter((item) => item.type === 'BOOTH').map((item) => item.targetId));
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
        projected.assignments = copy(assignments);
        projected.checks = deskIds.size ? array(workspace.checks).filter((check) => deskIds.has(String(check.deskId))).map((check) => ({
          id: String(check.id || ''), participantId: String(check.participantId || ''), name: String(check.name || ''),
          action: String(check.action || ''), deskId: String(check.deskId || ''), at: String(check.at || ''), corrected: check.corrected === true,
        })) : [];
        projected.visits = boothIds.size ? array(workspace.visits).filter((visit) => boothIds.has(String(visit.boothId))).map((visit) => ({
          id: String(visit.id || ''), boothId: String(visit.boothId || ''), participantId: String(visit.participantId || ''), at: String(visit.at || ''),
        })) : [];
        projectedWorkspace = projected;
      } else {
        projectedWorkspace = workspace;
      }

      const revision = Math.max(Number(row.revision) || 0, Number(row.workspace_revision) || 0);
      return {
        version: 9,
        revision,
        activeEventId: event.id,
        viewer: {
          id: String(actor.id),
          name: String(actor.name || ''),
          role: String(actor.role),
          organizationId: org.orgId,
          organizationName: org.orgName,
          contextVersion: account.sessionRevision ?? null,
          orgPermissions: Array.isArray(org.permissions) ? copy(org.permissions) : [],
        },
        events: [projectedEvent],
        workspaces: { [event.id]: projectedWorkspace },
        clients,
        accounts,
        memberships,
        invitations,
        globalAudit: [],
        commands: [],
        integrations: integrationsForOrg(org.orgId),
      };
    });
  }

  return { loadBootstrap, loadDirectory, loadEventBootstrap, createEvent, duplicateEvent, saveClient, saveOrgPermissions, assignMember };
}

module.exports = { createState, emptyWorkspace, normalizeEvent, normalizeWorkspace, projectParticipant, EVENT_FORMATS, normalizeEventFormat, parseEventFormatInput };
