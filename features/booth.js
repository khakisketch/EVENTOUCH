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

  function lookupUiState() {
    if (!ETKO.lookupUi || typeof ETKO.lookupUi !== 'object') ETKO.lookupUi = {};
    if (!ETKO.lookupUi.events || typeof ETKO.lookupUi.events !== 'object') ETKO.lookupUi.events = {};
    var eventId = String(ETKO.store && ETKO.store.activeEventId || 'default');
    if (!ETKO.lookupUi.events[eventId]) ETKO.lookupUi.events[eventId] = { draft: null, error: null };
    return ETKO.lookupUi.events[eventId];
  }

  function lookupFieldAttrs(state, field, id) {
    return state.error && state.error.field === field
      ? ' aria-invalid="true" aria-describedby="' + escapeHtml(id) + '"'
      : ' aria-invalid="false"';
  }

  function lookupFieldError(state, field, id) {
    if (!state.error || state.error.field !== field) return '';
    return '<p class="field-error" id="' + escapeHtml(id) + '" role="alert">' + escapeHtml(state.error.message) + '</p>';
  }

  function focusLookupError(container, outer, field) {
    if (!field) return;
    var root = outer && typeof outer.querySelector === 'function' ? outer : container;
    if (!root || typeof root.querySelector !== 'function') return;
    var control = root.querySelector('[data-lookup-' + field + ']');
    if (control && typeof control.focus === 'function') control.focus();
  }

  // Render the booth desk mode switch. Korean copy only; never renders the
  // raw SELF/STAFF keys. Wires the toggle when the container supports queries.
  ETKO.renderBooth = function (container) {
    var mode = ETKO.boothMode === 'STAFF' ? 'STAFF' : 'SELF';
    var selfPressed = mode === 'SELF' ? ' aria-pressed="true"' : ' aria-pressed="false"';
    var staffPressed = mode === 'STAFF' ? ' aria-pressed="true"' : ' aria-pressed="false"';
    var guide = mode === 'STAFF' ? '티켓을 보여주세요' : '부스 QR을 스캔해주세요';
    var html =
      '<section class="booth-mode-panel" data-booth-mode-current="' + mode + '" aria-label="부스 운영 방식">' +
      '<div class="booth-mode-selector" role="group" aria-label="스캔 방식 선택"><button type="button" data-booth-mode="SELF"' +
      selfPressed +
      '>직접 스캔</button>' +
      '<button type="button" data-booth-mode="STAFF"' +
      staffPressed +
      '>직원 스캔</button></div>' +
      '<p class="booth-mode-guidance" role="status">' +
      guide +
      '</p>' +
      '<div data-booth-manage-embed></div></section>';
    container.innerHTML = html;
    if (container.querySelector) {
      try {
        if (typeof ETKO.renderBoothManage === 'function') {
          var manage = container.querySelector('[data-booth-manage-embed]');
          if (manage) ETKO.renderBoothManage(manage);
        }
      } catch (err) {}
    }
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

  // My-ticket lookup: bind the home view to the caller's own record by
  // exact name+phone. Read-only self-service; cancelled records never match.
  ETKO.findMyTicket = function (payload) {
    var opts = payload || {};
    var name = String(opts.name === undefined || opts.name === null ? '' : opts.name).trim();
    var phone = String(opts.phone === undefined || opts.phone === null ? '' : opts.phone).trim();
    var list = [];
    try {
      if (typeof ETKO.workspace === 'function') list = ETKO.workspace().participants || [];
    } catch (err) {
      list = [];
    }
    for (var i = 0; i < list.length; i += 1) {
      var p = list[i];
      if (p && !p.cancelled && p.name === name && p.phone === phone) return p;
    }
    throw new Error('등록 정보를 찾을 수 없습니다. 이름과 연락처를 확인하세요');
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
        if (active[i].id === ETKO.homeParticipantId) return { person: active[i] };
      }
      ETKO.homeParticipantId = null;
    }
    // No fallback: without an explicit selection the home view must not
    // expose another participant's ticket. The lookup form binds it.
    return { person: null };
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

  // My-ticket lookup mount: name+phone form bound to findMyTicket.
  // On success binds homeParticipantId and re-renders the outer mount;
  // on failure surfaces a Korean alert and binds nothing.
  ETKO.renderLookup = function (container, outer) {
    var state = lookupUiState();
    var draft = state.draft || {};
    var html =
      '<section class="panel" aria-label="내 티켓 찾기"><div class="section-head"><h2>내 티켓 찾기</h2></div>' +
      '<div class="inline-form">' +
      '<div class="field"><label>이름<input data-lookup-name type="text" value="' + escapeHtml(draft.name || '') + '" aria-label="이름" autocomplete="name"' + lookupFieldAttrs(state, 'name', 'lookup-name-error') + ' /></label>' +
      lookupFieldError(state, 'name', 'lookup-name-error') + '</div>' +
      '<div class="field"><label>연락처<input data-lookup-phone type="tel" value="' + escapeHtml(draft.phone || '') + '" aria-label="연락처" inputmode="tel" autocomplete="tel"' + lookupFieldAttrs(state, 'phone', 'lookup-phone-error') + ' /></label>' +
      lookupFieldError(state, 'phone', 'lookup-phone-error') + '</div>' +
      '<button type="button" data-lookup-submit>내 티켓 찾기</button></div>' +
      (state.error && !state.error.field ? '<p role="alert">' + escapeHtml(state.error.message) + '</p>' : '') +
      '</section>';
    container.innerHTML = html;
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(container.querySelectorAll('[data-lookup-submit]'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = lookupUiState();
          ETKO.lastLookupError = null;
          state.error = null;
          var nameEl = container.querySelector ? container.querySelector('[data-lookup-name]') : null;
          var phoneEl = container.querySelector ? container.querySelector('[data-lookup-phone]') : null;
          state.draft = {
            name: nameEl && nameEl.value !== undefined ? nameEl.value : '',
            phone: phoneEl && phoneEl.value !== undefined ? phoneEl.value : '',
          };
          try {
            var found = ETKO.findMyTicket({
              name: state.draft.name,
              phone: state.draft.phone,
            });
            ETKO.homeParticipantId = found.id;
            state.draft = null;
          } catch (err) {
            var message = err && err.message ? err.message : '티켓을 찾지 못했습니다';
            ETKO.lastLookupError = message;
            var field = !String(state.draft.name || '').trim()
              ? 'name'
              : !String(state.draft.phone || '').trim() ? 'phone' : null;
            state.error = { message: message, field: field };
          }
          if (outer && typeof ETKO.renderParticipant === 'function') {
            try {
              ETKO.renderParticipant(outer);
            } catch (renderErr) {}
          } else {
            ETKO.renderLookup(container, outer);
          }
          if (state.error) focusLookupError(container, outer, state.error.field);
        });
      });
    }
    return container.innerHTML;
  };

  // Full participant mobile mount: next action + schedule + ticket +
  // signup/stamp embeds (Tasks 2-3). Shows only the bound participant's
  // own record, never the roster or another ticket. Without a binding the
  // lookup form + signup guide render instead.
  ETKO.renderParticipant = function (container) {
    var resolved = resolveParticipant();
    var me = resolved.person;
    if (!me) {
      container.innerHTML =
        '<section class="panel" aria-label="참가자 홈"><div class="section-head"><h2>참가자 홈</h2></div>' +
        '<p>내 티켓을 확인하려면 등록한 이름과 연락처를 입력하세요. 본인 티켓만 보여줍니다. 처음 방문하셨다면 아래에서 참가 신청을 해주세요.</p></section>' +
        '<div data-lookup-embed></div>' +
        '<div data-signup-embed></div>';
      if (container.querySelector) {
        try {
          if (typeof ETKO.renderLookup === 'function') {
            var lookup = container.querySelector('[data-lookup-embed]');
            if (lookup) ETKO.renderLookup(lookup, container);
          }
        } catch (err) {}
        try {
          if (typeof ETKO.renderSignup === 'function') {
            var embed = container.querySelector('[data-signup-embed]');
            if (embed) ETKO.renderSignup(embed);
          }
        } catch (err) {}
      }
      return container.innerHTML;
    }
    var feed = { now: null, next: null };
    try {
      if (typeof ETKO.homeNow === 'function') feed = ETKO.homeNow() || feed;
    } catch (err) {}
    function programRow(row, tag) {
      if (!row) return '<p role="status" data-empty>' + tag + ': 예정된 일정이 없습니다</p>';
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
      return '<li class="card">' + escapeHtml(row.time) + ' ' + escapeHtml(row.title) + ' · ' + escapeHtml(row.location) + '</li>';
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
    var ticketQr = '';
    try {
      if (typeof ETKO.qrSvg === 'function' && me.code) {
        ticketQr = '<div class="qr" aria-hidden="false">' + ETKO.qrSvg(me.code) + '</div>';
      }
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
      '<section class="panel" aria-label="다음 행동">' +
      '<div><button type="button" data-home-cta>' +
      escapeHtml(ETKO.nextAction(me.status)) +
      '</button></div></section>' +
      '<section class="panel" aria-label="내 일정"><div class="section-head"><h2>내 일정</h2></div>' +
      programRow(feed.now, '현재') + programRow(feed.next, '다음') +
      '<ul class="cards">' + (programAll || '<li class="card" data-empty><p role="status">등록된 일정이 없습니다</p></li>') + '</ul>' + programNote + '</section>' +
      '<section class="panel" aria-label="내 티켓"><div class="section-head"><h2>내 티켓</h2></div>' +
      (eventName ? '<p>' + escapeHtml(eventName) + '</p>' : '') +
      '<p>' + escapeHtml(me.name) + ' · ' + escapeHtml(ticketLabelOf(me.ticket)) + ' · ' + escapeHtml(statusLabelOf(me.status)) + '</p>' +
      '<p>체크인 QR 코드: ' + escapeHtml(me.code) + '</p>' +
      ticketQr +
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
