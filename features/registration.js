(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Core payload keys read from the top level; every other field id reads
  // from payload.customAnswers (top level accepted as a fallback).
  var CORE_IDS = ['name', 'phone', 'company', 'email'];
  var FIELD_TYPES = ['text', 'email', 'select', 'checkbox'];

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value));
  }

  function defaultFields() {
    return [
      { id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true },
      { id: 'company', label: '소속', type: 'text', required: false },
      { id: 'email', label: '이메일', type: 'email', required: false },
    ];
  }

  // Active workspace must exist (Task 1 ETKO.workspace throws otherwise).
  // Seeds the default form on first use so consumers never see empty fields.
  function formWorkspace() {
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.fields) || ws.fields.length === 0) {
      ws.fields = defaultFields();
    }
    if (typeof ws.formVersion !== 'number') ws.formVersion = 1;
    if (!Array.isArray(ws.participants)) ws.participants = [];
    return ws;
  }

  function activeEvent() {
    var found = null;
    (ETKO.store.events || []).forEach(function (ev) {
      if (ev && ev.id === ETKO.store.activeEventId) found = ev;
    });
    return found;
  }

  // Read-only copy of the active registration form (defaults ensured).
  ETKO.formFields = function () {
    return formWorkspace().fields.map(function (f) {
      var copy = {
        id: f.id,
        label: f.label,
        type: f.type,
        required: !!f.required,
      };
      if (Array.isArray(f.options)) copy.options = f.options.slice();
      return copy;
    });
  };

  function normalizeField(raw) {
    var src = raw || {};
    var id = text(src.id);
    if (!id) throw new Error('항목 ID를 입력하세요');
    var type = text(src.type) || 'text';
    if (FIELD_TYPES.indexOf(type) === -1) throw new Error('필드 형식을 확인하세요');
    var options = Array.isArray(src.options)
      ? src.options.map(text).filter(function (opt) {
          return !!opt;
        })
      : [];
    if (type === 'select' && options.length < 2) {
      throw new Error('선택지는 두 개 이상 입력하세요');
    }
    return {
      id: id,
      label: text(src.label) || id,
      type: type,
      required: id === 'name' || id === 'phone' ? true : !!src.required,
      options: type === 'select' ? options : undefined,
    };
  }

  // Replace the whole registration form. name/phone can never be removed
  // (they stay required); select fields need at least two options.
  // Bumps formVersion so existing answers stay pinned to their version.
  ETKO.setFields = function (fields) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('participants');
    var ws = formWorkspace();
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error('등록 항목을 입력하세요');
    }
    var next = fields.map(normalizeField);
    var ids = next.map(function (f) {
      return f.id;
    });
    if (ids.indexOf('name') === -1 || ids.indexOf('phone') === -1) {
      throw new Error('이름·연락처는 필수 항목입니다');
    }
    ws.fields = next;
    ws.formVersion += 1;
    return ETKO.formFields();
  };

  function fieldValue(field, payload) {
    var opts = payload || {};
    var custom = opts.customAnswers || {};
    if (CORE_IDS.indexOf(field.id) !== -1) return opts[field.id];
    if (opts[field.id] !== undefined) return opts[field.id];
    return custom[field.id];
  }

  // Validate a signup payload against the active form. Throws Korean errors
  // on missing required values, invalid select options, or bad email.
  // Returns the form version the payload was validated against.
  ETKO.validateSignup = function (payload) {
    var ws = formWorkspace();
    var opts = payload || {};
    ws.fields.forEach(function (f) {
      var raw = fieldValue(f, opts);
      if (f.required) {
        var present = f.type === 'checkbox' ? !!raw : !!text(raw);
        if (!present) throw new Error(f.label + ' 항목을 입력하세요');
      }
      if (raw !== undefined && raw !== null && text(raw) !== '') {
        if (f.type === 'select' && (f.options || []).indexOf(text(raw)) === -1) {
          throw new Error(f.label + ' 선택을 확인하세요');
        }
        if (f.type === 'email' && !isEmail(raw)) {
          throw new Error(f.label + ' 이메일 형식을 확인하세요');
        }
      }
    });
    return { formVersion: ws.formVersion };
  };

  function activeCount(ws) {
    return ws.participants.filter(function (p) {
      return p && !p.cancelled;
    }).length;
  }

  function capacityOf(ws) {
    var ev = activeEvent();
    var cap = ev && ev.capacity !== undefined ? Number(ev.capacity) : NaN;
    if (!isFinite(cap) || cap < 0) cap = Number(ws.capacity) || 0;
    return cap;
  }

  function nextParticipantId(ws) {
    var max = 0;
    ws.participants.forEach(function (p) {
      var m = /^p(\d+)$/.exec((p && p.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'p' + (max + 1);
  }

  // Create a participant: validate, refuse name+phone duplicates and a full
  // event, then append with the next p<N> id.
  // Admin path: requires the participants write grant.
  ETKO.register = function (payload) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('participants');
    return createParticipant(payload);
  };

  // Self-service path: no admin write grant required. Same validation,
  // duplicate, and capacity rules as register(). Staff/admin entry stays
  // on ETKO.register so audits can distinguish the two callers.
  ETKO.registerSelf = function (payload) {
    return createParticipant(payload);
  };

  function createParticipant(payload) {
    var ws = formWorkspace();
    var version = ETKO.validateSignup(payload).formVersion;
    var opts = payload || {};
    var name = text(opts.name);
    var phone = text(opts.phone);
    var duplicate = ws.participants.some(function (p) {
      return p && !p.cancelled && p.name === name && p.phone === phone;
    });
    if (duplicate) throw new Error('이미 등록한 참가자입니다');
    var cap = capacityOf(ws);
    if (cap > 0 && activeCount(ws) >= cap) {
      throw new Error('등록 정원이 마감되었습니다');
    }
    var n = nextParticipantId(ws);
    var num = parseInt(n.slice(1), 10);
    var custom = {};
    Object.keys(opts).forEach(function (key) {
      if (CORE_IDS.indexOf(key) !== -1 || key === 'customAnswers') return;
      custom[key] = opts[key];
    });
    Object.keys(opts.customAnswers || {}).forEach(function (key) {
      custom[key] = opts.customAnswers[key];
    });
    var participant = {
      id: n,
      eventId: ETKO.store.activeEventId,
      name: name,
      phone: phone,
      company: text(opts.company),
      email: text(opts.email),
      group: '일반',
      registrationType: 'PRE',
      status: 'registered',
      everIn: false,
      cancelled: false,
      ticket: 'GENERAL',
      code: 'EVT-' + (1000 + num),
      registeredAt: new Date().toISOString(),
      customAnswers: custom,
      formVersion: version,
    };
    ws.participants.push(participant);
    return participant;
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function signupUiState() {
    if (!ETKO.signupUi || typeof ETKO.signupUi !== 'object') ETKO.signupUi = {};
    if (!ETKO.signupUi.events || typeof ETKO.signupUi.events !== 'object') ETKO.signupUi.events = {};
    var eventId = String(ETKO.store && ETKO.store.activeEventId || 'default');
    if (!ETKO.signupUi.events[eventId]) ETKO.signupUi.events[eventId] = { draft: null, error: null };
    return ETKO.signupUi.events[eventId];
  }

  function signupFieldAttrs(state, field, id) {
    return state.error && state.error.field === field
      ? ' aria-invalid="true" aria-describedby="' + escapeHtml(id) + '"'
      : ' aria-invalid="false"';
  }

  function signupFieldError(state, field, id) {
    if (!state.error || state.error.field !== field) return '';
    return '<p class="field-error" id="' + escapeHtml(id) + '" role="alert">' + escapeHtml(state.error.message) + '</p>';
  }

  function signupErrorField(fields, message) {
    for (var i = 0; i < fields.length; i += 1) {
      var label = String(fields[i].label || '');
      if (label && message.indexOf(label) !== -1) return fields[i].id;
    }
    return null;
  }

  function focusSignupError(container, field) {
    if (!container || !field || typeof container.querySelector !== 'function') return;
    var control = container.querySelector('[data-signup-' + field + ']');
    if (control && typeof control.focus === 'function') control.focus();
  }

  // Mobile signup mount: renders the active form with required marks and
  // select options, submits to registerSelf(), shows the ticket code on success
  // and a field-named Korean alert on failure.
  ETKO.renderSignup = function (container) {
    var fields = ETKO.formFields();
    var state = signupUiState();
    var rows = fields.map(function (f) {
      var req = f.required ? ' <span>필수</span>' : '';
      var input = '';
      if (f.type === 'select' && Array.isArray(f.options)) {
        var selected = state.draft && state.draft[f.id];
        input =
          '<select data-signup-' + escapeHtml(f.id) + (f.required ? ' required' : '') + ' aria-label="' + escapeHtml(f.label) + '"' + signupFieldAttrs(state, f.id, 'signup-' + f.id + '-error') + '>' +
          '<option value=""' + (!selected ? ' selected' : '') + '>선택하세요</option>' +
          f.options.map(function (o) {
            return '<option value="' + escapeHtml(o) + '"' + (selected === o ? ' selected' : '') + '>' + escapeHtml(o) + '</option>';
          }).join('') +
          '</select>';
      } else if (f.type === 'checkbox') {
        input = '<input data-signup-' + escapeHtml(f.id) + ' type="checkbox"' + (f.required ? ' required' : '') +
          (state.draft && state.draft[f.id] ? ' checked' : '') + ' aria-label="' + escapeHtml(f.label) + '"' +
          signupFieldAttrs(state, f.id, 'signup-' + f.id + '-error') + ' />';
      } else {
        var inputType = f.type === 'email' ? 'email' : f.id === 'phone' ? 'tel' : 'text';
        var autocomplete = f.id === 'phone' ? ' autocomplete="tel" inputmode="tel"' : f.id === 'email' ? ' autocomplete="email"' : f.id === 'name' ? ' autocomplete="name"' : '';
        input =
          '<input data-signup-' + escapeHtml(f.id) + ' type="' + inputType + '"' + (f.required ? ' required' : '') + autocomplete +
          ' value="' + escapeHtml(state.draft && state.draft[f.id]) + '" aria-label="' + escapeHtml(f.label) + '"' +
          signupFieldAttrs(state, f.id, 'signup-' + f.id + '-error') + ' />';
      }
      return '<div class="field"><label>' + escapeHtml(f.label) + req + input + '</label>' +
        signupFieldError(state, f.id, 'signup-' + f.id + '-error') + '</div>';
    }).join('');
    var html =
      '<section aria-label="참가 신청"><h2>참가 신청</h2>' +
      rows +
      '<button type="button" data-signup-submit>신청하기</button></section>';
    if (state.error && !state.error.field) {
      html += '<p role="alert">' + escapeHtml(state.error.message) + '</p>';
    } else if (ETKO.lastSignupError && !state.error) {
      html += '<p role="alert">' + escapeHtml(ETKO.lastSignupError) + '</p>';
    }
    if (ETKO.lastSignupTicket) {
      var signupQr = '';
      try {
        if (typeof ETKO.qrSvg === 'function') {
          signupQr = '<div class="qr">' + ETKO.qrSvg(ETKO.lastSignupTicket) + '</div>';
        }
      } catch (err) {}
      html += '<p>등록 완료 · 체크인 QR 코드: ' + escapeHtml(ETKO.lastSignupTicket) + '</p>' + signupQr + '<p>입장 데스크에서 보여주세요</p>';
    }
    container.innerHTML = html;
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(container.querySelectorAll('[data-signup-submit]'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = signupUiState();
          ETKO.lastSignupError = null;
          ETKO.lastSignupTicket = null;
          state.error = null;
          try {
            var payload = {};
            fields.forEach(function (f) {
              var el = container.querySelector ? container.querySelector('[data-signup-' + f.id + ']') : null;
              payload[f.id] = f.type === 'checkbox'
                ? !!(el && el.checked)
                : el && el.value !== undefined ? el.value : '';
            });
            state.draft = payload;
            var signupFn = typeof ETKO.registerSelf === 'function' ? ETKO.registerSelf : ETKO.register;
            var created = signupFn(payload);
            ETKO.lastSignupTicket = created.code || created.ticket || '';
            state.draft = null;
          } catch (err) {
            ETKO.lastSignupError = err && err.message ? err.message : '신청하지 못했습니다';
            state.error = { message: ETKO.lastSignupError, field: signupErrorField(fields, ETKO.lastSignupError) };
          }
          ETKO.renderSignup(container);
          if (state.error) focusSignupError(container, state.error.field);
        });
      });
    }
    return container.innerHTML;
  };

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['setFields', 'register', 'registerSelf']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
