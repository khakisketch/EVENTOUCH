(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Desk units + scan history + correction (Task 3).
  // Consumes ETKO.workspace(); the workspace owns `units` and `logs`.
  // Status contract mirrors features/checkin.js ETKO.scan (case-insensitive):
  // entered means status 'in' in any case; IN marks status 'IN' + everIn,
  // OUT marks the registered-equivalent 'OUT' (both count as not-inside).
  // This file never touches ETKO.scan.

  var ACTIONS = ['IN', 'OUT'];
  var MODES = ['desk', 'tablet', 'kiosk'];

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function normStatus(value) {
    return text(value).toLowerCase();
  }

  // Active workspace with the Task 3 slices ensured, never replaced.
  function deskWorkspace() {
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.units)) ws.units = [];
    if (!Array.isArray(ws.logs)) ws.logs = [];
    if (!Array.isArray(ws.participants)) ws.participants = [];
    return ws;
  }

  function copyEntry(log) {
    var out = {};
    Object.keys(log || {}).forEach(function (key) {
      out[key] = log[key];
    });
    return out;
  }

  function nextUnitId(ws) {
    var max = 0;
    ws.units.forEach(function (u) {
      var m = /^u(\d+)$/.exec((u && u.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = 'u' + (max + 1);
    while (ws.units.some(function (u) { return u && u.id === id; })) {
      max += 1;
      id = 'u' + (max + 1);
    }
    return id;
  }

  function nextLogId(ws) {
    var max = 0;
    ws.logs.forEach(function (entry) {
      var m = /^log-(\d+)$/.exec((entry && entry.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'log-' + (max + 1);
  }

  function findUnit(ws, id) {
    for (var i = 0; i < ws.units.length; i += 1) {
      if (ws.units[i] && ws.units[i].id === id) return ws.units[i];
    }
    return null;
  }

  function findParticipant(ws, id) {
    for (var i = 0; i < ws.participants.length; i += 1) {
      if (ws.participants[i] && ws.participants[i].id === id) return ws.participants[i];
    }
    return null;
  }

  // Create a desk unit by default; update the matching unit when `id` matches.
  ETKO.saveUnit = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('checkin');
    var opts = input || {};
    var ws = deskWorkspace();
    var name = text(opts.name);
    var action = text(opts.action).toUpperCase();
    var mode = text(opts.mode).toLowerCase();
    if (!name) throw new Error('데스크 이름을 입력하세요');
    if (ACTIONS.indexOf(action) === -1) throw new Error('입장·퇴장 구분을 확인하세요');
    if (MODES.indexOf(mode) === -1) throw new Error('데스크 모드를 확인하세요');
    if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
      var existing = findUnit(ws, opts.id);
      if (!existing) throw new Error('데스크를 찾을 수 없습니다');
      existing.name = name;
      existing.action = action;
      existing.mode = mode;
      return existing;
    }
    var unit = { id: nextUnitId(ws), name: name, action: action, mode: mode };
    ws.units.push(unit);
    return unit;
  };

  // Record one scan at a desk unit. Duplicate IN throws `이미 처리되었습니다`
  // and OUT without a live IN throws a Korean not-in error (same semantics as
  // ETKO.scan, which stays untouched). Stores an immutable before/after entry.
  ETKO.recordScan = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('checkin');
    var opts = input || {};
    var ws = deskWorkspace();
    var action = text(opts.action).toUpperCase();
    if (ACTIONS.indexOf(action) === -1) throw new Error('입장·퇴장 구분을 확인하세요');
    var person = findParticipant(ws, opts.participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    var unit = findUnit(ws, opts.unitId);
    if (!unit) throw new Error('데스크를 찾을 수 없습니다');
    if (unit.action !== action) throw new Error('데스크의 입장·퇴장 구분을 확인하세요');
    var entered = normStatus(person.status) === 'in';
    if (action === 'IN' && entered) throw new Error('이미 처리되었습니다');
    if (action === 'OUT' && !entered) throw new Error('입장 기록이 없습니다');
    var before = person.status;
    var after = action === 'IN' ? 'IN' : 'OUT';
    person.status = after;
    if (action === 'IN') person.everIn = true;
    var log = {
      id: nextLogId(ws),
      participantId: person.id,
      action: action,
      unitId: unit.id,
      before: before,
      after: after,
      at: new Date().toISOString(),
      corrected: false,
    };
    ws.logs.unshift(log);
    return copyEntry(log);
  };

  // Newest-first scan history. Returns copies so callers cannot mutate the store.
  ETKO.history = function () {
    return deskWorkspace().logs.map(copyEntry);
  };

  // Correct one log entry: reason must be 5~200 chars and only the latest log
  // per participant can be corrected. Restores the entry's before state and
  // unshifts a CORRECTION entry; all other cases throw Korean errors.
  ETKO.correctLog = function (logId, reason) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('checkin');
    var ws = deskWorkspace();
    var why = text(reason);
    if (why.length < 5 || why.length > 200) {
      throw new Error('정정 사유는 5자 이상 200자 이하로 입력하세요');
    }
    var target = null;
    ws.logs.forEach(function (entry) {
      if (entry && entry.id === logId) target = entry;
    });
    if (!target) throw new Error('기록을 찾을 수 없습니다');
    if (target.action === 'CORRECTION') throw new Error('정정 기록은 다시 정정할 수 없습니다');
    if (target.corrected) throw new Error('이미 정정된 기록입니다');
    var latest = null;
    for (var i = 0; i < ws.logs.length; i += 1) {
      if (ws.logs[i] && ws.logs[i].participantId === target.participantId) {
        latest = ws.logs[i];
        break;
      }
    }
    if (!latest || latest.id !== target.id) {
      throw new Error('가장 최근 기록만 정정할 수 있습니다');
    }
    var person = findParticipant(ws, target.participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    person.status = target.before;
    // everIn tracks "has ever entered": if the corrected entry was the
    // participant's only IN and no other uncorrected IN remains, clear it.
    // Otherwise a wrong first IN keeps inflating cumulative counts.
    if (target.action === 'IN') {
      var stillIn = false;
      ws.logs.forEach(function (entry) {
        if (!entry || entry.participantId !== person.id) return;
        if (entry.id === target.id || entry.action === 'CORRECTION' || entry.corrected) return;
        if (entry.action === 'IN') stillIn = true;
      });
      if (!stillIn) person.everIn = false;
    }
    target.corrected = true;
    target.correctedAt = new Date().toISOString();
    target.correctReason = why;
    var entry = {
      id: nextLogId(ws),
      participantId: target.participantId,
      action: 'CORRECTION',
      unitId: target.unitId,
      before: target.after,
      after: target.before,
      reason: why,
      correctionOf: target.id,
      at: new Date().toISOString(),
      corrected: false,
    };
    ws.logs.unshift(entry);
    return copyEntry(entry);
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Active desk unit for ticket intake. Namespace-level; cleared on event
  // switch by agency.js alongside other per-event UI state.
  if (ETKO.activeUnitId === undefined) ETKO.activeUnitId = null;

  ETKO.setActiveUnit = function (id) {
    var ws = deskWorkspace();
    var found = null;
    for (var i = 0; i < ws.units.length; i += 1) {
      if (ws.units[i] && ws.units[i].id === id) {
        found = ws.units[i];
        break;
      }
    }
    if (!found) throw new Error('데스크를 찾을 수 없습니다');
    ETKO.activeUnitId = found.id;
    return found.id;
  };

  function actionLabel(action) {
    return action === 'OUT' ? '퇴장' : '입장';
  }

  function modeLabel(mode) {
    if (mode === 'tablet') return '태블릿';
    if (mode === 'kiosk') return '키오스크';
    return '데스크';
  }

  // Desk section renderer: unit list with select + add form. History and
  // correction follow in Task 2 via renderDesksHistory().
  ETKO.renderDesks = function (container) {
    var ws = deskWorkspace();
    var rows = ws.units.map(function (u) {
      var active = ETKO.activeUnitId === u.id;
      return (
        '<li>' + escapeHtml(u.name) + ' · ' + actionLabel(u.action) + ' · ' + escapeHtml(modeLabel(u.mode)) +
        (active ? ' · 사용 중' : '') +
        ' <button type="button" data-unit-select="' + escapeHtml(u.id) + '">선택</button></li>'
      );
    }).join('');
    var html =
      '<section aria-label="데스크 관리"><h2>데스크</h2>' +
      '<ul>' + (rows || '<li>개설된 데스크가 없습니다</li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><input data-unit-name type="text" placeholder="데스크 이름" aria-label="데스크 이름" /></div>' +
      '<div class="field"><select data-unit-action aria-label="입장 퇴장 구분"><option value="IN">입장</option><option value="OUT">퇴장</option></select></div>' +
      '<button type="button" data-unit-add>데스크 개설</button></div>' +
      ETKO.renderDesksHistory(ws) +
      (ETKO.lastDeskError ? '<p role="alert">' + escapeHtml(ETKO.lastDeskError) + '</p>' : '') +
      '</section>';
    container.innerHTML = html;
    wireDesks(container);
    return container.innerHTML;
  };

  // History section with correction entries and reason inputs.
  ETKO.renderDesksHistory = function (wsArg) {    var ws = wsArg;
    try {
      ws = wsArg || deskWorkspace();
    } catch (err) {
      ws = { logs: [], units: [], participants: [] };
    }
    var logs = Array.isArray(ws.logs) ? ws.logs : [];
    function personName(pid) {
      var people = ws.participants || [];
      for (var i = 0; i < people.length; i += 1) {
        if (people[i] && people[i].id === pid) return people[i].name;
      }
      return pid;
    }
    function unitName(uid) {
      var units = ws.units || [];
      for (var j = 0; j < units.length; j += 1) {
        if (units[j] && units[j].id === uid) return units[j].name;
      }
      return uid;
    }
    function actionLabelLog(action) {
      if (action === 'IN') return '입장';
      if (action === 'OUT') return '퇴장';
      return '정정';
    }
    var rows = logs.map(function (entry) {
      var correctBtn = '';
      if (entry && entry.action !== 'CORRECTION' && !entry.corrected) {
        correctBtn =
          ' <input data-correct-reason="' + escapeHtml(entry.id) + '" type="text" placeholder="정정 사유 5~200자" aria-label="정정 사유" />' +
          ' <button type="button" data-correct-log="' + escapeHtml(entry.id) + '">정정</button>';
      }
      return (
        '<li>' + escapeHtml(personName(entry.participantId)) + ' · ' + actionLabelLog(entry.action) +
        ' · ' + escapeHtml(unitName(entry.unitId)) +
        (entry.corrected ? ' · 정정됨' : '') + correctBtn + '</li>'
      );
    }).join('');
    return (
      '<div aria-label="입퇴장 기록"><h3>입퇴장 기록</h3>' +
      '<ul>' + (rows || '<li>기록이 없습니다</li>') + '</ul></div>'
    );
  };

  ETKO.wireDesksHistory = function (container, onAttr) {
    onAttr('data-correct-log', function (btn) {
      var id = btn.getAttribute('data-correct-log');
      var reasonEl = container.querySelector ? container.querySelector('[data-correct-reason="' + id + '"]') : null;
      var reason = reasonEl && reasonEl.value !== undefined ? reasonEl.value : '';
      ETKO.correctLog(id, reason);
    });
  };

  // History section is fully implemented above; no fallback needed.

  function fieldValue(container, attr) {
    var el = container.querySelector ? container.querySelector('[' + attr + ']') : null;
    return el && el.value !== undefined ? el.value : '';
  }

  function wireDesks(container) {
    if (!container || !container.querySelectorAll) return;
    function onAttr(attr, fn) {
      Array.prototype.forEach.call(container.querySelectorAll('[' + attr + ']'), function (btn) {
        if (btn.tagName === 'INPUT' || btn.tagName === 'SELECT') return;
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          ETKO.lastDeskError = null;
          try {
            fn(btn);
          } catch (err) {
            ETKO.lastDeskError = err && err.message ? err.message : '처리하지 못했습니다';
          }
          if (typeof ETKO.renderDesks === 'function') {
            try {
              ETKO.renderDesks(container);
            } catch (err) {}
          }
        });
      });
    }
    onAttr('data-unit-add', function () {
      var unit = ETKO.saveUnit({
        name: fieldValue(container, 'data-unit-name'),
        action: fieldValue(container, 'data-unit-action') || 'IN',
        mode: 'desk',
      });
      ETKO.setActiveUnit(unit.id);
    });
    onAttr('data-unit-select', function (btn) {
      ETKO.setActiveUnit(btn.getAttribute('data-unit-select'));
    });
    if (typeof ETKO.wireDesksHistory === 'function') {
      try {
        ETKO.wireDesksHistory(container, onAttr);
      } catch (err) {}
    }
  }

  // Ticket intake through the active unit when one is selected and still
  // exists; otherwise falls back to plain ETKO.scan. Returns {kind, key}
  // and records ETKO.lastScanResult for the panel.
  ETKO.submitTicket = function (code, direction) {
    var dir = String(direction || 'IN').trim().toUpperCase() === 'OUT' ? 'OUT' : 'IN';
    var result = null;
    var unitId = ETKO.activeUnitId;
    var useUnit = false;
    if (unitId && ETKO.online !== false) {
      try {
        var ws = deskWorkspace();
        useUnit = ws.units.some(function (u) { return u && u.id === unitId; });
      } catch (err) {
        useUnit = false;
      }
    }
    if (useUnit) {
      var person = null;
      var unitName = '';
      try {
        var units = deskWorkspace().units;
        for (var ui = 0; ui < units.length; ui += 1) {
          if (units[ui] && units[ui].id === unitId) {
            unitName = units[ui].name;
            break;
          }
        }
      } catch (err) {}
      try {
        var people = deskWorkspace().participants;
        var want = String(code === undefined || code === null ? '' : code).trim().toUpperCase();
        for (var i = 0; i < people.length; i += 1) {
          if (people[i] && String(people[i].code || '').trim().toUpperCase() === want) {
            person = people[i];
            break;
          }
        }
      } catch (err) {
        person = null;
      }
      if (!person) {
        result = { kind: 'bad', key: 'not-found' };
      } else {
        try {
          ETKO.recordScan({ participantId: person.id, action: dir, unitId: unitId });
          result = { kind: 'good', key: 'success' };
        } catch (err) {
          var msg = err && err.message ? err.message : '';
          if (/이미 처리/.test(msg)) result = { kind: 'warn', key: 'duplicate' };
          else if (/권한/.test(msg)) result = { kind: 'bad', key: 'no-permission' };
          else if (/입장 기록/.test(msg)) result = { kind: 'warn', key: 'not-in' };
          else if (/구분/.test(msg)) result = { kind: 'warn', key: 'wrong-desk', unitName: unitName };
          else throw err;
        }
      }
    } else {
      if (typeof ETKO.scan !== 'function') throw new Error('체크인 기능을 확인할 수 없습니다');
      result = ETKO.scan({ code: code, direction: dir, online: ETKO.online !== false });
    }
    ETKO.lastScanResult = result;
    return result;
  };

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['saveUnit', 'recordScan', 'correctLog', 'setActiveUnit']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
