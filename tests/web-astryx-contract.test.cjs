'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { React, renderComponent } = require('./helpers/render-web-component.cjs');

test('an ordinary product action never becomes an implicit form submit', () => {
  const button = renderComponent('ProductButton', {}, '항목 추가').querySelector('button');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.textContent.includes('항목 추가'), true);
});

test('a submit action preserves its native form association and payload', () => {
  const button = renderComponent('ProductButton', {
    type: 'submit', form: 'settings-form', name: 'intent', value: 'save', id: 'save-action',
    'aria-describedby': 'save-help', 'data-command': 'event.basics.save',
  }, '기본 정보 저장').querySelector('button');
  for (const [key, value] of Object.entries({ type: 'submit', form: 'settings-form', name: 'intent', value: 'save', id: 'save-action', 'aria-describedby': 'save-help', 'data-command': 'event.basics.save' })) {
    assert.equal(button.getAttribute(key), value, key);
  }
});

test('explicitly disabled actions remain native disabled, not just aria-disabled', () => {
  const button = renderComponent('ProductButton', { disabled: true }, '게시하기').querySelector('button');
  assert.equal(button.hasAttribute('disabled'), true);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
});

test('busy actions retain their focus-preserving non-native disabled contract', () => {
  const button = renderComponent('ProductButton', { busy: true }, '새로고침').querySelector('button');
  assert.equal(button.hasAttribute('disabled'), false);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
});

test('legacy action intent maps to Astryx without leaking old global button selectors', () => {
  const document = renderComponent('ProductButton', { className: 'button button-primary layout-anchor' }, '저장');
  const button = document.querySelector('button');
  assert.equal(button.getAttribute('data-variant'), 'primary');
  assert.equal(button.classList.contains('layout-anchor'), true);
  assert.equal(button.classList.contains('button'), false);
  assert.equal(button.classList.contains('button-primary'), false);
  assert.equal(button.classList.contains('astryx-button'), true);
});

test('destructive action intent is not demoted to an ordinary secondary button', () => {
  const button = renderComponent('ProductButton', { className: 'button button-danger' }, '취소 확인').querySelector('button');
  assert.equal(button.getAttribute('data-variant'), 'destructive');
});

test('nested visible action copy and its explicit accessible name survive conversion', () => {
  const button = renderComponent('ProductButton', { 'aria-label': '선택한 참가자 3명 검토' }, React.createElement('strong', null, '선택 검토'), React.createElement('span', null, '3명')).querySelector('button');
  assert.equal(button.getAttribute('aria-label'), '선택한 참가자 3명 검토');
  assert.match(button.textContent, /선택 검토/);
  assert.match(button.textContent, /3명/);
});

test('navigation keeps a real destination and current-page semantics without a nested button', () => {
  const document = renderComponent('ProductLink', { href: '/console/events/synthetic/settings', 'aria-current': 'page', className: 'button button-secondary' }, '행사 설정');
  const link = document.querySelector('a');
  assert.equal(link.getAttribute('href'), '/console/events/synthetic/settings');
  assert.equal(link.getAttribute('aria-current'), 'page');
  assert.equal(document.querySelector('button'), null);
  assert.equal(link.classList.contains('button'), false);
});

test('action-styled navigation uses an Astryx anchor without button-only event typing', () => {
  const document = renderComponent('ProductLink', { href: '/console', className: 'button button-primary' }, '행사 열기');
  const link = document.querySelector('a');
  assert.equal(link.getAttribute('data-action-variant'), 'primary');
  assert.equal(link.classList.contains('astryx-link'), true);
  assert.equal(document.querySelector('button'), null);
});

test('structured navigation and native MIME types keep Next link semantics', () => {
  const link = renderComponent('ProductLink', { href: { pathname: '/console', query: { filter: 'active' } }, type: 'text/html' }, '행사').querySelector('a');
  assert.equal(link.getAttribute('href'), '/console?filter=active');
  assert.equal(link.getAttribute('type'), 'text/html');
});

