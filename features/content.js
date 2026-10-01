(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Program, notices, venue, board and participant-home feed (Task 9).
  // Consumes ETKO.workspace() (holds `program`, `notices`, `venue`,
  // `posts`). Data functions only; existing renderHome/nextAction untouched.

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function contentWorkspace() {
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.program)) ws.program = [];
    if (!Array.isArray(ws.notices)) ws.notices = [];
    if (!Array.isArray(ws.posts)) ws.posts = [];
    if (!Array.isArray(ws.participants)) ws.participants = [];
    return ws;
  }

  function findParticipant(ws, id) {
    for (var i = 0; i < ws.participants.length; i += 1) {
      if (ws.participants[i] && ws.participants[i].id === id) return ws.participants[i];
    }
    return null;
  }

  function nextId(ws, list, prefix) {
    var max = 0;
    list.forEach(function (row) {
      var m = new RegExp('^' + prefix + '-(\\d+)$').exec((row && row.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = prefix + '-' + (max + 1);
    while (list.some(function (row) { return row && row.id === id; })) {
      max += 1;
      id = prefix + '-' + (max + 1);
    }
    return id || ws;
  }

  function toMinutes(value) {
    var m = /^(\d{2}):(\d{2})$/.exec(text(value));
    if (!m) return NaN;
    var hour = parseInt(m[1], 10);
    var minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) return NaN;
    return hour * 60 + minute;
  }

  function findProgram(ws, id) {
    for (var i = 0; i < ws.program.length; i += 1) {
      if (ws.program[i] && ws.program[i].id === id) return ws.program[i];
    }
    return null;
  }

  function sortProgram(ws) {
    ws.program.sort(function (a, b) {
      return text(a && a.time).localeCompare(text(b && b.time));
    });
  }

  // Create by default, update when `id` matches. End must be a later
  // same-day HH:MM than start.
  ETKO.saveProgram = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('program');
    var opts = input || {};
    var ws = contentWorkspace();
    var title = text(opts.title);
    var location = text(opts.location);
    var start = toMinutes(opts.time);
    var finish = toMinutes(opts.end);
    if (!title) throw new Error('프로그램명을 입력하세요');
    if (isNaN(start) || isNaN(finish) || finish <= start) {
      throw new Error('종료는 시작보다 늦은 당일 시간이어야 합니다');
    }
    if (!location) throw new Error('장소를 입력하세요');
    if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
      var previous = findProgram(ws, opts.id);
      if (!previous) throw new Error('프로그램을 찾을 수 없습니다');
      previous.title = title;
      previous.time = text(opts.time);
      previous.end = text(opts.end);
      previous.location = location;
      sortProgram(ws);
      return previous;
    }
    var row = {
      id: nextId(ws, ws.program, 'program'),
      title: title,
      time: text(opts.time),
      end: text(opts.end),
      location: location,
    };
    ws.program.push(row);
    sortProgram(ws);
    return row;
  };

  ETKO.deleteProgram = function (id) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('program');
    var ws = contentWorkspace();
    ws.program = ws.program.filter(function (row) {
      return !row || row.id !== id;
    });
    return ws.program.length;
  };

  function findNotice(ws, id) {
    for (var i = 0; i < ws.notices.length; i += 1) {
      if (ws.notices[i] && ws.notices[i].id === id) return ws.notices[i];
    }
    return null;
  }

  // Create by default, update when `id` matches. New notices go first.
  ETKO.saveNotice = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('notices');
    var opts = input || {};
    var ws = contentWorkspace();
    var title = text(opts.title);
    var body = text(opts.body);
    if (!title) throw new Error('공지 제목을 입력하세요');
    if (!body) throw new Error('내용을 입력하세요');
    if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
      var previous = findNotice(ws, opts.id);
      if (!previous) throw new Error('공지를 찾을 수 없습니다');
      previous.title = title;
      previous.body = body;
      previous.pinned = !!opts.pinned;
      return previous;
    }
    var row = { id: nextId(ws, ws.notices, 'notice'), title: title, body: body, pinned: !!opts.pinned };
    ws.notices.unshift(row);
    return row;
  };

  ETKO.saveVenue = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('venue');
    var opts = input || {};
    var ws = contentWorkspace();
    var name = text(opts.name);
    if (!name) throw new Error('행사장 이름을 입력하세요');
    ws.venue = {
      name: name,
      address: text(opts.address),
      description: text(opts.description),
    };
    return { name: ws.venue.name, address: ws.venue.address, description: ws.venue.description };
  };

  // Participant board post, max 300 chars. Newest first.
  ETKO.createPost = function (participantId, body) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('board');
    var ws = contentWorkspace();
    var person = findParticipant(ws, participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    var content = text(body);
    if (!content || content.length > 300) throw new Error('게시글은 300자 이내로 입력하세요');
    var record = {
      id: nextId(ws, ws.posts, 'post'),
      participantId: person.id,
      author: person.name,
      body: content,
      status: 'VISIBLE',
    };
    ws.posts.unshift(record);
    return {
      id: record.id,
      participantId: record.participantId,
      author: record.author,
      body: record.body,
      status: record.status,
    };
  };

  function homeAt(value) {
    if (value === undefined || value === null || value === '') {
      var current = new Date();
      return current.getHours() * 60 + current.getMinutes();
    }
    if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();
    if (typeof value === 'number' && isFinite(value)) return Math.floor(value);
    var minutes = toMinutes(value);
    if (!isNaN(minutes)) return minutes;
    throw new Error('기준 시간을 확인하세요');
  }

  // Participant-home feed: `{now, next}` program rows at the given
  // HH:MM (defaults to the current local time). Data only.
  ETKO.homeNow = function (at) {
    var ws = contentWorkspace();
    var mark = homeAt(at);
    var rows = ws.program
      .filter(function (row) {
        return row && !isNaN(toMinutes(row.time)) && !isNaN(toMinutes(row.end));
      })
      .slice()
      .sort(function (a, b) {
        return toMinutes(a.time) - toMinutes(b.time);
      });
    var now = null;
    var next = null;
    for (var i = 0; i < rows.length; i += 1) {
      var start = toMinutes(rows[i].time);
      var finish = toMinutes(rows[i].end);
      if (start <= mark && mark < finish && !now) now = rows[i];
      if (start > mark && !next) next = rows[i];
    }
    return { now: now, next: next };
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
