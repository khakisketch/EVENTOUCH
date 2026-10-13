'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/surface-presentation.js'), 'utf8');

function load({ route, remoteStatus = 'connected', remoteStatusCode, booth = null, snapshot = null } = {}) {
  const E = {
    route: route || { scope: 'attendee', eventId: null, slug: 'partner-demo', page: 'ticket', params: new URLSearchParams('ticket=invalid') },
    remote: { status: remoteStatus, statusCode: remoteStatusCode },
    views: {
      attendee: () => '<div class="attendee">loaded</div>',
      staff: () => '<div class="staff-summary"><div class="od-stat"><strong>0</strong><small>이 업무의 처리 기록</small></div><div class="od-stat"><strong>무제한</strong><small>남은 수량</small></div></div><div class="notice ">사용 undefined · 잔여 제한 없음 · 1인 undefined회</div>',
      display: () => {
        const type = snapshot?.display?.type || 'notice';
        return `<main class="display-stage"><div class="display-content display-content--${type}"><h1>제목</h1><p class="preserve-lines">본문</p></div></main>`;
      },
    },
    assignment: () => booth ? { type: 'BOOTH', targetId: booth.id } : null,
    work: () => ({ booths: booth ? [booth] : [] }),
    number: String,
    notice: message => `<div class="notice">${message}</div>`,
    publicSnapshot: () => snapshot,
    mobileState: (title, description, actions = '') => `<section><h1>${title}</h1><p>${description}</p>${actions}</section>`,
    link: (label, href, cls = '') => `<a class="btn ${cls}" href="${href}">${label}</a>`,
  };
  vm.runInNewContext(source, { window: { ET: E, navigator: { onLine: true } } });
  return E;
}

test('cancelled attendee deep link stays explanatory when its revoked ticket cannot load', () => {
  const E = load({ route: { scope: 'attendee', eventId: null, slug: 'partner-demo', page: 'cancelled', params: new URLSearchParams('ticket=revoked') }, remoteStatus: 'denied' });
  const html = E.views.attendee();
  assert.match(html, /신청이 취소되었습니다/);
  assert.match(html, /기존 티켓으로 입장할 수 없습니다/);
  assert.match(html, /href="#\/event\/partner-demo\/home"/);
  assert.doesNotMatch(html, /undefined|오류 내용을 확인/);
});

test('invalid attendee ticket explains possible invalidation and offers the event home', () => {
  const E = load({ remoteStatus: 'denied' });
  const html = E.views.attendee();
  assert.match(html, /티켓 링크를 사용할 수 없습니다/);
  assert.match(html, /취소·만료·재발급/);
  assert.match(html, /href="#\/event\/partner-demo\/home"/);
  assert.doesNotMatch(html, /로그인으로 이동|Cannot read properties/);
});

test('attendee HTTP 404 is treated as an unavailable link, not a network failure', () => {
  const E = load({ remoteStatus: 'error', remoteStatusCode: 404 });
  const html = E.views.attendee();
  assert.match(html, /티켓 링크를 사용할 수 없습니다/);
  assert.doesNotMatch(html, /티켓 정보를 불러오지 못했습니다|data-reload-entry/);
});

test('attendee network failure offers retry instead of labeling a valid ticket invalid', () => {
  const E = load({ remoteStatus: 'offline' });
  const html = E.views.attendee();
  assert.match(html, /티켓 정보를 불러오지 못했습니다/);
  assert.match(html, /data-reload-entry/);
  assert.match(html, /인터넷 연결을 확인/);
  assert.doesNotMatch(html, /취소·만료·재발급/);
});

test('assigned booth presentation uses its visible status instead of hidden quantity limits', () => {
  const E = load({ booth: { id: 'booth-1', name: '체험 부스', status: 'OPEN' } });
  const html = E.views.staff();
  assert.match(html, /<strong>진행<\/strong><small>부스 상태<\/small>/);
  assert.match(html, /인증이 완료되면 최근 처리에서 확인할 수 있습니다/);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /무제한/);
});

test('long idle event names use the projector long-headline treatment', () => {
  const E = load({ snapshot: { display: { type: 'idle' }, event: { name: '파트너 국제 교류와 미래 기술 협력을 위한 가을 컨퍼런스 참가자 안내'.repeat(2) } } });
  const html = E.views.display();
  assert.match(html, /display-content--idle is-long/);
});

test('long projector notices are bounded and disclose where to read the full announcement', () => {
  const E = load({ snapshot: { display: { type: 'notice' }, event: { name: '행사' }, notice: { title: '현장 운영 안내 '.repeat(8), body: '긴 공지 내용입니다. '.repeat(110) } } });
  const html = E.views.display();
  assert.match(html, /display-content--notice is-long/);
  assert.match(html, /전체 안내는 참가자 화면의 공지 메뉴에서 확인하세요/);
});
