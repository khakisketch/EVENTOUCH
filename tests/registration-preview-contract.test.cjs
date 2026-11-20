'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require(path.join(__dirname, '..', 'apps/web/node_modules/react'));
const { renderToStaticMarkup } = require(path.join(__dirname, '..', 'apps/web/node_modules/react-dom/server'));
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '..', 'apps/web')] }));

test('operator form preview uses the attendee field order and real disabled controls', () => {
  const file = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/settings/fields/FieldsPhonePreview.tsx');
  const source = fs.readFileSync(file, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(id) {
      if (id === 'react') return React;
      if (id === 'react/jsx-runtime') return require(path.join(__dirname, '..', 'apps/web/node_modules/react/jsx-runtime'));
      if (id.endsWith('fields.module.css') || id.endsWith('register.module.css')) return { default: new Proxy({}, { get: (_target, key) => String(key) }) };
      if (id.endsWith('/DeviceFrame')) return { default: (props) => React.createElement('div', { 'data-device': props.variant }, props.children) };
      if (id.endsWith('/AttendeeIcons')) return { default: () => null };
      if (id.endsWith('/EventBanner')) return { default: (props) => React.createElement('div', { className: props.className, 'data-banner': '' }, props.title, props.kicker) };
      if (id.endsWith('/EventFacts')) return { default: () => null };
      // Reopened 2026-11-20: the phone wears the attendee surface and look (a1/a2), as the real application page does.
      if (id.endsWith('/AttendeeSurface')) return { default: (props) => React.createElement('div', { 'data-attendee-mode': props.mode, className: props.className }, props.children) };
      if (id.endsWith('/attendee-look')) return { attendeeLook: () => ({ mode: 'a1', color: '#EA552E', ground: null }) };
      if (id.endsWith('/event-theme')) return { attendeeGroundStyle: () => ({}), DEFAULT_ATTENDEE_THEME: { homeStyle: { backgroundColor: '#B9DEF0' } } };
      if (id.endsWith('/ProductInput')) return { default: (props) => React.createElement('input', props) };
      if (id.endsWith('/ProductSelect')) return { default: (props) => React.createElement('select', props) };
      if (id.endsWith('/ProductButton')) return { default: (props) => React.createElement('button', {
        type: props.type, disabled: props.disabled, className: props.className, 'aria-pressed': props['aria-pressed'],
      }, props.children) };
      throw new Error(`Unexpected import ${id}`);
    },
  });
  const Preview = exports.default;
  const props = {
    eventName: '운영 미리보기 행사',
    activeId: 'company',
    publishedVersion: 2,
    draftVersion: 3,
    publishedFields: [
      { id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] },
      { id: 'company', label: '소속', type: 'text', required: false, options: [] },
      { id: 'agree', label: '안내 확인', type: 'checkbox', required: false, options: [] },
    ],
    draftFields: [
      { id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] },
      { id: 'company', label: '소속 기관', type: 'text', required: true, options: [] },
      { id: 'agree', label: '안내 확인', type: 'checkbox', required: false, options: [] },
    ],
  };
  const html = renderToStaticMarkup(React.createElement(Preview, props));

  const labels = ['식사 선택', '소속 기관', '안내 확인'];
  const offsets = labels.map((label) => html.indexOf(label));
  assert.ok(offsets[0] >= 0 && offsets[0] < offsets[1] && offsets[1] < offsets[2]);
  assert.match(html, /<select[^>]*disabled=""[^>]*required=""/);
  assert.match(html, /<option value="일반식">일반식<\/option>/);
  assert.match(html, /<input[^>]*type="text"[^>]*disabled=""[^>]*required=""/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>신청하기<\/button>/);
  assert.match(html, /aria-hidden="true"/);

  const published = renderToStaticMarkup(React.createElement(Preview, { ...props, draftVersion: 2 }));
  assert.match(published, /<small class="phoneStatus">게시 2차<\/small>/);
  assert.match(published, /<label[^>]*>소속<span[^>]*> \(선택\)<\/span><\/label>/);
  assert.doesNotMatch(published, /소속 기관/);

  // Reopened 2026-11-20: the phone shows the real registration sheet: the event
  // banner, then numbered sections in the attendee form's order.
  const sheet = { theme: { homeStyle: { backgroundColor: '#B9DEF0' } }, context: {}, verificationRequired: true, approvalRequired: false, consentText: '이름과 연락처를 사용합니다.', consentVersion: 3 };
  const full = renderToStaticMarkup(React.createElement(Preview, { ...props, sheet }));
  assert.match(full, /data-device="phone"/);
  assert.match(full, /data-banner=""[^>]*>운영 미리보기 행사/);
  const sections = ['참가자 정보', '연락처 인증', '정보 수집 동의'].map((title) => full.indexOf(`>${title}</h2>`));
  assert.ok(sections[0] > 0 && sections[0] < sections[1] && sections[1] < sections[2], 'sections follow the attendee form order');
  assert.match(full, /동의 버전 3/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Preview, props)), />연락처 인증<\/h2>|>정보 수집 동의<\/h2>/, 'sections the event does not ask for stay out');
});
