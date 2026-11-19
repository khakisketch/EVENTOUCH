'use strict';

// Run the actual server page with a synthetic public API response. This is
// intentionally independent of the browser audit and does not use live data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../apps/web');
const ts = require(require.resolve('typescript', { paths: [web] }));
const jsx = require(require.resolve('react/jsx-runtime', { paths: [web] }));
const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: [web] }));
const { loadComponent } = require('./helpers/render-web-component.cjs');
const schedule = loadComponent('../event/[slug]/PublicProgramSchedule');
const addressCopy = loadComponent('../event/[slug]/AddressCopyButton');
const tabTicketChoice = loadComponent('../event/[slug]/TabTicketChoice');
const attendeeHome = require('../apps/web/lib/attendee-home.ts');
// The surface colors are not what these tests are about; the real helper is covered by the home layout tests.
const homeSurface = { homeSurfaceStyle: (style) => ({ '--home-background-color': style.backgroundColor }) };
// Class-name stubs for CSS modules: every key reads as its own name.
const cssModule = () => ({ __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) });

async function renderVenue(venue, published, features = ['venue'], program = []) {
  const source = fs.readFileSync(path.join(web, 'app/event/[slug]/page.tsx'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const recoveryCode = ts.transpileModule(fs.readFileSync(path.join(web, 'lib/public-recovery-contact.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const recoveryExports = {};
  vm.runInNewContext(recoveryCode, { exports: recoveryExports });
  const exports = {};
  const response = {
    event: { id: 'fixture', slug: 'fixture', name: '합성 행사', date: '2027-01-16', stage: 'READY', features },
    workspace: { venue, program, pageExperience: { published } },
  };
  vm.runInNewContext(code, {
    exports,
    process: { env: {} },
    fetch: async () => ({ status: 200, ok: true, json: async () => response }),
    require(id) {
      if (id === 'react/jsx-runtime') return jsx;
      if (id === 'next/link') return { __esModule: true, default: ({ children, ...props }) => jsx.jsx('a', { ...props, children }) };
      if (id === 'next/navigation') return { notFound: () => { throw new Error('Unexpected 404'); } };
      if (id === '../../event-stage') return { eventStageClassName: () => 'stage', eventStageLabel: () => '운영 준비' };
      if (id === '../../../lib/attendee-home') return attendeeHome;
      if (id === '../../../lib/home-surface') return homeSurface;
      if (id === '../../ui/ProductLink') return { __esModule: true, default: ({ children, ...props }) => jsx.jsx('a', { ...props, children }) };
      if (id === './home/HomeHero') return { __esModule: true, default: ({ eventName, subtitle }) => jsx.jsxs('section', { children: [jsx.jsx('h1', { children: eventName }), subtitle ? jsx.jsx('p', { children: subtitle }) : null] }) };
      if (id === './home/home.module.css' || id === './home/home-layouts.module.css') return cssModule();
      if (id === './GuideIcon') return { __esModule: true, default: () => null };
      if (id === '../../../lib/public-event-date') return require('../apps/web/lib/public-event-date.ts');
      if (id === './PublicProgramSchedule') return schedule;
      if (id === './AddressCopyButton') return addressCopy;
      if (id === './TabTicketChoice') return tabTicketChoice;
      if (id === '../../../lib/verification-mode') return { loadVerificationMode: async () => 'real' };
      if (id === '../../../lib/public-recovery-contact') return recoveryExports;
      if (id === '../../ui/RichText') return { __esModule: true, default: ({ source }) => jsx.jsx('div', { children: source }) };
      if (id === './public-event.module.css') return cssModule();
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return renderToStaticMarkup(await exports.default({ params: Promise.resolve({ slug: 'fixture' }) }));
}

test('venue description alone renders as escaped, multiline guidance when venue is shown', async () => {
  const html = await renderVenue({ description: '합성 안내 첫 줄\n<img src=x onerror=alert(1)>' }, { showVenue: true });
  assert.match(html, /id="public-venue"/);
  assert.match(html, /<dt>행사장 안내<\/dt>/);
  assert.match(html, /class="venueText">합성 안내 첫 줄\n&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('venue description does not render when the published venue section is hidden', async () => {
  const html = await renderVenue({ description: '숨긴 장소 안내 표식' }, { showVenue: false });
  assert.doesNotMatch(html, /숨긴 장소 안내 표식|id="public-venue"/);
});

test('an older API response cannot display stored venue text when its feature is disabled', async () => {
  const venue = { name: '비활성 합성 장소', address: '비활성 합성 주소', contact: '비활성 합성 문의', description: '비활성 합성 안내' };
  const html = await renderVenue(venue, { showVenue: true }, []);
  assert.doesNotMatch(html, /비활성 합성 장소|비활성 합성 주소|비활성 합성 문의|비활성 합성 안내|id="public-venue"/);
});

test('ticket recovery never shows an older API contact without the venue feature', async () => {
  const code = ts.transpileModule(fs.readFileSync(path.join(web, 'lib/public-recovery-contact.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  let response = { event: { features: [] }, workspace: { venue: { contact: '합성 문의' }, pageExperience: { published: { showVenue: true } } } };
  vm.runInNewContext(code, { exports, process: { env: {} }, fetch: async () => ({ ok: true, json: async () => response }) });
  assert.equal(exports.publicRecoveryContact(response.workspace, []), '');
  assert.equal(exports.publicRecoveryContact(response.workspace, undefined), '');
  assert.equal(await exports.loadPublicRecoveryContact('fixture'), '');
  response = { ...response, event: { features: ['venue'] } };
  assert.equal(await exports.loadPublicRecoveryContact('fixture'), '합성 문의');
  response.workspace.pageExperience.published.showVenue = false;
  assert.equal(await exports.loadPublicRecoveryContact('fixture'), '');
});

test('an empty or non-string venue description does not invent a section', async () => {
  for (const description of ['', null, { text: 'not text' }]) {
    const html = await renderVenue({ description }, { showVenue: true });
    assert.doesNotMatch(html, /id="public-venue"/);
  }
});

test('an undated published session uses the event date only when that date is visible', async () => {
  const session = { id: 'undated', title: '합성 세션', date: '', start: '', end: '', place: '', description: '' };
  const shown = await renderVenue(null, { showSchedule: true }, [], [session]);
  assert.match(shown, /행사 일정 기준/);
  const hidden = await renderVenue(null, { showSchedule: false }, [], [session]);
  assert.match(hidden, /합성 세션/);
  assert.match(hidden, /날짜 미정/);
  assert.doesNotMatch(hidden, /2027-01-16|행사 일정 기준/);
});

test('venue map has escaped descriptive alt text and an accessible full-size link', async () => {
  const html = await renderVenue({ map: { image: { fileId: 'file-example' }, alt: '동문에서 <접수대>로 이동' } }, { showVenue: true });
  assert.match(html, /src="\/api\/public\/events\/fixture\/files\/file-example"/);
  assert.match(html, /alt="동문에서 &lt;접수대&gt;로 이동"/);
  assert.match(html, /안내도 크게 보기 \(새 탭\)/);
  const hidden = await renderVenue({ map: { image: { fileId: 'file-example' }, alt: '숨긴 안내도' } }, { showVenue: false });
  assert.doesNotMatch(hidden, /file-example|숨긴 안내도/);
});
