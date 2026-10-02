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
  ETKO.stamp = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('booth');
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
  // and a booth receive control. Success and limit/sold-out/closed refusals
  // surface as Korean alerts.
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
        '<li>' + escapeHtml(b.name) + ' · ' + boothStatusLabel(b.status) +
        ' · 남은 ' + left + '개' + (got ? ' · 받음' : '') + '</li>'
      );
    }).join('');
    var options = ws.booths.filter(function (b) {
      return b && b.status === 'OPEN';
    }).map(function (b) {
      return '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + '</option>';
    }).join('');
    var html =
      '<section aria-label="스탬프 투어"><h2>스탬프 투어</h2>' +
      '<p>내 스탬프 ' + mine + '개</p>' +
      '<ul>' + (rows || '<li>운영 중인 부스가 없습니다</li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><select data-stamp-booth aria-label="부스 선택">' + options + '</select></div>' +
      '<button type="button" data-stamp-receive>스탬프 받기</button></div></section>';
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
            var sel = container.querySelector ? container.querySelector('[data-stamp-booth]') : null;
            var boothId = sel && sel.value !== undefined ? sel.value : '';
            ETKO.stamp({ boothId: boothId, participantId: participantId });
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

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