test('product feedback preserves one live announcement and its contextual link', () => {
  const document = renderComponent('ProductNotice', { kind: 'error', id: 'save-error' }, '저장하지 못했습니다. ', React.createElement('a', { href: '#event-name' }, '행사명 확인'));
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
  assert.match(document.body.textContent, /저장하지 못했습니다/);
  assert.equal(document.querySelector('a').getAttribute('href'), '#event-name');
  assert.equal(document.querySelector('[id="save-error"]') !== null, true);
});

test('informational product feedback remains polite and never adds a disclosure', () => {
  const document = renderComponent('ProductNotice', { kind: 'info' }, '이전 자료를 유지합니다.');
  assert.equal(document.querySelectorAll('[role="status"]').length, 1);
  assert.equal(document.querySelector('button'), null);
  assert.equal(document.querySelector('details'), null);
});

test('aria-only disabled actions retain their native named payload', () => {
  const button = renderComponent('ProductButton', { name: 'intent', value: 'publish', 'aria-disabled': true }, '게시').querySelector('button');
  assert.equal(button.hasAttribute('disabled'), false);
  assert.equal(button.getAttribute('name'), 'intent');
  assert.equal(button.getAttribute('value'), 'publish');
});

test('derived action names contain adjacent visible account text without invented whitespace',()=>{
  const button=renderComponent('ProductButton',{},
    React.createElement('span',{'aria-hidden':true},'감'),
    React.createElement('span',null,
      React.createElement('strong',null,'감사 운영자'),
      React.createElement('small',null,'기존 조직 · 운영사 구성원')),
  ).querySelector('button');
  const visible=button.cloneNode(true);
  for(const hidden of visible.querySelectorAll('[aria-hidden="true"]'))hidden.remove();
  assert.equal(button.getAttribute('aria-label'),visible.textContent.replace(/\s+/g,' ').trim());
});

test('leading and trailing public slots preserve the visible identity and native action payload',()=>{
  const {createRequire}=require('node:module');
  const {Avatar}=createRequire(require('node:path').join(__dirname,'../apps/web/package.json'))('@astryxdesign/core/Avatar');
  const button=renderComponent('ProductButton',{
    type:'submit',form:'profile-form',name:'action',value:'review',
    icon:React.createElement(Avatar,{name:'감사 운영자',size:32,tooltip:false,'aria-hidden':true,'data-avatar':true}),
    endContent:React.createElement('span',{'aria-hidden':true,'data-caret':true}),
  },React.createElement('span',null,React.createElement('strong',null,'감사 운영자'),' ',React.createElement('small',null,'기존 조직'))).querySelector('button');
  assert.equal(button.querySelectorAll('[data-avatar]').length,1);
  assert.equal(button.querySelectorAll('[data-caret]').length,1);
  assert.equal(button.querySelector('[data-avatar]').getAttribute('role'),'img');
  assert.equal(button.querySelector('[data-avatar]').textContent,'');
  assert.equal(button.getAttribute('aria-label'),'감사 운영자 기존 조직');
  assert.equal(button.getAttribute('type'),'submit');
  assert.equal(button.getAttribute('form'),'profile-form');
  assert.equal(button.getAttribute('name'),'action');
  assert.equal(button.getAttribute('value'),'review');
});

test('attendee menu names include the visible ticket prerequisite', () => {
  const document = renderComponent('../event/[slug]/home/AttendeeHomeLanding', {
    eventName: '검증 행사', hasTicket: false, keyvisual: null, defaultHomeBanner: 'neutral', onOpen() {},
    homeStyle: { heroTitle: '', heroSubtitle: '', heroLayout: 'centered', textAlign: 'center', textTone: 'light', overlay: 'none', titleScale: 'normal', imageFocus: 'center' },
  });
  const actions = [...document.querySelectorAll('button')].filter(button => button.textContent.includes('티켓 필요'));
  assert.equal(actions.length, 4);
  for (const button of actions) {
    assert.equal(button.getAttribute('aria-label').replace(/\s+/g, ''), button.textContent.replace(/\s+/g, ''), 'visible prerequisite must not disappear from the action name');
  }
});
