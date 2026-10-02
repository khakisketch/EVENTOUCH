(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Event-wide booth mode. SELF = participant scans the booth QR themselves;
  // STAFF = staff scans, participant shows their ticket. Defaults to SELF;
  // namespace-level so re-renders never reset it (mirrors checkinDirection).
  if (ETKO.boothMode !== 'STAFF' && ETKO.boothMode !== 'SELF') ETKO.boothMode = 'SELF';

  // Switch mode. Unknown values keep the current mode (mirrors ETKO.navigate
  // semantics: no state change on unknown input). Returns the active mode.
  // When an event workspace exists, delegate to the locked event mode so the
  // legacy toggle cannot bypass acknowledge + visit locks.
  ETKO.setBoothMode = function (mode) {
    if (typeof ETKO.setEventBoothMode === 'function' && typeof ETKO.workspace === 'function') {
      try {
        ETKO.setEventBoothMode(mode, { acknowledge: true });
        try {
          var ws = ETKO.workspace();
          if (ws && typeof ws.boothMode === 'string') ETKO.boothMode = ws.boothMode;
        } catch (err) {}
        return ETKO.boothMode;
      } catch (err) {
        throw err;
      }
    }
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
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function resolveParticipant() {
    var list = [];
    try {
      if (typeof ETKO.workspace === 'function') list = ETKO.workspace().participants || [];
    } catch (err) {
      list = [];
    }
    var active = list.filter(function (p) { return p && !p.cancelled; });
    if (ETKO.homeParticipantId) {
      for (var i = 0; i < active.length; i += 1) {
        if (active[i].id === ETKO.homeParticipantId) return { person: active[i], fellBack: false };
      }
      ETKO.homeParticipantId = null;
      return { person: active.length ? active[0] : null, fellBack: true };
    }
    return { person: active.length ? active[0] : null, fellBack: false };
  }

  function ticketLabelOf(ticket) {
    if (typeof ETKO.ticketLabel === 'function') {
      try {
        return ETKO.ticketLabel(ticket);
      } catch (err) {}
    }
    return String(ticket === undefined || ticket === null ? '' : ticket).trim();
  }

  function statusLabelOf(status) {
    if (typeof ETKO.statusLabel === 'function') {
      try {
        return ETKO.statusLabel(status);
      } catch (err) {}
    }
    return String(status || '').trim().toLowerCase() === 'in' ? '입장 중' : '미입장';
  }

  // Full participant mobile mount: next action + schedule + ticket +
  // signup/stamp embeds (Tasks 2-3). Shows only the resolved participant's
  // own record, never the roster. Empty roster guides to signup.
  ETKO.renderParticipant = function (container) {
    var resolved = resolveParticipant();
    var me = resolved.person;
    if (!me) {
      container.innerHTML =
        '<section aria-label="참가자 홈"><h2>참가자 홈</h2>' +
        '<p>등록된 참가자가 없습니다. 아래에서 참가 신청을 해주세요.</p></section>' +
        '<div data-signup-embed></div>';
      if (typeof ETKO.renderSignup === 'function' && container.querySelector) {
        try {
          var embed = container.querySelector('[data-signup-embed]');
          if (embed) ETKO.renderSignup(embed);
        } catch (err) {}
      }
      return container.innerHTML;
    }
    var feed = { now: null, next: null };
    try {
      if (typeof ETKO.homeNow === 'function') feed = ETKO.homeNow() || feed;
    } catch (err) {}
    function programRow(row, tag) {
      if (!row) return '<p>' + tag + ': 예정된 일정이 없습니다</p>';
      return '<p>' + tag + ': ' + escapeHtml(row.time) + ' ' + escapeHtml(row.title) + ' · ' + escapeHtml(row.location) + '</p>';
    }
    var programList = [];
    var programTotal = 0;
    try {
      var wss = typeof ETKO.workspace === 'function' ? ETKO.workspace() : null;
      var all = (wss && Array.isArray(wss.program) ? wss.program : []);
      programTotal = all.length;
      programList = all.slice(0, 20);
    } catch (err) {}
    var programAll = programList.map(function (row) {
      return '<li>' + escapeHtml(row.time) + ' ' + escapeHtml(row.title) + ' · ' + escapeHtml(row.location) + '</li>';
    }).join('');
    var programNote = programTotal > programList.length
      ? '<p>전체 ' + programTotal + '개 중 ' + programList.length + '개 표시</p>'
      : '';
    var stampCount = 0;
    try {
      var ws = typeof ETKO.workspace === 'function' ? ETKO.workspace() : null;
      var visits = ws && Array.isArray(ws.visits) ? ws.visits : [];
      stampCount = visits.filter(function (v) { return v && v.participantId === me.id; }).length;
    } catch (err) {}
    var eventName = '';
    try {
      var evs = (ETKO.store && ETKO.store.events) || [];
      for (var ei = 0; ei < evs.length; ei += 1) {
        if (evs[ei] && evs[ei].id === ETKO.store.activeEventId) {
          eventName = String(evs[ei].name || '');
          break;
        }
      }
    } catch (err) {}
    var html =
      '<section aria-label="다음 행동">' +
      (resolved.fellBack ? '<p role="status">선택한 참가자를 찾을 수 없어 첫 참가자를 보여줍니다</p>' : '') +
      '<div><button type="button" data-home-cta>' +
      escapeHtml(ETKO.nextAction(me.status)) +
      '</button></div></section>' +
      '<section aria-label="내 일정"><h2>내 일정</h2>' +
      programRow(feed.now, '현재') + programRow(feed.next, '다음') +
      '<ul>' + (programAll || '<li>등록된 일정이 없습니다</li>') + '</ul>' + programNote + '</section>' +
      '<section aria-label="내 티켓"><h2>내 티켓</h2>' +
      (eventName ? '<p>' + escapeHtml(eventName) + '</p>' : '') +
      '<p>' + escapeHtml(me.name) + ' · ' + escapeHtml(ticketLabelOf(me.ticket)) + ' · ' + escapeHtml(statusLabelOf(me.status)) + '</p>' +
      '<p>체크인 QR 코드: ' + escapeHtml(me.code) + '</p>' +
      '<p>입장 데스크에서 보여주세요</p>' +
      '<p>내 스탬프 ' + stampCount + '개</p></section>' +
      '<div data-signup-embed></div><div data-stamps-embed></div>';
    container.innerHTML = html;
    if (container.querySelector) {
      try {
        if (typeof ETKO.renderSignup === 'function') {
          var se = container.querySelector('[data-signup-embed]');
          if (se) ETKO.renderSignup(se);
        }
      } catch (err) {}
      try {
        if (typeof ETKO.renderStamps === 'function') {
          var te = container.querySelector('[data-stamps-embed]');
          if (te) ETKO.renderStamps(te, me.id);
        }
      } catch (err) {}
    }
    return container.innerHTML;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
