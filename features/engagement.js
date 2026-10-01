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

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
