(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Canonical views. Singular `participant` is the participant home;
  // plural `participants` is the directory. Never merge the two.
  // `engage` hosts poll/quiz/qna/draw/survey/photo management.
  var VIEWS = ['overview', 'participants', 'checkin', 'booth', 'participant', 'engage', 'stage'];

  ETKO.views = VIEWS.slice();

  if (typeof ETKO.currentView !== 'string' || VIEWS.indexOf(ETKO.currentView) === -1) {
    ETKO.currentView = 'overview';
  }

  function docOf(overrideDoc) {
    if (overrideDoc) return overrideDoc;
    if (typeof document !== 'undefined') return document;
    return null;
  }

  function paint(doc) {
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
    var main = doc.querySelector ? doc.querySelector('main') : null;
    if (main && main.setAttribute) main.setAttribute('data-current-view', ETKO.currentView);
  }

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
      // Beyond the six shell sections, allow role-permitted routes so
      // results/settings/members/events remain reachable; unknown routes
      // still keep the current view.
      if (typeof ETKO.canRoute !== 'function') return ETKO.currentView;
      try {
        if (ETKO.detailBypass === 'participant' && view === 'participant') {
          ETKO.detailBypass = false;
        } else {
          if (!ETKO.canRoute(ETKO.currentRole(), view)) return ETKO.currentView;
          var allowed = ['overview', 'participants', 'participant', 'checkin', 'booth', 'booths', 'stage', 'staff', 'qna', 'photos', 'poll', 'quiz', 'draw', 'survey', 'messages', 'program', 'notices', 'venue', 'board', 'results', 'settings', 'members', 'events', 'home', 'screen'];
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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        ETKO.wireNav(document);
      });
    } else {
      ETKO.wireNav(document);
    }
  }

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
