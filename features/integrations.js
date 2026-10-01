(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Integration provider registry. Areas are fixed; each area holds one
  // active provider. Defaults are built-in simulation providers so the
  // browser flow completes without external calls. Real providers replace
  // the slot via registerProvider; nothing here stores credentials.
  var AREAS = ['auth', 'messages', 'payments', 'devices'];

  var slots = {};

  function simulationProvider(area) {
    return { area: area, name: 'simulation', kind: 'simulation' };
  }

  // Fixed mode: this build never performs real external calls.
  ETKO.integrationMode = function () {
    return 'SIMULATION';
  };

  ETKO.integrationAreas = function () {
    return AREAS.slice();
  };

  // Register a provider for one area. Unknown areas throw a Korean error.
  // Returns the registered provider.
  ETKO.registerProvider = function (area, name, impl) {
    var key = String(area === undefined || area === null ? '' : area).trim().toLowerCase();
    if (AREAS.indexOf(key) === -1) throw new Error('연동 영역을 확인하세요');
    var label = String(name === undefined || name === null ? '' : name).trim();
    if (!label) throw new Error('연동 이름을 입력하세요');
    var provider = { area: key, name: label, kind: 'custom', impl: impl || {} };
    slots[key] = provider;
    return provider;
  };

  // Active provider for an area: registered custom or built-in simulation.
  ETKO.providerFor = function (area) {
    var key = String(area === undefined || area === null ? '' : area).trim().toLowerCase();
    if (AREAS.indexOf(key) === -1) throw new Error('연동 영역을 확인하세요');
    if (slots[key]) return slots[key];
    return simulationProvider(key);
  };

  // ---- auth: demo sessions (no real backend) ----
  // Login binds to the workspace member record: unknown emails and role
  // mismatches throw Korean errors, so sessions never escalate.
  var authSession = null;

  function normEmail(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  }

  ETKO.login = function (input) {
    var opts = input || {};
    var email = normEmail(opts.email);
    if (!email) throw new Error('이메일을 입력하세요');
    var ws = null;
    try {
      ws = typeof ETKO.workspace === 'function' ? ETKO.workspace() : null;
    } catch (err) {
      ws = null;
    }
    var members = ws && Array.isArray(ws.members) ? ws.members : [];
    var found = null;
    for (var i = 0; i < members.length; i += 1) {
      if (members[i] && normEmail(members[i].email) === email) {
        found = members[i];
        break;
      }
    }
    if (!found) throw new Error('등록된 구성원이 아닙니다');
    if (opts.role !== undefined && opts.role !== null && opts.role !== '') {
      var asked = String(opts.role).trim().toUpperCase();
      if (asked !== String(found.role || '').trim().toUpperCase()) throw new Error('권한을 확인하세요');
    }
    var stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    authSession = { token: 'DEMO-' + stamp, email: found.email, name: found.name, role: found.role, demo: true };
    if (typeof ETKO.setRole === 'function') {
      try {
        ETKO.setRole(found.role);
      } catch (err) {}
    }
    return { token: authSession.token, email: authSession.email, name: authSession.name, role: authSession.role, demo: true };
  };

  ETKO.logout = function () {
    authSession = null;
    return null;
  };

  ETKO.session = function () {
    if (!authSession) return null;
    return { token: authSession.token, email: authSession.email, name: authSession.name, role: authSession.role, demo: authSession.demo };
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
