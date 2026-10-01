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

  // ---- messages: simulated outbox (no real sending) ----
  // sendCampaign resolves a stored campaign into an immutable outbox entry.
  // The default provider never transmits; a replaced area provider may
  // deliver through its own impl, but status never claims SENT here.
  function messageWorkspace() {
    if (typeof ETKO.workspace !== 'function') throw new Error('행사를 찾을 수 없습니다');
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.messages)) ws.messages = [];
    if (!Array.isArray(ws.messageOutbox)) ws.messageOutbox = [];
    return ws;
  }

  ETKO.sendCampaign = function (campaignId) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('messages');
    var ws = messageWorkspace();
    var id = String(campaignId === undefined || campaignId === null ? '' : campaignId).trim();
    var found = null;
    for (var i = 0; i < ws.messages.length; i += 1) {
      if (ws.messages[i] && ws.messages[i].id === id) {
        found = ws.messages[i];
        break;
      }
    }
    if (!found) throw new Error('캠페인을 찾을 수 없습니다');
    var entry = {
      id: 'out-' + (ws.messageOutbox.length + 1),
      campaignId: found.id,
      title: found.title || '',
      channel: found.channel || '',
      toCount: Array.isArray(found.recipientIds) ? found.recipientIds.length : 0,
      body: found.content || '',
      at: new Date().toISOString(),
      delivery: 'SIMULATION_ONLY',
    };
    Object.freeze(entry);
    ws.messageOutbox.push(entry);
    var provider = ETKO.providerFor('messages');
    if (provider && provider.kind !== 'simulation' && provider.impl && typeof provider.impl.send === 'function') {
      try {
        provider.impl.send(entry);
      } catch (err) {}
    }
    return { status: 'QUEUED_SIMULATION', outboxId: entry.id };
  };

  ETKO.outbox = function () {
    return messageWorkspace().messageOutbox.slice();
  };

  // ---- payments: simulated intents (never charged) ----
  // Intents record amount + status only. No card, account, or gateway call
  // exists in this build; a replaced provider settles externally.
  var paymentIntents = [];

  ETKO.createPaymentIntent = function (input) {
    var opts = input || {};
    var amount = Number(opts.amount);
    if (!isFinite(amount) || Math.floor(amount) !== amount || amount <= 0) {
      throw new Error('결제 금액을 확인하세요');
    }
    var currency = String(opts.currency === undefined || opts.currency === null ? 'KRW' : opts.currency).trim() || 'KRW';
    var intent = {
      id: 'pi-' + (paymentIntents.length + 1),
      amount: amount,
      currency: currency,
      description: String(opts.description === undefined || opts.description === null ? '' : opts.description).trim(),
      status: 'SIMULATION_ONLY',
      charged: false,
      at: new Date().toISOString(),
    };
    Object.freeze(intent);
    paymentIntents.push(intent);
    return { id: intent.id, amount: intent.amount, currency: intent.currency, description: intent.description, status: intent.status, charged: intent.charged };
  };

  ETKO.paymentStatus = function (id) {
    var key = String(id === undefined || id === null ? '' : id).trim();
    for (var i = 0; i < paymentIntents.length; i += 1) {
      if (paymentIntents[i] && paymentIntents[i].id === key) {
        var p = paymentIntents[i];
        return { id: p.id, amount: p.amount, currency: p.currency, description: p.description, status: p.status, charged: p.charged };
      }
    }
    throw new Error('결제 내역을 찾을 수 없습니다');
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
