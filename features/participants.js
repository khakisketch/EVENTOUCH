(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Empty-result copy must stay Korean.
  ETKO.PEOPLE_EMPTY = '검색 결과가 없습니다';

  function norm(value) {
    return String(value === undefined || value === null ? '' : value)
      .trim()
      .toLowerCase();
  }

  function defaultPeople() {
    if (ETKO.sample && Array.isArray(ETKO.sample.participants)) {
      return ETKO.sample.participants;
    }
    return [];
  }

  // Filter directory by free text (name/email/code), ticket and status.
  // Status + ticket compare case-insensitively: sample.json mixes
  // lowercase "registered" with uppercase "IN".
  ETKO.filterPeople = function (filters, people) {
    var list = Array.isArray(people) ? people : defaultPeople();
    var opts = filters || {};
    var q = norm(opts.q);
    var ticket = norm(opts.ticket);
    var status = norm(opts.status);
    return list.filter(function (p) {
      if (q) {
        var hay = norm(p.name) + ' ' + norm(p.email) + ' ' + norm(p.code);
        if (hay.indexOf(q) === -1) return false;
      }
      if (ticket && norm(p.ticket) !== ticket) return false;
      if (status && norm(p.status) !== status) return false;
      return true;
    });
  };

  // Selection set lives on the namespace so re-renders never reset it.
  if (!(ETKO.selectedIds instanceof Set)) {
    ETKO.selectedIds = new Set();
  }

  ETKO.toggleSelect = function (id) {
    if (ETKO.selectedIds.has(id)) {
      ETKO.selectedIds.delete(id);
    } else {
      ETKO.selectedIds.add(id);
    }
    return ETKO.selectedIds;
  };

  ETKO.clearSelection = function () {
    ETKO.selectedIds.clear();
    return ETKO.selectedIds;
  };

  ETKO.peopleCounts = function (people) {
    var list = Array.isArray(people) ? people : defaultPeople();
    var entered = 0;
    list.forEach(function (p) {
      if (norm(p.status) === 'in') entered += 1;
    });
    return { total: list.length, in: entered, registered: list.length - entered };
  };

  // Mark every selected participant IN. Returns the marked count.
  ETKO.bulkCheckIn = function (people) {
    var list = Array.isArray(people) ? people : defaultPeople();
    var marked = 0;
    list.forEach(function (p) {
      if (!ETKO.selectedIds.has(p.id)) return;
      if (norm(p.status) === 'in') return;
      p.status = 'IN';
      marked += 1;
    });
    return marked;
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function rowHtml(p) {
    var checked = ETKO.selectedIds.has(p.id) ? ' checked' : '';
    return (
      '<tr><td><input type="checkbox" data-select="' +
      escapeHtml(p.id) +
      '"' +
      checked +
      ' aria-label="' +
      escapeHtml(p.name) +
      ' 선택"></td><td>' +
      escapeHtml(p.name) +
      '</td><td>' +
      escapeHtml(p.email) +
      '</td><td>' +
      escapeHtml(p.ticket) +
      '</td><td>' +
      escapeHtml(p.status) +
      '</td><td>' +
      escapeHtml(p.code) +
      '</td></tr>'
    );
  }

  function cardHtml(p) {
    var checked = ETKO.selectedIds.has(p.id) ? ' checked' : '';
    return (
      '<li class="card"><label><input type="checkbox" data-select="' +
      escapeHtml(p.id) +
      '"' +
      checked +
      '> ' +
      escapeHtml(p.name) +
      '</label><p>' +
      escapeHtml(p.email) +
      ' · ' +
      escapeHtml(p.ticket) +
      ' · ' +
      escapeHtml(p.status) +
      ' · ' +
      escapeHtml(p.code) +
      '</p></li>'
    );
  }

  // Render table + mobile cards. Reads (never resets) ETKO.selectedIds.
  ETKO.renderPeople = function (container, people) {
    var list = Array.isArray(people) ? people : defaultPeople();
    var counts = ETKO.peopleCounts(list);
    var html =
      '<p>전체 ' +
      counts.total +
      '명 · 입장 ' +
      counts.in +
      '명</p>';
    if (list.length === 0) {
      html += '<p>' + escapeHtml(ETKO.PEOPLE_EMPTY) + '</p>';
    } else {
      html +=
        '<div class="table-wrap"><table><thead><tr><th scope="col">선택</th>' +
        '<th scope="col">이름</th><th scope="col">이메일</th>' +
        '<th scope="col">권종</th><th scope="col">상태</th>' +
        '<th scope="col">코드</th></tr></thead><tbody>' +
        list.map(rowHtml).join('') +
        '</tbody></table></div>';
      html +=
        '<ul class="cards">' + list.map(cardHtml).join('') + '</ul>';
      html += '<button type="button" data-bulk-in>선택 입장 처리</button>';
    }
    container.innerHTML = html;
    if (container.querySelectorAll) {
      Array.prototype.forEach.call(
        container.querySelectorAll('[data-select]'),
        function (box) {
          if (typeof box.addEventListener !== 'function') return;
          box.addEventListener('change', function () {
            var id = box.getAttribute
              ? box.getAttribute('data-select')
              : box.id;
            ETKO.toggleSelect(id);
          });
        }
      );
      var bulk = container.querySelector
        ? container.querySelector('[data-bulk-in]')
        : null;
      if (bulk && typeof bulk.addEventListener === 'function') {
        bulk.addEventListener('click', function () {
          ETKO.bulkCheckIn(list);
          ETKO.renderPeople(container, list);
        });
      }
    }
    return container.innerHTML;
  };

  // Gate the directory section behind ETKO.navigate: show it on the
  // `participants` view, hide it everywhere else. Returns true when active.
  // No-ops (false) when the section is absent, e.g. Node without a document.
  ETKO.syncParticipantsView = function (overrideDoc, people) {
    var doc = overrideDoc;
    if (!doc && typeof document !== 'undefined' && document) doc = document;
    if (!doc || typeof doc.querySelector !== 'function') return false;
    var section = doc.querySelector('#participants-view');
    if (!section) return false;
    var active = ETKO.currentView === 'participants';
    if (typeof section.setAttribute === 'function' && typeof section.removeAttribute === 'function') {
      if (active) {
        section.removeAttribute('hidden');
      } else {
        section.setAttribute('hidden', '');
      }
    } else {
      section.hidden = !active;
    }
    if (active) {
      var mount =
        typeof section.querySelector === 'function'
          ? section.querySelector('#people-list')
          : null;
      if (mount) ETKO.renderPeople(mount, Array.isArray(people) ? people : defaultPeople());
    }
    return active;
  };

  // Consume ETKO.navigate (Task 3 interface): re-sync the directory section
  // after every view switch. Call-through preserves app.js semantics exactly
  // (unknown views keep the current view); guarded so double-load never re-wraps.
  if (typeof ETKO.navigate === 'function' && !ETKO.participantsNavHooked) {
    ETKO.participantsNavHooked = true;
    var baseNavigate = ETKO.navigate;
    ETKO.navigate = function (view) {
      var result = baseNavigate(view);
      try {
        ETKO.syncParticipantsView(null);
      } catch (err) {}
      return result;
    };
  }

  // Browser only: apply the initial gate once the DOM is ready.
  if (
    typeof document !== 'undefined' &&
    document &&
    typeof document.addEventListener === 'function'
  ) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        ETKO.syncParticipantsView(document);
      });
    } else {
      try {
        ETKO.syncParticipantsView(document);
      } catch (err) {}
    }
  }

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
