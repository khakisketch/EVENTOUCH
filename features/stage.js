(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});
  var SCENE_GROUP_LABELS = {
    CORE: '행사 기본',
    POLL: '투표',
    QUIZ: '퀴즈',
    QNA: '질문과 답변',
    DRAW: '럭키드로우',
    PHOTO: '사진',
  };

  // Live control disclosure + stage safety. Consumes ETKO.navigate only as a
  // view switch (never redefined here); Task 2 navigate semantics untouched.

  function allChecked(value) {
    if (!Array.isArray(value) || value.length < 2) return false;
    for (var i = 0; i < 2; i += 1) {
      if (!value[i]) return false;
    }
    return true;
  }

  // Two-stage gate: TAKE is allowed only when BOTH disclosure checks and
  // BOTH confirm checks pass. Never throws; bad input blocks TAKE.
  ETKO.canTake = function (opts) {
    var args = opts || {};
    return allChecked(args.disclose) && allChecked(args.confirm);
  };

  // Safety output copy: every mode maps to a Korean title + detail.
  // The panel renders this map, never the raw English key.
  var SAFETY_MESSAGES = {
    BLACK: { title: '암전 중입니다', detail: '무대 화면이 꺼져 있습니다.' },
    HOLD: { title: '잠시 대기해주세요', detail: '곧 행사가 이어집니다.' },
    LOGO: { title: '로고를 표시하고 있습니다', detail: '행사 로고가 송출 중입니다.' },
  };

  function normMode(value) {
    return String(value === undefined || value === null ? '' : value)
      .trim()
      .toUpperCase();
  }

  // Korean message for a safety mode. Unknown modes fall back to a generic
  // Korean message so English never leaks into the panel.
  // Returns a FRESH {title, detail} object per call.
  ETKO.safety = function (mode) {
    var entry = SAFETY_MESSAGES[normMode(mode)];
    if (entry) return { title: entry.title, detail: entry.detail };
    return { title: '알 수 없는 화면입니다', detail: '무대 상태를 다시 확인해주세요.' };
  };

  // Reduced-motion preference. Namespace-level so re-renders never reset it.
  if (ETKO.reducedMotion !== true && ETKO.reducedMotion !== false) {
    ETKO.reducedMotion = false;
  }

  // Switch reduced motion. Returns the active flag.
  ETKO.setReducedMotion = function (value) {
    ETKO.reducedMotion = value === true || value === 'true';
    try {
      var doc = root.document || (typeof document !== 'undefined' ? document : null);
      syncReducedMotionDoc(doc);
    } catch (err) {}
    return ETKO.reducedMotion;
  };

  // Expose the toggle on the document so it actually stops motion.
  // Guards keep mock containers and non-DOM runtimes working.
  function syncReducedMotionDoc(doc) {
    try {
      var el = doc && doc.documentElement ? doc.documentElement : null;
      if (!el) return;
      if (el.setAttribute) el.setAttribute('data-reduced-motion', ETKO.reducedMotion ? 'true' : 'false');
      else if (el.dataset) el.dataset.reducedMotion = ETKO.reducedMotion ? 'true' : 'false';
    } catch (err) {}
  }

  function normChecks(value) {
    var out = [false, false];
    if (Array.isArray(value)) {
      out[0] = !!value[0];
      out[1] = !!value[1];
    }
    return out;
  }

  function ensureStageState(state) {
    var s = state || {};
    if (typeof s.preview !== 'string' || !SAFETY_MESSAGES[normMode(s.preview)]) {
      s.preview = 'LOGO';
    } else {
      s.preview = normMode(s.preview);
    }
    if (typeof s.program !== 'string' || !SAFETY_MESSAGES[normMode(s.program)]) {
      s.program = 'LOGO';
    } else {
      s.program = normMode(s.program);
    }
    s.disclose = normChecks(s.disclose);
    s.confirm = normChecks(s.confirm);
    if (typeof s.scenePreview !== 'string' || !s.scenePreview) s.scenePreview = 'brand-idle';
    if (typeof s.sceneProgram !== 'string' || !s.sceneProgram) s.sceneProgram = null;
    return s;
  }

  // Second stage of the dialog: copy preview to program ONLY when the full
  // disclosure + confirm gate passes. A preview change alone never touches
  // the program; a refused TAKE leaves the program untouched. Returns true
  // on take, false on refuse.
  ETKO.applyTake = function (state) {
    var s = ensureStageState(state);
    if (!ETKO.canTake({ disclose: s.disclose, confirm: s.confirm })) return false;
    s.program = s.preview;
    if (typeof ETKO.sceneById === 'function' && ETKO.sceneById(s.scenePreview)) {
      s.sceneProgram = s.scenePreview;
    }
    try {
      if (typeof ETKO.announceScreen === 'function') ETKO.announceScreen();
    } catch (err) {}
    return true;
  };

  var DISCLOSE_COPY = ['현재 송출 중임을 확인했습니다', '관객 안내 고지를 확인했습니다'];
  var CONFIRM_COPY = ['미리보기 화면을 확인했습니다', '송출 전환에 동의합니다'];

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function checkHtml(kind, index, checked, copy) {
    return (
      '<label><input type="checkbox" data-' +
      kind +
      '="' +
      index +
      '"' +
      (checked ? ' checked' : '') +
      ' />' +
      escapeHtml(copy) +
      '</label>'
    );
  }

  // Render the two-stage live dialog: disclosure checks, preview/program,
  // scene picker, TAKE gated on all four checks, safety outputs,
  // reduced-motion toggle. Korean copy only. Wires controls when the
  // container supports queries.
  ETKO.renderStage = function (container, state) {
    var s = ensureStageState(state);
    var allowed = ETKO.canTake({ disclose: s.disclose, confirm: s.confirm });
    var previewMsg = ETKO.safety(s.preview);
    var programMsg = ETKO.safety(s.program);
    var scenes = [];
    try {
      scenes = typeof ETKO.SCENES !== 'undefined' && Array.isArray(ETKO.SCENES) ? ETKO.SCENES : [];
    } catch (err) {
      scenes = [];
    }
    var sceneGroups = [];
    scenes.forEach(function (scene) {
      if (!scene) return;
      var groupId = String(scene.group || 'OTHER');
      var group = null;
      for (var i = 0; i < sceneGroups.length; i += 1) {
        if (sceneGroups[i].id === groupId) group = sceneGroups[i];
      }
      if (!group) {
        group = { id: groupId, scenes: [] };
        sceneGroups.push(group);
      }
      group.scenes.push(scene);
    });
    var sceneGrid = sceneGroups.map(function (group) {
      var groupLabel = SCENE_GROUP_LABELS[group.id] || group.id;
      var buttons = group.scenes.map(function (scene) {
        var active = s.scenePreview === scene.id ? ' aria-pressed="true"' : ' aria-pressed="false"';
        return (
          '<button type="button" data-scene="' + escapeHtml(scene.id) + '"' + active + '>' +
          escapeHtml(scene.name) + ' · ' + escapeHtml(scene.code) + '</button>'
        );
      }).join('');
      return (
        '<section class="scene-group" data-scene-group="' + escapeHtml(group.id) + '" aria-label="' + escapeHtml(groupLabel) + '">' +
        '<div class="scene-group-heading"><h3>' + escapeHtml(groupLabel) + '</h3><span>' + group.scenes.length + '개</span></div>' +
        '<div class="scene-grid">' + buttons + '</div></section>'
      );
    }).join('');
    var html =
      '<div class="section-stack">' +
      '<section class="panel" aria-label="송출 상태"><div><p>미리보기: ' +
      escapeHtml(previewMsg.title) +
      '</p>' +
      '<p>송출 중: ' +
      escapeHtml(programMsg.title) +
      '</p></div></section>' +
      '<section class="panel" aria-label="송출 전 확인"><div class="section-head"><h2>송출 전 확인</h2></div>' +
      checkHtml('disclose', 0, s.disclose[0], DISCLOSE_COPY[0]) +
      checkHtml('disclose', 1, s.disclose[1], DISCLOSE_COPY[1]) +
      '</section>' +
      '<section class="panel" aria-label="송출 확인"><div class="section-head"><h2>송출 확인</h2></div>' +
      checkHtml('confirm', 0, s.confirm[0], CONFIRM_COPY[0]) +
      checkHtml('confirm', 1, s.confirm[1], CONFIRM_COPY[1]) +
      '<div><button type="button" data-take' +
      (allowed ? '' : ' disabled') +
      '>송출하기</button></div></section>' +
      '<section class="panel" aria-label="안전 화면"><div class="section-head"><h2>안전 화면</h2></div>' +
      '<div><button type="button" data-safety="BLACK">암전</button>' +
      '<button type="button" data-safety="HOLD">대기 화면</button>' +
      '<button type="button" data-safety="LOGO">로고</button></div>' +
      '<div><button type="button" data-motion aria-pressed="' +
      (ETKO.reducedMotion ? 'true' : 'false') +
      '">모션 줄이기</button></div>' +
      '<div><a href="?view=screen" target="_blank" rel="noopener">관객 화면 열기</a></div></section>' +
      (sceneGrid ? '<section class="stage-scenes panel" aria-label="장면 선택"><div class="section-head"><h2>장면 선택</h2>' +
        '<p>기능별로 분류된 시연 장면 ' + scenes.length + '개</p></div><div class="scene-groups">' + sceneGrid + '</div></section>' : '') +
      '</div>';
    container.innerHTML = html;
    try {
      syncReducedMotionDoc(container.ownerDocument || null);
    } catch (err) {}
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-disclose]'),
        function (box) {
          if (typeof box.addEventListener !== 'function') return;
          box.addEventListener('change', function () {
            var idx = box.getAttribute ? Number(box.getAttribute('data-disclose')) : -1;
            if (idx === 0 || idx === 1) s.disclose[idx] = !!box.checked;
            ETKO.renderStage(container, s);
          });
        }
      );
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-confirm]'),
        function (box) {
          if (typeof box.addEventListener !== 'function') return;
          box.addEventListener('change', function () {
            var idx = box.getAttribute ? Number(box.getAttribute('data-confirm')) : -1;
            if (idx === 0 || idx === 1) s.confirm[idx] = !!box.checked;
            ETKO.renderStage(container, s);
          });
        }
      );
      var take = container.querySelector ? container.querySelector('[data-take]') : null;
      if (take && typeof take.addEventListener === 'function') {
        take.addEventListener('click', function () {
          ETKO.applyTake(s);
          ETKO.renderStage(container, s);
        });
      }
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-scene]'),
        function (btn) {
          if (typeof btn.addEventListener !== 'function') return;
          btn.addEventListener('click', function () {
            var id = btn.getAttribute ? btn.getAttribute('data-scene') : null;
            try {
              if (typeof ETKO.setPreviewScene === 'function') ETKO.setPreviewScene(id);
              s.scenePreview = id;
            } catch (err) {}
            ETKO.renderStage(container, s);
          });
        }
      );
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-safety]'),
        function (btn) {
          if (typeof btn.addEventListener !== 'function') return;
          btn.addEventListener('click', function () {
            var next = btn.getAttribute ? btn.getAttribute('data-safety') : null;
            if (SAFETY_MESSAGES[normMode(next)]) s.preview = normMode(next);
            ETKO.renderStage(container, s);
          });
        }
      );
      var motion = container.querySelector ? container.querySelector('[data-motion]') : null;
      if (motion && typeof motion.addEventListener === 'function') {
        motion.addEventListener('click', function () {
          ETKO.setReducedMotion(!ETKO.reducedMotion);
          ETKO.renderStage(container, s);
        });
      }
    }
    return container.innerHTML;
  };

  // Audience display sync across tabs/windows.
  // announceScreen posts the live program; listenScreen re-renders a screen
  // mount on every announcement (pulling the saved snapshot first so a
  // dedicated display tab shows the control tab's data). Both degrade to
  // silent no-ops without a bus, and never throw.
  var SCREEN_CHANNEL = 'eventouch-screen-v1';

  function screenBus() {
    if (ETKO.screenBus) return ETKO.screenBus;
    try {
      if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
        ETKO.screenBus = new BroadcastChannel(SCREEN_CHANNEL);
        return ETKO.screenBus;
      }
    } catch (err) {}
    return null;
  }

  ETKO.announceScreen = function () {
    var bus = null;
    try {
      bus = screenBus();
    } catch (err) {
      bus = null;
    }
    if (!bus) return false;
    var program = 'LOGO';
    try {
      if (ETKO.stageState && typeof ETKO.stageState.program === 'string') {
        program = ETKO.stageState.program;
      }
    } catch (err) {}
    try {
      bus.postMessage({ type: 'eventouch-screen', program: program, at: new Date().toISOString() });
      return true;
    } catch (err) {
      return false;
    }
  };

  ETKO.listenScreen = function (container) {
    if (!container || container.screenListening) return !!container && !!container.screenListening;
    function refresh() {
      var keep = ETKO.currentView;
      try {
        if (typeof ETKO.savedSnapshot === 'function' && typeof ETKO.restoreStore === 'function') {
          var raw = ETKO.savedSnapshot();
          if (raw) ETKO.restoreStore(raw);
        }
      } catch (err) {}
      ETKO.currentView = keep;
      try {
        ETKO.renderScreen(container);
      } catch (err) {}
    }
    var wired = false;
    var bus = null;
    try {
      bus = screenBus();
    } catch (err) {
      bus = null;
    }
    if (bus && typeof bus.addEventListener === 'function') {
      try {
        bus.addEventListener('message', function (ev) {
          if (ev && ev.data && ev.data.type === 'eventouch-screen') refresh();
        });
        wired = true;
      } catch (err) {}
    } else if (bus && typeof bus.onmessage !== 'undefined') {
      try {
        bus.onmessage = function (ev) {
          if (ev && ev.data && ev.data.type === 'eventouch-screen') refresh();
        };
        wired = true;
      } catch (err) {}
    }
    // Storage events fire only in OTHER tabs: the exact cross-tab fallback.
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (ev) {
          if (ev && ev.key === 'eventouch-store-v1') refresh();
        });
        wired = true;
      }
    } catch (err) {}
    if (wired) {
      try {
        container.screenListening = true;
      } catch (err) {}
    }
    return wired;
  };

  // Audience projection: program scene when one is taken, otherwise the
  // legacy read-only composite (program output + selected question +
  // approved photo count). No controls, no contacts. Reads live state so
  // every render reflects the latest take/moderation/selection.
  // BLACK is a true blackout: only the notice renders, never the question
  // or photo sections.
  ETKO.renderScreen = function (container, state) {
    var s = ensureStageState(state || ETKO.stageState);
    var programMsg = ETKO.safety(s.program);
    if (s.program === 'BLACK') {
      container.innerHTML =
        '<section aria-label="현재 송출"><h2>' +
        escapeHtml(programMsg.title) +
        '</h2><p>' +
        escapeHtml(programMsg.detail) +
        '</p></section>';
      return container.innerHTML;
    }
    if (s.sceneProgram && typeof ETKO.renderSceneProgram === 'function') {
      try {
        var sceneHtml = ETKO.renderSceneProgram(container, s);
        if (sceneHtml !== null) return sceneHtml;
      } catch (err) {}
    }
    var selected = null;
    try {
      var qna = typeof ETKO.workspace === 'function' ? (ETKO.workspace().qna || []) : [];
      for (var i = 0; i < qna.length; i += 1) {
        if (qna[i] && qna[i].selected && qna[i].approved) {
          selected = qna[i];
          break;
        }
      }
    } catch (err) {
      selected = null;
    }
    var approvedPhotos = 0;
    try {
      var photos = typeof ETKO.workspace === 'function' ? (ETKO.workspace().photos || []) : [];
      approvedPhotos = photos.filter(function (p) {
        return p && p.status === 'APPROVED';
      }).length;
    } catch (err) {
      approvedPhotos = 0;
    }
    var html =
      '<section aria-label="현재 송출"><h2>' +
      escapeHtml(programMsg.title) +
      '</h2><p>' +
      escapeHtml(programMsg.detail) +
      '</p></section>' +
      '<section aria-label="선택된 질문"><h2>질문</h2><p>' +
      (selected ? escapeHtml(selected.question) : '선택된 질문이 없습니다') +
      '</p></section>' +
      '<section aria-label="공개 사진"><h2>사진</h2><p>공개 사진 ' +
      approvedPhotos +
      '장</p></section>';
    container.innerHTML = html;
    return container.innerHTML;
  };

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['applyTake']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
