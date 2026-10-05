(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Polls + quizzes (Task 5). Consumes ETKO.workspace(), which owns
  // `poll:{title,options,votes,status}` and
  // `quiz:{title,answer,answers,status}` plus `participants`.
  // Single-vote rules: one vote / one quiz answer per participant.

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function engagementWorkspace() {
    var ws = ETKO.workspace();
    if (!ws.poll || typeof ws.poll !== 'object') {
      ws.poll = { title: '', options: [], votes: [], status: 'CLOSED' };
    }
    if (!Array.isArray(ws.poll.options)) ws.poll.options = [];
    if (!Array.isArray(ws.poll.votes)) ws.poll.votes = [];
    if (ws.poll.status !== 'OPEN') ws.poll.status = 'CLOSED';
    if (!ws.quiz || typeof ws.quiz !== 'object') {
      ws.quiz = { title: '', answer: '', answers: [], status: 'CLOSED' };
    }
    if (!Array.isArray(ws.quiz.answers)) ws.quiz.answers = [];
    if (ws.quiz.status !== 'OPEN') ws.quiz.status = 'CLOSED';
    if (!Array.isArray(ws.participants)) ws.participants = [];
    // Q&A + lucky draw + survey (Task 6). Workspace owns `qna`,
    // `draw:{phase,result,history,winners}`, `survey:{questions,open}`
    // and `responses`. Slices are ensured, never replaced.
    if (!Array.isArray(ws.qna)) ws.qna = [];
    if (!ws.draw || typeof ws.draw !== 'object') {
      ws.draw = { phase: 'IDLE', result: null, history: [], winners: [] };
    }
    if (ws.draw.phase !== 'READY' && ws.draw.phase !== 'RESOLVED') {
      ws.draw.phase = 'IDLE';
    }
    if (!Array.isArray(ws.draw.history)) ws.draw.history = [];
    if (!Array.isArray(ws.draw.winners)) ws.draw.winners = [];
    if (!ws.survey || typeof ws.survey !== 'object') {
      ws.survey = { title: '', questions: [], open: false };
    }
    if (!Array.isArray(ws.survey.questions)) ws.survey.questions = [];
    if (!Array.isArray(ws.responses)) ws.responses = [];
    return ws;
  }

  function findParticipant(ws, id) {
    for (var i = 0; i < ws.participants.length; i += 1) {
      if (ws.participants[i] && ws.participants[i].id === id) return ws.participants[i];
    }
    return null;
  }

  function normStatus(value) {
    return text(value).toUpperCase();
  }

  // Open or close the poll. Returns the active status.
  ETKO.setPollStatus = function (status) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('poll');
    var next = normStatus(status);
    if (next !== 'OPEN' && next !== 'CLOSED') throw new Error('상태를 확인하세요');
    engagementWorkspace().poll.status = next;
    return next;
  };

  function pollOptionIndex(poll, option) {
    if (typeof option === 'number' && Math.floor(option) === option) {
      if (option >= 0 && option < poll.options.length) return option;
      return -1;
    }
    var label = text(option);
    for (var i = 0; i < poll.options.length; i += 1) {
      if (text(poll.options[i]) === label) return i;
    }
    return -1;
  }

  // Cast one vote. Closed throws `투표가 마감되었습니다`,
  // repeat throws `이미 투표했습니다`.
  ETKO.vote = function (participantId, option) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('poll');
    var ws = engagementWorkspace();
    var person = findParticipant(ws, participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    if (ws.poll.status !== 'OPEN') throw new Error('투표가 마감되었습니다');
    for (var i = 0; i < ws.poll.votes.length; i += 1) {
      if (ws.poll.votes[i] && ws.poll.votes[i].participantId === person.id) {
        throw new Error('이미 투표했습니다');
      }
    }
    var index = pollOptionIndex(ws.poll, option);
    if (index === -1) throw new Error('선택지를 확인하세요');
    var record = { participantId: person.id, option: index };
    ws.poll.votes.push(record);
    return { participantId: record.participantId, option: record.option };
  };

  // Tally votes per option. Returns {counts, total}; counts aligns with
  // poll.options by index.
  ETKO.pollCounts = function () {
    var ws = engagementWorkspace();
    var counts = ws.poll.options.map(function () {
      return 0;
    });
    ws.poll.votes.forEach(function (v) {
      if (v && typeof v.option === 'number' && counts[v.option] !== undefined) {
        counts[v.option] += 1;
      }
    });
    return { counts: counts, total: ws.poll.votes.length };
  };

  // Open or close the quiz. Returns the active status.
  ETKO.setQuizStatus = function (status) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('quiz');
    var next = normStatus(status);
    if (next !== 'OPEN' && next !== 'CLOSED') throw new Error('상태를 확인하세요');
    engagementWorkspace().quiz.status = next;
    return next;
  };

  // Submit one quiz answer. Closed / repeat / empty / over-200-char inputs
  // throw Korean errors.
  ETKO.answerQuiz = function (participantId, answer) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('quiz');
    var ws = engagementWorkspace();
    var person = findParticipant(ws, participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    if (ws.quiz.status !== 'OPEN') throw new Error('퀴즈가 마감되었습니다');
    for (var i = 0; i < ws.quiz.answers.length; i += 1) {
      if (ws.quiz.answers[i] && ws.quiz.answers[i].participantId === person.id) {
        throw new Error('이미 답변했습니다');
      }
    }
    var body = text(answer);
    if (!body) throw new Error('답변을 입력하세요');
    if (body.length > 200) throw new Error('답변은 200자 이내로 입력하세요');
    var record = { participantId: person.id, answer: body };
    ws.quiz.answers.push(record);
    return { participantId: record.participantId, answer: record.answer };
  };

  // Close the quiz and reveal the registered answer.
  ETKO.revealQuiz = function () {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('quiz');
    var ws = engagementWorkspace();
    ws.quiz.status = 'CLOSED';
    return text(ws.quiz.answer);
  };

  // entered mirrors features/desks.js: status 'in' in any case.
  // The draw pool MUST use this check, never a literal status equality.
  function isEntered(person) {
    return text(person && person.status).toLowerCase() === 'in';
  }

  function winnerIds(draw) {
    return draw.winners.map(function (w) {
      if (typeof w === 'string') return w;
      if (w && typeof w.participantId === 'string') return w.participantId;
      if (w && typeof w.id === 'string') return w.id;
      return null;
    });
  }

  function drawPool(ws) {
    var won = winnerIds(ws.draw);
    return ws.participants
      .filter(function (p) {
        return p && isEntered(p) && won.indexOf(p.id) === -1;
      })
      .map(function (p) {
        return p.id;
      });
  }

  function nextQnaId(ws) {
    var max = 0;
    ws.qna.forEach(function (q) {
      var m = /^q(\d+)$/.exec((q && q.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = 'q' + (max + 1);
    while (ws.qna.some(function (q) { return q && q.id === id; })) {
      max += 1;
      id = 'q' + (max + 1);
    }
    return id;
  }

  function findQna(ws, id) {
    for (var i = 0; i < ws.qna.length; i += 1) {
      if (ws.qna[i] && ws.qna[i].id === id) return ws.qna[i];
    }
    return null;
  }

  // Submit a question. Empty / over-600-char inputs throw Korean errors.
  ETKO.ask = function (participantId, question) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('qna');
    var ws = engagementWorkspace();
    var person = findParticipant(ws, participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    var body = text(question);
    if (!body) throw new Error('질문을 입력하세요');
    if (body.length > 600) throw new Error('질문은 600자 이내로 입력하세요');
    var record = {
      id: nextQnaId(ws),
      participantId: person.id,
      question: body,
      approved: false,
      selected: false,
    };
    ws.qna.push(record);
    return { id: record.id, participantId: record.participantId, question: record.question, approved: record.approved, selected: record.selected };
  };

  // Approve (or unapprove) a question for public display.
  // Unapproving a stage-selected question clears its selection.
  ETKO.approveQna = function (id, approved) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('qna');
    var ws = engagementWorkspace();
    var item = findQna(ws, id);
    if (!item) throw new Error('질문을 찾을 수 없습니다');
    item.approved = !!approved;
    if (!item.approved) item.selected = false;
    try {
      if (typeof ETKO.announceScreen === 'function') ETKO.announceScreen();
    } catch (err) {}
    return item;
  };

  // Pick one approved question for the stage. Unapproved throws
  // `공개 승인한 질문만 선택할 수 있습니다`.
  ETKO.selectQna = function (id) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('qna');
    var ws = engagementWorkspace();
    var item = findQna(ws, id);
    if (!item) throw new Error('질문을 찾을 수 없습니다');
    if (!item.approved) throw new Error('공개 승인한 질문만 선택할 수 있습니다');
    ws.qna.forEach(function (q) {
      if (q) q.selected = q.id === item.id;
    });
    try {
      if (typeof ETKO.announceScreen === 'function') ETKO.announceScreen();
    } catch (err) {}
    return item;
  };

  // Open a draw round. Pool = IN participants not yet winners;
  // empty throws `추첨 대상이 없습니다`.
  ETKO.startDraw = function () {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('draw');
    var ws = engagementWorkspace();
    var pool = drawPool(ws);
    if (pool.length === 0) throw new Error('추첨 대상이 없습니다');
    ws.draw.phase = 'READY';
    ws.draw.result = null;
    return pool;
  };

  // Resolve the round to one winner. Accepts an injectable
  // randomInt(poolSize)->index for tests; defaults to Math.random.
  ETKO.resolveDraw = function (randomInt) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('draw');
    var ws = engagementWorkspace();
    var pool = drawPool(ws);
    if (pool.length === 0) throw new Error('추첨 대상이 없습니다');
    var index;
    if (typeof randomInt === 'function') {
      index = randomInt(pool.length);
    } else if (typeof randomInt === 'number') {
      index = randomInt;
    } else {
      index = Math.floor(Math.random() * pool.length);
    }
    if (typeof index !== 'number' || isNaN(index)) throw new Error('추첨 값을 확인하세요');
    index = Math.floor(index);
    if (index < 0 || index >= pool.length) throw new Error('추첨 값을 확인하세요');
    ws.draw.phase = 'RESOLVED';
    ws.draw.result = { participantId: pool[index] };
    return { participantId: ws.draw.result.participantId };
  };

  // Confirm the resolved winner into history + winners.
  // Without a resolved result throws `확정할 당첨 결과가 없습니다`.
  ETKO.confirmDraw = function () {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('draw');
    var ws = engagementWorkspace();
    if (!ws.draw.result || !ws.draw.result.participantId) {
      throw new Error('확정할 당첨 결과가 없습니다');
    }
    var record = {
      participantId: ws.draw.result.participantId,
      at: new Date().toISOString(),
    };
    ws.draw.winners.push(record.participantId);
    ws.draw.history.push(record);
    ws.draw.result = null;
    ws.draw.phase = 'IDLE';
    return { participantId: record.participantId, at: record.at };
  };

  // Open or close the survey. Returns the active flag.
  ETKO.setSurveyOpen = function (open) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('survey');
    var ws = engagementWorkspace();
    ws.survey.open = !(open === false || open === 'false');
    return ws.survey.open;
  };

  // Submit one survey response. Length must match the question count,
  // every score an integer 1~5; repeat throws `이미 평가를 제출했습니다`.
  // Closed surveys reject with `설문이 마감되었습니다`.
  ETKO.submitSurvey = function (participantId, scores) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('survey');
    var ws = engagementWorkspace();
    if (!ws.survey.open) throw new Error('설문이 마감되었습니다');
    var person = findParticipant(ws, participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    for (var i = 0; i < ws.responses.length; i += 1) {
      if (ws.responses[i] && ws.responses[i].participantId === person.id) {
        throw new Error('이미 평가를 제출했습니다');
      }
    }
    var list = Array.isArray(scores) ? scores.slice() : null;
    if (!list || list.length !== ws.survey.questions.length) {
      throw new Error('응답 문항 수를 확인하세요');
    }
    list.forEach(function (s) {
      if (typeof s !== 'number' || Math.floor(s) !== s || s < 1 || s > 5) {
        throw new Error('평가 점수를 확인하세요');
      }
    });
    var record = { participantId: person.id, scores: list };
    ws.responses.push(record);
    return { participantId: record.participantId, scores: record.scores.slice() };
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function engagementStatus(state, label) {
    return '<span class="engagement-status" data-engagement-status="' +
      escapeHtml(state) + '">' + escapeHtml(label) + '</span>';
  }

  // Management mount renderer: poll + quiz sections with Korean copy and
  // wired controls. Q&A/draw/survey/photo sections follow below.
  ETKO.renderEngagement = function (container) {
    var ws = engagementWorkspace();
    var html = '<div class="section-stack">' + ETKO.renderEngagementPollQuiz(ws) + ETKO.renderEngagementMore(ws) + '</div>';
    if (ETKO.lastEngageError) {
      html += '<p role="alert">' + escapeHtml(ETKO.lastEngageError) + '</p>';
    }
    container.innerHTML = html;
    wireEngagement(container);
    return container.innerHTML;
  };

  ETKO.renderEngagementPollQuiz = function (wsArg) {
    var ws = wsArg || engagementWorkspace();
    var poll = ws.poll || { title: '', options: [], votes: [], status: 'CLOSED' };
    var quiz = ws.quiz || { title: '', answer: '', answers: [], status: 'CLOSED' };
    var counts = ETKO.pollCounts ? ETKO.pollCounts() : { counts: [], total: 0 };
    var options = (poll.options || []).map(function (opt, i) {
      var label = typeof opt === 'string' ? opt : opt && opt.label ? opt.label : '';
      var n = counts.counts && counts.counts[i] !== undefined ? counts.counts[i] : 0;
      return '<li class="card">' + escapeHtml(label) + ' · ' + n + '표</li>';
    }).join('');
    var pollOpen = poll.status === 'OPEN';
    var quizOpen = quiz.status === 'OPEN';
    var pollStatus = pollOpen ? '진행 중' : '마감';
    var quizStatus = quizOpen ? '진행 중' : '마감';
    return (
      '<section class="panel" aria-label="투표 관리"><div class="section-head"><h2>투표</h2></div>' +
      '<p>' + escapeHtml(poll.title || '제목 없음') + ' · ' + engagementStatus(pollOpen ? 'open' : 'closed', pollStatus) + ' · 총 ' + counts.total + '표</p>' +
      '<ul class="cards">' + (options || '<li class="card" data-empty><p role="status">선택지가 없습니다</p></li>') + '</ul>' +
      '<div class="action-group"><button type="button" data-poll-open>투표 개시</button>' +
      '<button type="button" data-poll-close>투표 마감</button></div></section>' +
      '<section class="panel" aria-label="퀴즈 관리"><div class="section-head"><h2>퀴즈</h2></div>' +
      '<p>' + escapeHtml(quiz.title || '제목 없음') + ' · ' + engagementStatus(quizOpen ? 'open' : 'closed', quizStatus) + ' · 답변 ' + (quiz.answers || []).length + '건</p>' +
      '<div class="action-group"><button type="button" data-quiz-open>퀴즈 개시</button>' +
      '<button type="button" data-quiz-reveal>정답 공개</button></div></section>'
    );
  };

  // Extended sections (Q&A/draw/survey/photo) with full markup.
  ETKO.renderEngagementMore = function (wsArg) {
    var ws = wsArg || engagementWorkspace();
    return (
      ETKO.renderEngagementQna(ws) +
      ETKO.renderEngagementDraw(ws) +
      ETKO.renderEngagementSurvey(ws) +
      ETKO.renderEngagementPhoto(ws)
    );
  };

  ETKO.renderEngagementQna = function (wsArg) {
    var ws = wsArg || engagementWorkspace();
    var rows = (ws.qna || []).map(function (q) {
      var stateKey = q.selected ? 'selected' : q.approved ? 'approved' : 'pending';
      var state = q.selected ? '무대 선택' : q.approved ? '승인됨' : '대기 중';
      return (
        '<li class="card">' + escapeHtml(q.question || '') + ' · ' + engagementStatus(stateKey, state) +
        ' <button type="button" data-qna-approve="' + escapeHtml(q.id) + '">승인</button>' +
        ' <button type="button" data-qna-stage="' + escapeHtml(q.id) + '">무대로</button></li>'
      );
    }).join('');
    return (
      '<section class="panel" aria-label="질문과 답변 관리"><div class="section-head"><h2>질문과 답변</h2></div>' +
      '<ul class="cards">' + (rows || '<li class="card" data-empty><p role="status">등록된 질문이 없습니다</p></li>') + '</ul></section>'
    );
  };

  ETKO.renderEngagementDraw = function (wsArg) {
    var ws = wsArg || engagementWorkspace();
    var draw = ws.draw || { phase: 'IDLE', result: null, winners: [] };
    var winners = (draw.winners || []).join(', ');
    var candidate = draw.result && draw.result.participantId ? draw.result.participantId : '미정';
    var drawLabels = { IDLE: '대기', READY: '추첨 준비', RESOLVED: '결과 확인' };
    var drawState = String(draw.phase || 'IDLE').toUpperCase();
    return (
      '<section class="panel" aria-label="럭키드로우 관리"><div class="section-head"><h2>럭키드로우</h2></div>' +
      '<p>' + engagementStatus(drawState.toLowerCase(), drawLabels[drawState] || '대기') +
      ' · 당첨 후보: ' + escapeHtml(candidate) + ' · 확정 ' + (draw.winners || []).length + '명' +
      (winners ? ' (' + escapeHtml(winners) + ')' : '') + '</p>' +
      '<div><button type="button" data-draw-start>추첨 시작</button>' +
      '<button type="button" data-draw-resolve>후보 확정</button>' +
      '<button type="button" data-draw-confirm>당첨 확정</button></div></section>'
    );
  };

  ETKO.renderEngagementSurvey = function (wsArg) {
    var ws = wsArg || engagementWorkspace();
    var survey = ws.survey || { title: '', questions: [], open: false };
    var responses = ws.responses || [];
    return (
      '<section class="panel" aria-label="만족도 관리"><div class="section-head"><h2>만족도 평가</h2></div>' +
      '<p>' + escapeHtml(survey.title || '제목 없음') + ' · ' + engagementStatus(survey.open ? 'open' : 'closed', survey.open ? '진행 중' : '마감') +
      ' · 문항 ' + (survey.questions || []).length + '개 · 응답 ' + responses.length + '건</p>' +
      '<div><button type="button" data-survey-toggle>' + (survey.open ? '설문 마감' : '설문 개시') + '</button></div></section>'
    );
  };

  ETKO.renderEngagementPhoto = function (wsArg) {
    var ws = wsArg || engagementWorkspace();
    var photos = ws.photos || [];
    var pending = photos.filter(function (p) {
      return p && p.status !== 'APPROVED';
    });
    var approved = photos.filter(function (p) {
      return p && p.status === 'APPROVED';
    }).length;
    var rows = pending.map(function (p) {
      return (
        '<li class="card">' + escapeHtml(p.caption || p.id) + ' <button type="button" data-photo-approve="' + escapeHtml(p.id) + '">공개</button>' +
        ' <button type="button" data-photo-hide="' + escapeHtml(p.id) + '">숨김</button></li>'
      );
    }).join('');
    return (
      '<section class="panel" aria-label="사진 검토"><div class="section-head"><h2>사진 검토</h2></div>' +
      '<p>공개 ' + approved + '장 · ' + engagementStatus(pending.length ? 'pending' : 'clear', pending.length ? '검토 대기 ' + pending.length + '장' : '검토 대기 없음') + '</p>' +
      '<ul class="cards">' + (rows || '<li class="card" data-empty><p role="status">검토할 사진이 없습니다</p></li>') + '</ul></section>'
    );
  };

  ETKO.wireEngagementMore = function (container, onAttr) {
    onAttr('data-qna-approve', function (btn) {
      var id = btn.getAttribute('data-qna-approve');
      ETKO.approveQna(id, true);
    });
    onAttr('data-qna-stage', function (btn) {
      var id = btn.getAttribute('data-qna-stage');
      ETKO.selectQna(id);
    });
    onAttr('data-draw-start', function () {
      ETKO.startDraw();
    });
    onAttr('data-draw-resolve', function () {
      ETKO.resolveDraw();
    });
    onAttr('data-draw-confirm', function () {
      ETKO.confirmDraw();
    });
    onAttr('data-survey-toggle', function () {
      var ws = engagementWorkspace();
      ETKO.setSurveyOpen(!ws.survey.open);
    });
    onAttr('data-photo-approve', function (btn) {
      if (typeof ETKO.moderatePhotos !== 'function') throw new Error('사진 기능을 확인할 수 없습니다');
      ETKO.moderatePhotos([btn.getAttribute('data-photo-approve')], 'APPROVED');
    });
    onAttr('data-photo-hide', function (btn) {
      if (typeof ETKO.moderatePhotos !== 'function') throw new Error('사진 기능을 확인할 수 없습니다');
      ETKO.moderatePhotos([btn.getAttribute('data-photo-hide')], 'HIDDEN');
    });
  };

  function rerender(node) {
    var mount = node;
    while (mount && !(mount.setAttribute && mount.getAttribute && mount.getAttribute('id') === 'engage-mount')) {
      mount = mount.parentNode;
    }
    if (mount && typeof ETKO.renderEngagement === 'function') {
      try {
        ETKO.renderEngagement(mount);
      } catch (err) {}
    }
  }

  function wireEngagement(container) {
    if (!container || !container.querySelectorAll) return;
    function onAttr(attr, fn) {
      Array.prototype.forEach.call(container.querySelectorAll('[' + attr + ']'), function (btn) {
        if (typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', function () {
          ETKO.lastEngageError = null;
          try {
            fn(btn);
          } catch (err) {
            ETKO.lastEngageError = err && err.message ? err.message : '처리하지 못했습니다';
          }
          rerender(container);
        });
      });
    }
    onAttr('data-poll-open', function () {
      ETKO.setPollStatus('OPEN');
    });
    onAttr('data-poll-close', function () {
      ETKO.setPollStatus('CLOSED');
    });
    onAttr('data-quiz-open', function () {
      ETKO.setQuizStatus('OPEN');
    });
    onAttr('data-quiz-reveal', function () {
      ETKO.revealQuiz();
    });
    if (typeof ETKO.wireEngagementMore === 'function') {
      try {
        ETKO.wireEngagementMore(container, onAttr, rerender);
      } catch (err) {}
    }
  }

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['setPollStatus', 'vote', 'setQuizStatus', 'answerQuiz', 'revealQuiz', 'ask', 'approveQna', 'selectQna', 'startDraw', 'resolveDraw', 'confirmDraw', 'setSurveyOpen', 'submitSurvey']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
