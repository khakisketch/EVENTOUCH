(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Canonical views. Singular `participant` is the participant home;
  // plural `participants` is the directory. Never merge the two.
  var VIEWS = ['overview', 'participants', 'checkin', 'booth', 'participant', 'stage'];

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
  ETKO.navigate = function (view) {
    if (VIEWS.indexOf(view) === -1) return ETKO.currentView;
    ETKO.currentView = view;
    paint(docOf(null));
    return ETKO.currentView;
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
