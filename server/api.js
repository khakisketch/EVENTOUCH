'use strict';

// Domain APIs mirroring the ETKO feature semantics (Korean errors,
// forward-only status, scan classification, one-vote/answer rules).
// All mutations require an authenticated session + write grant.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sendJson, readJsonBody } = require('./http');

const STAFF_WRITE = ['participants', 'checkin', 'booth', 'booths', 'staff', 'qna', 'photos', 'poll', 'quiz', 'draw', 'survey'];
const STATUS_FLOW = { PRE: ['LIVE'], LIVE: ['END'], END: [] };
const CHECKIN_MESSAGES = {
  success: { title: '처리되었습니다', detail: '스캔이 정상적으로 반영되었습니다.' },
  duplicate: { title: '이미 처리된 코드입니다', detail: '중복 스캔은 반영되지 않았습니다.' },
  'not-in': { title: '입장 기록이 없습니다', detail: '먼저 입장 처리를 해주세요.' },
  'wrong-kind': { title: '체크인용 코드가 아닙니다', detail: '부스 QR은 부스에서 스캔해주세요.' },
  'wrong-event': { title: '다른 행사의 티켓입니다', detail: '이번 행사 코드인지 확인해주세요.' },
  'not-found': { title: '등록되지 않은 코드입니다', detail: '코드를 다시 확인해주세요.' },
  queued: { title: '대기열에 저장했습니다', detail: '오프라인 상태입니다. 연결 후 동기화하면 반영됩니다.' },
};

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function err(res, status, message, field) {
  const body = { error: message };
  if (field) body.field = field;
  sendJson(res, status, body);
}

function isCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[mo - 1];
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// ---- store access ----

function readEvents(store) {
  const events = store.read('events');
  return Array.isArray(events.items) ? events : { items: [], workspaces: {} };
}

function saveEvents(store, data) {
  store.write('events', data);
}

function findEvent(data, id) {
  const found = (data.items || []).find((ev) => ev && ev.id === id);
  if (!found) throw Object.assign(new Error('행사를 찾을 수 없습니다'), { status: 404 });
  return found;
}

function workspaceOf(data, id) {
  if (!data.workspaces[id]) data.workspaces[id] = emptyWorkspace();
  return data.workspaces[id];
}

function emptyWorkspace() {
  return {
    participants: [],
    program: [],
    notices: [],
    venue: null,
    posts: [],
    booths: [],
    boothMode: 'SELF',
    visits: [],
    desks: [],
    logs: [],
    scanQueue: [],
    poll: { status: 'CLOSED', options: [], votes: {} },
    quiz: { status: 'CLOSED', question: '', answers: {} },
    qna: [],
    draw: {},
    survey: { open: true, answers: {} },
    photos: [],
    templates: [],
    campaigns: [],
    outbox: [],
    reports: [],
    features: {},
    members: [],
    capacity: 0,
  };
}

function seedSampleParticipants() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'data', 'sample.json'), 'utf8')
    );
    if (raw && Array.isArray(raw.participants)) {
      return raw.participants.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email || '',
        phone: p.phone || '',
        ticket: p.ticket || 'GENERAL',
        status: p.status || 'registered',
        code: p.code,
        everIn: p.status === 'IN',
        cancelled: false,
      }));
    }
  } catch (err) {}
  return [];
}

function ensureSeedData(store) {
  const data = readEvents(store);
  if (data.items.length > 0) return;
  const ws = emptyWorkspace();
  ws.participants = seedSampleParticipants();
  data.items.push({
    id: 'evt-1',
    name: 'EVENTOUCH 운영 샘플',
    date: '2026-10-01',
    venue: 'A홀',
    status: 'PRE',
  });
  data.workspaces['evt-1'] = ws;
  saveEvents(store, data);
}

