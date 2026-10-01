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
    var next = normStatus(status);
    if (next !== 'OPEN' && next !== 'CLOSED') throw new Error('상태를 확인하세요');
    engagementWorkspace().quiz.status = next;
    return next;
  };

  // Submit one quiz answer. Closed / repeat / empty / over-200-char inputs
  // throw Korean errors.
  ETKO.answerQuiz = function (participantId, answer) {
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
    var ws = engagementWorkspace();
    var item = findQna(ws, id);
    if (!item) throw new Error('질문을 찾을 수 없습니다');
    item.approved = !!approved;
    if (!item.approved) item.selected = false;
    return item;
  };

  // Pick one approved question for the stage. Unapproved throws
  // `공개 승인한 질문만 선택할 수 있습니다`.
  ETKO.selectQna = function (id) {
    var ws = engagementWorkspace();
    var item = findQna(ws, id);
    if (!item) throw new Error('질문을 찾을 수 없습니다');
    if (!item.approved) throw new Error('공개 승인한 질문만 선택할 수 있습니다');
    ws.qna.forEach(function (q) {
      if (q) q.selected = q.id === item.id;
    });
    return item;
  };

  // Open a draw round. Pool = IN participants not yet winners;
  // empty throws `추첨 대상이 없습니다`.
  ETKO.startDraw = function () {
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

  // Submit one survey response. Length must match the question count,
  // every score an integer 1~5; repeat throws `이미 평가를 제출했습니다`.
  // Closed surveys reject with `설문이 마감되었습니다`.
  ETKO.submitSurvey = function (participantId, scores) {
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

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
