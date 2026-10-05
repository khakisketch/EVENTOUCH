(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Canonical views. Agency console leads; singular `participant` is the
  // participant home; plural `participants` is the directory. Never merge.
  // `engage` hosts poll/quiz/qna/draw/survey/photo management.
  var VIEWS = ['agency-home', 'agency-events', 'agency-clients', 'agency-team', 'overview', 'participants', 'checkin', 'booth', 'participant', 'engage', 'content', 'messages', 'stage', 'screen'];

  ETKO.views = VIEWS.slice();

  if (typeof ETKO.currentView !== 'string' || VIEWS.indexOf(ETKO.currentView) === -1) {
    ETKO.currentView = 'overview';
  }

  function docOf(overrideDoc) {
    if (overrideDoc) return overrideDoc;
    if (typeof document !== 'undefined') return document;
    return null;
  }

  function getAttr(node, name) {
    if (!node) return null;
    if (node.getAttribute) return node.getAttribute(name);
    if (node.dataset) {
      var key = name.replace(/^data-/, '').replace(/-([a-z])/g, function (_match, letter) {
        return letter.toUpperCase();
      });
      return node.dataset[key];
    }
    return null;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    node.hidden = !!hidden;
    if (node.setAttribute && node.removeAttribute) {
      if (hidden) node.setAttribute('hidden', '');
      else node.removeAttribute('hidden');
    }
  }

  function canOpen(view) {
    if (typeof ETKO.canRoute !== 'function') return true;
    try {
      return ETKO.canRoute(ETKO.currentRole(), view) === true;
    } catch (err) {
      return false;
    }
  }

  function setScreenDisplayMode(doc, enabled) {
    var body = doc && doc.body;
    if (!body) return;
    if (enabled && typeof body.setAttribute === 'function') {
      body.setAttribute('data-screen-mode', 'true');
    } else if (!enabled && typeof body.removeAttribute === 'function') {
      body.removeAttribute('data-screen-mode');
    }
  }

  function layerForView(view) {
    return typeof ETKO.layerForView === 'function' ? ETKO.layerForView(view) : null;
  }

  function findLayer(layerId) {
    if (typeof ETKO.layerRegistry !== 'function') return null;
    var layers = ETKO.layerRegistry();
    for (var i = 0; i < layers.length; i += 1) {
      if (layers[i] && layers[i].id === layerId) return layers[i];
    }
    return null;
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function paint(doc) {
    ETKO.currentLayer = layerForView(ETKO.currentView) || ETKO.currentLayer || 'event';
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    var buttons = doc.querySelectorAll('[data-view]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var view = btn.getAttribute ? btn.getAttribute('data-view') : btn.view;
      if (view === ETKO.currentView) {
        if (btn.setAttribute) btn.setAttribute('aria-current', 'page');
      } else if (btn.removeAttribute) {
        btn.removeAttribute('aria-current');
      }
    });

    var layerButtons = doc.querySelectorAll('[data-layer]');
    Array.prototype.forEach.call(layerButtons, function (btn) {
      var layerId = getAttr(btn, 'data-layer');
      if (!layerId) return;
      var layer = findLayer(layerId);
      var accessible = layer && layer.views.some(canOpen);
      setHidden(btn, !accessible);
      if (btn.setAttribute) btn.setAttribute('aria-pressed', String(layerId === ETKO.currentLayer));
    });

    var queryOne = typeof doc.querySelector === 'function'
      ? function (selector) { return doc.querySelector(selector); }
      : function () { return null; };
    var navGroups = doc.querySelectorAll('[data-nav-layer]');
    Array.prototype.forEach.call(navGroups, function (group) {
      var layerId = getAttr(group, 'data-nav-layer');
      if (!layerId) return;
      var links = group.querySelectorAll ? group.querySelectorAll('[data-shell-nav-item]') : [];
      var hasAccessibleLink = false;
      Array.prototype.forEach.call(links, function (link) {
        var allowed = canOpen(getAttr(link, 'data-view'));
        setHidden(link, !allowed);
        if (allowed) hasAccessibleLink = true;
      });
      setHidden(group, layerId !== ETKO.currentLayer || !hasAccessibleLink);
    });

    var activeLayerButton = null;
    Array.prototype.forEach.call(layerButtons, function (btn) {
      if (getAttr(btn, 'data-layer') === ETKO.currentLayer) activeLayerButton = btn;
    });
    var layerLabel = queryOne('[data-shell-current-layer]');
    if (layerLabel && activeLayerButton) layerLabel.textContent = activeLayerButton.textContent.trim();
    var currentLabel = queryOne('[data-shell-current-view]');
    if (currentLabel) {
      Array.prototype.forEach.call(doc.querySelectorAll('[data-shell-nav-item]'), function (link) {
        if (getAttr(link, 'data-view') === ETKO.currentView) currentLabel.textContent = link.textContent.trim();
      });
    }

    var returnControl = queryOne('[data-shell-return]');
    if (returnControl) {
      var agencyLayer = findLayer('agency');
      var canReturnToAgency = agencyLayer && agencyLayer.views.some(canOpen);
      var isEventWorkspace = ETKO.currentLayer === 'event' || ETKO.currentLayer === 'onsite';
      setHidden(returnControl, !isEventWorkspace || !canReturnToAgency);
    }

    var main = queryOne('main');
    if (main && main.setAttribute) main.setAttribute('data-current-view', ETKO.currentView);
    ETKO.syncShellContext(doc);
  }

  ETKO.syncShellContext = function (overrideDoc) {
    var doc = docOf(overrideDoc);
    if (!doc || typeof doc.querySelector !== 'function') return false;
    var select = doc.querySelector('[data-event-context]');
    var store = ETKO.store;
    if (!select || !store || !Array.isArray(store.events)) return false;
    var options = store.events.map(function (event) {
      if (!event || event.id === undefined || event.id === null) return '';
      return '<option value="' + escapeHtml(event.id) + '">' + escapeHtml(event.name || '이름 없는 행사') + '</option>';
    }).join('');
    select.innerHTML = options;
    select.value = String(store.activeEventId || '');
    var activeEvent = null;
    for (var i = 0; i < store.events.length; i += 1) {
      if (store.events[i] && String(store.events[i].id) === String(store.activeEventId || '')) {
        activeEvent = store.events[i];
        break;
      }
    }
    var meta = doc.querySelector('[data-event-meta]');
    if (meta) {
      meta.textContent = activeEvent
        ? eventDateLabel(activeEvent.date) + ' · ' + eventStatusLabel(activeEvent.status)
        : '행사를 선택하세요';
    }
    return true;
  };

  function eventDateLabel(value) {
    var date = String(value === undefined || value === null ? '' : value);
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return date || '날짜 미정';
    return Number(match[1]) + '년 ' + Number(match[2]) + '월 ' + Number(match[3]) + '일';
  }

  function eventStatusLabel(value) {
    var status = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
    var labels = { PRE: '준비 중', LIVE: '진행 중', END: '종료' };
    return labels[status] || '상태 미정';
  }

  ETKO.selectLayer = function (layerId) {
    var layer = findLayer(layerId);
    if (!layer || !Array.isArray(layer.views)) return ETKO.currentView;
    var target = null;
    if (layer.views.indexOf(layer.defaultView) !== -1 && canOpen(layer.defaultView)) {
      target = layer.defaultView;
    } else {
      for (var i = 0; i < layer.views.length; i += 1) {
        if (canOpen(layer.views[i])) {
          target = layer.views[i];
          break;
        }
      }
    }
    if (!target) return ETKO.currentView;
    return ETKO.navigate(target);
  };

  // Switch view. Unknown views keep the current view (no state change).
  // When a role store exists, denied routes keep the current view.
  // openParticipantDetail sets ETKO.detailBypass once so STAFF can reach
  // the singular participant view without changing the route table.
  ETKO.currentRole = function () {
    if (ETKO.store && typeof ETKO.store.role === 'string') return ETKO.store.role;
    return 'AGENCY';
  };

  ETKO.navigate = function (view) {
    var known = VIEWS.indexOf(view) !== -1;
    if (!known) {
      // Beyond the shell sections, allow role-permitted routes so
      // results/settings/members/events remain reachable; unknown routes
      // still keep the current view.
      if (typeof ETKO.canRoute !== 'function') return ETKO.currentView;
      try {
        if (ETKO.detailBypass === 'participant' && view === 'participant') {
          ETKO.detailBypass = false;
        } else {
          if (!ETKO.canRoute(ETKO.currentRole(), view)) return ETKO.currentView;
          var allowed = ['overview', 'participants', 'participant', 'checkin', 'booth', 'booths', 'engage', 'content', 'messages', 'stage', 'staff', 'qna', 'photos', 'poll', 'quiz', 'draw', 'survey', 'program', 'notices', 'venue', 'board', 'results', 'settings', 'members', 'events', 'clients', 'agency-home', 'agency-events', 'agency-clients', 'agency-team', 'home', 'screen'];
          if (allowed.indexOf(view) === -1) return ETKO.currentView;
        }
      } catch (err) {
        return ETKO.currentView;
      }
    } else if (typeof ETKO.canRoute === 'function') {
      try {
        if (ETKO.detailBypass === 'participant' && view === 'participant') {
          ETKO.detailBypass = false;
        } else if (ETKO.detailBypass === true && view === 'participant') {
          ETKO.detailBypass = false;
        } else if (!ETKO.canRoute(ETKO.currentRole(), view)) {
          return ETKO.currentView;
        }
      } catch (err) {}
    } else if (ETKO.detailBypass === true || ETKO.detailBypass === 'participant') {
      ETKO.detailBypass = false;
    }
    ETKO.currentView = view;
    setScreenDisplayMode(docOf(null), view === 'screen');
    paint(docOf(null));
    return ETKO.currentView;
  };

  // Switch the active event and re-sync mounted sections when possible.
  ETKO.switchEventAndRender = function (id) {
    if (typeof ETKO.switchEvent !== 'function') throw new Error('행사를 찾을 수 없습니다');
    var ev = ETKO.switchEvent(id);
    try {
      if (typeof ETKO.syncViews === 'function') ETKO.syncViews(null);
    } catch (err) {}
    try {
      if (typeof ETKO.syncParticipantsView === 'function') ETKO.syncParticipantsView(null);
    } catch (err) {}
    ETKO.syncShellContext(docOf(null));
    return ev;
  };

  // Bind every [data-view] button to navigate. Returns the wired count.
  ETKO.wireNav = function (overrideDoc) {
    var doc = docOf(overrideDoc);
    if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
    var buttons = doc.querySelectorAll('[data-view]');
    var count = 0;
    Array.prototype.forEach.call(buttons, function (btn) {
      var view = btn.getAttribute ? btn.getAttribute('data-view') : btn.view;
      if (VIEWS.indexOf(view) === -1) return;
      if (typeof btn.addEventListener === 'function') {
        btn.addEventListener('click', function () {
          ETKO.navigate(view);
        });
        count += 1;
      }
    });

    var layerButtons = doc.querySelectorAll('[data-layer]');
    Array.prototype.forEach.call(layerButtons, function (btn) {
      var layerId = getAttr(btn, 'data-layer');
      if (!layerId || typeof btn.addEventListener !== 'function' || btn.__etkoLayerWired) return;
      btn.__etkoLayerWired = true;
      btn.addEventListener('click', function () {
        ETKO.selectLayer(layerId);
      });
    });

    var eventSelectors = doc.querySelectorAll('[data-event-context]');
    Array.prototype.forEach.call(eventSelectors, function (select) {
      if (typeof select.addEventListener !== 'function' || select.__etkoEventContextWired) return;
      select.__etkoEventContextWired = true;
      select.addEventListener('focus', function () {
        ETKO.syncShellContext(doc);
      });
      select.addEventListener('change', function () {
        try {
          ETKO.switchEventAndRender(select.value);
        } catch (err) {
          ETKO.syncShellContext(doc);
        }
      });
    });
    paint(doc);
    return count;
  };

  // Browser only: load Korean labels; auto-wire nav once the DOM is ready.
  var isBrowser = typeof window !== 'undefined' && window && window.document;
  if (isBrowser && typeof fetch === 'function' && !ETKO.labels) {
    fetch('i18n/ko.json')
      .then(function (res) {
        return res.json();
      })
      .then(function (labels) {
        ETKO.labels = labels;
      })
      .catch(function () {});
  }
  if (
    typeof document !== 'undefined' &&
    document &&
    typeof document.addEventListener === 'function'
  ) {
    var boot = function () {
      ETKO.wireNav(document);
      // Prefer the shared server when one answers; otherwise keep the
      // local demo untouched. Login gate appears on agency-home only.
      if (typeof ETKO.bootRemote === 'function') {
        ETKO.bootRemote().then(function (mode) {
          if (!mode) return;
          var apply =
            typeof ETKO.applyBootMode === 'function'
              ? ETKO.applyBootMode(mode)
              : Promise.resolve(mode.mode);
          Promise.resolve(apply).then(function (result) {
            try {
              if (result === 'server') {
                if (typeof ETKO.setRole === 'function' && mode.user) ETKO.setRole(mode.user.role);
                if (typeof ETKO.syncViews === 'function') ETKO.syncViews(null);
              } else if (result === 'login-needed') {
                if (typeof ETKO.navigate === 'function') ETKO.navigate('agency-home');
                else if (typeof ETKO.syncViews === 'function') ETKO.syncViews(null);
              }
            } catch (err) {}
          });
        });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  // Dedicated audience display: ?view=screen boots straight into the
  // read-only screen view (projector/second window), no role needed.
  try {
    if (
      typeof window !== 'undefined' &&
      window &&
      window.location &&
      typeof window.location.search === 'string' &&
      /[?&]view=screen\b/.test(window.location.search)
    ) {
      ETKO.navigate('screen');
    }
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