function nextId(items, prefix, key) {
  let max = 0;
  (items || []).forEach((item) => {
    const m = new RegExp('^' + prefix + '-(\\d+)$').exec((item && item[key || 'id']) || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + (max + 1);
}

function nextEventId(items) {
  let max = 0;
  (items || []).forEach((ev) => {
    const m = /^evt-(\d+)$/.exec((ev && ev.id) || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'evt-' + (max + 1);
}

// ---- auth gates (mirror requireWrite) ----

async function requireUser(auth, req) {
  const account = auth && await auth.sessionFromCookie(req.headers.cookie);
  if (!account) throw Object.assign(new Error('로그인이 필요합니다'), { status: 401 });
  return account;
}

function requireWrite(user, route) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'AGENCY' || role === 'MANAGER') return;
  if (role === 'STAFF' && STAFF_WRITE.indexOf(route) !== -1) return;
  throw Object.assign(new Error('권한을 확인하세요'), { status: 403 });
}

// ---- summaries (mirror agencySummary / eventSummary) ----

function isActiveParticipant(p) {
  return p && !p.cancelled;
}

function eventSummary(ws) {
  const list = (ws.participants || []).filter(isActiveParticipant);
  const checked = list.filter((p) => p.everIn === true).length;
  const inside = list.filter((p) => String(p.status).toUpperCase() === 'IN').length;
  const total = list.length;
  return {
    total,
    checked,
    inside,
    notArrived: total - checked,
    rate: total ? +(checked / total * 100).toFixed(1) : 0,
  };
}

function agencySummary(data) {
  const out = { total: 0, live: 0, pre: 0, ended: 0, participants: 0, pending: 0 };
  (data.items || []).forEach((ev) => {
    if (!ev) return;
    out.total += 1;
    if (ev.status === 'LIVE') out.live += 1;
    else if (ev.status === 'END') out.ended += 1;
    else out.pre += 1;
    const ws = data.workspaces[ev.id];
    if (!ws) return;
    if (Array.isArray(ws.participants)) out.participants += ws.participants.length;
    (ws.photos || []).forEach((p) => {
      if (p && p.status !== 'APPROVED') out.pending += 1;
    });
    (ws.qna || []).forEach((q) => {
      if (q && !q.approved) out.pending += 1;
    });
  });
  return out;
}

// ---- scan (mirror ETKO.scan) ----

function normCode(value) {
  return String(value === undefined || value === null ? '' : value).trim().toUpperCase();
}

function findPerson(people, code) {
  const want = normCode(code);
  return (people || []).find((p) => p && !p.cancelled && normCode(p.code) === want) || null;
}

function isQueued(queue, code, direction) {
  const want = normCode(code);
  return (queue || []).some(
    (e) => e && normCode(e.code) === want && normCode(e.direction) === normCode(direction)
  );
}

function scanIn(ws, code, direction, online) {
  if (!Array.isArray(ws.scanQueue)) ws.scanQueue = [];
  if (/^BADGE-/i.test(code)) return 'wrong-kind';
  if (/^[A-Z]+-\d+$/.test(code) && code.indexOf('EVT-') !== 0) return 'wrong-event';
  const person = findPerson(ws.participants, code);
  if (!person) return 'not-found';
  const entered = normCode(person.status) === 'IN';
  if (direction === 'OUT') {
    if (!entered) return 'not-in';
    if (!online) {
      if (isQueued(ws.scanQueue, code, 'OUT')) return 'duplicate';
      ws.scanQueue.push({ code: normCode(code), direction: 'OUT' });
      return 'queued';
    }
    person.status = 'registered';
    logLine(ws, person, 'OUT');
    return 'success';
  }
  if (entered || isQueued(ws.scanQueue, code, 'IN')) return 'duplicate';
  if (!online) {
    ws.scanQueue.push({ code: normCode(code), direction: 'IN' });
    return 'queued';
  }
  person.status = 'IN';
  person.everIn = true;
  logLine(ws, person, 'IN');
  return 'success';
}

function logLine(ws, person, action) {
  if (!Array.isArray(ws.logs)) ws.logs = [];
  ws.logs.push({
    participantId: person.id,
    code: person.code,
    action,
    at: new Date().toISOString(),
  });
}

function syncQueue(ws) {
  if (!Array.isArray(ws.scanQueue)) ws.scanQueue = [];
  const pending = ws.scanQueue.slice();
  ws.scanQueue.length = 0;
  pending.forEach((entry) => {
    if (!entry) return;
    const person = findPerson(ws.participants, entry.code);
    if (!person) return;
    const entered = normCode(person.status) === 'IN';
    if (normCode(entry.direction) === 'IN' && !entered) {
      person.status = 'IN';
      person.everIn = true;
      logLine(ws, person, 'IN');
    }
    if (normCode(entry.direction) === 'OUT' && entered) {
      person.status = 'registered';
      logLine(ws, person, 'OUT');
    }
  });
  return pending.length;
}

function scanMessage(key) {
  const entry = CHECKIN_MESSAGES[key];
  if (entry) return { title: entry.title, detail: entry.detail };
  return { title: '알 수 없는 결과입니다', detail: '코드를 다시 스캔해주세요.' };
}

function nextParticipantId(ws) {
  let max = 0;
  (ws.participants || []).forEach((p) => {
    const m = /^p(\d+)$/.exec((p && p.id) || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'p' + (max + 1);
}

// ---- router ----

function eventCommand(parts, method, body) {
  const route = parts[1] || '';
  if (!parts.length) return method === 'GET' ? 'events.list' : 'events.create';
  if (route === 'participants' && method === 'GET') return 'participants.read';
  if (route === 'checkin' && method === 'POST') return 'checkin.scan';
  if (route === 'sync' && method === 'POST') return 'checkin.sync';
  if (route === 'corrections' && method === 'POST') return 'checkin.correction';
  if (route === 'stamps' && method === 'POST') return 'booth.visit';
  if (route === 'assignments' && method === 'GET') return 'assignment.read';
  return `event.${method.toLowerCase()}`;
}

async function handleEvents(req, res, store, parts, body, auth, access) {
  // POST /api/events/:id/signup (self-service, same validation, no grant)
  if (parts.length === 2 && parts[1] === 'signup' && req.method === 'POST') {
    try {
      const data = readEvents(store);
      findEvent(data, parts[0]);
      const ws = workspaceOf(data, parts[0]);
      const participant = addParticipant(store, data, ws, body, true);
      saveEvents(store, data);
      return sendJson(res, 201, { participant });
    } catch (e) {
      return err(res, e.status || 500, e.message || '요청을 처리하지 못했습니다', e.field);
    }
  }
  const me = await requireUser(auth, req);
  const query = new URL(req.url || '/', 'http://localhost').searchParams;
  const command = eventCommand(parts, req.method, body);
  const targetId = command === 'booth.visit'
    ? body.booth
    : body.targetId || body.deskId || query.get('targetId') || query.get('deskId');
  await access.authorize({
    account: me,
    eventId: parts[0] || null,
    command,
    assignmentId: body.assignmentId || query.get('assignmentId'),
    targetId,
  });
  const data = readEvents(store);

  // GET /api/events
  if (parts.length === 0 && req.method === 'GET') {
    return sendJson(res, 200, { events: data.items, activeEventId: data.items[0] ? data.items[0].id : null });
  }
  // POST /api/events
  if (parts.length === 0 && req.method === 'POST') {
    requireWrite(me, 'events');
    const name = text(body.name);
    const date = text(body.date);
    const venue = text(body.venue);
    if (!name) return err(res, 400, '행사 이름을 입력하세요', 'name');
    if (!date) return err(res, 400, '행사 날짜를 입력하세요', 'date');
    if (!isCalendarDate(date)) return err(res, 400, '행사 날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)', 'date');
    if (!venue) return err(res, 400, '행사 장소를 입력하세요', 'venue');
    const id = nextEventId(data.items);
    const ev = { id, name, date, venue, status: 'PRE' };
    data.items.push(ev);
    data.workspaces[id] = emptyWorkspace();
    if (body.capacity !== undefined) {
      const cap = Number(body.capacity);
      if (!Number.isFinite(cap) || cap < 0) return err(res, 400, '정원을 확인하세요', 'capacity');
      data.workspaces[id].capacity = cap;
    }
    saveEvents(store, data);
    return sendJson(res, 201, { event: ev });
  }

  const ev = findEvent(data, parts[0]);
  const ws = workspaceOf(data, ev.id);
  const save = () => saveEvents(store, data);

  // GET /api/events/:id
  if (parts.length === 1 && req.method === 'GET') return sendJson(res, 200, { event: ev });
  // PATCH /api/events/:id
  if (parts.length === 1 && req.method === 'PATCH') {
    requireWrite(me, 'events');
    if (body.name !== undefined) {
      if (!text(body.name)) return err(res, 400, '행사 이름을 입력하세요', 'name');
      ev.name = text(body.name);
    }
    if (body.date !== undefined) {
      if (!isCalendarDate(text(body.date))) return err(res, 400, '행사 날짜 형식을 확인하세요', 'date');
      ev.date = text(body.date);
    }
    if (body.venue !== undefined) {
      if (!text(body.venue)) return err(res, 400, '행사 장소를 입력하세요', 'venue');
      ev.venue = text(body.venue);
    }
    if (body.capacity !== undefined) {
      const cap = Number(body.capacity);
      if (!Number.isFinite(cap) || cap < 0) return err(res, 400, '정원을 확인하세요', 'capacity');
      ws.capacity = cap;
    }
    if (body.recruitment !== undefined) {
      const method = String(body.recruitment).toLowerCase();
      if (['online', 'manual', 'later'].indexOf(method) === -1) {
        return err(res, 400, '모집 방식을 확인하세요', 'recruitment');
      }
      ev.recruitment = method;
    }
    if (body.approval !== undefined) {
      ev.approval = !!body.approval;
    }
    save();
    return sendJson(res, 200, { event: ev });
  }
  // PATCH /api/events/:id/status
  if (parts.length === 2 && parts[1] === 'status' && req.method === 'PATCH') {
    requireWrite(me, 'events');
    const next = text(body.status).toUpperCase();
    if ((STATUS_FLOW[ev.status] || []).indexOf(next) === -1) {
      return err(res, 400, '행사 상태는 준비→운영→결과 순서로만 변경할 수 있습니다', 'status');
    }
    ev.status = next;
    save();
    return sendJson(res, 200, { event: ev });
  }
  // GET /api/events/:id/summary
  if (parts.length === 2 && parts[1] === 'summary' && req.method === 'GET') {
    return sendJson(res, 200, { summary: eventSummary(ws) });
  }
  // GET /api/events/:id/workspace (authenticated slices for sync clients)
  if (parts.length === 2 && parts[1] === 'workspace' && req.method === 'GET') {
    return sendJson(res, 200, { workspace: ws });
  }
  // Participants
  if (parts[1] === 'participants' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { participants: ws.participants });
  }
  if (parts[1] === 'participants' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'participants');
    return sendJson(res, 201, { participant: addParticipant(store, data, ws, body, false) });
  }
  // POST /api/events/:id/checkin
  if (parts[1] === 'checkin' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'checkin');
    const code = text(body.code);
    if (!code) return err(res, 400, '코드를 입력하세요', 'code');
    const direction = normCodeDirection(body.direction);
    const online = body.online !== false;
    const key = scanIn(ws, code, direction, online);
    save();
    const msg = scanMessage(key);
    return sendJson(res, 200, { kind: scanKind(key), key, title: msg.title, detail: msg.detail });
  }
  // POST /api/events/:id/sync
  if (parts[1] === 'sync' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'checkin');
    const applied = syncQueue(ws);
    save();
    return sendJson(res, 200, { applied });
  }
  // POST /api/events/:id/corrections
  if (parts[1] === 'corrections' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'checkin');
    const person = findPerson(ws.participants, body.code);
    if (!person) return err(res, 404, '참가자를 찾을 수 없습니다', 'code');
    const reason = text(body.reason);
    if (reason.length < 5 || reason.length > 200) return err(res, 400, '정정 사유를 5~200자로 입력하세요', 'reason');
    if (!Array.isArray(ws.logs)) ws.logs = [];
    ws.logs.push({ participantId: person.id, code: person.code, action: 'CORRECTION', reason, at: new Date().toISOString() });
    save();
    return sendJson(res, 200, { ok: true });
  }
  // Booth mode
  if (parts[1] === 'booth-mode' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { mode: ws.boothMode, locked: ws.visits.length > 0 });
  }
  if (parts[1] === 'booth-mode' && parts.length === 2 && req.method === 'PUT') {
    requireWrite(me, 'booth');
    const next = text(body.mode).toUpperCase();
    if (next !== 'SELF' && next !== 'STAFF') return err(res, 400, '인증 방식을 확인하세요', 'mode');
    if (ws.visits.length > 0 && next !== ws.boothMode) {
      return err(res, 409, '인증 기록이 있는 행사는 방식을 변경할 수 없습니다');
    }
    ws.boothMode = next;
    save();
    return sendJson(res, 200, { mode: ws.boothMode });
  }
  // Booths
  if (parts[1] === 'booths' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { booths: ws.booths });
  }
  if (parts[1] === 'booths' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'booth');
    if (!text(body.name)) return err(res, 400, '부스 이름을 입력하세요', 'name');
    const booth = {
      id: nextId(ws.booths, 'b'),
      name: text(body.name),
      code: text(body.code),
      maxCount: body.maxCount === undefined ? 0 : Number(body.maxCount),
      perPerson: body.perPerson === undefined ? 0 : Number(body.perPerson),
    };
    ws.booths.push(booth);
    save();
    return sendJson(res, 201, { booth });
  }
  // Stamps
  if (parts[1] === 'stamps' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'booth');
    if (ws.boothMode !== 'SELF') return err(res, 403, '직원 스캔 방식에서는 직원이 인증합니다');
    const booth = (ws.booths || []).find((b) => b && b.id === body.booth);
    if (!booth) return err(res, 404, '부스를 찾을 수 없습니다', 'booth');
    const person = findPerson(ws.participants, body.code);
    if (!person) return err(res, 404, '참가자를 찾을 수 없습니다', 'code');
    const mine = ws.visits.filter((v) => v && v.boothId === booth.id);
    if (booth.maxCount > 0 && mine.length >= booth.maxCount) return err(res, 409, '부스 인증이 마감되었습니다');
    if (booth.perPerson > 0 && mine.filter((v) => v.participantId === person.id).length >= booth.perPerson) {
      return err(res, 409, '1인당 인증 횟수를 초과했습니다');
    }
    const visit = { boothId: booth.id, participantId: person.id, at: new Date().toISOString() };
    ws.visits.push(visit);
    save();
    return sendJson(res, 201, { visit });
  }
  // Poll
  if (parts[1] === 'poll' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { poll: publicPoll(ws) });
  }
  if (parts[1] === 'poll' && parts.length === 2 && req.method === 'PUT') {
    requireWrite(me, 'poll');
    const next = text(body.status).toUpperCase();
    if (next !== 'OPEN' && next !== 'CLOSED') return err(res, 400, '상태를 확인하세요', 'status');
    ws.poll.status = next;
    if (Array.isArray(body.options)) ws.poll.options = body.options.map(String);
    save();
    return sendJson(res, 200, { poll: publicPoll(ws) });
  }
  if (parts[1] === 'poll' && parts[2] === 'votes' && parts.length === 3 && req.method === 'POST') {
    requireWrite(me, 'poll');
    const person = findPersonById(ws, body.participantId);
    if (!person) return err(res, 404, '참가자를 찾을 수 없습니다', 'participantId');
    if (ws.poll.status !== 'OPEN') return err(res, 409, '투표가 마감되었습니다');
    if (ws.poll.votes[person.id] !== undefined) return err(res, 409, '이미 투표했습니다');
    const index = Number(body.option);
    if (!Number.isInteger(index) || index < 0 || index >= ws.poll.options.length) {
      return err(res, 400, '선택지를 확인하세요', 'option');
    }
    ws.poll.votes[person.id] = index;
    save();
    return sendJson(res, 200, { ok: true });
  }
  // Quiz
  if (parts[1] === 'quiz' && parts.length === 2 && req.method === 'PUT') {
    requireWrite(me, 'quiz');
    const next = text(body.status).toUpperCase();
    if (next !== 'OPEN' && next !== 'CLOSED') return err(res, 400, '상태를 확인하세요', 'status');
    ws.quiz.status = next;
    if (body.question !== undefined) ws.quiz.question = text(body.question);
    save();
    return sendJson(res, 200, { quiz: { status: ws.quiz.status } });
  }
  if (parts[1] === 'quiz' && parts[2] === 'answers' && parts.length === 3 && req.method === 'POST') {
    requireWrite(me, 'quiz');
    const person = findPersonById(ws, body.participantId);
    if (!person) return err(res, 404, '참가자를 찾을 수 없습니다', 'participantId');
    if (ws.quiz.status !== 'OPEN') return err(res, 409, '퀴즈가 마감되었습니다');
    if (ws.quiz.answers[person.id] !== undefined) return err(res, 409, '이미 답변했습니다');
    const answer = text(body.answer);
    if (!answer) return err(res, 400, '답변을 입력하세요', 'answer');
    if (answer.length > 200) return err(res, 400, '답변은 200자 이내로 입력하세요', 'answer');
    ws.quiz.answers[person.id] = answer;
    save();
    return sendJson(res, 200, { ok: true });
  }
  // Q&A
  if (parts[1] === 'qna' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { qna: ws.qna });
  }
  if (parts[1] === 'qna' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'qna');
    const person = findPersonById(ws, body.participantId);
    if (!person) return err(res, 404, '참가자를 찾을 수 없습니다', 'participantId');
    const qbody = text(body.body);
    if (!qbody) return err(res, 400, '질문을 입력하세요', 'body');
    if (qbody.length > 600) return err(res, 400, '질문은 600자 이내로 입력하세요', 'body');
    const item = { id: nextId(ws.qna, 'q'), participantId: person.id, body: qbody, approved: false, selected: false };
    ws.qna.push(item);
    save();
    return sendJson(res, 201, { item });
  }
  if (parts[1] === 'qna' && parts[3] === 'approve' && parts.length === 4 && req.method === 'POST') {
    requireWrite(me, 'qna');
    const item = (ws.qna || []).find((q) => q && q.id === parts[2]);
    if (!item) return err(res, 404, '질문을 찾을 수 없습니다');
    item.approved = body.approved !== false;
    save();
    return sendJson(res, 200, { item });
  }
  if (parts[1] === 'qna' && parts[3] === 'select' && parts.length === 4 && req.method === 'POST') {
    requireWrite(me, 'qna');
    const item = (ws.qna || []).find((q) => q && q.id === parts[2]);
    if (!item) return err(res, 404, '질문을 찾을 수 없습니다');
    if (!item.approved) return err(res, 409, '공개 승인한 질문만 선택할 수 있습니다');
    item.selected = true;
    save();
    return sendJson(res, 200, { item });
  }
  // Draw
  if (parts[1] === 'draw' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'draw');
    const pool = (ws.participants || []).filter((p) => p && !p.cancelled && normCode(p.status) === 'IN');
    if (pool.length === 0) return err(res, 400, '추첨 대상이 없습니다');
    const index = crypto.randomInt(pool.length);
    ws.draw.pending = { participantId: pool[index].id, index };
    save();
    return sendJson(res, 200, { result: ws.draw.pending });
  }
  if (parts[1] === 'draw' && parts[2] === 'confirm' && parts.length === 3 && req.method === 'POST') {
    requireWrite(me, 'draw');
    if (!ws.draw.pending) return err(res, 400, '확정할 당첨 결과가 없습니다');
    ws.draw.winner = ws.draw.pending;
    ws.draw.pending = null;
    save();
    return sendJson(res, 200, { winner: ws.draw.winner });
  }
  // Survey
  if (parts[1] === 'survey' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'survey');
    const person = findPersonById(ws, body.participantId);
    if (!person) return err(res, 404, '참가자를 찾을 수 없습니다', 'participantId');
    if (!ws.survey.open) return err(res, 409, '설문이 마감되었습니다');
    if (ws.survey.answers[person.id] !== undefined) return err(res, 409, '이미 평가를 제출했습니다');
    const scores = body.scores;
    if (!Array.isArray(scores) || scores.length === 0) return err(res, 400, '응답 문항 수를 확인하세요', 'scores');
    if (scores.some((n) => !Number.isInteger(n) || n < 1 || n > 5)) {
      return err(res, 400, '평가 점수를 확인하세요', 'scores');
    }
    ws.survey.answers[person.id] = scores.slice();
    save();
    return sendJson(res, 201, { ok: true });
  }
  // Photos
  if (parts[1] === 'photos' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { photos: ws.photos });
  }
  if (parts[1] === 'photos' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'photos');
    if (body.participantId !== undefined && !findPersonById(ws, body.participantId)) {
      return err(res, 404, '참가자를 찾을 수 없습니다', 'participantId');
    }
    const photo = {
      id: nextId(ws.photos, 'photo'),
      participantId: text(body.participantId),
      caption: text(body.caption),
      status: 'PENDING',
    };
    ws.photos.push(photo);
    save();
    return sendJson(res, 201, { photo });
  }
  if (parts[1] === 'photos' && parts.length === 4 && req.method === 'POST') {
    requireWrite(me, 'photos');
    const photo = (ws.photos || []).find((p) => p && p.id === parts[2]);
    if (!photo) return err(res, 404, '사진을 찾을 수 없습니다');
    if (parts[3] === 'approve') photo.status = 'APPROVED';
    else if (parts[3] === 'hide') photo.status = 'HIDDEN';
    else return err(res, 404, '요청한 API를 찾을 수 없습니다');
    save();
    return sendJson(res, 200, { photo });
  }
  // Content
  if (parts[1] === 'program' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'program');
    if (!text(body.title)) return err(res, 400, '세션명을 입력하세요', 'title');
    if (!text(body.time)) return err(res, 400, '시작 시간을 입력하세요', 'time');
    const row = {
      id: nextId(ws.program, 'prog'),
      time: text(body.time),
      end: text(body.end),
      title: text(body.title),
      location: text(body.location),
    };
    ws.program.push(row);
    save();
    return sendJson(res, 201, { program: row });
  }
  if (parts[1] === 'program' && parts.length === 3 && req.method === 'DELETE') {
    requireWrite(me, 'program');
    const before = ws.program.length;
    ws.program = ws.program.filter((r) => r && r.id !== parts[2]);
    if (ws.program.length === before) return err(res, 404, '프로그램을 찾을 수 없습니다');
    save();
    return sendJson(res, 200, { ok: true });
  }
  if (parts[1] === 'notices' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'notices');
    if (!text(body.title)) return err(res, 400, '공지 제목을 입력하세요', 'title');
    if (!text(body.body)) return err(res, 400, '공지 내용을 입력하세요', 'body');
    const notice = { id: nextId(ws.notices, 'notice'), title: text(body.title), body: text(body.body) };
    ws.notices.push(notice);
    save();
    return sendJson(res, 201, { notice });
  }
  if (parts[1] === 'venue' && parts.length === 2 && req.method === 'PUT') {
    requireWrite(me, 'venue');
    if (!text(body.name)) return err(res, 400, '행사장 이름을 입력하세요', 'name');
    ws.venue = { name: text(body.name), address: text(body.address) };
    save();
    return sendJson(res, 200, { venue: ws.venue });
  }
  // Messages
  if (parts[1] === 'templates' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'messages');
    if (!text(body.name)) return err(res, 400, '템플릿 이름을 입력하세요', 'name');
    if (!text(body.body)) return err(res, 400, '템플릿 내용을 입력하세요', 'body');
    const tpl = { id: nextId(ws.templates, 'tpl'), name: text(body.name), body: text(body.body) };
    ws.templates.push(tpl);
    save();
    return sendJson(res, 201, { template: tpl });
  }
  if (parts[1] === 'campaigns' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'messages');
    if (!text(body.title)) return err(res, 400, '캠페인 이름을 입력하세요', 'title');
    if (!text(body.content)) return err(res, 400, '메시지 내용을 입력하세요', 'content');
    const camp = {
      id: nextId(ws.campaigns, 'camp'),
      title: text(body.title),
      content: text(body.content),
      channel: text(body.channel) || '알림톡',
      recipientIds: Array.isArray(body.recipientIds) ? body.recipientIds : [],
    };
    ws.campaigns.push(camp);
    save();
    return sendJson(res, 201, { campaign: camp });
  }
  if (parts[1] === 'campaigns' && parts[3] === 'send' && parts.length === 4 && req.method === 'POST') {
    requireWrite(me, 'messages');
    const camp = (ws.campaigns || []).find((c) => c && c.id === parts[2]);
    if (!camp) return err(res, 404, '캠페인을 찾을 수 없습니다');
    const entry = {
      id: 'out-' + (ws.outbox.length + 1),
      campaignId: camp.id,
      title: camp.title,
      channel: camp.channel,
      toCount: camp.recipientIds.length,
      body: camp.content,
      at: new Date().toISOString(),
      delivery: 'SIMULATION_ONLY',
    };
    ws.outbox.push(entry);
    save();
    return sendJson(res, 200, { delivery: 'SIMULATION_ONLY', outboxId: entry.id });
  }
  // Files
  if (parts[1] === 'files' && parts.length === 3 && req.method === 'GET') {
    await requireUser(auth, req);
    const file = resolveStoredFile(ev.id, parts[2]);
    if (!file) return err(res, 404, '파일을 찾을 수 없습니다');
    const ext = path.extname(file).toLowerCase();
    const type =
      Object.keys(ALLOW_TYPES).find((t) => ALLOW_TYPES[t] === ext) || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  // Results + reports
  if (parts[1] === 'reports' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { reports: ws.reports });
  }
  if (parts[1] === 'reports' && parts.length === 2 && req.method === 'POST') {
    requireWrite(me, 'results');
    if (!text(body.title)) return err(res, 400, '보고서 제목을 입력하세요', 'title');
    const metrics = eventSummary(ws);
    const report = {
      id: nextId(ws.reports, 'report'),
      title: text(body.title),
      summary: text(body.summary),
      metrics,
      photos: ws.photos
        .filter((p) => p && p.status === 'APPROVED')
        .map((p) => ({ id: p.id, participantId: p.participantId, caption: p.caption || '' })),
      createdAt: new Date().toISOString(),
    };
    Object.freeze(report);
    ws.reports.push(report);
    save();
    return sendJson(res, 201, { report });
  }
  return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
}

