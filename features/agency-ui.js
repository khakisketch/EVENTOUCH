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
    if (!ETKO.agencyUi.errors || typeof ETKO.agencyUi.errors !== 'object') ETKO.agencyUi.errors = {};
    if (!ETKO.agencyUi.teamDrafts || typeof ETKO.agencyUi.teamDrafts !== 'object') ETKO.agencyUi.teamDrafts = {};
    return ETKO.agencyUi;
  }

  function stateKey(view) {
    return view === 'team'
      ? 'team:' + String(ETKO.store && ETKO.store.activeEventId || '')
      : view;
  }

  function errorFor(view) {
    return ui().errors[stateKey(view)] || null;
  }

  function fieldAttrs(view, field, id) {
    var error = errorFor(view);
    return error && error.field === field
      ? ' aria-invalid="true" aria-describedby="' + escapeHtml(id) + '"'
      : ' aria-invalid="false"';
  }

  function fieldError(view, field, id) {
    var error = errorFor(view);
    if (!error || error.field !== field) return '';
    return '<p class="field-error" id="' + escapeHtml(id) + '" role="alert">' + escapeHtml(error.message) + '</p>';
  }

  function viewError(view) {
    var error = errorFor(view);
    return error && !error.field
      ? '<p role="alert">' + escapeHtml(error.message) + '</p>'
      : '';
  }

  function fieldForError(view, message) {
    if (view === 'events') {
      if (message.indexOf('이름') !== -1) return 'name';
      if (message.indexOf('날짜') !== -1) return 'date';
      if (message.indexOf('장소') !== -1) return 'venue';
    } else if (view === 'clients') {
      if (message.indexOf('이메일') !== -1) return 'email';
      if (message.indexOf('고객사 이름') !== -1) return 'name';
    } else if (view === 'team') {
      if (message.indexOf('이메일') !== -1) return 'email';
      if (message.indexOf('이름') !== -1) return 'name';
      if (message.indexOf('역할') !== -1) return 'role';
    }
    return null;
  }

  function focusError(container, view, field) {
    if (!container || !field || typeof container.querySelector !== 'function') return;
    var attrs = {
      events: { name: 'data-wname', date: 'data-wdate', venue: 'data-wvenue' },
      clients: { name: 'data-client-name', email: 'data-client-email' },
      team: { name: 'data-member-name', email: 'data-member-email', role: 'data-member-role-new' },
    };
    var attr = attrs[view] && attrs[view][field];
    var control = attr ? container.querySelector('[' + attr + ']') : null;
    if (control && typeof control.focus === 'function') control.focus();
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
        '<div class="field"><label>행사명<input data-wname type="text" required value="' + escapeHtml(draft.name || '') + '" aria-label="행사명"' + fieldAttrs('events', 'name', 'wname-error') + ' /></label>' +
        fieldError('events', 'name', 'wname-error') + '</div>' +
        '<div class="field"><label>날짜<input data-wdate type="date" required value="' + escapeHtml(draft.date || '') + '" aria-label="행사 날짜"' + fieldAttrs('events', 'date', 'wdate-error') + ' /></label>' +
        fieldError('events', 'date', 'wdate-error') + '</div>' +
        '<div class="field"><label>장소<input data-wvenue type="text" required value="' + escapeHtml(draft.venue || '') + '" aria-label="행사 장소"' + fieldAttrs('events', 'venue', 'wvenue-error') + ' /></label>' +
        fieldError('events', 'venue', 'wvenue-error') + '</div>' +
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
      viewError('events') +
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
    var draft = state.clientDraft || null;
    var clientName = draft ? draft.name : editing ? editing.name : '';
    var clientContact = draft ? draft.contact : editing ? editing.contact : '';
    var clientEmail = draft ? draft.email : editing ? editing.email : '';
    var html =
      '<section aria-label="고객사"><h2>고객사</h2>' +
      '<ul class="cards">' + (rows || emptyItem('등록된 고객사가 없습니다')) + '</ul>' +
      '<div class="inline-form">' +
      '<div class="field"><label>고객사 이름<input data-client-name type="text" value="' + escapeHtml(clientName || '') + '" aria-label="고객사 이름"' + fieldAttrs('clients', 'name', 'client-name-error') + ' /></label>' +
      fieldError('clients', 'name', 'client-name-error') + '</div>' +
      '<div class="field"><label>담당자<input data-client-contact type="text" value="' + escapeHtml(clientContact || '') + '" aria-label="담당자" /></label></div>' +
      '<div class="field"><label>이메일<input data-client-email type="email" autocomplete="email" value="' + escapeHtml(clientEmail || '') + '" aria-label="고객사 이메일"' + fieldAttrs('clients', 'email', 'client-email-error') + ' /></label>' +
      fieldError('clients', 'email', 'client-email-error') + '</div>' +
      '<button type="button" data-client-save>' + (editing ? '고객사 수정' : '고객사 저장') + '</button></div>' +
      viewError('clients') +
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
    var state = ui();
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
    var draft = state.teamDrafts[stateKey('team')] || {};
    var html =
      '<section aria-label="팀과 권한"><h2>팀과 권한</h2>' +
      '<p role="note">' + escapeHtml(ev ? ev.name : '') + ' 구성원을 관리합니다. 역할을 바꾸면 해당 인원의 메뉴 범위가 함께 바뀝니다.</p>' +
      '<ul class="cards">' + (rows || emptyItem('등록된 구성원이 없습니다')) + '</ul>' +
      '<div class="inline-form">' +
      '<div class="field"><label>이름<input data-member-name type="text" value="' + escapeHtml(draft.name || '') + '" aria-label="구성원 이름"' + fieldAttrs('team', 'name', 'member-name-error') + ' /></label>' +
      fieldError('team', 'name', 'member-name-error') + '</div>' +
      '<div class="field"><label>이메일<input data-member-email type="email" autocomplete="email" value="' + escapeHtml(draft.email || '') + '" aria-label="구성원 이메일"' + fieldAttrs('team', 'email', 'member-email-error') + ' /></label>' +
      fieldError('team', 'email', 'member-email-error') + '</div>' +
      '<div class="field"><label>역할<select data-member-role-new aria-label="새 구성원 역할"' + fieldAttrs('team', 'role', 'member-role-error') + '>' +
      '<option value="STAFF"' + ((draft.role || 'STAFF') === 'STAFF' ? ' selected' : '') + '>현장 스태프</option>' +
      '<option value="MANAGER"' + (draft.role === 'MANAGER' ? ' selected' : '') + '>행사 매니저</option>' +
      '<option value="CLIENT"' + (draft.role === 'CLIENT' ? ' selected' : '') + '>고객사 담당자</option>' +
      '<option value="VIEWER"' + (draft.role === 'VIEWER' ? ' selected' : '') + '>조회 전용</option></select></label>' +
      fieldError('team', 'role', 'member-role-error') + '</div>' +
      '<button type="button" data-member-add>구성원 추가</button></div>' +
      viewError('team') +
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

  function fail(container, err, field) {
    var view = container && container.__agencyView ? container.__agencyView : 'events';
    var message = (err && err.message) || '처리하지 못했습니다';
    var state = ui();
    var invalidField = field || fieldForError(view, message);
    state.errors[stateKey(view)] = { message: message, field: invalidField || null };
    if (view === 'events' && invalidField && state.step !== 1) state.step = 1;
    ETKO.lastAgencyError = message;
    refresh(container);
    focusError(container, view, invalidField);
  }

  function clearError(view) {
    delete ui().errors[stateKey(view)];
    ETKO.lastAgencyError = null;
  }

  // Shared wiring for the four agency mounts.
  function wireAgency(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    onClick(container, 'data-event-open', function () {
      var id = this.getAttribute ? this.getAttribute('data-event-open') : null;
      try {
        if (typeof ETKO.switchEventAndRender === 'function') ETKO.switchEventAndRender(id);
        else if (typeof ETKO.switchEvent === 'function') ETKO.switchEvent(id);
        clearError(container.__agencyView || 'home');
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-event-status', function () {
      var raw = this.getAttribute ? this.getAttribute('data-event-status') : '';
      var parts = String(raw || '').split(':');
      try {
        ETKO.setEventStatus(parts[0], parts[1]);
        clearError(container.__agencyView || 'home');
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
          state.draft = { name: name, date: date, venue: venue, features: (state.draft && state.draft.features) || {} };
          if (!name) throw new Error('행사 이름을 입력하세요');
          if (!date) throw new Error('행사 날짜를 입력하세요');
          if (!venue) throw new Error('행사 장소를 입력하세요');
          state.step = 2;
        } else if (state.step === 2) {
          var picked = {};
          eachAttr(container, 'data-wfeat', function (box) {
            if (box && box.checked && box.getAttribute) picked[box.getAttribute('data-wfeat')] = true;
          });
          state.draft.features = picked;
          state.step = 3;
        }
        clearError('events');
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-wizard-back', function () {
      var state = ui();
      state.step = state.step === 3 ? 2 : 1;
      clearError('events');
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
        clearError('events');
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
        state.clientDraft = {
          name: fieldText(container, 'data-client-name'),
          contact: fieldText(container, 'data-client-contact'),
          email: fieldText(container, 'data-client-email'),
        };
        ETKO.saveClient({
          id: state.editClientId || undefined,
          name: state.clientDraft.name,
          contact: state.clientDraft.contact,
          email: state.clientDraft.email,
        });
        state.editClientId = null;
        state.clientDraft = null;
        clearError('clients');
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-client-edit', function () {
      var id = this.getAttribute ? this.getAttribute('data-client-edit') : null;
      ui().editClientId = id;
      ui().clientDraft = null;
      clearError('clients');
      refresh(container);
    });
    onClick(container, 'data-client-del', function () {
      var id = this.getAttribute ? this.getAttribute('data-client-del') : null;
      try {
        ETKO.removeClient(id);
        clearError('clients');
        refresh(container);
      } catch (err) {
        fail(container, err);
      }
    });
    onClick(container, 'data-member-add', function () {
      var state = ui();
      try {
        var roleEl = container.querySelector ? container.querySelector('[data-member-role-new]') : null;
        var teamKey = stateKey('team');
        state.teamDrafts[teamKey] = {
          name: fieldText(container, 'data-member-name'),
          email: fieldText(container, 'data-member-email'),
          role: roleEl && roleEl.value ? roleEl.value : 'STAFF',
        };
        ETKO.saveMember({
          name: state.teamDrafts[teamKey].name,
          email: state.teamDrafts[teamKey].email,
          role: state.teamDrafts[teamKey].role,
        });
        delete state.teamDrafts[teamKey];
        clearError('team');
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
        clearError('team');
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
