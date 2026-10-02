(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

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
    return ETKO.reducedMotion;
  };

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
  // TAKE gated on all four checks, safety outputs, reduced-motion toggle.
  // Korean copy only. Wires controls when the container supports queries.
  ETKO.renderStage = function (container, state) {
    var s = ensureStageState(state);
    var allowed = ETKO.canTake({ disclose: s.disclose, confirm: s.confirm });
    var previewMsg = ETKO.safety(s.preview);
    var programMsg = ETKO.safety(s.program);
    var html =
      '<div><p>미리보기: ' +
      escapeHtml(previewMsg.title) +
      '</p>' +
      '<p>송출 중: ' +
      escapeHtml(programMsg.title) +
      '</p></div>' +
      '<div><p>송출 전 확인</p>' +
      checkHtml('disclose', 0, s.disclose[0], DISCLOSE_COPY[0]) +
      checkHtml('disclose', 1, s.disclose[1], DISCLOSE_COPY[1]) +
      '</div>' +
      '<div><p>송출 확인</p>' +
      checkHtml('confirm', 0, s.confirm[0], CONFIRM_COPY[0]) +
      checkHtml('confirm', 1, s.confirm[1], CONFIRM_COPY[1]) +
      '</div>' +
      '<div><button type="button" data-take' +
      (allowed ? '' : ' disabled') +
      '>송출하기</button></div>' +
      '<div><p>안전 화면</p>' +
      '<button type="button" data-safety="BLACK">암전</button>' +
      '<button type="button" data-safety="HOLD">대기 화면</button>' +
      '<button type="button" data-safety="LOGO">로고</button></div>' +
      '<div><button type="button" data-motion aria-pressed="' +
      (ETKO.reducedMotion ? 'true' : 'false') +
      '">모션 줄이기</button></div>';
    container.innerHTML = html;
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

  // Audience projection: read-only program output + selected question +
  // approved photo count. No controls, no contacts. Reads live state so
  // every render reflects the latest take/moderation/selection.
  ETKO.renderScreen = function (container, state) {
    var s = ensureStageState(state || ETKO.stageState);
    var programMsg = ETKO.safety(s.program);
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

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
