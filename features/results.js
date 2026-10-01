(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Event summary + report snapshots + event settings (Task 10).
  // Consumes ETKO.workspace() (owns `participants`, `photos`, `reports`,
  // `features`) and the active event in ETKO.store.events. Standalone: never
  // calls other feature files so tests can load agency.js + results.js only.

  var EVENT_STATUSES = ['PRE', 'LIVE', 'END'];
  var FEATURE_KEYS = [
    'draw',
    'poll',
    'quiz',
    'qna',
    'survey',
    'stamp',
    'photo',
    'venue',
    'board',
  ];

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function normStatus(value) {
    return text(value).toLowerCase();
  }

  // Entered means status 'in' in any case (mirrors desks/checkin contract).
  // Never a literal status equality: OUT and registered both count as out.
  function isEntered(person) {
    return normStatus(person && person.status) === 'in';
  }

  function isActive(person) {
    return !!person && !person.cancelled;
  }

  function resultsWorkspace() {
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.participants)) ws.participants = [];
    if (!Array.isArray(ws.photos)) ws.photos = [];
    if (!Array.isArray(ws.reports)) ws.reports = [];
    if (!ws.features || typeof ws.features !== 'object') ws.features = {};
    return ws;
  }

  function activeEvent() {
    var found = null;
    (ETKO.store.events || []).forEach(function (ev) {
      if (ev && ev.id === ETKO.store.activeEventId) found = ev;
    });
    if (!found) throw new Error('행사를 찾을 수 없습니다');
    return found;
  }

  // Read-only summary with fixed definitions: total = registered (active),
  // checked = ever entered (everIn), inside = currently in, notArrived =
  // never entered, rate = checked share in percent (1 decimal).
  ETKO.eventSummary = function () {
    var list = resultsWorkspace().participants.filter(isActive);
    var checked = list.filter(function (p) {
      return p.everIn === true;
    }).length;
    var inside = list.filter(isEntered).length;
    var total = list.length;
    return {
      total: total,
      checked: checked,
      inside: inside,
      notArrived: total - checked,
      rate: total ? +(checked / total * 100).toFixed(1) : 0,
    };
  };

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.keys(value).forEach(function (key) {
        deepFreeze(value[key]);
      });
      Object.freeze(value);
    }
    return value;
  }

  function nextReportId(ws) {
    var max = 0;
    ws.reports.forEach(function (r) {
      var m = /^report-(\d+)$/.exec((r && r.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'report-' + (max + 1);
  }

  // Snapshot report: metrics + approved photos deep-copied and deep-frozen
  // at creation time, so later check-ins or moderations never mutate it.
  ETKO.createReport = function (input) {
    var opts = input || {};
    var ws = resultsWorkspace();
    var title = text(opts.title);
    if (!title) throw new Error('보고서 제목을 입력하세요');
    var metrics = ETKO.eventSummary();
    var photos = ws.photos
      .filter(function (p) {
        return p && p.status === 'APPROVED';
      })
      .map(function (p) {
        return { id: p.id, participantId: p.participantId, caption: p.caption || '' };
      });
    var report = {
      id: nextReportId(ws),
      title: title,
      summary: text(opts.summary),
      metrics: {
        total: metrics.total,
        checked: metrics.checked,
        inside: metrics.inside,
        notArrived: metrics.notArrived,
        rate: metrics.rate,
      },
      photos: photos,
      createdAt: new Date().toISOString(),
    };
    deepFreeze(report);
    ws.reports.push(report);
    return report;
  };

  ETKO.reports = function () {
    return resultsWorkspace().reports.slice();
  };

  // Patch the active event. Only known keys apply; every provided value is
  // validated with a Korean error. Unknown status/capacity never persist.
  ETKO.updateEvent = function (patch) {
    var opts = patch || {};
    var ev = activeEvent();
    if (opts.name !== undefined) {
      var name = text(opts.name);
      if (!name) throw new Error('행사 이름을 입력하세요');
      ev.name = name;
    }
    if (opts.date !== undefined) {
      var date = text(opts.date);
      if (!date) throw new Error('행사 날짜를 입력하세요');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('행사 날짜 형식을 확인하세요');
      ev.date = date;
    }
    if (opts.venue !== undefined) {
      var venue = text(opts.venue);
      if (!venue) throw new Error('행사 장소를 입력하세요');
      ev.venue = venue;
    }
    if (opts.status !== undefined) {
      var status = text(opts.status).toUpperCase();
      if (EVENT_STATUSES.indexOf(status) === -1) throw new Error('행사 상태를 확인하세요');
      ev.status = status;
    }
    if (opts.capacity !== undefined) {
      var capacity = Number(opts.capacity);
      if (!isFinite(capacity) || capacity < 0) throw new Error('정원을 확인하세요');
      ev.capacity = Math.floor(capacity);
    }
    return {
      id: ev.id,
      name: ev.name,
      date: ev.date,
      venue: ev.venue,
      status: ev.status,
      capacity: ev.capacity,
    };
  };

  // Toggle participant-facing feature flags. Unknown keys throw; known keys
  // coerce to boolean. Returns a copy so callers cannot mutate the store.
  ETKO.setEventFeatures = function (features) {
    var ws = resultsWorkspace();
    var opts = features || {};
    Object.keys(opts).forEach(function (key) {
      if (FEATURE_KEYS.indexOf(key) === -1) throw new Error('기능을 확인하세요');
      ws.features[key] = !!opts[key];
    });
    var copy = {};
    FEATURE_KEYS.forEach(function (key) {
      copy[key] = !!ws.features[key];
    });
    return copy;
  };

  var EVENT_STATUS_LABELS = { PRE: '준비 중', LIVE: '진행 중', END: '종료' };
  var FEATURE_LABELS = {
    draw: '럭키드로우',
    poll: '투표',
    quiz: '퀴즈',
    qna: '질문과 답변',
    survey: '만족도 평가',
    stamp: '스탬프 투어',
    photo: '포토 이벤트',
    venue: '행사장 안내',
    board: '행사 게시판',
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Korean-only result summary panel: counts and rate, never raw keys.
  ETKO.renderResults = function (container) {
    var s = ETKO.eventSummary();
    var approved = resultsWorkspace().photos.filter(function (p) {
      return p && p.status === 'APPROVED';
    }).length;
    var html =
      '<div><h2>행사 결과</h2>' +
      '<p>전체 ' +
      s.total +
      '명 · 누적 입장 ' +
      s.checked +
      '명 · 현재 입장 ' +
      s.inside +
      '명 · 미입장 ' +
      s.notArrived +
      '명 · 입장률 ' +
      s.rate +
      '%</p>' +
      '<p>승인된 사진 ' +
      approved +
      '장 · 보고서 ' +
      resultsWorkspace().reports.length +
      '건</p></div>';
    container.innerHTML = html;
    return container.innerHTML;
  };

  // Korean-only settings panel: event fields with mapped status labels plus
  // the feature flag list. Data only; no buttons, so no dead ends.
  ETKO.renderSettings = function (container) {
    var ev = activeEvent();
    var ws = resultsWorkspace();
    var statusLabel = EVENT_STATUS_LABELS[ev.status] || '준비 중';
    var flags = FEATURE_KEYS.map(function (key) {
      return (
        '<li>' +
        escapeHtml(FEATURE_LABELS[key]) +
        ' · ' +
        (ws.features[key] ? '사용' : '미사용') +
        '</li>'
      );
    }).join('');
    var html =
      '<div><h2>행사 설정</h2>' +
      '<p>' +
      escapeHtml(ev.name) +
      ' · ' +
      escapeHtml(ev.date) +
      ' · ' +
      escapeHtml(ev.venue) +
      ' · ' +
      escapeHtml(statusLabel) +
      '</p>' +
      '<ul>' +
      flags +
      '</ul></div>';
    container.innerHTML = html;
    return container.innerHTML;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
