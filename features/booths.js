(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Booth lifecycle, event-scoped (Task 4).
  // Consumes ETKO.workspace() which owns `boothMode`, `booths`, `visits`.
  // Separate from the legacy global ETKO.boothMode / ETKO.setBoothMode in
  // features/booth.js (left untouched); on a successful mode switch this
  // file mirrors the value onto ETKO.boothMode so ETKO.nextAction copy
  // stays consistent.

  var MODES = ['SELF', 'STAFF'];
  var STATUSES = ['OPEN', 'WAITING', 'CLOSED'];

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function boothWorkspace() {
    var ws = ETKO.workspace();
    if (ws.boothMode !== 'SELF' && ws.boothMode !== 'STAFF') ws.boothMode = 'SELF';
    if (!Array.isArray(ws.booths)) ws.booths = [];
    if (!Array.isArray(ws.visits)) ws.visits = [];
    if (!Array.isArray(ws.participants)) ws.participants = [];
    return ws;
  }

  function findBooth(ws, id) {
    for (var i = 0; i < ws.booths.length; i += 1) {
      if (ws.booths[i] && ws.booths[i].id === id) return ws.booths[i];
    }
    return null;
  }

  function findParticipant(ws, id) {
    for (var i = 0; i < ws.participants.length; i += 1) {
      if (ws.participants[i] && ws.participants[i].id === id) return ws.participants[i];
    }
    return null;
  }

  function usedCount(ws, boothId) {
    var count = 0;
    ws.visits.forEach(function (v) {
      if (v && v.boothId === boothId) count += 1;
    });
    return count;
  }

  function personalCount(ws, boothId, participantId) {
    var count = 0;
    ws.visits.forEach(function (v) {
      if (v && v.boothId === boothId && v.participantId === participantId) count += 1;
    });
    return count;
  }

  function nextBoothId(ws) {
    var max = 0;
    ws.booths.forEach(function (b) {
      var m = /^b(\d+)$/.exec((b && b.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = 'b' + (max + 1);
    while (findBooth(ws, id)) {
      max += 1;
      id = 'b' + (max + 1);
    }
    return id;
  }

  function nextVisitId(ws) {
    var max = 0;
    ws.visits.forEach(function (v) {
      var m = /^v(\d+)$/.exec((v && v.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'v' + (max + 1);
  }

  function copyVisit(v) {
    return { id: v.id, boothId: v.boothId, participantId: v.participantId, at: v.at };
  }

  function normCapacity(value) {
    var n = Number(value);
    if (!isFinite(n) || Math.floor(n) !== n || n < 1) {
      throw new Error('부스 수량을 확인하세요');
    }
    return n;
  }

  function normLimit(value) {
    var n = Number(value);
    if (!isFinite(n) || Math.floor(n) !== n || n < 1) {
      throw new Error('1인당 참여 횟수를 확인하세요');
    }
    return n;
  }

  function normStatus(status) {
    var next = text(status).toUpperCase();
    if (STATUSES.indexOf(next) === -1) throw new Error('부스 상태를 확인하세요');
    return next;
  }

  function checkWindow(startsAt, endsAt) {
    var start = text(startsAt);
    var end = text(endsAt);
    if (start && end && end < start) throw new Error('종료 시간은 시작 시간보다 늦어야 합니다');
    return { startsAt: start || undefined, endsAt: end || undefined };
  }

  // Event-wide booth mode. Requires explicit acknowledgement; locks forever
  // once any stamp visit exists.
  ETKO.setEventBoothMode = function (mode, opts) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('booth');
    var ws = boothWorkspace();
    var next = text(mode).toUpperCase();
    if (MODES.indexOf(next) === -1) throw new Error('인증 방식을 확인하세요');
    var ack = opts && opts.acknowledge;
    if (!ack) throw new Error('인증 방향과 적용 범위를 확인하세요');
    if (ws.visits.length > 0) {
      throw new Error('인증 기록이 있는 행사는 방식을 변경할 수 없습니다');
    }
    ws.boothMode = next;
    ETKO.boothMode = next;
    return ws.boothMode;
  };

  // Create a booth by default; update the matching booth when `id` matches.
  ETKO.saveBooth = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('booth');
    var opts = input || {};
    var ws = boothWorkspace();
    var name = text(opts.name);
    if (!name) throw new Error('부스 이름을 입력하세요');
    var capacity = normCapacity(opts.capacity);
    var limit = normLimit(opts.limit);
    var status = normStatus(opts.status);
    var window = checkWindow(opts.startsAt, opts.endsAt);
    if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
      var existing = findBooth(ws, opts.id);
      if (!existing) throw new Error('부스를 찾을 수 없습니다');
      if (capacity < usedCount(ws, existing.id)) {
        throw new Error('이미 발급된 수량보다 적게 설정할 수 없습니다');
      }
      existing.name = name;
      existing.capacity = capacity;
      existing.limit = limit;
      existing.status = status;
      if (window.startsAt) existing.startsAt = window.startsAt;
      else delete existing.startsAt;
      if (window.endsAt) existing.endsAt = window.endsAt;
      else delete existing.endsAt;
      return existing;
    }
    var booth = { id: nextBoothId(ws), name: name, capacity: capacity, limit: limit, status: status };
    if (window.startsAt) booth.startsAt = window.startsAt;
    if (window.endsAt) booth.endsAt = window.endsAt;
    ws.booths.push(booth);
    return booth;
  };

  ETKO.setBoothStatus = function (id, status) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('booth');
    var ws = boothWorkspace();
    var booth = findBooth(ws, id);
    if (!booth) throw new Error('부스를 찾을 수 없습니다');
    booth.status = normStatus(status);
    return booth;
  };

  // Stamp one visit. Validates booth OPEN, time window, total capacity and
  // per-person limit. Returns a copy of the recorded visit.
  // Staff/admin path: requires the booth write grant.
  ETKO.stamp = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('booth');
    return recordVisit(input);
  };

  // Self-service path: SELF mode only (participant scans the booth QR).
  // STAFF mode refuses so participants cannot bypass the staff desk.
  ETKO.stampSelf = function (input) {
    var ws = boothWorkspace();
    if (ws.boothMode !== 'SELF') throw new Error('직원 스캔 방식에서는 직원이 인증합니다');
    return recordVisit(input);
  };

  function recordVisit(input) {
    var opts = input || {};
    var ws = boothWorkspace();
    var booth = findBooth(ws, opts.boothId);
    if (!booth) throw new Error('부스를 찾을 수 없습니다');
    var person = findParticipant(ws, opts.participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    if (booth.status !== 'OPEN') throw new Error('운영 중인 부스에서만 인증할 수 있습니다');
    var at = text(opts.at) || new Date().toISOString();
    if (booth.startsAt && at < booth.startsAt) {
      throw new Error('부스 운영 시간이 아닙니다');
    }
    if (booth.endsAt && at > booth.endsAt) {
      throw new Error('부스 운영 시간이 아닙니다');
    }
    if (usedCount(ws, booth.id) >= booth.capacity) {
      throw new Error('부스 정원이 마감되었습니다');
    }
    if (personalCount(ws, booth.id, person.id) >= booth.limit) {
      throw new Error('1인당 참여 횟수를 초과했습니다');
    }
    var visit = {
      id: nextVisitId(ws),
      boothId: booth.id,
      participantId: person.id,
      at: at,
    };
    ws.visits.push(visit);
    return copyVisit(visit);
  };

  // Public booth QR identifier (not an encrypted token).
  ETKO.boothPayload = function (eventId, boothId) {
    return 'ET:BOOTH:' + eventId + ':' + boothId;
  };

  function canWriteBooth() {
    if (typeof ETKO.requireWrite !== 'function') return true;
    try {
      ETKO.requireWrite('booth');
      return true;
    } catch (err) {
      return false;
    }
  }

  function boothUiState() {
    if (!ETKO.boothUi || typeof ETKO.boothUi !== 'object') ETKO.boothUi = {};
    if (!ETKO.boothUi.events || typeof ETKO.boothUi.events !== 'object') ETKO.boothUi.events = {};
    var eventId = String(ETKO.store && ETKO.store.activeEventId || 'default');
    if (!ETKO.boothUi.events[eventId]) ETKO.boothUi.events[eventId] = { draft: null, error: null, pageError: null };
    return ETKO.boothUi.events[eventId];
  }

  function boothFieldAttrs(state, field, id) {
    return state.error && state.error.field === field
      ? ' aria-invalid="true" aria-describedby="' + escapeHtml(id) + '"'
      : ' aria-invalid="false"';
  }

  function boothFieldError(state, field, id) {
    if (!state.error || state.error.field !== field) return '';
    return '<p class="field-error" id="' + escapeHtml(id) + '" role="alert">' + escapeHtml(state.error.message) + '</p>';
  }

  function boothErrorField(message) {
    if (message.indexOf('부스 이름') !== -1) return 'name';
    if (message.indexOf('부스 수량') !== -1 || message.indexOf('발급된 수량') !== -1) return 'capacity';
    if (message.indexOf('1인당') !== -1) return 'limit';
    if (message.indexOf('부스 상태') !== -1) return 'status';
    return null;
  }

  function focusBoothError(container, field) {
    if (!container || !field || typeof container.querySelector !== 'function') return;
    var attrs = { name: 'data-booth-name', capacity: 'data-booth-capacity', limit: 'data-booth-limit', status: 'data-booth-status-select' };
    var control = container.querySelector('[' + attrs[field] + ']');
    if (control && typeof control.focus === 'function') control.focus();
  }

  function latestPrint(ws, boothId) {
    var prints = ws && Array.isArray(ws.prints) ? ws.prints : [];
    for (var i = prints.length - 1; i >= 0; i -= 1) {
      if (prints[i] && prints[i].boothId === boothId) return prints[i];
    }
    return null;
  }

  // Staff booth management: mode + lock note, booth list with payload/QR/
  // remaining counts, add form, status switches, print confirmations.
  // Read-only roles see the list and payloads without controls. All
  // failures surface as Korean alerts.
  ETKO.renderBoothManage = function (container) {
    var ws = boothWorkspace();
    var state = boothUiState();
    var draft = state.draft || {};
    var writable = canWriteBooth();
    var modeLabel = ws.boothMode === 'STAFF' ? '직원 스캔' : '직접 스캔';
    var items = ws.booths.map(function (b) {
      var left = Math.max(0, (b.capacity || 0) - usedCount(ws, b.id));
      var payload = ETKO.boothPayload(ETKO.store.activeEventId, b.id);
      var qr = '';
      try {
        if (typeof ETKO.qrSvg === 'function') qr = '<div class="qr">' + ETKO.qrSvg(payload) + '</div>';
      } catch (err) {}
      var printed = latestPrint(ws, b.id);
      var controls = '';
      if (writable) {
        controls =
          ' <button type="button" data-booth-status="' + escapeHtml(b.id) + ':OPEN">운영</button>' +
          ' <button type="button" data-booth-status="' + escapeHtml(b.id) + ':WAITING">대기</button>' +
          ' <button type="button" data-booth-status="' + escapeHtml(b.id) + ':CLOSED">종료</button>' +
          ' <button type="button" data-booth-print="' + escapeHtml(b.id) + '">인쇄 확인</button>';
      }
      return (
        '<li class="card"><strong>' + escapeHtml(b.name) + '</strong> · ' + boothStatusLabel(b.status) +
        ' · 남은 ' + left + '개 · 1인 ' + (b.limit || 0) + '회' +
        '<p>QR: ' + escapeHtml(payload) + '</p>' + qr +
        (printed ? '<p>인쇄 확인됨 (' + escapeHtml(printed.format || 'A4') + ')</p>' : '') +
        controls + '</li>'
      );
    }).join('');
    var html =
      '<section aria-label="부스 관리"><h2>부스 관리</h2>' +
      '<p>방식: ' + modeLabel + (ws.visits.length > 0 ? ' · 인증 기록이 있어 방식을 변경할 수 없습니다' : '') + '</p>' +
      '<ul class="cards">' + (items || '<li class="card" data-empty><p role="status">등록된 부스가 없습니다</p></li>') + '</ul>';
    if (writable) {
      html +=
        '<div class="inline-form">' +
        '<div class="field"><label>부스 이름<input data-booth-name type="text" required value="' + escapeHtml(draft.name || '') + '" aria-label="부스 이름"' + boothFieldAttrs(state, 'name', 'booth-name-error') + ' /></label>' +
        boothFieldError(state, 'name', 'booth-name-error') + '</div>' +
        '<div class="field"><label>수량<input data-booth-capacity type="number" min="1" step="1" required value="' + escapeHtml(draft.capacity || '') + '" aria-label="부스 수량"' + boothFieldAttrs(state, 'capacity', 'booth-capacity-error') + ' /></label>' +
        boothFieldError(state, 'capacity', 'booth-capacity-error') + '</div>' +
        '<div class="field"><label>1인 횟수<input data-booth-limit type="number" min="1" step="1" required value="' + escapeHtml(draft.limit || '') + '" aria-label="1인당 참여 횟수"' + boothFieldAttrs(state, 'limit', 'booth-limit-error') + ' /></label>' +
        boothFieldError(state, 'limit', 'booth-limit-error') + '</div>' +
        '<div class="field"><label>상태<select data-booth-status-select aria-label="부스 상태"' + boothFieldAttrs(state, 'status', 'booth-status-error') + '>' +
        '<option value="OPEN"' + ((draft.status || 'OPEN') === 'OPEN' ? ' selected' : '') + '>운영 중</option>' +
        '<option value="WAITING"' + (draft.status === 'WAITING' ? ' selected' : '') + '>대기 중</option>' +
        '<option value="CLOSED"' + (draft.status === 'CLOSED' ? ' selected' : '') + '>종료</option></select></label>' +
        boothFieldError(state, 'status', 'booth-status-error') + '</div>' +
        '<button type="button" data-booth-add>부스 개설</button></div>';
    }
    html += '</section>';
    if (state.pageError) html += '<p role="alert">' + escapeHtml(state.pageError) + '</p>';
    container.innerHTML = html;
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(container.querySelectorAll('[data-booth-add]'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = boothUiState();
          ETKO.lastBoothError = null;
          state.error = null;
          state.pageError = null;
          state.draft = {
            name: fieldText(container, '[data-booth-name]'),
            capacity: fieldText(container, '[data-booth-capacity]'),
            limit: fieldText(container, '[data-booth-limit]'),
            status: fieldText(container, '[data-booth-status-select]') || 'OPEN',
          };
          try {
            ETKO.saveBooth(state.draft);
            state.draft = null;
          } catch (err) {
            var message = err && err.message ? err.message : '부스를 개설하지 못했습니다';
            ETKO.lastBoothError = message;
            var field = boothErrorField(message);
            state.error = { message: message, field: field };
            if (!field) state.pageError = message;
          }
          ETKO.renderBoothManage(container);
          if (state.error) focusBoothError(container, state.error.field);
        });
      });
      Array.prototype.forEach.call(container.querySelectorAll('[data-booth-status]'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = boothUiState();
          ETKO.lastBoothError = null;
          state.error = null;
          state.pageError = null;
          try {
            var spec = btn.getAttribute ? String(btn.getAttribute('data-booth-status') || '') : '';
            var parts = spec.split(':');
            ETKO.setBoothStatus(parts[0], parts.slice(1).join(':'));
          } catch (err) {
            ETKO.lastBoothError = err && err.message ? err.message : '부스 상태를 변경하지 못했습니다';
            state.pageError = ETKO.lastBoothError;
          }
          ETKO.renderBoothManage(container);
        });
      });
      Array.prototype.forEach.call(container.querySelectorAll('[data-booth-print]'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = boothUiState();
          ETKO.lastBoothError = null;
          state.error = null;
          state.pageError = null;
          try {
            var id = btn.getAttribute ? btn.getAttribute('data-booth-print') : '';
            ETKO.markPrinted(id);
          } catch (err) {
            ETKO.lastBoothError = err && err.message ? err.message : '인쇄 확인을 기록하지 못했습니다';
            state.pageError = ETKO.lastBoothError;
          }
          ETKO.renderBoothManage(container);
        });
      });
    }
    return container.innerHTML;
  };

  function fieldText(container, sel) {
    var el = container.querySelector ? container.querySelector(sel) : null;
    return el && el.value !== undefined ? el.value : '';
  }

  // Resolve a scanned booth QR to its booth. Strict format; the event scope
  // must match the active event so another event's QR cannot stamp here.
  ETKO.resolveBoothQr = function (text) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    var parsed = null;
    if (typeof ETKO.parseBoothPayload === 'function') {
      try {
        parsed = ETKO.parseBoothPayload(raw);
      } catch (err) {
        throw new Error('부스 QR을 확인하세요');
      }
    } else {
      var m = /^ET:BOOTH:([^:]+):([^:]+)$/.exec(raw);
      if (!m) throw new Error('부스 QR을 확인하세요');
      parsed = { eventId: m[1], boothId: m[2] };
    }
    if (!parsed || parsed.eventId !== ETKO.store.activeEventId) {
      throw new Error('다른 행사의 부스 QR입니다');
    }
    var ws = boothWorkspace();
    var booth = findBooth(ws, parsed.boothId);
    if (!booth) throw new Error('부스를 찾을 수 없습니다');
    return booth;
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function boothStatusLabel(status) {
    if (status === 'OPEN') return '운영 중';
    if (status === 'CLOSED') return '종료';
    return '대기 중';
  }

  // Participant stamp mount: booth list with remaining counts, my stamps,
  // a booth QR input, and a booth receive control. A filled QR input wins
  // over the select so camera-app paste and manual typing share one button.
  // Success and limit/sold-out/closed/QR refusals surface as Korean alerts.
  // SELF mode uses stampSelf(); STAFF desks keep using stamp() so
  // participants cannot bypass the staff desk.
  ETKO.renderStamps = function (container, participantId) {
    var ws = boothWorkspace();
    var mine = ws.visits.filter(function (v) {
      return v && v.participantId === participantId;
    }).length;
    var rows = ws.booths.map(function (b) {
      var left = Math.max(0, (b.capacity || 0) - usedCount(ws, b.id));
      var got = ws.visits.some(function (v) {
        return v && v.boothId === b.id && v.participantId === participantId;
      });
      return (
        '<li class="card">' + escapeHtml(b.name) + ' · ' + boothStatusLabel(b.status) +
        ' · 남은 ' + left + '개' + (got ? ' · 받음' : '') + '</li>'
      );
    }).join('');
    var options = ws.booths.filter(function (b) {
      return b && b.status === 'OPEN';
    }).map(function (b) {
      return '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + '</option>';
    }).join('');
    var staffMode = ws.boothMode === 'STAFF';
    var controls = staffMode
      ? '<p>직원에게 티켓을 보여주세요. 직원이 스캔합니다.</p>'
      : '<div class="inline-form"><div class="field"><label>부스 QR 입력<input data-stamp-qr type="text" inputmode="text" autocomplete="off" spellcheck="false" aria-label="부스 QR 입력" placeholder="ET:BOOTH:행사ID:부스ID" /></label></div>' +
        '<div class="field"><select data-stamp-booth aria-label="부스 선택">' + options + '</select></div>' +
        '<button type="button" data-stamp-receive>스탬프 받기</button></div>';
    var html =
      '<section aria-label="스탬프 투어"><h2>스탬프 투어</h2>' +
      '<p>내 스탬프 ' + mine + '개</p>' +
      '<ul class="cards">' + (rows || '<li class="card" data-empty><p role="status">운영 중인 부스가 없습니다</p></li>') + '</ul>' +
      controls + '</section>';
    if (ETKO.lastStampError) {
      html += '<p role="alert">' + escapeHtml(ETKO.lastStampError) + '</p>';
    }
    if (ETKO.lastStampDone) {
      html += '<p>스탬프를 받았습니다</p>';
    }
    container.innerHTML = html;
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(container.querySelectorAll('[data-stamp-receive]'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          ETKO.lastStampError = null;
          ETKO.lastStampDone = false;
          try {
            var qrEl = container.querySelector ? container.querySelector('[data-stamp-qr]') : null;
            var qrText = qrEl && qrEl.value !== undefined ? String(qrEl.value).trim() : '';
            var boothId = '';
            if (qrText) {
              boothId = ETKO.resolveBoothQr(qrText).id;
            } else {
              var sel = container.querySelector ? container.querySelector('[data-stamp-booth]') : null;
              boothId = sel && sel.value !== undefined ? sel.value : '';
            }
            var modeNow = ws.boothMode !== 'STAFF' ? 'SELF' : 'STAFF';
            var stampFn = modeNow === 'SELF' && typeof ETKO.stampSelf === 'function' ? ETKO.stampSelf : ETKO.stamp;
            stampFn({ boothId: boothId, participantId: participantId });
            ETKO.lastStampDone = true;
          } catch (err) {
            ETKO.lastStampError = err && err.message ? err.message : '스탬프를 받지 못했습니다';
          }
          ETKO.renderStamps(container, participantId);
        });
      });
    }
    return container.innerHTML;
  };

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['setEventBoothMode', 'saveBooth', 'setBoothStatus', 'stamp', 'stampSelf']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
