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

  function contentState() {
    if (!ETKO.contentUi || typeof ETKO.contentUi !== 'object') ETKO.contentUi = {};
    if (!ETKO.contentUi.events || typeof ETKO.contentUi.events !== 'object') ETKO.contentUi.events = {};
    var eventId = String(ETKO.store && ETKO.store.activeEventId || 'default');
    if (!ETKO.contentUi.events[eventId]) {
      ETKO.contentUi.events[eventId] = { drafts: {}, errors: {}, pageError: null };
    }
    return ETKO.contentUi.events[eventId];
  }

  function formFieldAttrs(state, form, field, id) {
    var error = state.errors[form];
    return error && error.field === field
      ? ' aria-invalid="true" aria-describedby="' + escapeHtml(id) + '"'
      : ' aria-invalid="false"';
  }

  function formFieldError(state, form, field, id) {
    var error = state.errors[form];
    if (!error || error.field !== field) return '';
    return '<p class="field-error" id="' + escapeHtml(id) + '" role="alert">' + escapeHtml(error.message) + '</p>';
  }

  function formValue(state, form, field) {
    var draft = state.drafts[form] || {};
    return escapeHtml(draft[field] || '');
  }

  function contentErrorField(form, message, draft) {
    if (form === 'program') {
      if (message.indexOf('프로그램명') !== -1) return 'title';
      if (message.indexOf('장소') !== -1) return 'location';
      if (message.indexOf('종료는 시작보다') !== -1) {
        return isNaN(toMinutes(draft.time)) ? 'time' : 'end';
      }
    } else if (form === 'notice') {
      if (message.indexOf('공지 제목') !== -1) return 'title';
      if (message.indexOf('내용') !== -1) return 'body';
    } else if (form === 'venue' && message.indexOf('행사장 이름') !== -1) {
      return 'name';
    }
    return null;
  }

  function focusContentField(container, form, field) {
    if (!container || !field || typeof container.querySelector !== 'function') return;
    var attrs = {
      program: { title: 'data-program-title', time: 'data-program-time', end: 'data-program-end', location: 'data-program-location' },
      notice: { title: 'data-notice-title', body: 'data-notice-body' },
      venue: { name: 'data-venue-name', address: 'data-venue-address' },
    };
    var attr = attrs[form] && attrs[form][field];
    var control = attr ? container.querySelector('[' + attr + ']') : null;
    if (control && typeof control.focus === 'function') control.focus();
  }

  // Management mount renderer: program + notice + venue + board sections
  // with Korean copy and wired controls. Errors surface as role=alert.
  ETKO.renderContent = function (container) {
    var ws = contentWorkspace();
    var state = contentState();
    var programRows = ws.program.map(function (row) {
      return (
        '<li class="card">' + escapeHtml(row.time) + '~' + escapeHtml(row.end) + ' ' +
        escapeHtml(row.title) + ' · ' + escapeHtml(row.location) +
        ' <button type="button" data-program-del="' + escapeHtml(row.id) + '">삭제</button></li>'
      );
    }).join('');
    var noticeRows = ws.notices.map(function (n) {
      return (
        '<li class="card">' + (n.pinned ? '[고정] ' : '') + escapeHtml(n.title) + ' · ' + escapeHtml(n.body) + '</li>'
      );
    }).join('');
    var venue = ws.venue || null;
    var posts = ws.posts.map(function (p) {
      return '<li class="card">' + escapeHtml(p.author || '') + ': ' + escapeHtml(p.body || '') + '</li>';
    }).join('');
    var html =
      '<section aria-label="프로그램 관리"><h2>프로그램</h2>' +
      '<ul class="cards">' + (programRows || '<li class="card" data-empty><p role="status">등록된 프로그램이 없습니다</p></li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><label>세션명<input data-program-title type="text" required value="' + formValue(state, 'program', 'title') + '" aria-label="세션명"' + formFieldAttrs(state, 'program', 'title', 'program-title-error') + ' /></label>' +
      formFieldError(state, 'program', 'title', 'program-title-error') + '</div>' +
      '<div class="field"><label>시작 시간<input data-program-time type="time" required value="' + formValue(state, 'program', 'time') + '" aria-label="시작 시간"' + formFieldAttrs(state, 'program', 'time', 'program-time-error') + ' /></label>' +
      formFieldError(state, 'program', 'time', 'program-time-error') + '</div>' +
      '<div class="field"><label>종료 시간<input data-program-end type="time" required value="' + formValue(state, 'program', 'end') + '" aria-label="종료 시간"' + formFieldAttrs(state, 'program', 'end', 'program-end-error') + ' /></label>' +
      formFieldError(state, 'program', 'end', 'program-end-error') + '</div>' +
      '<div class="field"><label>장소<input data-program-location type="text" required value="' + formValue(state, 'program', 'location') + '" aria-label="장소"' + formFieldAttrs(state, 'program', 'location', 'program-location-error') + ' /></label>' +
      formFieldError(state, 'program', 'location', 'program-location-error') + '</div>' +
      '<button type="button" data-program-add>세션 추가</button></div></section>' +
      '<section aria-label="공지 관리"><h2>공지</h2>' +
      '<ul class="cards">' + (noticeRows || '<li class="card" data-empty><p role="status">등록된 공지가 없습니다</p></li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><label>공지 제목<input data-notice-title type="text" required value="' + formValue(state, 'notice', 'title') + '" aria-label="공지 제목"' + formFieldAttrs(state, 'notice', 'title', 'notice-title-error') + ' /></label>' +
      formFieldError(state, 'notice', 'title', 'notice-title-error') + '</div>' +
      '<div class="field"><label>공지 내용<textarea data-notice-body rows="4" required aria-label="공지 내용"' + formFieldAttrs(state, 'notice', 'body', 'notice-body-error') + '>' + formValue(state, 'notice', 'body') + '</textarea></label>' +
      formFieldError(state, 'notice', 'body', 'notice-body-error') + '</div>' +
      '<button type="button" data-notice-add>공지 게시</button></div></section>' +
      '<section aria-label="행사장 관리"><h2>행사장 안내</h2>' +
      (venue
        ? '<p>' + escapeHtml(venue.name) + ' · ' + escapeHtml(venue.address || '') + '</p>'
        : '<p role="status" data-empty>행사장 정보가 없습니다</p>') +
      '<div class="inline-form"><div class="field"><label>행사장 이름<input data-venue-name type="text" value="' + formValue(state, 'venue', 'name') + '" aria-label="행사장 이름"' + formFieldAttrs(state, 'venue', 'name', 'venue-name-error') + ' /></label>' +
      formFieldError(state, 'venue', 'name', 'venue-name-error') + '</div>' +
      '<div class="field"><label>주소<input data-venue-address type="text" value="' + formValue(state, 'venue', 'address') + '" aria-label="행사장 주소"' + formFieldAttrs(state, 'venue', 'address', 'venue-address-error') + ' /></label>' +
      formFieldError(state, 'venue', 'address', 'venue-address-error') + '</div>' +
      '<button type="button" data-venue-save>행사장 저장</button></div></section>' +
      '<section aria-label="게시판"><h2>게시판</h2>' +
      '<ul class="cards">' + (posts || '<li class="card" data-empty><p role="status">게시글이 없습니다</p></li>') + '</ul></section>';
    if (state.pageError) html += '<p role="alert">' + escapeHtml(state.pageError) + '</p>';
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
    function onAttr(attr, fn, form) {
      Array.prototype.forEach.call(container.querySelectorAll('[' + attr + ']'), function (btn) {
        if (btn.tagName === 'INPUT') return;
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = contentState();
          ETKO.lastContentError = null;
          state.pageError = null;
          try {
            fn(btn);
            if (form) {
              state.drafts[form] = null;
              state.errors[form] = null;
            }
          } catch (err) {
            var message = err && err.message ? err.message : '처리하지 못했습니다';
            ETKO.lastContentError = message;
            if (form) {
              var draft = state.drafts[form] || {};
              var field = contentErrorField(form, message, draft);
              state.errors[form] = { message: message, field: field };
              if (!field) state.pageError = message;
            } else {
              state.pageError = message;
            }
          }
          rerenderContent(container);
          if (form && state.errors[form]) {
            focusContentField(container, form, state.errors[form].field);
          }
        });
      });
    }
    onAttr('data-program-add', function () {
      var state = contentState();
      state.drafts.program = {
        title: fieldValue(container, 'data-program-title'),
        time: fieldValue(container, 'data-program-time'),
        end: fieldValue(container, 'data-program-end'),
        location: fieldValue(container, 'data-program-location'),
      };
      ETKO.saveProgram(state.drafts.program);
    }, 'program');
    onAttr('data-program-del', function (btn) {
      ETKO.deleteProgram(btn.getAttribute('data-program-del'));
    });
    onAttr('data-notice-add', function () {
      var state = contentState();
      state.drafts.notice = {
        title: fieldValue(container, 'data-notice-title'),
        body: fieldValue(container, 'data-notice-body'),
      };
      ETKO.saveNotice(state.drafts.notice);
    }, 'notice');
    onAttr('data-venue-save', function () {
      var state = contentState();
      state.drafts.venue = {
        name: fieldValue(container, 'data-venue-name'),
        address: fieldValue(container, 'data-venue-address'),
      };
      ETKO.saveVenue(state.drafts.venue);
    }, 'venue');
  }

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['saveProgram', 'deleteProgram', 'saveNotice', 'saveVenue', 'createPost']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
