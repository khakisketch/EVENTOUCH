'use strict';

const crypto = require('node:crypto');

const COMMANDS = new Set([
  'module.save',
  'module.status',
  'module.reveal',
  'response.submit',
  'question.submit',
  'question.manage',
  'question.like',
  'photo.submit',
  'photo.moderate',
  'post.submit',
  'post.moderate',
  'draw.run',
  'draw.publish',
  'display.set',
]);

const MODULE_TYPES = new Set(['poll', 'quiz', 'qa', 'draw', 'survey', 'photo', 'board']);
const RESPONSE_TYPES = new Set(['poll', 'quiz', 'survey']);
const ATTENDEE_CONTENT_STAGES = new Set(['READY', 'LIVE', 'ENDED']);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function requireText(ctx, value, label, max, field) {
  const text = ctx.clean(value, max);
  if (!text) throw ctx.fail(400, `${label}을(를) 입력하세요`, field);
  return text;
}

function featureEnabled(ctx, feature) {
  if (!list(ctx.event.features).includes(feature)) throw ctx.fail(409, '행사 설정에서 이 기능을 먼저 켜세요');
}

function ensureAttendeeCanSubmit(ctx) {
  const stage = String(ctx.event.stage || '').toUpperCase();
  if (!ATTENDEE_CONTENT_STAGES.has(stage)) throw ctx.fail(409, '현재 참여 프로그램을 이용할 수 없습니다');
  const person = ctx.participant;
  if (!person || String(person.status).toUpperCase() !== 'APPROVED') {
    throw ctx.fail(403, '참가 확정 후 참여할 수 있습니다');
  }
}

function findModule(ctx, id) {
  const module = list(ctx.workspace.modules).find((item) => item && item.id === ctx.clean(id, 120));
  if (!module) throw ctx.fail(404, '참여 프로그램을 찾을 수 없습니다');
  return module;
}

function requireModule(ctx, id, type, { status = 'OPEN' } = {}) {
  const module = findModule(ctx, id);
  if (module.type !== type) throw ctx.fail(400, '참여 프로그램 종류를 확인하세요');
  featureEnabled(ctx, type);
  if (module.published !== true || (status && module.status !== status)) {
    throw ctx.fail(409, '현재 참여할 수 있는 프로그램이 아닙니다');
  }
  return module;
}

function saveModule(ctx, input) {
  const type = ctx.clean(input.type, 24).toLowerCase();
  if (!MODULE_TYPES.has(type)) throw ctx.fail(400, '프로그램 형식을 선택하세요', 'type');
  featureEnabled(ctx, type);
  const id = ctx.clean(input.id || ctx.makeId('module'), 120);
  const old = list(ctx.workspace.modules).find((item) => item && item.id === id);
  if (old && list(ctx.workspace.responses).some((response) => response.moduleId === id)) {
    throw ctx.fail(409, '응답이 있어 문제를 수정할 수 없습니다. 새 프로그램을 만드세요');
  }
  const title = requireText(ctx, input.title, '제목', 100, 'title');
  const options = (Array.isArray(input.options) ? input.options : String(input.options || '').split(/\r?\n/))
    .map((value) => ctx.clean(value, 200))
    .filter(Boolean);
  if (new Set(options).size !== options.length) throw ctx.fail(400, '선택지에 중복된 항목이 있습니다', 'options');
  if (type === 'poll' && options.length < 2) throw ctx.fail(400, '투표 선택지는 두 개 이상 입력하세요', 'options');
  const answer = ctx.clean(input.answer, 500);
  if (type === 'quiz' && !answer) throw ctx.fail(400, '퀴즈 정답을 입력하세요', 'answer');
  const questionsValue = Array.isArray(input.questions)
    ? input.questions
    : String(input.questions || '전반적인 만족도\n프로그램 구성\n현장 운영\n행사장 편의성\n재참석 의향').split(/\r?\n/);
  const questions = questionsValue.map((value) => ctx.clean(value, 200)).filter(Boolean);
  if (type === 'survey' && (!questions.length || new Set(questions).size !== questions.length)) {
    throw ctx.fail(400, '설문 항목을 확인하세요', 'questions');
  }
  const module = {
    id,
    type,
    title,
    status: old ? old.status : 'DRAFT',
    options,
    answer,
    questions,
    published: old ? old.published === true : false,
    revealed: old ? old.revealed === true : false,
  };
  if (old) Object.assign(old, module);
  else ctx.workspace.modules.push(module);
  return { status: old ? 200 : 201, body: { module } };
}

