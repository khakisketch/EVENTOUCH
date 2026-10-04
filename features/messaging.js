(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Campaigns + templates (Task 8): simulation only, never sends.
  // Consumes ETKO.workspace() (holds `templates`, `messages`) and mirrors
  // the `campaignReview` target semantics: 전체 / 체크인 참가자 /
  // 미입장 참가자 / 선택 참가자. Entered-check uses `everIn`
  // (set on IN scans), never a literal status equality, so a participant
  // who left after entering still counts as 체크인 참가자.

  var CHANNELS = ['알림톡', 'SMS', 'LMS', 'MMS'];
  var TARGETS = ['전체', '체크인 참가자', '미입장 참가자', '선택 참가자'];

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function messagingWorkspace() {
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.templates)) ws.templates = [];
    if (!Array.isArray(ws.messages)) ws.messages = [];
    if (!Array.isArray(ws.participants)) ws.participants = [];
    return ws;
  }

  function findTemplate(ws, id) {
    for (var i = 0; i < ws.templates.length; i += 1) {
      if (ws.templates[i] && ws.templates[i].id === id) return ws.templates[i];
    }
    return null;
  }

  function nextTemplateId(ws) {
    var max = 0;
    ws.templates.forEach(function (t) {
      var m = /^tpl-(\d+)$/.exec((t && t.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = 'tpl-' + (max + 1);
    while (findTemplate(ws, id)) {
      max += 1;
      id = 'tpl-' + (max + 1);
    }
    return id;
  }

  function required(value, label, max) {
    var body = text(value);
    if (!body) throw new Error(label + '을(를) 입력하세요');
    if (max && body.length > max) {
      throw new Error(label + '은(는) ' + max + '자 이내로 입력하세요');
    }
    return body;
  }

  function isActive(person) {
    return !!person && !person.cancelled;
  }

  function inTarget(person, target, set) {
    if (target === '전체') return true;
    if (target === '체크인 참가자') return !!person.everIn;
    if (target === '미입장 참가자') return !person.everIn;
    if (target === '선택 참가자') return set.has(person.id);
    return false;
  }

  // Review the recipient set for a target without sending anything.
  // Returns a FROZEN {target,recipientIds,count,channel,content,
  // scheduled,cost:null,delivery:'SIMULATION_ONLY'} snapshot.
  ETKO.campaignReview = function (input) {
    var opts = input || {};
    var ws = messagingWorkspace();
    var target = text(opts.target) || '전체';
    if (TARGETS.indexOf(target) === -1) throw new Error('발송 대상을 확인하세요');
    var ids = Array.isArray(opts.ids)
      ? opts.ids
      : Array.isArray(opts.recipientIds)
        ? opts.recipientIds
        : [];
    var set = {};
    ids.forEach(function (id) {
      set[id] = true;
    });
    var has = function (id) {
      return !!set[id];
    };
    var recipientIds = ws.participants
      .filter(function (p) {
        return isActive(p) && inTarget(p, target, { has: has });
      })
      .map(function (p) {
        return p.id;
      });
    return Object.freeze({
      target: target,
      recipientIds: Object.freeze(recipientIds),
      count: recipientIds.length,
      channel: text(opts.channel) || 'SMS',
      content: String(opts.content === undefined || opts.content === null ? '' : opts.content),
      scheduled: text(opts.scheduled),
      cost: null,
      delivery: 'SIMULATION_ONLY',
    });
  };

  // Save a reusable message template. Creates by default, updates when
  // `id` matches. Channel defaults to SMS.
  ETKO.saveTemplate = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('messages');
    var opts = input || {};
    var ws = messagingWorkspace();
    var name = required(opts.name, '템플릿명', 80);
    var content = required(opts.content, '메시지 내용', 2000);
    var channel = text(opts.channel) || 'SMS';
    if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
      var found = findTemplate(ws, opts.id);
      if (!found) throw new Error('템플릿을 찾을 수 없습니다');
      found.name = name;
      found.channel = channel;
      found.content = content;
      return { id: found.id, name: found.name, channel: found.channel, content: found.content };
    }
    var record = { id: nextTemplateId(ws), name: name, channel: channel, content: content };
    ws.templates.push(record);
    return { id: record.id, name: record.name, channel: record.channel, content: record.content };
  };

  // Delete one template by id. Missing ids are a no-op returning false,
  // deleted ids return true.
  ETKO.deleteTemplate = function (id) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('messages');
    var ws = messagingWorkspace();
    var before = ws.templates.length;
    ws.templates = ws.templates.filter(function (t) {
      return !(t && t.id === id);
    });
    return ws.templates.length < before;
  };

  function nextCampaignId(ws) {
    var max = 0;
    ws.messages.forEach(function (m) {
      var match = /^msg-(\d+)$/.exec((m && m.id) || '');
      if (match) max = Math.max(max, parseInt(match[1], 10));
    });
    var id = 'msg-' + (max + 1);
    var taken = function (candidate) {
      return ws.messages.some(function (m) {
        return m && m.id === candidate;
      });
    };
    while (taken(id)) {
      max += 1;
      id = 'msg-' + (max + 1);
    }
    return id;
  }

  // Save a campaign for simulation only. Recipient ids are validated
  // against live non-cancelled participants at submit, frozen on the
  // stored record, and never sent: status is DRAFT (or SCHEDULED when a
  // reservation time is given), delivery is always SIMULATION_ONLY and
  // cost stays null (unpriced, not zero).
  ETKO.createCampaign = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('messages');
    var opts = input || {};
    var ws = messagingWorkspace();
    var target = text(opts.target) || '전체';
    if (TARGETS.indexOf(target) === -1) throw new Error('발송 대상을 확인하세요');
    var ids = Array.isArray(opts.recipientIds) ? opts.recipientIds.slice() : [];
    if (ids.length === 0) throw new Error('발송 대상을 다시 확인하세요');
    var seen = {};
    ids.forEach(function (id) {
      if (seen[id]) throw new Error('발송 대상을 다시 확인하세요');
      seen[id] = true;
    });
    var unknown = ids.some(function (id) {
      return !ws.participants.some(function (p) {
        return p && p.id === id && !p.cancelled;
      });
    });
    if (unknown) throw new Error('검토 후 참가자 상태가 변경되었습니다. 발송 대상을 다시 확인하세요');
    var title = required(opts.title, '캠페인 이름', 80);
    var content = required(opts.content, '메시지', 2000);
    var channel = text(opts.channel);
    if (CHANNELS.indexOf(channel) === -1) throw new Error('발송 채널을 확인하세요');
    var scheduled = text(opts.scheduled);
    var record = {
      id: nextCampaignId(ws),
      title: title,
      channel: channel,
      target: target,
      recipientIds: Object.freeze(ids),
      count: ids.length,
      content: content,
      scheduled: scheduled,
      status: scheduled ? 'SCHEDULED' : 'DRAFT',
      delivery: 'SIMULATION_ONLY',
      cost: null,
    };
    ws.messages.unshift(record);
    return record;
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function messagingState() {
    if (!ETKO.messagingUi || typeof ETKO.messagingUi !== 'object') ETKO.messagingUi = {};
    if (!ETKO.messagingUi.events || typeof ETKO.messagingUi.events !== 'object') ETKO.messagingUi.events = {};
    var eventId = String(ETKO.store && ETKO.store.activeEventId || 'default');
    if (!ETKO.messagingUi.events[eventId]) {
      ETKO.messagingUi.events[eventId] = { drafts: {}, errors: {}, pageError: null };
    }
    return ETKO.messagingUi.events[eventId];
  }

  function formFieldAttrs(state, form, field, id) {
    var error = state.errors[form];
    return error && error.field === field
      ? ' aria-invalid="true" aria-describedby="' + escapeHtml(id) + '"'
      : ' aria-invalid="false"';
  }

  function formFieldError(state, form, field, id) {
    var error = state.errors[form];
    if (!error || error.field !== field) return '';
    return '<p class="field-error" id="' + escapeHtml(id) + '" role="alert">' + escapeHtml(error.message) + '</p>';
  }

  function formValue(state, form, field) {
    var draft = state.drafts[form] || {};
    return escapeHtml(draft[field] || '');
  }

  function optionSelected(state, form, field, value, fallback) {
    var draft = state.drafts[form] || {};
    var selected = draft[field] === undefined ? fallback : draft[field];
    return String(selected) === String(value) ? ' selected' : '';
  }

  function messageErrorField(form, message) {
    if (form === 'template') {
      if (message.indexOf('템플릿명') !== -1) return 'name';
      if (message.indexOf('메시지 내용') !== -1) return 'content';
      if (message.indexOf('채널') !== -1) return 'channel';
    } else if (form === 'campaign') {
      if (message.indexOf('캠페인 이름') !== -1) return 'title';
      if (message.indexOf('메시지') !== -1) return 'content';
      if (message.indexOf('발송 채널') !== -1) return 'channel';
      if (message.indexOf('발송 대상') !== -1 || message.indexOf('참가자 상태') !== -1) return 'target';
    }
    return null;
  }

  function focusMessageField(container, form, field) {
    if (!container || !field || typeof container.querySelector !== 'function') return;
    var attrs = {
      template: { name: 'data-template-name', channel: 'data-template-channel', content: 'data-template-content' },
      campaign: { title: 'data-campaign-title', channel: 'data-campaign-channel', target: 'data-campaign-target', content: 'data-campaign-content' },
    };
    var attr = attrs[form] && attrs[form][field];
    var control = attr ? container.querySelector('[' + attr + ']') : null;
    if (control && typeof control.focus === 'function') control.focus();
  }

  // Management mount renderer: templates + campaign compose + campaign
  // list with send + simulated outbox. Errors surface as role=alert.
  // Uses the slice-ensuring messagingWorkspace() above.
  ETKO.renderMessaging = function (container) {
    var ws = messagingWorkspace();
    var state = messagingState();
    var templates = (ws.templates || []).map(function (t) {
      return (
        '<li class="card">' + escapeHtml(t.name) + ' · ' + escapeHtml(t.channel) +
        ' <button type="button" data-template-del="' + escapeHtml(t.id) + '">삭제</button></li>'
      );
    }).join('');
    var campaigns = (ws.messages || []).map(function (c) {
      return (
        '<li class="card">' + escapeHtml(c.title) + ' · ' + escapeHtml(c.channel) + ' · ' + escapeHtml(c.target) +
        ' · ' + (c.count || 0) + '명 · ' + escapeHtml(c.status) + ' · SIMULATION_ONLY' +
        ' <button type="button" data-campaign-send="' + escapeHtml(c.id) + '">발송</button></li>'
      );
    }).join('');
    var outbox = [];
    try {
      outbox = typeof ETKO.outbox === 'function' ? ETKO.outbox() : [];
    } catch (err) {
      outbox = [];
    }
    var outboxRows = outbox.map(function (o) {
      return '<li class="card">' + escapeHtml(o.title || '') + ' · ' + escapeHtml(o.channel || '') + ' · ' + (o.toCount || 0) + '명 · SIMULATION_ONLY</li>';
    }).join('');
    function channelOptions(form) {
      return CHANNELS.map(function (c) {
        return '<option value="' + escapeHtml(c) + '"' + optionSelected(state, form, 'channel', c, '알림톡') + '>' + escapeHtml(c) + '</option>';
      }).join('');
    }
    var targetOptions = ['전체', '체크인 참가자', '미입장 참가자', '선택 참가자'].map(function (target) {
      var label = target === '전체' ? '전체 참가자' : target;
      return '<option value="' + escapeHtml(target) + '"' + optionSelected(state, 'campaign', 'target', target, '전체') + '>' + escapeHtml(label) + '</option>';
    }).join('');
    var html =
      '<section aria-label="메시지 템플릿 관리"><h2>템플릿</h2>' +
      '<ul class="cards">' + (templates || '<li class="card" data-empty><p role="status">저장된 템플릿이 없습니다</p></li>') + '</ul>' +
      '<div class="inline-form"><div class="field"><label>템플릿 이름<input data-template-name type="text" required value="' + formValue(state, 'template', 'name') + '" aria-label="템플릿 이름"' + formFieldAttrs(state, 'template', 'name', 'template-name-error') + ' /></label>' +
      formFieldError(state, 'template', 'name', 'template-name-error') + '</div>' +
      '<div class="field"><label>채널<select data-template-channel aria-label="템플릿 채널">' + channelOptions('template') + '</select></label>' +
      formFieldError(state, 'template', 'channel', 'template-channel-error') + '</div>' +
      '<div class="field"><label>템플릿 내용<textarea data-template-content rows="4" required aria-label="템플릿 내용"' + formFieldAttrs(state, 'template', 'content', 'template-content-error') + '>' + formValue(state, 'template', 'content') + '</textarea></label>' +
      formFieldError(state, 'template', 'content', 'template-content-error') + '</div>' +
      '<button type="button" data-template-save>템플릿 저장</button></div></section>' +
      '<section aria-label="캠페인 작성"><h2>캠페인</h2>' +
      '<div class="inline-form"><div class="field"><label>캠페인 이름<input data-campaign-title type="text" required value="' + formValue(state, 'campaign', 'title') + '" aria-label="캠페인 이름"' + formFieldAttrs(state, 'campaign', 'title', 'campaign-title-error') + ' /></label>' +
      formFieldError(state, 'campaign', 'title', 'campaign-title-error') + '</div>' +
      '<div class="field"><label>채널<select data-campaign-channel aria-label="발송 채널">' + channelOptions('campaign') + '</select></label>' +
      formFieldError(state, 'campaign', 'channel', 'campaign-channel-error') + '</div>' +
      '<div class="field"><label>발송 대상<select data-campaign-target aria-label="발송 대상">' + targetOptions + '</select></label>' +
      formFieldError(state, 'campaign', 'target', 'campaign-target-error') + '</div>' +
      '<div class="field"><label>캠페인 메시지<textarea data-campaign-content rows="5" required aria-label="캠페인 메시지"' + formFieldAttrs(state, 'campaign', 'content', 'campaign-content-error') + '>' + formValue(state, 'campaign', 'content') + '</textarea></label>' +
      formFieldError(state, 'campaign', 'content', 'campaign-content-error') + '</div>' +
      '<button type="button" data-campaign-save>초안 저장</button></div>' +
      '<ul class="cards">' + (campaigns || '<li class="card" data-empty><p role="status">작성된 캠페인이 없습니다</p></li>') + '</ul></section>' +
      '<section aria-label="발송함"><h2>발송함</h2>' +
      '<ul class="cards">' + (outboxRows || '<li class="card" data-empty><p role="status">발송 기록이 없습니다</p></li>') + '</ul></section>';
    if (state.pageError) html += '<p role="alert">' + escapeHtml(state.pageError) + '</p>';
    container.innerHTML = html;
    wireMessaging(container);
    return container.innerHTML;
  };

  function fieldValue(container, attr) {
    var el = container.querySelector ? container.querySelector('[' + attr + ']') : null;
    return el && el.value !== undefined ? el.value : '';
  }

  function wireMessaging(container) {
    if (!container || !container.querySelectorAll) return;
    function onAttr(attr, fn, form) {
      Array.prototype.forEach.call(container.querySelectorAll('[' + attr + ']'), function (btn) {
        if (btn.tagName === 'INPUT' || btn.tagName === 'SELECT') return;
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          var state = messagingState();
          ETKO.lastMessagingError = null;
          state.pageError = null;
          try {
            fn(btn);
            if (form) {
              state.drafts[form] = null;
              state.errors[form] = null;
            }
          } catch (err) {
            var message = err && err.message ? err.message : '처리하지 못했습니다';
            ETKO.lastMessagingError = message;
            if (form) {
              var field = messageErrorField(form, message);
              state.errors[form] = { message: message, field: field };
              if (!field) state.pageError = message;
            } else {
              state.pageError = message;
            }
          }
          if (typeof ETKO.renderMessaging === 'function') {
            try {
              ETKO.renderMessaging(container);
            } catch (err) {}
          }
          if (form && state.errors[form]) {
            focusMessageField(container, form, state.errors[form].field);
          }
        });
      });
    }
    onAttr('data-template-save', function () {
      var state = messagingState();
      state.drafts.template = {
        name: fieldValue(container, 'data-template-name'),
        channel: fieldValue(container, 'data-template-channel') || 'SMS',
        content: fieldValue(container, 'data-template-content'),
      };
      ETKO.saveTemplate(state.drafts.template);
    }, 'template');
    onAttr('data-template-del', function (btn) {
      ETKO.deleteTemplate(btn.getAttribute('data-template-del'));
    });
    onAttr('data-campaign-save', function () {
      var state = messagingState();
      var ws = messagingWorkspace();
      state.drafts.campaign = {
        title: fieldValue(container, 'data-campaign-title'),
        channel: fieldValue(container, 'data-campaign-channel') || 'SMS',
        target: fieldValue(container, 'data-campaign-target') || '전체',
        content: fieldValue(container, 'data-campaign-content'),
      };
      var target = state.drafts.campaign.target;
      var pool = ws.participants.filter(function (p) {
        return p && !p.cancelled;
      });
      var entered = function (p) {
        return String(p.status === undefined || p.status === null ? '' : p.status).trim().toLowerCase() === 'in';
      };
      var ids;
      if (target === '체크인 참가자') {
        ids = pool.filter(entered).map(function (p) { return p.id; });
      } else if (target === '미입장 참가자') {
        ids = pool.filter(function (p) { return !entered(p); }).map(function (p) { return p.id; });
      } else if (target === '선택 참가자') {
        var picked = ETKO.selectedIds && typeof ETKO.selectedIds.has === 'function'
          ? pool.filter(function (p) { return ETKO.selectedIds.has(p.id); })
          : [];
        ids = picked.map(function (p) { return p.id; });
      } else {
        target = '전체';
        ids = pool.map(function (p) { return p.id; });
      }
      ETKO.createCampaign({
        title: state.drafts.campaign.title,
        channel: state.drafts.campaign.channel,
        target: target,
        recipientIds: ids,
        content: state.drafts.campaign.content,
      });
    }, 'campaign');
    onAttr('data-campaign-send', function (btn) {
      if (typeof ETKO.sendCampaign !== 'function') throw new Error('발송 기능을 확인할 수 없습니다');
      ETKO.sendCampaign(btn.getAttribute('data-campaign-send'));
    });
  }

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['saveTemplate', 'deleteTemplate', 'createCampaign']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
