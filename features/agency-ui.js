(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  var STATUS_LABELS = { PRE: '준비 중', LIVE: '진행 중', END: '종료' };
  var STATUS_NEXT = { PRE: 'LIVE', LIVE: 'END', END: null };
  var WIZARD_STEPS = ['기본정보', '참여기능', '검토'];

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function canWrite() {
    try {
      if (typeof ETKO.currentRole === 'function') {
        var role = ETKO.currentRole();
        return role === 'AGENCY' || role === 'MANAGER';
      }
    } catch (err) {}
    return true;
  }

  function emptyItem(copy) {
    return '<li class="card" data-empty><p role="status">' + escapeHtml(copy) + '</p></li>';
  }

  function fieldText(container, attr) {
    var el = container && container.querySelector ? container.querySelector('[' + attr + ']') : null;
    return el && el.value !== undefined ? String(el.value) : '';
  }

  function eachAttr(container, attr, fn) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(container.querySelectorAll('[' + attr + ']'), fn);
  }

  function onClick(container, attr, fn) {
    eachAttr(container, attr, function (el) {
      if (el && typeof el.addEventListener === 'function') el.addEventListener('click', fn);
    });
  }

  function onChange(container, attr, fn) {
    eachAttr(container, attr, function (el) {
      if (el && typeof el.addEventListener === 'function') el.addEventListener('change', fn);
    });
  }

  function ui() {
    if (!ETKO.agencyUi || typeof ETKO.agencyUi !== 'object') ETKO.agencyUi = { step: 1, draft: {} };
    if (!ETKO.agencyUi.draft || typeof ETKO.agencyUi.draft !== 'object') ETKO.agencyUi.draft = {};
    return ETKO.agencyUi;
  }

  function eventById(id) {
    var found = null;
    (ETKO.store.events || []).forEach(function (ev) {
      if (ev && ev.id === id) found = ev;
    });
    return found;
  }

  function participantsOf(eventId) {
    try {
      var ws = ETKO.store.workspaces ? ETKO.store.workspaces[eventId] : null;
      return Array.isArray(ws && ws.participants) ? ws.participants.length : 0;
    } catch (err) {
      return 0;
    }
  }

  function eventCards() {
    var writable = canWrite();
    return (ETKO.store.events || []).map(function (ev) {
      if (!ev) return '';
      var next = STATUS_NEXT[ev.status] || null;
      var controls = writable
        ? ' <button type="button" data-event-open="' + escapeHtml(ev.id) + '">워크스페이스 열기</button>' +
          (next ? ' <button type="button" data-event-status="' + escapeHtml(ev.id) + ':' + next + '">다음 단계: ' + escapeHtml(STATUS_LABELS[next] || next) + '</button>' : '')
        : '';
      return (
        '<li class="card"><strong>' + escapeHtml(ev.name) + '</strong> · ' + escapeHtml(STATUS_LABELS[ev.status] || '준비 중') +
        '<p>' + escapeHtml(ev.date) + ' · ' + escapeHtml(ev.venue) + ' · 참가자 ' + participantsOf(ev.id) + '명</p>' +
        (controls ? '<p>' + controls + '</p>' : '') + '</li>'
      );
    }).join('');
  }

  function activityRows() {
    var rows = [];
    (ETKO.store.events || []).forEach(function (ev) {
      if (!ev) return;
      var ws = null;
      try {
        ws = ETKO.store.workspaces ? ETKO.store.workspaces[ev.id] : null;
      } catch (err) {
        ws = null;
      }
      (Array.isArray(ws && ws.logs) ? ws.logs : []).forEach(function (entry) {
        rows.push({ ev: ev, entry: entry });
      });
    });
    return rows.slice(-8).reverse().map(function (item) {
      var action = item.entry && item.entry.action === 'OUT' ? '퇴장' : item.entry && item.entry.action === 'CORRECTION' ? '정정' : '입장';
      return '<li class="card">' + escapeHtml(item.ev.name) + ' · ' + action + '</li>';
    }).join('');
  }

  function stat(label, value) {
    return '<div class="stat"><small>' + escapeHtml(label) + '</small><b class="stat-value">' + escapeHtml(value) + '</b></div>';
  }

  // Agency dashboard: cross-event stats, event cards, recent activity.
  ETKO.renderAgencyHome = function (container) {
    var s = ETKO.agencySummary();
    var cards = eventCards();
    var activity = activityRows();
    var html =
      '<section aria-label="대행사 현황"><h2>대행사 현황</h2>' +
      '<div class="stats">' +
      stat('진행 중', s.live + '건') +
      stat('준비 중', s.pre + '건') +
      stat('전체 참가자', s.participants + '명') +
      stat('확인할 항목', s.pending + '건') +
      '</div></section>' +
      '<section aria-label="전체 행사"><h2>전체 행사</h2>' +
      '<ul class="cards">' + (cards || emptyItem('등록된 행사가 없습니다')) + '</ul></section>' +
      '<section aria-label="최근 활동"><h2>최근 활동</h2>' +
      '<ul class="cards">' + (activity || emptyItem('최근 활동이 없습니다')) + '</ul></section>';
    container.innerHTML = html;
    container.__agencyView = 'home';
    wireAgency(container);
    return container.innerHTML;
  };

  function wizardStepsBar(step) {
    return '<p>' + WIZARD_STEPS.map(function (label, i) {
      var n = i + 1;
      var mark = n < step ? '완료' : n === step ? '진행 중' : '대기';
      return (n > 1 ? ' → ' : '') + n + '단계 ' + label + '(' + mark + ')';
    }).join('') + '</p>';
  }

  function featureChecks(draft) {
    var labels = {};
    try {
      labels = typeof ETKO.featureLabels === 'function' ? ETKO.featureLabels() : {};
    } catch (err) {
      labels = {};
    }
    var picked = (draft && draft.features) || {};
    return Object.keys(labels).map(function (key) {
      var checked = picked[key] ? ' checked' : '';
      return '<label><input type="checkbox" data-wfeat="' + escapeHtml(key) + '"' + checked + ' />' + escapeHtml(labels[key]) + '</label>';
    }).join('');
  }

  function wizardHtml() {
    var state = ui();
    var step = state.step === 2 ? 2 : state.step === 3 ? 3 : 1;
    var draft = state.draft || {};
    var body = '';
    if (step === 1) {
      body =
        '<div class="inline-form">' +
        '<div class="field"><label>행사명<input data-wname type="text" value="' + escapeHtml(draft.name || '') + '" aria-label="행사명" /></label></div>' +
        '<div class="field"><label>날짜<input data-wdate type="text" value="' + escapeHtml(draft.date || '') + '" aria-label="행사 날짜" placeholder="2026-11-01" /></label></div>' +
        '<div class="field"><label>장소<input data-wvenue type="text" value="' + escapeHtml(draft.venue || '') + '" aria-label="행사 장소" /></label></div>' +
        '<button type="button" data-wizard-next>다음</button></div>';
    } else if (step === 2) {
      body =
        '<div>' + (featureChecks(draft) || '<p role="status" data-empty>설정할 참여 기능이 없습니다</p>') + '</div>' +
        '<div><button type="button" data-wizard-back>이전</button> ' +
        '<button type="button" data-wizard-next>다음</button></div>';
    } else {
      body =
        '<p>' + escapeHtml(draft.name || '') + ' · ' + escapeHtml(draft.date || '') + ' · ' + escapeHtml(draft.venue || '') + '</p>' +
        '<div><button type="button" data-wizard-back>이전</button> ' +
        '<button type="button" data-wizard-create>행사 만들기</button></div>';
    }
    return (
      '<section aria-label="새 행사 만들기"><h2>새 행사 만들기</h2>' +
      wizardStepsBar(step) + body +
      (ETKO.lastAgencyError ? '<p role="alert">' + escapeHtml(ETKO.lastAgencyError) + '</p>' : '') +
      '</section>'
    );
  }

  // Event management: 3-step creation wizard plus the event list.
  ETKO.renderAgencyEvents = function (container) {
    var cards = eventCards();
    var html =
      wizardHtml() +
      '<section aria-label="전체 행사"><h2>전체 행사</h2>' +
      '<ul class="cards">' + (cards || emptyItem('등록된 행사가 없습니다')) + '</ul></section>';
    container.innerHTML = html;
    container.__agencyView = 'events';
    wireAgency(container);
    return container.innerHTML;
  };

  // Client directory with an add/edit form.
  ETKO.renderAgencyClients = function (container) {
    var state = ui();
    var editing = null;
    (ETKO.store.clients || []).forEach(function (c) {
      if (c && c.id === state.editClientId) editing = c;
    });
    var rows = (ETKO.store.clients || []).map(function (c) {
      if (!c) return '';
      return (
        '<li class="card"><strong>' + escapeHtml(c.name) + '</strong>' +
        (c.contact ? ' · ' + escapeHtml(c.contact) : '') + ' · ' + escapeHtml(c.email) +
        ' <button type="button" data-client-edit="' + escapeHtml(c.id) + '">수정</button>' +
        ' <button type="button" data-client-del="' + escapeHtml(c.id) + '">삭제</button></li>'
      );
    }).join('');
    var html =
      '<section aria-label="고객사"><h2>고객사</h2>' +
      '<ul class="cards">' + (rows || emptyItem('등록된 고객사가 없습니다')) + '</ul>' +
      '<div class="inline-form">' +
      '<div class="field"><label>고객사 이름<input data-client-name type="text" value="' + escapeHtml(editing ? editing.name : '') + '" aria-label="고객사 이름" /></label></div>' +
      '<div class="field"><label>담당자<input data-client-contact type="text" value="' + escapeHtml(editing ? editing.contact : '') + '" aria-label="담당자" /></label></div>' +
      '<div class="field"><label>이메일<input data-client-email type="text" value="' + escapeHtml(editing ? editing.email : '') + '" aria-label="고객사 이메일" /></label></div>' +
      '<button type="button" data-client-save>' + (editing ? '고객사 수정' : '고객사 저장') + '</button></div>' +
      (ETKO.lastAgencyError ? '<p role="alert">' + escapeHtml(ETKO.lastAgencyError) + '</p>' : '') +
      '</section>';
    container.innerHTML = html;
    container.__agencyView = 'clients';
    wireAgency(container);
    return container.innerHTML;
  };

  function roleLabel(role) {
    if (role === 'AGENCY') return '대행사 관리자';
    if (role === 'MANAGER') return '행사 매니저';
    if (role === 'CLIENT') return '고객사 담당자';
    if (role === 'VIEWER') return '조회 전용';
    return '현장 스태프';
  }

  // Team matrix for the active event workspace.
  ETKO.renderAgencyTeam = function (container) {
    var ws = null;
    try {
      ws = typeof ETKO.workspace === 'function' ? ETKO.workspace() : null;
    } catch (err) {
      ws = null;
    }
    var members = (ws && Array.isArray(ws.members) ? ws.members : []);
    var ev = eventById(ETKO.store.activeEventId);
    var rows = members.map(function (m) {
      if (!m) return '';
      var options = ['AGENCY', 'MANAGER', 'CLIENT', 'STAFF', 'VIEWER'].map(function (r) {
        return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + roleLabel(r) + '</option>';
      }).join('');
      return (
        '<li class="card"><strong>' + escapeHtml(m.name) + '</strong> · ' + escapeHtml(m.email) +
        ' <select data-member-role="' + escapeHtml(m.id) + '" aria-label="역할">' + options + '</select></li>'
      );
    }).join('');
    var html =
      '<section aria-label="팀과 권한"><h2>팀과 권한</h2>' +
      '<p role="note">' + escapeHtml(ev ? ev.name : '') + ' 구성원을 관리합니다. 역할을 바꾸면 해당 인원의 메뉴 범위가 함께 바뀝니다.</p>' +
      '<ul class="cards">' + (rows || emptyItem('등록된 구성원이 없습니다')) + '</ul>' +
      '<div class="inline-form">' +
      '<div class="field"><label>이름<input data-member-name type="text" aria-label="구성원 이름" /></label></div>' +
      '<div class="field"><label>이메일<input data-member-email type="text" aria-label="구성원 이메일" /></label></div>' +
      '<div class="field"><label>역할<select data-member-role-new aria-label="새 구성원 역할"><option value="STAFF">현장 스태프</option><option value="MANAGER">행사 매니저</option><option value="CLIENT">고객사 담당자</option><option value="VIEWER">조회 전용</option></select></label></div>' +
      '<button type="button" data-member-add>구성원 추가</button></div>' +
      (ETKO.lastAgencyError ? '<p role="alert">' + escapeHtml(ETKO.lastAgencyError) + '</p>' : '') +
      '</section>';
    container.innerHTML = html;
    container.__agencyView = 'team';
    wireAgency(container);
    return container.innerHTML;
  };

  function refresh(container) {
    var view = container ? container.__agencyView : null;
    try {
      if (view === 'home' && typeof ETKO.renderAgencyHome === 'function') ETKO.renderAgencyHome(container);
      else if (view === 'events' && typeof ETKO.renderAgencyEvents === 'function') ETKO.renderAgencyEvents(container);
      else if (view === 'clients' && typeof ETKO.renderAgencyClients === 'function') ETKO.renderAgencyClients(container);
      else if (view === 'team' && typeof ETKO.renderAgencyTeam === 'function') ETKO.renderAgencyTeam(container);
    } catch (err) {}
  }

  function fail(container, err) {
    ETKO.lastAgencyError = (err && err.message) || '처리하지 못했습니다';
    refresh(container);
  }

  // Shared wiring for the four agency mounts.
  function wireAgency(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    onClick(container, 'data-event-open', function () {
      var id = this.getAttribute ? this.getAttribute('data-event-open') : null;
      try {
        if (typeof ETKO.switchEventAndRender === 'function') ETKO.switchEventAndRender(id);
        else if (typeof ETKO.switchEvent === 'function') ETKO.switchEvent(id);
        ETKO.lastAgencyError = null;
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-event-status', function () {
      var raw = this.getAttribute ? this.getAttribute('data-event-status') : '';
      var parts = String(raw || '').split(':');
      try {
        ETKO.setEventStatus(parts[0], parts[1]);
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-wizard-next', function () {
      var state = ui();
      try {
        if (state.step === 1) {
          var name = fieldText(container, 'data-wname').trim();
          var date = fieldText(container, 'data-wdate').trim();
          var venue = fieldText(container, 'data-wvenue').trim();
          if (!name) throw new Error('행사 이름을 입력하세요');
          if (!date) throw new Error('행사 날짜를 입력하세요');
          if (!venue) throw new Error('행사 장소를 입력하세요');
          state.draft = { name: name, date: date, venue: venue, features: (state.draft && state.draft.features) || {} };
          state.step = 2;
        } else if (state.step === 2) {
          var picked = {};
          eachAttr(container, 'data-wfeat', function (box) {
            if (box && box.checked && box.getAttribute) picked[box.getAttribute('data-wfeat')] = true;
          });
          state.draft.features = picked;
          state.step = 3;
        }
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-wizard-back', function () {
      var state = ui();
      state.step = state.step === 3 ? 2 : 1;
      ETKO.lastAgencyError = null;
      refresh(container);
    });
    onClick(container, 'data-wizard-create', function () {
      var state = ui();
      var backTo = ETKO.store.activeEventId;
      try {
        var draft = state.draft || {};
        var id = ETKO.createEvent({ name: draft.name, date: draft.date, venue: draft.venue });
        ETKO.switchEvent(id);
        if (typeof ETKO.setEventFeatures === 'function') ETKO.setEventFeatures(draft.features || {});
        ETKO.switchEvent(backTo);
        ETKO.agencyUi = { step: 1, draft: {} };
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        try {
          if (backTo) ETKO.switchEvent(backTo);
        } catch (innerErr) {}
        fail(container, err);
      }
    });
    onClick(container, 'data-client-save', function () {
      var state = ui();
      try {
        ETKO.saveClient({
          id: state.editClientId || undefined,
          name: fieldText(container, 'data-client-name'),
          contact: fieldText(container, 'data-client-contact'),
          email: fieldText(container, 'data-client-email'),
        });
        state.editClientId = null;
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-client-edit', function () {
      var id = this.getAttribute ? this.getAttribute('data-client-edit') : null;
      ui().editClientId = id;
      ETKO.lastAgencyError = null;
      refresh(container);
    });
    onClick(container, 'data-client-del', function () {
      var id = this.getAttribute ? this.getAttribute('data-client-del') : null;
      try {
        ETKO.removeClient(id);
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-member-add', function () {
      try {
        var roleEl = container.querySelector ? container.querySelector('[data-member-role-new]') : null;
        ETKO.saveMember({
          name: fieldText(container, 'data-member-name'),
          email: fieldText(container, 'data-member-email'),
          role: roleEl && roleEl.value ? roleEl.value : 'STAFF',
        });
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onChange(container, 'data-member-role', function () {
      var sel = this;
      var id = sel.getAttribute ? sel.getAttribute('data-member-role') : null;
      try {
        var ws = typeof ETKO.workspace === 'function' ? ETKO.workspace() : null;
        var current = null;
        (ws && Array.isArray(ws.members) ? ws.members : []).forEach(function (m) {
          if (m && m.id === id) current = m;
        });
        if (!current) throw new Error('행사 구성원을 찾을 수 없습니다');
        ETKO.saveMember({ id: current.id, name: current.name, email: current.email, role: sel.value });
        ETKO.lastAgencyError = null;
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
  }

  ETKO.wireAgency = wireAgency;

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
