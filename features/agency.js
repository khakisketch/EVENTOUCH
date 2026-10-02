(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  var ROLES = ['AGENCY', 'MANAGER', 'CLIENT', 'STAFF', 'VIEWER'];

  // Known workspace routes. `booth`/`booths` are aliases for the same desk.
  // `engage` is the participation management screen.
  var KNOWN_ROUTES = [
    'overview',
    'participants',
    'participant',
    'checkin',
    'booth',
    'booths',
    'engage',
    'content',
    'messages',
    'stage',
    'staff',
    'qna',
    'photos',
    'poll',
    'quiz',
    'draw',
    'survey',
    'program',
    'notices',
    'venue',
    'board',
    'results',
    'settings',
    'members',
    'events',
    'home',
    'screen',
  ];

  // STAFF works the field desks only. CLIENT/VIEWER share the read-only subset.
  // `engage` is visible to staff for field participation work and to
  // clients/viewers read-only; writes stay behind requireWrite.
  var STAFF_ROUTES = [
    'overview',
    'participants',
    'checkin',
    'booth',
    'booths',
    'engage',
    'screen',
    'staff',
    'qna',
    'photos',
  ];
  var READONLY_ROUTES = [
    'overview',
    'participants',
    'participant',
    'booth',
    'booths',
    'engage',
    'content',
    'messages',
    'stage',
    'photos',
    'poll',
    'program',
    'notices',
    'venue',
    'board',
    'results',
    'home',
    'screen',
  ];

  function normRole(role) {
    return String(role === undefined || role === null ? '' : role)
      .trim()
      .toUpperCase();
  }

  function normRoute(route) {
    return String(route === undefined || route === null ? '' : route).trim();
  }

  function sampleParticipants() {
    if (ETKO.sample && Array.isArray(ETKO.sample.participants)) {
      return ETKO.sample.participants;
    }
    // Node (require-based tests) may load before ETKO.sample is set;
    // fall back to the shipped sample file. Browsers skip this branch.
    try {
      if (typeof require === 'function' && typeof __dirname === 'string') {
        var fs = require('fs');
        var pth = require('path');
        var data = JSON.parse(
          fs.readFileSync(pth.join(__dirname, '..', 'data', 'sample.json'), 'utf8')
        );
        if (data && Array.isArray(data.participants)) return data.participants;
      }
    } catch (err) {}
    return [];
  }

  function copyParticipant(p) {
    var out = {};
    Object.keys(p || {}).forEach(function (key) {
      out[key] = p[key];
    });
    var entered = String(out.status === undefined || out.status === null ? '' : out.status).trim().toLowerCase() === 'in';
    out.everIn = entered ? true : out.everIn === true;
    if (typeof out.group !== 'string' || !out.group) out.group = '일반';
    return out;
  }

  // Empty workspace: later features fill their own slices, but every key
  // exists from the start so consumers never see `undefined`.
  function emptyWorkspace() {
    return {
      participants: [],
      seeded: false,
      seedFromSample: false,
      members: [],
      fields: [],
      formVersion: 1,
      units: [],
      logs: [],
      boothMode: 'SELF',
      booths: [],
      visits: [],
      poll: { title: '', options: [], votes: [], status: 'CLOSED' },
      quiz: { title: '', answer: '', answers: [], status: 'CLOSED' },
      qna: [],
      draw: { phase: 'IDLE', result: null, history: [], winners: [] },
      survey: { title: '', questions: [], open: false },
      responses: [],
      photos: [],
      product: { presentation: null, media: [] },
      templates: [],
      messages: [],
      program: [],
      notices: [],
      venue: null,
      posts: [],
      reports: [],
    };
  }

  function seedWorkspace() {
    var ws = emptyWorkspace();
    ws.participants = sampleParticipants().map(copyParticipant);
    ws.poll = { title: '만족도 투표', options: ['만족', '보통'], votes: [], status: 'CLOSED' };
    ws.quiz = { title: '퀴즈', answer: '', answers: [], status: 'CLOSED' };
    ws.survey = { title: '만족도 조사', questions: [], open: false };
    // Seed provenance: only this workspace may refill from a late sample
    // (browser fetch races script load). New events never seed.
    ws.seeded = ws.participants.length > 0;
    ws.seedFromSample = ws.participants.length === 0;
    return ws;
  }

  function seedStore() {
    return {
      events: [
        {
          id: 'evt-1',
          name: 'EVENTOUCH 운영 샘플',
          date: '2026-10-01',
          venue: 'A홀',
          status: 'PRE',
        },
      ],
      workspaces: { 'evt-1': seedWorkspace() },
      activeEventId: 'evt-1',
      role: 'AGENCY',
    };
  }

  if (!ETKO.store || !Array.isArray(ETKO.store.events)) {
    ETKO.store = seedStore();
  }
  if (ROLES.indexOf(ETKO.store.role) === -1) ETKO.store.role = 'AGENCY';

  // Switch the virtual role. Unknown roles keep the current role.
  ETKO.setRole = function (role) {
    var next = normRole(role);
    if (ROLES.indexOf(next) === -1) return ETKO.store.role;
    ETKO.store.role = next;
    return ETKO.store.role;
  };

  // Menu + direct-path + write-command gate. Unknown roles and unknown
  // routes are always denied.
  ETKO.canRoute = function (role, route) {
    var r = normRole(role);
    var path = normRoute(route);
    if (KNOWN_ROUTES.indexOf(path) === -1) return false;
    if (r === 'AGENCY' || r === 'MANAGER') return true;
    if (r === 'STAFF') return STAFF_ROUTES.indexOf(path) !== -1;
    if (r === 'CLIENT' || r === 'VIEWER') {
      return READONLY_ROUTES.indexOf(path) !== -1;
    }
    return false;
  };

  // Write-command gate: VIEWER/CLIENT cannot mutate event data.
  // STAFF keeps field-desk writes via its route table; participant detail
  // stays reachable through openParticipantDetail (route table untouched).
  // Read-only routes (e.g. results for VIEWER) never imply write permission.
  var STAFF_WRITE_ROUTES = ['participants', 'checkin', 'booth', 'booths', 'staff', 'qna', 'photos', 'poll', 'quiz', 'draw', 'survey'];
  ETKO.requireWrite = function (route) {
    var role = ETKO.store && ETKO.store.role ? ETKO.store.role : 'AGENCY';
    var r = normRole(role);
    if (r === 'AGENCY' || r === 'MANAGER') {
      if (!ETKO.canRoute(r, route)) throw new Error('권한을 확인하세요');
      return;
    }
    if (r === 'STAFF') {
      if (STAFF_WRITE_ROUTES.indexOf(normRoute(route)) === -1) throw new Error('권한을 확인하세요');
      return;
    }
    throw new Error('권한을 확인하세요');
  };

  function nextEventId() {
    var max = 0;
    ETKO.store.events.forEach(function (ev) {
      var m = /^evt-(\d+)$/.exec(ev && ev.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'evt-' + (max + 1);
  }

  // Create an empty event: 3-field validation, status PRE, no cloned records.
  // Does not switch the active event.
  ETKO.createEvent = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('events');
    var opts = input || {};
    var name = String(opts.name === undefined || opts.name === null ? '' : opts.name).trim();
    var date = String(opts.date === undefined || opts.date === null ? '' : opts.date).trim();
    var venue = String(
      opts.venue === undefined || opts.venue === null ? '' : opts.venue
    ).trim();
    if (!name) throw new Error('행사 이름을 입력하세요');
    if (!date) throw new Error('행사 날짜를 입력하세요');
    if (!venue) throw new Error('행사 장소를 입력하세요');
    var id = nextEventId();
    ETKO.store.events.push({ id: id, name: name, date: date, venue: venue, status: 'PRE' });
    ETKO.store.workspaces[id] = emptyWorkspace();
    return id;
  };

  ETKO.switchEvent = function (id) {
    var found = null;
    ETKO.store.events.forEach(function (ev) {
      if (ev && ev.id === id) found = ev;
    });
    if (!found) throw new Error('행사를 찾을 수 없습니다');
    ETKO.store.activeEventId = found.id;
    try {
      if (ETKO.selectedIds && typeof ETKO.selectedIds.clear === 'function') ETKO.selectedIds.clear();
    } catch (err) {}
    ETKO.lastScanResult = null;
    ETKO.homeParticipantId = null;
    ETKO.detailBypass = false;
    ETKO.activeUnitId = null;
    ETKO.lastSignupTicket = null;
    ETKO.lastSignupError = null;
    ETKO.lastLookupError = null;
    ETKO.lastQrError = null;
    ETKO.lastStampError = null;
    ETKO.lastStampDone = false;
    ETKO.lastEngageError = null;
    ETKO.lastContentError = null;
    ETKO.lastMessagingError = null;
    ETKO.lastDeskError = null;
    return found;
  };

  ETKO.workspace = function () {
    var ws = ETKO.store.workspaces[ETKO.store.activeEventId];
    if (!ws) throw new Error('행사를 찾을 수 없습니다');
    try {
      ETKO.ensureSeeded();
    } catch (err) {}
    return ws;
  };

  // Fill a seed-pending workspace once the sample arrives late (browser
  // fetch races script load). Only workspaces flagged `seedFromSample`
  // refill, and only while still empty and unseeded. Returns true on fill.
  ETKO.ensureSeeded = function () {
    var ws = ETKO.store.workspaces[ETKO.store.activeEventId];
    if (!ws) throw new Error('행사를 찾을 수 없습니다');
    if (ws.seeded || !ws.seedFromSample) return false;
    if (Array.isArray(ws.participants) && ws.participants.length > 0) {
      ws.seeded = true;
      ws.seedFromSample = false;
      return false;
    }
    var sample = ETKO.sample && Array.isArray(ETKO.sample.participants) ? ETKO.sample.participants : null;
    if (!sample) {
      try {
        sample = sampleParticipants();
      } catch (err) {
        sample = null;
      }
    }
    if (!sample || sample.length === 0) return false;
    ws.participants = sample.map(copyParticipant);
    ws.seeded = true;
    ws.seedFromSample = false;
    return true;
  };

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  // Event-members tab: create by default, update when `id` matches.
  ETKO.saveMember = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('members');
    var opts = input || {};
    var ws = ETKO.workspace();
    var name = String(opts.name === undefined || opts.name === null ? '' : opts.name).trim();
    var email = String(
      opts.email === undefined || opts.email === null ? '' : opts.email
    ).trim();
    var role = normRole(opts.role || 'STAFF');
    if (!name) throw new Error('이름을 입력하세요');
    if (!isEmail(email)) throw new Error('이메일 형식이 올바르지 않습니다');
    if (ROLES.indexOf(role) === -1) throw new Error('역할을 확인하세요');
    if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
      for (var i = 0; i < ws.members.length; i += 1) {
        if (ws.members[i] && ws.members[i].id === opts.id) {
          ws.members[i].name = name;
          ws.members[i].email = email;
          ws.members[i].role = role;
          return ws.members[i];
        }
      }
      throw new Error('행사 구성원을 찾을 수 없습니다');
    }
    var member = { id: 'm' + (ws.members.length + 1), name: name, email: email, role: role };
    ws.members.push(member);
    return member;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