function resolveStoredFile(eventId, filename) {
  const name = safeFileName(filename);
  if (!name || /^\.+$/.test(name)) return null;
  const full = path.normalize(path.join(storageRoot(), String(eventId), name));
  const base = path.normalize(storageRoot()) + path.sep;
  if (!full.startsWith(base)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

async function handleFileUpload(req, res, store, eventId, urlPath, auth, access) {
  const me = await requireUser(auth, req);
  await access.authorize({ account: me, eventId, command: 'file.upload' });
  requireWrite(me, 'photos');
  const initialEvent = findEvent(readEvents(store), eventId);
  const query = urlPath.split('?')[1] || '';
  const params = new URLSearchParams(query);
  const rawName = params.get('name') || '';
  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    return err(res, 400, '파일 이름을 확인하세요', 'name');
  }
  const name = safeFileName(rawName);
  if (!name) return err(res, 400, '파일 이름을 확인하세요', 'name');
  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOW_TYPES[ctype]) return err(res, 400, '지원하지 않는 파일 형식입니다', 'type');
  const dir = path.join(storageRoot(), initialEvent.id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = crypto.randomUUID() + '-' + name;
  await writeUpload(req, path.join(dir, stored), MAX_FILE_BYTES);
  const data = readEvents(store);
  const ev = findEvent(data, eventId);
  const ws = workspaceOf(data, ev.id);
  if (!Array.isArray(ws.files)) ws.files = [];
  const meta = {
    key: ev.id + '/' + stored,
    name: stored,
    original: params.get('name'),
    size: fs.statSync(path.join(dir, stored)).size,
    type: ctype,
    at: new Date().toISOString(),
  };
  ws.files.push(meta);
  saveEvents(store, data);
  return sendJson(res, 201, { file: meta });
}

function normCodeDirection(value) {
  const dir = String(value === undefined || value === null ? 'IN' : value).trim().toUpperCase();
  return dir === 'OUT' ? 'OUT' : 'IN';
}

function scanKind(key) {
  if (key === 'success') return 'good';
  if (key === 'duplicate' || key === 'not-in' || key === 'queued') return 'warn';
  return 'bad';
}

function findPersonById(ws, id) {
  const want = text(id);
  return (ws.participants || []).find((p) => p && !p.cancelled && p.id === want) || null;
}

function publicPoll(ws) {
  const counts = (ws.poll.options || []).map(() => 0);
  Object.keys(ws.poll.votes || {}).forEach((pid) => {
    const idx = ws.poll.votes[pid];
    if (counts[idx] !== undefined) counts[idx] += 1;
  });
  return { status: ws.poll.status, options: ws.poll.options, counts };
}

function addParticipant(store, data, ws, body, selfService) {
  const opts = body || {};
  const name = text(opts.name);
  const phone = text(opts.phone);
  if (!name) {
    const e = new Error('이름을 입력하세요');
    e.status = 400;
    e.field = 'name';
    throw e;
  }
  const duplicate = (ws.participants || []).some(
    (p) => p && !p.cancelled && p.name === name && text(p.phone) === phone
  );
  if (duplicate) {
    const e = new Error('이미 등록한 참가자입니다');
    e.status = 409;
    throw e;
  }
  const cap = Number(ws.capacity) || 0;
  const active = (ws.participants || []).filter((p) => p && !p.cancelled).length;
  if (cap > 0 && active >= cap) {
    const e = new Error('등록 정원이 마감되었습니다');
    e.status = 409;
    throw e;
  }
  let max = 0;
  (ws.participants || []).forEach((p) => {
    const m = /^p(\d+)$/.exec((p && p.id) || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  const num = max + 1;
  const participant = {
    id: 'p' + num,
    name,
    phone,
    company: text(opts.company),
    email: text(opts.email),
    group: '일반',
    registrationType: 'PRE',
    status: 'registered',
    everIn: false,
    cancelled: false,
    ticket: 'GENERAL',
    code: 'EVT-' + (1000 + num),
    registeredAt: new Date().toISOString(),
    selfService: !!selfService,
  };
  ws.participants.push(participant);
  saveEvents(store, data);
  return participant;
}

const ALLOW_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/json': '.json',
};
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function storageRoot() {
  return process.env.STORAGE_DIR || path.join(__dirname, '..', 'data', 'storage');
}

function safeFileName(raw) {
  const base = path.basename(String(raw || ''));
  const clean = base.replace(/[^a-zA-Z0-9가-힣_.-]/g, '').replace(/^\.+/, '');
  return clean.slice(0, 120);
}

function writeUpload(req, dest, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const stream = fs.createWriteStream(dest);
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > cap) {
        tooBig = true;
        stream.destroy();
        fs.unlink(dest, () => {});
        req.resume();
        return;
      }
      stream.write(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        reject(Object.assign(new Error('파일이 너무 큽니다'), { status: 413 }));
        return;
      }
      stream.end(() => resolve(size));
    });
    req.on('error', () => {
      fs.unlink(dest, () => {});
      reject(new Error('파일을 받지 못했습니다'));
    });
    stream.on('error', () => {
      fs.unlink(dest, () => {});
      if (!tooBig) reject(new Error('파일을 저장하지 못했습니다'));
    });
  });
}

