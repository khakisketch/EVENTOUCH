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
  ETKO.register = function (payload) {
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
      email: text(opts.email) || 'guest@example.com',
      group: '일반',
      registrationType: 'PRE',
      status: 'registered',
      everIn: false,
      cancelled: false,
      ticket: 'DEMO-' + String(num).padStart(4, '0'),
      registeredAt: new Date().toISOString(),
      customAnswers: custom,
      formVersion: version,
    };
    ws.participants.push(participant);
    return participant;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
