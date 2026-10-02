(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // State-mutation contract (carries Task 3 forward): ETKO.scan and
  // ETKO.syncQueue mutate the passed-in state IN PLACE — people statuses are
  // updated on the same objects (like ETKO.bulkCheckIn) and the same queue
  // array is pushed/spliced, never replaced. Each scan returns a FRESH
  // {kind, key} result object; callers must not rely on object identity.
  //
  // Person lookup goes through ETKO.filterPeople (Task 3 interface) with an
  // exact code match on top, so code search stays in one place.

  function normCode(value) {
    return String(value === undefined || value === null ? '' : value)
      .trim()
      .toUpperCase();
  }

  function normStatus(value) {
    return String(value === undefined || value === null ? '' : value)
      .trim()
      .toLowerCase();
  }

  function ensureState(state) {
    var s = state || {};
    if (!Array.isArray(s.people)) s.people = [];
    if (!Array.isArray(s.queue)) s.queue = [];
    return s;
  }

  function findPerson(people, code) {
    var list = Array.isArray(people) ? people : [];
    var candidates = list;
    if (typeof ETKO.filterPeople === 'function') {
      try {
        candidates = ETKO.filterPeople({ q: code }, list) || list;
      } catch (err) {
        candidates = list;
      }
    }
    for (var i = 0; i < candidates.length; i += 1) {
      if (normCode(candidates[i] && candidates[i].code) === code) return candidates[i];
    }
    return null;
  }

  function isQueued(queue, code, direction) {
    for (var i = 0; i < queue.length; i += 1) {
      if (queue[i] && queue[i].code === code && queue[i].direction === direction) {
        return true;
      }
    }
    return false;
  }

  // Scan one code. Returns exactly {kind, key}; never throws on bad input.
  // Classification order is fixed: wrong-kind (booth BADGE- at the check-in
  // desk) beats wrong-event (another event's ticket-like code), which beats
  // the directory lookup (not-found). Invalid codes are rejected, never queued.
  // When `state` is omitted and an event workspace exists, the active
  // workspace participants + scan queue back the scan so shell wiring and
  // rule stores never split.
  function workspaceBacking() {
    if (typeof ETKO.workspace !== 'function') return null;
    try {
      var ws = ETKO.workspace();
      if (!ws || !Array.isArray(ws.participants)) return null;
      if (!Array.isArray(ws.scanQueue)) ws.scanQueue = [];
      return { people: ws.participants, queue: ws.scanQueue, workspace: ws };
    } catch (err) {
      return null;
    }
  }

  ETKO.scan = function (opts) {
    var args = opts || {};
    var code = normCode(args.code);
    var direction = normCode(args.direction || 'IN');
    if (direction !== 'OUT') direction = 'IN';
    var online = args.online !== false;
    var backing = args.state ? null : workspaceBacking();
    var state = ensureState(args.state || (backing ? { people: backing.people, queue: backing.queue } : null));

    if (/^BADGE-/i.test(code)) return { kind: 'bad', key: 'wrong-kind' };
    if (/^[A-Z]+-\d+$/.test(code) && code.indexOf('EVT-') !== 0) {
      return { kind: 'bad', key: 'wrong-event' };
    }

    var person = findPerson(state.people, code);
    if (!person) return { kind: 'bad', key: 'not-found' };

    var entered = normStatus(person.status) === 'in';

    if (direction === 'IN') {
      // Duplicate covers both the live status and an already-queued IN:
      // a second scan is warn + no-op either way, never a second entry.
      if (entered || isQueued(state.queue, code, 'IN')) {
        return { kind: 'warn', key: 'duplicate' };
      }
      if (!online) {
        state.queue.push({ code: code, direction: 'IN' });
        return { kind: 'warn', key: 'queued' };
      }
      person.status = 'IN';
      person.everIn = true;
      return { kind: 'good', key: 'success' };
    }

    // OUT: a queued IN does not count as entered — status is only marked by
    // an online scan or by sync, so OUT-without-IN stays warn + no-op.
    if (!entered) return { kind: 'warn', key: 'not-in' };
    if (!online) {
      if (isQueued(state.queue, code, 'OUT')) return { kind: 'warn', key: 'duplicate' };
      state.queue.push({ code: code, direction: 'OUT' });
      return { kind: 'warn', key: 'queued' };
    }
    person.status = 'registered';
    return { kind: 'good', key: 'success' };
  };

  // Apply every queued entry exactly once, FIFO. Entries whose transition no
  // longer applies (stale duplicates) are dropped without effect. The queue
  // is drained in place; returns the number of entries removed.
  // Workspace-backed when `state` is omitted.
  ETKO.syncQueue = function (state) {
    var backing = state ? null : workspaceBacking();
    var s = ensureState(state || (backing ? { people: backing.people, queue: backing.queue } : null));
    var pending = s.queue.slice();
    s.queue.length = 0;
    pending.forEach(function (entry) {
      if (!entry) return;
      var person = findPerson(s.people, entry.code);
      if (!person) return;
      var entered = normStatus(person.status) === 'in';
      if (entry.direction === 'IN' && !entered) {
        person.status = 'IN';
        person.everIn = true;
      }
      if (entry.direction === 'OUT' && entered) person.status = 'registered';
    });
    return pending.length;
  };

  // Result panel copy: every scan key maps to a Korean title + detail.
  // The panel renders this map, never the raw English key.
  var CHECKIN_MESSAGES = {
    success: { title: '처리되었습니다', detail: '스캔이 정상적으로 반영되었습니다.' },
    duplicate: { title: '이미 처리된 코드입니다', detail: '중복 스캔은 반영되지 않았습니다.' },
    'not-in': { title: '입장 기록이 없습니다', detail: '먼저 입장 처리를 해주세요.' },
    'wrong-kind': {
      title: '체크인용 코드가 아닙니다',
      detail: '부스 QR은 부스에서 스캔해주세요.',
    },
    'wrong-event': {
      title: '다른 행사의 티켓입니다',
      detail: '이번 행사 코드인지 확인해주세요.',
    },
    'not-found': { title: '등록되지 않은 코드입니다', detail: '코드를 다시 확인해주세요.' },
    'wrong-desk': {
      title: '이 데스크에서 처리할 수 없습니다',
      detail: '입장·퇴장 구분이 맞는 데스크를 선택해주세요.',
    },
    'no-permission': {
      title: '권한을 확인하세요',
      detail: '이 작업을 수행할 권한이 없습니다.',
    },
    queued: {
      title: '대기열에 저장했습니다',
      detail: '오프라인 상태입니다. 연결 후 동기화하면 반영됩니다.',
    },
  };

  // Korean message for a scan result key. Unknown keys fall back to a
  // generic Korean message so English never leaks into the panel.
  // Returns a FRESH {title, detail} object per call.
  ETKO.checkinMessage = function (key) {
    var entry = CHECKIN_MESSAGES[key];
    if (entry) return { title: entry.title, detail: entry.detail };
    return { title: '알 수 없는 결과입니다', detail: '코드를 다시 스캔해주세요.' };
  };
  // Check-in desk direction toggle. Namespace-level so re-renders never reset it.
  if (ETKO.checkinDirection !== 'OUT') ETKO.checkinDirection = 'IN';
  // Last scan result for the result panel; null until the first scan.
  if (!('lastScanResult' in ETKO)) ETKO.lastScanResult = null;
  // Connectivity flag. Namespace-level so re-renders never reset it.
  // The shell toggle and offline queue share this single value.
  if (ETKO.online !== false && ETKO.online !== true) ETKO.online = true;

  // Flip connectivity. Returns the active flag.
  ETKO.setOnline = function (value) {
    ETKO.online = value === true || value === 'true';
    return ETKO.online;
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Render direction toggle + result panel + queue list + sync button.
  // Korean copy only. Wires controls when the container supports queries.
  // Workspace-backed when `state` is omitted so the shell queue stays visible.
  ETKO.renderCheckin = function (container, state) {
    var backing = state ? null : workspaceBacking();
    var s = ensureState(state || (backing ? { people: backing.people, queue: backing.queue } : null));
    var dir = ETKO.checkinDirection === 'OUT' ? 'OUT' : 'IN';
    var inPressed = dir === 'IN' ? ' aria-pressed="true"' : ' aria-pressed="false"';
    var outPressed = dir === 'OUT' ? ' aria-pressed="true"' : ' aria-pressed="false"';
    var result = ETKO.lastScanResult;
    var message = result ? ETKO.checkinMessage(result.key) : null;
    var context = result && result.unitName ? ' (' + result.unitName + ')' : '';
    var resultHtml = message
      ? '<p data-result data-kind="' +
        escapeHtml(result.kind) +
        '"><strong>' +
        escapeHtml(message.title) +
        '</strong> ' +
        escapeHtml(message.detail + context) +
        '</p>'
      : '<p data-result>스캔을 기다리고 있습니다</p>';
    var queueHtml =
      s.queue.length === 0
        ? '<p>대기 중인 항목이 없습니다</p>'
        : '<ul>' +
          s.queue
            .map(function (entry) {
              return (
                '<li>' +
                escapeHtml(entry.code) +
                ' · ' +
                (entry.direction === 'OUT' ? '퇴장' : '입장') +
                '</li>'
              );
            })
            .join('') +
          '</ul>';
    var html =
      '<div><p data-connectivity>' +
      (ETKO.online === false ? '오프라인 · 대기열에 저장됩니다' : '온라인 · 즉시 반영됩니다') +
      '</p><button type="button" data-online-toggle>' +
      (ETKO.online === false ? '온라인으로 전환' : '오프라인으로 전환') +
      '</button></div>' +
      '<div><button type="button" data-direction="IN"' +
      inPressed +
      '>입장</button>' +
      '<button type="button" data-direction="OUT"' +
      outPressed +
      '>퇴장</button></div>' +
      '<div aria-live="polite">' +
      resultHtml +
      '</div>' +
      '<div><p>대기 목록 ' +
      s.queue.length +
      '건</p>' +
      queueHtml +
      '<button type="button" data-sync>동기화</button></div>';
    if (typeof ETKO.renderDesks === 'function') {
      html += '<div data-desks-embed></div>';
    }
    container.innerHTML = html;
    if (typeof ETKO.renderDesks === 'function' && container.querySelector) {
      try {
        var embed = container.querySelector('[data-desks-embed]');
        if (embed) ETKO.renderDesks(embed);
      } catch (err) {}
    }
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-direction]'),
        function (btn) {
          if (typeof btn.addEventListener !== 'function') return;
          btn.addEventListener('click', function () {
            var next = btn.getAttribute ? btn.getAttribute('data-direction') : btn.view;
            ETKO.checkinDirection = next === 'OUT' ? 'OUT' : 'IN';
            ETKO.renderCheckin(container, s);
          });
        }
      );
      var sync = container.querySelector ? container.querySelector('[data-sync]') : null;
      if (sync && typeof sync.addEventListener === 'function') {
        sync.addEventListener('click', function () {
          ETKO.syncQueue(s);
          ETKO.renderCheckin(container, s);
        });
      }
      var toggle = container.querySelector ? container.querySelector('[data-online-toggle]') : null;
      if (toggle && typeof toggle.addEventListener === 'function') {
        toggle.addEventListener('click', function () {
          ETKO.setOnline(!(ETKO.online !== false));
          ETKO.renderCheckin(container, s);
        });
      }
    }
    return container.innerHTML;
  };

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['scan', 'syncQueue']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
