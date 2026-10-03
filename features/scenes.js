(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // ---- scene library (output scenes, v7 inventory without GPU effects) ----
  // 28 scenes in six groups. Effects (orbit/cubes/burst) are informational
  // here: every scene renders static, readable content from live workspace
  // data and honors reduced motion by construction (no animation at all).
  var SCENES = [
    ['brand-idle', '브랜드 대기', 'CORE', 'ST-01'],
    ['event-opening', '이벤트 오프닝', 'CORE', 'ST-02'],
    ['countdown', '시작 카운트다운', 'CORE', 'ST-03'],
    ['now-playing', '진행 프로그램', 'CORE', 'ST-04'],
    ['announcement', '현장 공지', 'CORE', 'ST-05'],
    ['intermission', '인터미션', 'CORE', 'ST-06'],
    ['poll-intro', '투표 인트로', 'POLL', 'ST-07'],
    ['poll-question', '질문 공개', 'POLL', 'ST-08'],
    ['poll-waiting', '응답 수집', 'POLL', 'ST-09'],
    ['poll-result', '실시간 결과', 'POLL', 'ST-10'],
    ['poll-final', '최종 투표 결과', 'POLL', 'ST-11'],
    ['quiz-intro', '퀴즈 인트로', 'QUIZ', 'ST-12'],
    ['quiz-question', '퀴즈 문제', 'QUIZ', 'ST-13'],
    ['quiz-countdown', '퀴즈 타이머', 'QUIZ', 'ST-14'],
    ['quiz-answer', '정답 공개', 'QUIZ', 'ST-15'],
    ['quiz-ranking', '정답자 목록', 'QUIZ', 'ST-16'],
    ['qna-waiting', '질문 수집', 'QNA', 'ST-17'],
    ['qna-selected', '선택한 질문', 'QNA', 'ST-18'],
    ['qna-wall', '승인 질문 월', 'QNA', 'ST-19'],
    ['draw-intro', '럭키드로우 인트로', 'DRAW', 'ST-20'],
    ['draw-rolling', '추첨 진행', 'DRAW', 'ST-21'],
    ['draw-suspense', '결과 공개 대기', 'DRAW', 'ST-22'],
    ['draw-winner', '당첨자 공개', 'DRAW', 'ST-23'],
    ['draw-winners', '당첨자 모아보기', 'DRAW', 'ST-24'],
    ['photo-grid', '포토 그리드', 'PHOTO', 'ST-25'],
    ['photo-stream', '포토 스트림', 'PHOTO', 'ST-26'],
    ['photo-spotlight', '한 장의 순간', 'PHOTO', 'ST-27'],
    ['photo-mosaic', '모먼트 모자이크', 'PHOTO', 'ST-28'],
  ].map(function (row) {
    return { id: row[0], name: row[1], group: row[2], code: row[3] };
  });

  ETKO.SCENES = SCENES.map(function (s) {
    return { id: s.id, name: s.name, group: s.group, code: s.code };
  });

  ETKO.sceneById = function (id) {
    var key = String(id === undefined || id === null ? '' : id).trim();
    for (var i = 0; i < SCENES.length; i += 1) {
      if (SCENES[i].id === key) return { id: SCENES[i].id, name: SCENES[i].name, group: SCENES[i].group, code: SCENES[i].code };
    }
    return null;
  };

  function ensureSceneState() {
    if (!ETKO.stageState || typeof ETKO.stageState !== 'object') ETKO.stageState = {};
    return ETKO.stageState;
  }

  // Point the preview at a library scene. Unknown ids throw Korean.
  ETKO.setPreviewScene = function (id) {
    var entry = ETKO.sceneById(id);
    if (!entry) throw new Error('장면을 확인하세요');
    ensureSceneState().scenePreview = entry.id;
    return entry.id;
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeWorkspace() {
    try {
      if (typeof ETKO.workspace === 'function') return ETKO.workspace();
    } catch (err) {}
    return null;
  }

  function activeEvent() {
    try {
      var events = (ETKO.store && ETKO.store.events) || [];
      for (var i = 0; i < events.length; i += 1) {
        if (events[i] && events[i].id === ETKO.store.activeEventId) return events[i];
      }
    } catch (err) {}
    return null;
  }

  function personName(ws, id) {
    var people = (ws && ws.participants) || [];
    for (var i = 0; i < people.length; i += 1) {
      if (people[i] && people[i].id === id) return people[i].name || id;
    }
    return id;
  }

  function feed() {
    try {
      if (typeof ETKO.homeNow === 'function') return ETKO.homeNow() || {};
    } catch (err) {}
    return {};
  }

  function programRow(row) {
    if (!row) return null;
    return escapeHtml(row.time || '') + ' ' + escapeHtml(row.title || '') + ' · ' + escapeHtml(row.location || '');
  }

  function coreHtml(id, ws, ev) {
    var name = ev && ev.name ? ev.name : '행사';
    var meta = ev ? escapeHtml([ev.date, ev.venue].filter(Boolean).join(' · ')) : '';
    var f = feed();
    var next = programRow(f.next) || programRow(((ws && ws.program) || [])[0]);
    switch (id) {
      case 'event-opening':
        return '<h2>' + escapeHtml(name) + '</h2><p>' + meta + '</p><p>행사를 시작합니다</p>';
      case 'countdown':
        return '<h2>곧 시작합니다</h2>' + (next ? '<p>다음: ' + next + '</p>' : '');
      case 'now-playing': {
        var now = programRow(f.now);
        return '<h2>' + (now || '준비 중입니다') + '</h2>' + (next && next !== now ? '<p>다음: ' + next + '</p>' : '');
      }
      case 'announcement': {
        var notices = (ws && ws.notices) || [];
        var last = notices[notices.length - 1];
        if (!last) return '<h2>공지사항</h2><p>등록된 공지가 없습니다</p>';
        return '<h2>' + escapeHtml(last.title || '공지사항') + '</h2><p>' + escapeHtml(last.body || '') + '</p>';
      }
      case 'intermission':
        return '<h2>인터미션</h2>' + (next ? '<p>다음: ' + next + '</p>' : '<p>잠시 후 이어집니다</p>');
      default:
        return '<h2>' + escapeHtml(name) + '</h2><p>' + meta + '</p><p>함께 시작합니다</p>';
    }
  }

  function pollData(ws) {
    var poll = (ws && ws.poll) || { title: '', options: [], votes: [], status: 'CLOSED' };
    var counts = { counts: [], total: 0 };
    try {
      if (typeof ETKO.pollCounts === 'function') counts = ETKO.pollCounts();
    } catch (err) {}
    return { poll: poll, counts: counts };
  }

  function barsHtml(options, counts) {
    var total = counts.total || 0;
    return '<ul>' + options.map(function (opt, i) {
      var n = counts.counts[i] || 0;
      var pct = total > 0 ? Math.round((n / total) * 100) : 0;
      return (
        '<li>' + escapeHtml(opt) + ' · ' + n + '표' +
        '<div aria-hidden="true" style="background:#eee"><div style="width:' + pct + '%;height:8px;background:#F35B2C"></div></div></li>'
      );
    }).join('') + '</ul>';
  }

  function pollHtml(id, ws) {
    var data = pollData(ws);
    var poll = data.poll;
    var title = escapeHtml(poll.title || '제목 없음');
    switch (id) {
      case 'poll-result':
      case 'poll-final':
        return '<h2>' + title + '</h2>' + barsHtml(poll.options || [], data.counts) + '<p>총 ' + data.counts.total + '표</p>';
      default: {
        var opts = '<ul>' + (poll.options || []).map(function (o) { return '<li>' + escapeHtml(o) + '</li>'; }).join('') + '</ul>';
        return '<h2>' + title + '</h2>' + opts + '<p>' + (poll.status === 'OPEN' ? '응답 수집 중' : '마감') + '</p>';
      }
    }
  }

  function quizHtml(id, ws) {
    var quiz = (ws && ws.quiz) || { title: '', answer: '', answers: [], status: 'CLOSED' };
    var revealed = quiz.status !== 'OPEN';
    var answers = quiz.answers || [];
    switch (id) {
      case 'quiz-answer':
        return '<h2>' + escapeHtml(quiz.title || '퀴즈') + '</h2>' +
          (revealed && quiz.answer ? '<p>정답: ' + escapeHtml(quiz.answer) + '</p>' : '<p>정답은 잠시 후 공개됩니다</p>');
      case 'quiz-ranking': {
        if (!revealed) return '<h2>' + escapeHtml(quiz.title || '퀴즈') + '</h2><p>답변 ' + answers.length + '건 집계 중</p>';
        var correct = answers.filter(function (a) {
          return a && String(a.answer || '').trim() === String(quiz.answer || '').trim();
        });
        var rows = correct.map(function (a) { return '<li>' + escapeHtml(personName(ws, a.participantId)) + '</li>'; }).join('');
        return '<h2>정답자 ' + correct.length + '명</h2><ul>' + (rows || '<li>정답자가 없습니다</li>') + '</ul>';
      }
      case 'quiz-countdown':
        return '<h2>' + escapeHtml(quiz.title || '퀴즈') + '</h2><p>답변 ' + answers.length + '건</p><p>시간을 확인하세요</p>';
      default:
        return '<h2>' + escapeHtml(quiz.title || '퀴즈') + '</h2><p>답변 ' + answers.length + '건</p>';
    }
  }

  function qnaHtml(id, ws) {
    var qna = (ws && ws.qna) || [];
    var approved = qna.filter(function (q) { return q && q.approved; });
    var selected = null;
    for (var i = 0; i < approved.length; i += 1) {
      if (approved[i].selected) {
        selected = approved[i];
        break;
      }
    }
    switch (id) {
      case 'qna-selected':
        return '<h2>질문</h2><p>' + (selected ? escapeHtml(selected.question) : '선택된 질문이 없습니다') + '</p>';
      case 'qna-wall': {
        var rows = approved.map(function (q) { return '<li>' + escapeHtml(q.question) + '</li>'; }).join('');
        return '<h2>질문 ' + approved.length + '건</h2><ul>' + (rows || '<li>승인된 질문이 없습니다</li>') + '</ul>';
      }
      default:
        return '<h2>질문 수집 중</h2><p>질문 ' + qna.length + '건 접수</p>';
    }
  }

  function drawHtml(id, ws) {
    var draw = (ws && ws.draw) || { phase: 'IDLE', result: null, history: [], winners: [] };
    var winners = draw.winners || [];
    switch (id) {
      case 'draw-rolling':
        return '<h2>추첨 진행 중</h2><p>결과는 별도로 결정됩니다</p>';
      case 'draw-suspense':
        return '<h2>결과 공개 대기</h2><p>잠시 후 공개됩니다</p>';
      case 'draw-winner': {
        var rid = draw.result && draw.result.participantId;
        return '<h2>당첨자 공개</h2><p>' + (rid ? escapeHtml(personName(ws, rid)) : '결과를 기다립니다') + '</p>';
      }
      case 'draw-winners': {
        var rows = winners.map(function (w) {
          var pid = w && (w.participantId || w);
          return '<li>' + escapeHtml(typeof pid === 'string' && w.name ? w.name : personName(ws, pid)) + '</li>';
        }).join('');
        return '<h2>당첨자 ' + winners.length + '명</h2><ul>' + (rows || '<li>아직 확정된 당첨자가 없습니다</li>') + '</ul>';
      }
      default: {
        var entered = ((ws && ws.participants) || []).filter(function (p) {
          return p && !p.cancelled && String(p.status || '').toLowerCase() === 'in';
        }).length;
        return '<h2>럭키드로우</h2><p>입장 ' + entered + '명 대상</p>';
      }
    }
  }

  function photoHtml(id, ws) {
    var photos = ((ws && ws.photos) || []).filter(function (p) { return p && p.status === 'APPROVED'; });
    function img(p) {
      return '<figure><img src="' + escapeHtml(p.data || '') + '" alt="' + escapeHtml(p.caption || '현장 사진') + '" />' +
        (p.caption ? '<figcaption>' + escapeHtml(p.caption) + '</figcaption>' : '') + '</figure>';
    }
    if (photos.length === 0) return '<h2>사진</h2><p>공개 사진이 없습니다</p>';
    switch (id) {
      case 'photo-spotlight':
        return '<h2>한 장의 순간</h2>' + img(photos[0]);
      default:
        return '<h2>공개 사진 ' + photos.length + '장</h2><div>' + photos.map(img).join('') + '</div>';
    }
  }

  // Render one program scene into a section. Unknown ids return null so
  // the caller keeps its legacy composite.
  ETKO.sceneHtml = function (id) {
    var entry = ETKO.sceneById(id);
    if (!entry) return null;
    var ws = safeWorkspace();
    var ev = activeEvent();
    var body = '';
    try {
      switch (entry.group) {
        case 'POLL':
          body = pollHtml(entry.id, ws);
          break;
        case 'QUIZ':
          body = quizHtml(entry.id, ws);
          break;
        case 'QNA':
          body = qnaHtml(entry.id, ws);
          break;
        case 'DRAW':
          body = drawHtml(entry.id, ws);
          break;
        case 'PHOTO':
          body = photoHtml(entry.id, ws);
          break;
        default:
          body = coreHtml(entry.id, ws, ev);
          break;
      }
    } catch (err) {
      body = '<p>장면을 표시하지 못했습니다</p>';
    }
    return (
      '<section aria-label="현재 송출"><p>' + escapeHtml(entry.name) + ' · ' + escapeHtml(entry.code) + '</p>' + body + '</section>'
    );
  };

  // Program-scene mount for the audience display. Returns the innerHTML.
  ETKO.renderSceneProgram = function (container, state) {
    var s = state || {};
    var html = ETKO.sceneHtml(s.sceneProgram);
    if (html === null) return null;
    container.innerHTML = html;
    return container.innerHTML;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
