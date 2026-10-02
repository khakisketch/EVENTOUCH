(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // ---- store persistence (refresh-safe demo build) ----
  // Snapshot covers event data + the small UI bindings needed to resume
  // (selected participant, active desk, check-in direction, stage output,
  // current view). Transient result/error flags are intentionally dropped.
  // Mutators opt in via ETKO.persistWrap([...names]) at the bottom of
  // their own feature file; failed calls throw before the save runs.
  var STORAGE_KEY = 'eventouch-store-v1';

  function defaultBackend() {
    try {
      if (typeof root.localStorage !== 'undefined' && root.localStorage) {
        var ls = root.localStorage;
        return {
          get: function () { return ls.getItem(STORAGE_KEY); },
          set: function (value) { ls.setItem(STORAGE_KEY, String(value)); },
        };
      }
    } catch (err) {}
    return null;
  }

  function backend() {
    if (ETKO.storeBackend) return ETKO.storeBackend;
    return defaultBackend();
  }

  function cleanStageState(value) {
    if (!value || typeof value !== 'object') return null;
    var preview = String(value.preview || 'LOGO').trim().toUpperCase();
    var program = String(value.program || 'LOGO').trim().toUpperCase();
    var ok = ['BLACK', 'HOLD', 'LOGO'];
    if (ok.indexOf(preview) === -1) preview = 'LOGO';
    if (ok.indexOf(program) === -1) program = 'LOGO';
    return { preview: preview, program: program };
  }

  ETKO.snapshotStore = function () {
    var store = ETKO.store || {};
    return JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      store: {
        events: store.events || [],
        workspaces: store.workspaces || {},
        activeEventId: store.activeEventId,
        role: store.role || 'AGENCY',
      },
      ui: {
        homeParticipantId: ETKO.homeParticipantId || null,
        activeUnitId: ETKO.activeUnitId || null,
        checkinDirection: ETKO.checkinDirection === 'OUT' ? 'OUT' : 'IN',
        checkinView: ETKO.currentView || 'overview',
        stageState: cleanStageState(ETKO.stageState),
      },
    });
  };

  // Restore a snapshot. Returns true on success, false on corrupt/foreign
  // input (the live store is left untouched on failure).
  ETKO.restoreStore = function (raw) {
    var snap = null;
    try {
      snap = JSON.parse(String(raw));
    } catch (err) {
      return false;
    }
    if (!snap || typeof snap !== 'object') return false;
    var data = snap.store;
    if (!data || !Array.isArray(data.events) || !data.workspaces || typeof data.workspaces !== 'object') return false;
    if (typeof data.activeEventId !== 'string' || !data.workspaces[data.activeEventId]) return false;
    var known = false;
    for (var i = 0; i < data.events.length; i += 1) {
      if (data.events[i] && data.events[i].id === data.activeEventId) {
        known = true;
        break;
      }
    }
    if (!known) return false;
    ETKO.store = {
      events: data.events,
      workspaces: data.workspaces,
      activeEventId: data.activeEventId,
      role: typeof data.role === 'string' ? data.role : 'AGENCY',
    };
    var ui = (snap && snap.ui) || {};
    ETKO.homeParticipantId = typeof ui.homeParticipantId === 'string' ? ui.homeParticipantId : null;
    ETKO.activeUnitId = typeof ui.activeUnitId === 'string' ? ui.activeUnitId : null;
    ETKO.checkinDirection = ui.checkinDirection === 'OUT' ? 'OUT' : 'IN';
    if (typeof ui.checkinView === 'string' && ui.checkinView) ETKO.currentView = ui.checkinView;
    ETKO.stageState = cleanStageState(ui.stageState);
    ETKO.lastScanResult = null;
    ETKO.lastSignupTicket = null;
    ETKO.lastSignupError = null;
    ETKO.lastLookupError = null;
    ETKO.lastStampError = null;
    ETKO.lastStampDone = false;
    return true;
  };

  // Read the last saved snapshot (cross-tab sync). Null when absent.
  ETKO.savedSnapshot = function () {
    var b = null;
    try {
      b = backend();
    } catch (err) {
      b = null;
    }
    if (!b) return null;
    try {
      return b.get();
    } catch (err) {
      return null;
    }
  };
  // Save now. No backend (e.g. Node tests) is a silent no-op returning false.
  ETKO.touchStore = function () {
    var b = null;
    try {
      b = backend();
    } catch (err) {
      b = null;
    }
    if (!b) return false;
    try {
      b.set(ETKO.snapshotStore());
      return true;
    } catch (err) {
      return false;
    }
  };

  // Wrap named ETKO mutators so a successful call saves afterwards.
  // Missing names are skipped; already-wrapped functions are not rewrapped.
  ETKO.persistWrap = function (names) {
    if (!Array.isArray(names)) return 0;
    var count = 0;
    names.forEach(function (name) {
      var fn = ETKO[name];
      if (typeof fn !== 'function' || fn.persistWrapped) return;
      var wrapped = function () {
        var out = fn.apply(this, arguments);
        try {
          ETKO.touchStore();
        } catch (err) {}
        return out;
      };
      wrapped.persistWrapped = true;
      ETKO[name] = wrapped;
      count += 1;
    });
    return count;
  };

  // Boot: resume a previous session when one was saved. Runs once at load;
  // a missing/corrupt entry keeps the seeded store. A dedicated display
  // (?view=screen) still pulls the data but keeps its screen view.
  try {
    var keepView = null;
    try {
      if (
        typeof window !== 'undefined' &&
        window &&
        window.location &&
        typeof window.location.search === 'string' &&
        /[?&]view=screen\b/.test(window.location.search)
      ) {
        keepView = ETKO.currentView;
      }
    } catch (err) {}
    var b0 = backend();
    if (b0) {
      var prev = b0.get();
      if (prev) ETKO.restoreStore(prev);
    }
    if (keepView) ETKO.currentView = keepView;
  } catch (err) {}

  // Browser lifecycle: save on hide/close so refresh and revisit resume.
  try {
    var doc = typeof document !== 'undefined' ? document : null;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'hidden') {
          try {
            ETKO.touchStore();
          } catch (err) {}
        }
      });
    }
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pagehide', function () {
        try {
          ETKO.touchStore();
        } catch (err) {}
      });
    }
  } catch (err) {}

  // Wrap mutators from files that load before this one (app/agency/
  // integrations). Later files self-wrap at their own bottom; the
  // persistWrapped guard makes any overlap a no-op.
  try {
    ETKO.persistWrap(['navigate']);
    ETKO.persistWrap(['createEvent', 'switchEvent', 'saveMember', 'setRole', 'ensureSeeded']);
    ETKO.persistWrap(['sendCampaign', 'createPaymentIntent', 'markPrinted']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