function updateModuleStatus(ctx, input) {
  const module = findModule(ctx, input.id);
  const status = ctx.clean(input.status, 16).toUpperCase();
  if (!['DRAFT', 'OPEN', 'CLOSED'].includes(status)) throw ctx.fail(400, '프로그램 상태를 선택하세요', 'status');
  featureEnabled(ctx, module.type);
  module.status = status;
  module.published = status !== 'DRAFT';
  return { body: { module } };
}

function revealQuiz(ctx, input) {
  const module = findModule(ctx, input.id);
  if (module.type !== 'quiz' || module.published !== true || !['OPEN', 'CLOSED'].includes(module.status)) {
    throw ctx.fail(404, '공개된 퀴즈를 선택하세요');
  }
  featureEnabled(ctx, 'quiz');
  module.status = 'CLOSED';
  module.revealed = true;
  return { body: { moduleId: module.id, revealed: true } };
}

function submitResponse(ctx, input) {
  ensureAttendeeCanSubmit(ctx);
  const moduleId = ctx.clean(input.moduleId, 120);
  const module = findModule(ctx, moduleId);
  if (!RESPONSE_TYPES.has(module.type)) throw ctx.fail(400, '응답할 참여 프로그램을 확인하세요');
  requireModule(ctx, moduleId, module.type);
  if (list(ctx.workspace.responses).some((response) =>
    response.moduleId === module.id && response.participantId === ctx.participant.id
  )) throw ctx.fail(409, '이미 제출했습니다');

  let answer = input.answer;
  let ratings;
  if (module.type === 'poll') {
    answer = ctx.clean(answer, 200);
    if (!module.options.includes(answer)) throw ctx.fail(400, '투표 항목을 선택하세요', 'answer');
  } else if (module.type === 'quiz') {
    answer = requireText(ctx, answer, '답변', 200, 'answer');
  } else {
    ratings = objectRatings(input.ratings);
    const questions = list(module.questions);
    if (!questions.length || questions.some((question) => {
      const value = Number(ratings[question]);
      return !Number.isInteger(value) || value < 1 || value > 5;
    }) || Object.keys(ratings).some((question) => !questions.includes(question))) {
      throw ctx.fail(400, '모든 만족도 항목을 1~5점으로 선택하세요', 'ratings');
    }
    answer = 'SUBMITTED';
  }
  const response = {
    id: ctx.commandId,
    moduleId: module.id,
    participantId: ctx.participant.id,
    answer,
    ...(ratings ? { ratings } : {}),
    comment: ctx.clean(input.comment, 1000),
    at: ctx.now,
  };
  ctx.workspace.responses.push(response);
  return { status: 201, body: { response: { ...response } } };
}

