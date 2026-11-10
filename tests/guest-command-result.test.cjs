'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/lib/guest-command-result.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleStub = { exports: {} };
vm.runInNewContext(`(function(exports, module) { ${js}\n})`, { Object, Array, Number, Boolean, RegExp })(moduleStub.exports, moduleStub);
const { confirmsGuestCommand: confirm, confirmsGuestPhotoUpload: upload } = moduleStub.exports;

test('participant responses must match the submitted answer and rating fields', () => {
  const id = 'synthetic-command-1';
  assert.equal(confirm('response.submit', { response: { id, moduleId: 'm1', answer: '정답', comment: '' } }, { moduleId: 'm1', answer: '정답' }, id), true);
  assert.equal(confirm('response.submit', { response: { id, moduleId: 'm1', answer: '다른 답', comment: '' } }, { moduleId: 'm1', answer: '정답' }, id), false);
  const versioned = { moduleId: 'm1', answer: '정답', expectedContentVersion: 3 };
  assert.equal(confirm('response.submit', { response: { id, moduleId: 'm1', answer: '정답', contentVersion: 3 } }, versioned, id), true);
  assert.equal(confirm('response.submit', { response: { id, moduleId: 'm1', answer: '정답' } }, versioned, id), false);
  assert.equal(confirm('response.submit', { response: { id, moduleId: 'm1', answer: '정답', contentVersion: 2 } }, versioned, id), false);
  const survey = { moduleId: 'm2', ratings: { '질문 1': 4, '질문 2': 5 }, comment: ' 합성 의견 ' };
  const result = { response: { id, moduleId: 'm2', answer: 'SUBMITTED', ratings: { '질문 1': 4, '질문 2': 5 }, comment: '합성 의견' } };
  assert.equal(confirm('response.submit', result, survey, id), true);
  assert.equal(confirm('response.submit', { response: { ...result.response, ratings: { '질문 1': 3, '질문 2': 5 } } }, survey, id), false);
  assert.equal(confirm('response.submit', { response: { ...result.response, comment: '' } }, survey, id), false);
});

test('questions, posts and photos reject unrelated bodies or approval states', () => {
  const id = 'synthetic-command-2';
  const question = { question: { id, moduleId: 'q1', text: '합성 질문', approved: false } };
  assert.equal(confirm('question.submit', question, { moduleId: 'q1', text: '합성 질문' }, id), true);
  assert.equal(confirm('question.submit', question, { moduleId: 'q1', text: '다른 질문' }, id), false);
  assert.equal(confirm('question.submit', { question: { ...question.question, approved: true } }, { moduleId: 'q1', text: '합성 질문' }, id), false);
  const versionedQuestion = { moduleId: 'q1', text: '합성 질문', expectedContentVersion: 3 };
  assert.equal(confirm('question.submit', { question: { ...question.question, contentVersion: 3 } }, versionedQuestion, id), true);
  assert.equal(confirm('question.submit', question, versionedQuestion, id), false, 'partial acknowledgements stay unconfirmed');
  assert.equal(confirm('question.submit', { question: { ...question.question, contentVersion: 2 } }, versionedQuestion, id), false);
  const post = { post: { id, body: '합성 게시글', status: 'PENDING' } };
  assert.equal(confirm('post.submit', post, { body: '합성 게시글' }, id), true);
  assert.equal(confirm('post.submit', post, { body: '다른 게시글' }, id), false);
  const photo = { photo: { id, caption: '합성 사진', status: 'PENDING', image: { fileId: 'file-1' } } };
  assert.equal(confirm('photo.submit', photo, { caption: '합성 사진', image: { fileId: 'file-1' } }, id), true);
  assert.equal(confirm('photo.submit', photo, { caption: '다른 설명', image: { fileId: 'file-1' } }, id), false);
  assert.equal(confirm('photo.submit', photo, { caption: '합성 사진', image: { fileId: 'file-2' } }, id), false);
});

test('photo upload must identify the selected image and valid dimensions', () => {
  const file = { name: 'synthetic.png', type: 'image/png', size: 321 };
  const response = { file: { fileId: 'file-1', name: file.name, type: file.type, size: file.size, width: 10, height: 20 } };
  assert.equal(upload(response, file), true);
  for (const changed of [{ name: 'other.png' }, { type: 'image/jpeg' }, { size: 1 }, { width: 0 }, { height: null }, { fileId: '../wrong' }]) {
    assert.equal(upload({ file: { ...response.file, ...changed } }, file), false);
  }
});

test('a guarded reaction confirms the requested question and desired state', () => {
  const payload = { id: 'q1', expectedLiked: false, liked: true, expectedQuestionText: '합성 질문' };
  assert.equal(confirm('question.like', { questionId: 'q1', liked: true, likes: 1, confirmedQuestionText: '합성 질문' }, payload, 'id'), true);
  assert.equal(confirm('question.like', { questionId: 'q1', liked: false, likes: 0 }, payload, 'id'), false);
  assert.equal(confirm('question.like', { questionId: 'q2', liked: true, likes: 1 }, payload, 'id'), false);
  assert.equal(confirm('question.like', { questionId: 'q1', liked: true }, payload, 'id'), false);
  assert.equal(confirm('question.like', { questionId: 'q1', liked: true, likes: 1 }, payload, 'id'), false, 'a legacy server cannot prove the question context');
  assert.equal(confirm('question.like', { questionId: 'q1', liked: true, likes: 1, confirmedQuestionText: '수정된 질문' }, payload, 'id'), false);
  assert.equal(confirm('question.like', { questionId: 'q1', liked: false, likes: 0 }, { id: 'q1' }, 'id'), true);
});
