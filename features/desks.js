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

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