function objectRatings(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function submitQuestion(ctx, input) {
  ensureAttendeeCanSubmit(ctx);
  const module = requireModule(ctx, input.moduleId, 'qa');
  const question = {
    id: ctx.commandId,
    moduleId: module.id,
    participantId: ctx.participant.id,
    name: String(ctx.participant.name || ''),
    text: requireText(ctx, input.text, '질문', 500, 'text'),
    answer: '',
    approved: false,
    likes: [],
    at: ctx.now,
  };
  ctx.workspace.questions.unshift(question);
  return { status: 201, body: { question: { ...question } } };
}

function manageQuestion(ctx, input) {
  const question = list(ctx.workspace.questions).find((item) => item.id === ctx.clean(input.id, 120));
  if (!question) throw ctx.fail(404, '질문을 찾을 수 없습니다');
  const module = findModule(ctx, question.moduleId);
  featureEnabled(ctx, 'qa');
  if (module.type !== 'qa') throw ctx.fail(409, 'Q&A 프로그램과 연결된 질문이 아닙니다');
  const answer = ctx.clean(input.answer, 500);
  if (input.approved === true && !answer) throw ctx.fail(400, '답변을 입력한 뒤 공개하세요', 'answer');
  question.answer = answer;
  question.approved = input.approved === true;
  return { body: { question } };
}

function toggleQuestionLike(ctx, input) {
  ensureAttendeeCanSubmit(ctx);
  const question = list(ctx.workspace.questions).find((item) =>
    item.id === ctx.clean(input.id, 120) && item.approved === true
  );
  if (!question) throw ctx.fail(404, '공개된 질문을 찾을 수 없습니다');
  const module = findModule(ctx, question.moduleId);
  if (module.type !== 'qa' || module.published !== true || module.status === 'DRAFT') {
    throw ctx.fail(409, '현재 공개 중인 Q&A가 아닙니다');
  }
  featureEnabled(ctx, 'qa');
  if (!Array.isArray(question.likes)) question.likes = [];
  const index = question.likes.indexOf(ctx.participant.id);
  if (index >= 0) question.likes.splice(index, 1);
  else question.likes.push(ctx.participant.id);
  return { body: { questionId: question.id, liked: index < 0, likes: question.likes.length } };
}

async function submitPhoto(ctx, input) {
  ensureAttendeeCanSubmit(ctx);
  featureEnabled(ctx, 'photo');
  const image = await ctx.resolveFile(input.image, {
    eventId: ctx.event.id,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxBytes: 600000,
  });
  const photo = {
    id: ctx.commandId,
    participantId: ctx.participant.id,
    name: String(ctx.participant.name || ''),
    image,
    caption: requireText(ctx, input.caption, '사진 설명', 300, 'caption'),
    status: 'PENDING',
    at: ctx.now,
  };
  ctx.workspace.photos.unshift(photo);
  return { status: 201, body: { photo: { ...photo } } };
}

function moderatePhoto(ctx, input) {
  const photo = list(ctx.workspace.photos).find((item) => item.id === ctx.clean(input.id, 120));
  const status = ctx.clean(input.status, 16).toUpperCase();
  if (!photo || !['PENDING', 'APPROVED', 'HIDDEN'].includes(status)) {
    throw ctx.fail(400, '사진과 처리 상태를 확인하세요');
  }
  featureEnabled(ctx, 'photo');
  photo.status = status;
  return { body: { photo: { ...photo } } };
}

function submitPost(ctx, input) {
  ensureAttendeeCanSubmit(ctx);
  featureEnabled(ctx, 'board');
  const post = {
    id: ctx.commandId,
    participantId: ctx.participant.id,
    name: String(ctx.participant.name || ''),
    body: requireText(ctx, input.body, '게시글', 500, 'body'),
    status: 'PENDING',
    at: ctx.now,
  };
  ctx.workspace.posts.unshift(post);
  return { status: 201, body: { post: { ...post } } };
}

function moderatePost(ctx, input) {
  const post = list(ctx.workspace.posts).find((item) => item.id === ctx.clean(input.id, 120));
  const status = ctx.clean(input.status, 16).toUpperCase();
  if (!post || !['APPROVED', 'HIDDEN'].includes(status)) throw ctx.fail(400, '게시글과 처리 상태를 확인하세요');
  featureEnabled(ctx, 'board');
  post.status = status;
  return { body: { post: { ...post } } };
}

function draw(ctx, input) {
  featureEnabled(ctx, 'draw');
  const module = findModule(ctx, input.id);
  if (module.type !== 'draw' || module.status !== 'OPEN' || module.published !== true) {
    throw ctx.fail(409, '진행 중인 추첨을 선택하세요');
  }
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw ctx.fail(400, '당첨 인원은 1~20명으로 입력하세요', 'count');
  if (!Array.isArray(module.drawHistory)) module.drawHistory = [];
  const previous = new Set(module.drawHistory.flatMap((row) => list(row.winners).map((winner) => winner.id)));
  const pool = list(ctx.workspace.participants).filter((person) =>
    person.status === 'APPROVED' && person.revoked !== true && person.everIn === true &&
    ['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase()) && !previous.has(person.id)
  );
  const poolCount = pool.length;
  if (poolCount < count) throw ctx.fail(409, '미당첨 입장 참가자가 부족합니다');
  const winners = [];
  while (winners.length < count) {
    const index = crypto.randomInt(pool.length);
    const [person] = pool.splice(index, 1);
    winners.push({ id: person.id, name: String(person.name || ''), company: String(person.company || '') });
  }
  const result = { id: ctx.commandId, winners, at: ctx.now, poolCount, published: false };
  module.drawHistory.unshift(result);
  return { body: { winners, poolCount, draw: { ...result } } };
}

function publishDraw(ctx, input) {
  featureEnabled(ctx, 'draw');
  const module = findModule(ctx, input.id);
  const result = list(module.drawHistory)[0];
  if (module.type !== 'draw' || !result) throw ctx.fail(409, '추첨 결과가 없습니다');
  result.published = true;
  return { body: { draw: { ...result } } };
}

function setDisplay(ctx, input) {
  featureEnabled(ctx, 'screen');
  const type = ctx.clean(input.type, 20).toLowerCase();
  if (!['idle', 'notice', 'poll', 'draw', 'quiz', 'qa', 'photo'].includes(type)) {
    throw ctx.fail(400, '출력 종류를 선택하세요', 'type');
  }
  const display = { type, moduleId: null, noticeId: null, at: ctx.now };
  if (type === 'notice') {
    const notice = list(ctx.workspace.notices).find((item) => item.id === ctx.clean(input.noticeId, 120) && item.published === true);
    if (!notice) throw ctx.fail(404, '게시한 공지를 선택하세요');
    display.noticeId = notice.id;
  } else if (['poll', 'draw', 'quiz', 'qa'].includes(type)) {
    const module = findModule(ctx, input.moduleId);
    if (module.type !== type || module.published !== true || !list(ctx.event.features).includes(type)) {
      throw ctx.fail(409, '공개된 프로그램을 선택하세요');
    }
    if (type === 'draw' && !list(module.drawHistory).some((row) => row.published === true)) {
      throw ctx.fail(409, '추첨 결과를 먼저 공개하세요');
    }
    if (type === 'quiz' && module.revealed !== true) throw ctx.fail(409, '퀴즈 정답을 먼저 공개하세요');
    if (type === 'qa' && !list(ctx.workspace.questions).some((question) => question.approved === true)) {
      throw ctx.fail(409, '공개 승인된 질문이 없습니다');
    }
    display.moduleId = module.id;
  } else if (type === 'photo') {
    featureEnabled(ctx, 'photo');
    if (!list(ctx.workspace.photos).some((photo) => photo.status === 'APPROVED')) {
      throw ctx.fail(409, '공개 승인한 사진이 없습니다');
    }
  }
  ctx.workspace.display = display;
  return { body: { display } };
}

async function apply(ctx) {
  switch (ctx.command) {
    case 'module.save': return saveModule(ctx, ctx.input);
    case 'module.status': return updateModuleStatus(ctx, ctx.input);
    case 'module.reveal': return revealQuiz(ctx, ctx.input);
    case 'response.submit': return submitResponse(ctx, ctx.input);
    case 'question.submit': return submitQuestion(ctx, ctx.input);
    case 'question.manage': return manageQuestion(ctx, ctx.input);
    case 'question.like': return toggleQuestionLike(ctx, ctx.input);
    case 'photo.submit': return submitPhoto(ctx, ctx.input);
    case 'photo.moderate': return moderatePhoto(ctx, ctx.input);
    case 'post.submit': return submitPost(ctx, ctx.input);
    case 'post.moderate': return moderatePost(ctx, ctx.input);
    case 'draw.run': return draw(ctx, ctx.input);
    case 'draw.publish': return publishDraw(ctx, ctx.input);
    case 'display.set': return setDisplay(ctx, ctx.input);
    default: throw ctx.fail(400, '지원하지 않는 프로그램 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, apply };
