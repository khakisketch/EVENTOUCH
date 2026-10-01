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

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Management mount renderer: program + notice + venue + board sections
  // with Korean copy and wired controls. Errors surface as role=alert.
  ETKO.renderContent = function (container) {
    var ws = contentWorkspace();
    var programRows = ws.program.map(function (row) {
      return (
        '<li>' + escapeHtml(row.time) + '~' + escapeHtml(row.end) + ' ' +
        escapeHtml(row.title) + ' · ' + escapeHtml(row.location) +
        ' <button type="button" data-program-del="' + escapeHtml(row.id) + '">삭제</button></li>'
      );
    }).join('');
    var noticeRows = ws.notices.map(function (n) {
      return (
        '<li>' + (n.pinned ? '[고정] ' : '') + escapeHtml(n.title) + ' · ' + escapeHtml(n.body) + '</li>'
      );
    }).join('');
    var venue = ws.venue || null;
    var posts = ws.posts.map(function (p) {
      return '<li>' + escapeHtml(p.author || '') + ': ' + escapeHtml(p.body || '') + '</li>';
    }).join('');
    var html =
      '<section aria-label="프로그램 관리"><h2>프로그램</h2>' +
      '<ul>' + (programRows || '<li>등록된 프로그램이 없습니다</li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><input data-program-title type="text" placeholder="세션명" aria-label="세션명" /></div>' +
      '<div class="field"><input data-program-time type="text" placeholder="시작 09:00" aria-label="시작 시간" /></div>' +
      '<div class="field"><input data-program-end type="text" placeholder="종료 10:00" aria-label="종료 시간" /></div>' +
      '<div class="field"><input data-program-location type="text" placeholder="장소" aria-label="장소" /></div>' +
      '<button type="button" data-program-add>세션 추가</button></div></section>' +
      '<section aria-label="공지 관리"><h2>공지</h2>' +
      '<ul>' + (noticeRows || '<li>등록된 공지가 없습니다</li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><input data-notice-title type="text" placeholder="공지 제목" aria-label="공지 제목" /></div>' +
      '<div class="field"><input data-notice-body type="text" placeholder="내용" aria-label="공지 내용" /></div>' +
      '<button type="button" data-notice-add>공지 게시</button></div></section>' +
      '<section aria-label="행사장 관리"><h2>행사장 안내</h2>' +
      '<p>' + (venue ? escapeHtml(venue.name) + ' · ' + escapeHtml(venue.address || '') : '행사장 정보가 없습니다') + '</p>' +
      '<div class="inline-form"><div class="field"><input data-venue-name type="text" placeholder="행사장 이름" aria-label="행사장 이름" /></div>' +
      '<div class="field"><input data-venue-address type="text" placeholder="주소" aria-label="행사장 주소" /></div>' +
      '<button type="button" data-venue-save>행사장 저장</button></div></section>' +
      '<section aria-label="게시판"><h2>게시판</h2>' +
      '<ul>' + (posts || '<li>게시글이 없습니다</li>') + '</ul></section>';
    if (ETKO.lastContentError) {
      html += '<p role="alert">' + escapeHtml(ETKO.lastContentError) + '</p>';
    }
    container.innerHTML = html;
    wireContent(container);
    return container.innerHTML;
  };

  function rerenderContent(container) {
    if (typeof ETKO.renderContent === 'function') {
      try {
        ETKO.renderContent(container);
      } catch (err) {}
    }
  }

  function fieldValue(container, attr) {
    var el = container.querySelector ? container.querySelector('[' + attr + ']') : null;
    return el && el.value !== undefined ? el.value : '';
  }

  function wireContent(container) {
    if (!container || !container.querySelectorAll) return;
    function onAttr(attr, fn) {
      Array.prototype.forEach.call(container.querySelectorAll('[' + attr + ']'), function (btn) {
        if (btn.tagName === 'INPUT') return;
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          ETKO.lastContentError = null;
          try {
            fn(btn);
          } catch (err) {
            ETKO.lastContentError = err && err.message ? err.message : '처리하지 못했습니다';
          }
          rerenderContent(container);
        });
      });
    }
    onAttr('data-program-add', function () {
      ETKO.saveProgram({
        title: fieldValue(container, 'data-program-title'),
        time: fieldValue(container, 'data-program-time'),
        end: fieldValue(container, 'data-program-end'),
        location: fieldValue(container, 'data-program-location'),
      });
    });
    onAttr('data-program-del', function (btn) {
      ETKO.deleteProgram(btn.getAttribute('data-program-del'));
    });
    onAttr('data-notice-add', function () {
      ETKO.saveNotice({
        title: fieldValue(container, 'data-notice-title'),
        body: fieldValue(container, 'data-notice-body'),
      });
    });
    onAttr('data-venue-save', function () {
      ETKO.saveVenue({
        name: fieldValue(container, 'data-venue-name'),
        address: fieldValue(container, 'data-venue-address'),
      });
    });
  }

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