async function handleApi(req, res, store, urlPath, security = {}) {
  ensureSeedData(store);
  const { auth, access } = security;
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] !== 'api') return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });

  // Raw octet uploads bypass the JSON body reader.
  if (req.method === 'POST' && parts[1] === 'events' && parts[3] === 'files' && parts.length === 4) {
    try {
      return await handleFileUpload(req, res, store, parts[2], req.url || urlPath, auth, access);
    } catch (e) {
      return err(res, e.status || 500, e.message || '요청을 처리하지 못했습니다', e.field);
    }
  }

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }
  }

  try {
    if (parts[1] === 'users' && parts.length === 2 && req.method === 'POST') {
      const me = await requireUser(auth, req);
      if (String(me.role).toUpperCase() !== 'AGENCY') {
        throw Object.assign(new Error('권한을 확인하세요'), { status: 403 });
      }
      return err(res, 410, '계정은 초대 수락 절차로 생성해야 합니다');
    }
    if (parts[1] === 'summary' && parts.length === 2 && req.method === 'GET') {
      const account = await requireUser(auth, req);
      await access.authorize({ account, command: 'organization.summary' });
      return sendJson(res, 200, { summary: agencySummary(readEvents(store)) });
    }
    if (parts[1] === 'events') {
      return await handleEvents(req, res, store, parts.slice(2), body, auth, access);
    }
    return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
  } catch (e) {
    return err(res, e.status || 500, e.message || '요청을 처리하지 못했습니다', e.field);
  }
}

module.exports = { handleApi };
