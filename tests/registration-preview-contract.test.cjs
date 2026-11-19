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
      if (id.endsWith('fields.module.css')) return { default: new Proxy({}, { get: (_target, key) => String(key) }) };
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
  assert.match(published, /<label[^>]*>소속<small[^>]*>\(선택\)<\/small><\/label>/);
  assert.doesNotMatch(published, /소속 기관/);
});
