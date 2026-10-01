(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Event-wide booth mode. SELF = participant scans the booth QR themselves;
  // STAFF = staff scans, participant shows their ticket. Defaults to SELF;
  // namespace-level so re-renders never reset it (mirrors checkinDirection).
  if (ETKO.boothMode !== 'STAFF' && ETKO.boothMode !== 'SELF') ETKO.boothMode = 'SELF';

  // Switch mode. Unknown values keep the current mode (mirrors ETKO.navigate
  // semantics: no state change on unknown input). Returns the active mode.
  ETKO.setBoothMode = function (mode) {
    var next = String(mode === undefined || mode === null ? '' : mode)
      .trim()
      .toUpperCase();
    if (next === 'SELF' || next === 'STAFF') ETKO.boothMode = next;
    return ETKO.boothMode;
  };

  // Participant-home next action. IN (any case) flips the home CTA to the
  // completion copy; otherwise the copy follows the booth mode: SELF asks
  // for a booth QR scan, STAFF asks the participant to show their ticket.
  // Returns Korean copy directly so English never leaks into the home CTA.
  // (Consumes ETKO.scan conceptually: booth QRs are BADGE-* codes, which the
  // check-in desk rejects as wrong-kind with directions to the booth.)
  ETKO.nextAction = function (status) {
    var entered =
      String(status === undefined || status === null ? '' : status).trim().toLowerCase() ===
      'in';
    if (entered) return '입장이 완료되었습니다';
    if (ETKO.boothMode === 'STAFF') return '티켓을 보여주세요';
    return '부스 QR을 스캔해주세요';
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Render the booth desk mode switch. Korean copy only; never renders the
  // raw SELF/STAFF keys. Wires the toggle when the container supports queries.
  ETKO.renderBooth = function (container) {
    var mode = ETKO.boothMode === 'STAFF' ? 'STAFF' : 'SELF';
    var selfPressed = mode === 'SELF' ? ' aria-pressed="true"' : ' aria-pressed="false"';
    var staffPressed = mode === 'STAFF' ? ' aria-pressed="true"' : ' aria-pressed="false"';
    var guide = mode === 'STAFF' ? '티켓을 보여주세요' : '부스 QR을 스캔해주세요';
    var html =
      '<div><button type="button" data-booth-mode="SELF"' +
      selfPressed +
      '>직접 스캔</button>' +
      '<button type="button" data-booth-mode="STAFF"' +
      staffPressed +
      '>직원 스캔</button></div>' +
      '<p>' +
      guide +
      '</p>';
    container.innerHTML = html;
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-booth-mode]'),
        function (btn) {
          if (typeof btn.addEventListener !== 'function') return;
          btn.addEventListener('click', function () {
            var next = btn.getAttribute ? btn.getAttribute('data-booth-mode') : btn.view;
            ETKO.setBoothMode(next);
            ETKO.renderBooth(container);
          });
        }
      );
    }
    return container.innerHTML;
  };

  // Render the participant-home CTA synced with nextAction(status).
  // Korean copy only; works with stub containers (mirrors renderCheckin).
  ETKO.renderHome = function (container, status) {
    var copy = ETKO.nextAction(status);
    container.innerHTML =
      '<div><button type="button" data-home-cta>' + escapeHtml(copy) + '</button></div>';
    return container.innerHTML;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
