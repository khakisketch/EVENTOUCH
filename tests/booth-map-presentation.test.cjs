'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const event = { id: 'event-map', slug: 'map-event', name: '부스 지도 확인 행사', date: '2026-10-21', start: '09:30', end: '16:00', stage: 'LIVE', features: ['stamp'] };
const booths = [
  { id: 'booth-a', name: '체험 부스', zone: '로비', status: 'OPEN', capacity: 20, used: 4, limit: 1 },
  { id: 'booth-b', name: '체험 부스', zone: '2층', status: 'OPEN', capacity: 10, used: 2, limit: 1 },
  { id: 'booth-c', name: '안내 데스크', zone: '입구', status: 'CLOSED', capacity: 0, used: 0, limit: 1 },
  { id: 'booth-d', name: '워크숍', zone: '별관', status: 'WAITING', capacity: 8, used: 0, limit: 2 }
];
const map = { published: { version: 3, image: { fileId: 'floorplan-1', name: 'floorplan.png', type: 'image/png', size: 120000, width: 320, height: 200 }, points: [{ boothId: 'booth-a', x: .25, y: .5 }, { boothId: 'booth-b', x: 1, y: 0 }] }, draft: null };

function harness({ participant = null, published = map.published, stampMode = 'STAFF', page = 'stamp', can = true, boothList = booths } = {}) {
  const calls = [];
  const workspace = { booths: boothList, visits: [], venue: { name: '컨벤션 홀', address: '서울 중구 세종대로 1' }, stampMode, boothMap: { published, draft: null } };
  const E = {
    ui: {}, actions: {}, forms: {}, views: { booths: () => '<section id="existing-booth-controls">기존 부스 설정</section>' },
    event: () => event, work: () => workspace, person: () => participant, ticketValid: p => !!p && !p.revoked && p.status !== 'CANCELLED', can: () => can,
    route: { page, eventId: event.id, params: new URLSearchParams() },
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    aurl: (pageName) => `#/event/${event.slug}/${pageName}`,
    button: (text, action, attrs = '', cls = '') => `<button class="${cls}" data-action="${action}" ${attrs}>${text}</button>`,
    link: (text, href, cls = '') => `<a class="${cls}" href="${href}">${text}</a>`,
    field: (label, name, value = '', type = 'text', attrs = '') => `<label>${label}<input name="${name}" type="${type}" value="${value}" ${attrs}></label>`,
    select: () => '<select></select>', notice: (text, kind = '') => `<p class="notice ${kind}">${text}</p>`,
    badge: (label, kind = '') => `<span class="badge ${kind}">${label}</span>`, detail: rows => `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`,
    panel: (title, body) => `<section><h2>${title}</h2>${body}</section>`, empty: (title, body) => `<section><h2>${title}</h2><p>${body}</p></section>`,
    register: () => {}, run: async (name, payload) => { calls.push([name, payload]); return { boothMap: { draft: { ...payload, version: payload.expectedDraftVersion + 1, image: { fileId: payload.fileId } } } }; },
    remote: {
      fileURL: options => `/${options.public ? 'public/' : ''}events/${options.eventId || options.slug}/files/${options.fileId}`,
      uploadFile: async file => ({ id: 'uploaded-1', fileId: 'uploaded-1', name: file.name, type: file.type, size: file.size, width: 320, height: 200 }),
      loadPublic: async (slug, ticket) => { calls.push(['loadPublic', slug, ticket]); if (ticket) throw Object.assign(Error('invalid ticket'), { status: 404 }); return { guest: true }; }
    },
    parseRoute: () => ({ scope: 'attendee', page }),
    id: prefix => `${prefix}-test`, toast: () => {}, render: () => {}, dirty: false,
    mobileState: (title, body) => `<section><h1>${title}</h1><p>${body}</p></section>`, mobileEngagement: () => '<p>ticket protected feature</p>',
    attendeeEventSummary: () => '', image: () => '', icon: () => '', notice: (text, kind = '') => `<p class="notice ${kind}">${text}</p>`,
    boothStampSummary: (bs, vs, id) => { const ids = [...new Set(bs.map(b => b.id))]; const own = new Set(vs.filter(v => id && v.participantId === id && ids.includes(v.boothId)).map(v => v.boothId)); return { total: ids.length, completed: id ? own.size : null, visitedBoothIds: [...own] }; }
  };
  const documentListeners = {}, targets = {};
  const document = { addEventListener(type, handler) { documentListeners[type] = handler; }, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById(id) { return targets[id] || null; } };
  const window = { ET: E, location: { hash: '#/event/map-event/stamp?ticket=ticket-1' }, addEventListener() {}, matchMedia: () => ({ matches: false }), scrollTo() {}, URL: { createObjectURL: () => 'blob:preview' } };
  const context = vm.createContext({ window, document, URLSearchParams, console, Math, Number, Array, Set, Object, String, Error, Promise, Date, File: function File() {} });
  const load = file => vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  load('assets/js/booth-map-data.js');
  load('assets/js/booth-map-ui.js');
  load('assets/js/attendee.js');
  return { E, workspace, calls, load, documentListeners, document, window, targets };
}

test('guest stamp route shows event context, published map and all booths without claiming zero personal progress', () => {
  const { E, workspace } = harness();
  E.route.params = new URLSearchParams('ticket=invalid-old-ticket');
  workspace.participants = [];
  workspace.branding = { logo: null };
  workspace.notices = [];
  workspace.program = [];
  const html = E.views.attendee();
  assert.match(html, /부스 지도 확인 행사/);
  assert.match(html, /2026-10-21/);
  assert.match(html, /data-od-id="booth-map-meta-event"[^>]*>부스 지도 확인 행사/);
  assert.match(html, /data-od-id="booth-map-meta-date"[^>]*>2026-10-21/);
  assert.match(html, /티켓 등록 후 내 인증 현황을 확인할 수 있어요/);
  assert.doesNotMatch(html, /booth-map-meta-venue|booth-map-meta-address|행사 참여/);
  assert.doesNotMatch(html, /0\s*\/\s*4/);
  assert.match(html, /floorplan-1/);
  assert.match(html, /left:100%;top:0%/);
  for (const b of booths) assert.ok(html.includes(b.id), `booth ${b.id} remains visible in the list/map labels`);
  assert.match(html, /체험 부스 1/);
  assert.match(html, /체험 부스 2/);
  assert.match(html, /CLOSED|종료/);
  assert.match(html, /배치되지 않음|위치 미지정/);
  assert.doesNotMatch(html, /data-action="camera-scan"|data-action="self-booth-input"/);
});

test('stamp route bypasses only ticket-link guards while other ticket-protected routes remain guarded', () => {
  const { E, workspace } = harness();
  workspace.participants = [];
  workspace.branding = { logo: null };
  workspace.notices = [];
  workspace.program = [];
  E.route.params = new URLSearchParams('ticket=invalid-old-ticket');
  assert.match(E.views.attendee(), /booth-map-page/);
  E.route.page = 'poll';
  assert.match(E.views.attendee(), /사용할 수 없는 링크입니다/);
});

test('stamp bootstrap retries a rejected ticket link as public event data only on that route', async () => {
  const { E, calls } = harness();
  const result = await E.remote.loadPublic(event.slug, 'expired-ticket');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { guest: true });
  assert.deepEqual(calls.filter(call => call[0] === 'loadPublic').map(call => call[2]), ['expired-ticket', '']);
  E.parseRoute = () => ({ scope: 'attendee', page: 'poll' });
  await assert.rejects(E.remote.loadPublic(event.slug, 'expired-ticket'), /invalid ticket/);
  assert.equal(calls.filter(call => call[0] === 'loadPublic').length, 3, 'other attendee routes never retry without their ticket');
});

test('valid ticket renders only own confirmed unique visit marks; unapproved state does not gain scan controls', () => {
  const participant = { id: 'person-1', ticket: 'ticket-1', name: '홍길동', status: 'APPROVED', paymentStatus: 'FREE', inside: true };
  const { E, workspace } = harness({ participant });
  workspace.visits = [
    { boothId: 'booth-a', participantId: 'person-1' }, { boothId: 'booth-a', participantId: 'person-1' },
    { boothId: 'booth-b', participantId: 'person-2' }, { boothId: 'orphan', participantId: 'person-1' }
  ];
  let html = E.boothStampPage();
  assert.match(html, /1\s*\/\s*4/);
  assert.match(html, /booth-a[^>]*(visited|완료|인증)/i);
  const pending = harness({ participant: { ...participant, status: 'PENDING' } }).E.boothStampPage();
  assert.doesNotMatch(pending, /data-action="camera-scan"|data-action="self-booth-input"/);
  assert.match(pending, /참가가 확정되면/);
});

test('attendee certification actions appear between the map and booth list', () => {
  const participant = { id: 'person-1', ticket: 'ticket-1', name: '홍길동', status: 'APPROVED', paymentStatus: 'FREE', inside: true };
  const staffHtml = harness({ participant, stampMode: 'STAFF' }).E.boothStampPage();
  assert.ok(staffHtml.indexOf('booth-map-view') < staffHtml.indexOf('booth-ticket-entry'));
  assert.ok(staffHtml.indexOf('booth-ticket-entry') < staffHtml.indexOf('booth-map-list-panel'));
  assert.match(staffHtml, /내 티켓 제시/);

  const selfHtml = harness({ participant, stampMode: 'SELF' }).E.boothStampPage();
  assert.ok(selfHtml.indexOf('booth-map-view') < selfHtml.indexOf('booth-self-scan'));
  assert.ok(selfHtml.indexOf('booth-self-scan') < selfHtml.indexOf('booth-map-list-panel'));
  assert.match(selfHtml, /코드 직접 입력/);
});

test('completed booth rows add a decorative check while retaining their accessible completion label', () => {
  const participant = { id: 'person-1', status: 'APPROVED', paymentStatus: 'FREE', inside: true };
  const { E, workspace } = harness({ participant });
  workspace.visits = [{ boothId: 'booth-a', participantId: participant.id }];
  const html = E.boothStampPage();
  assert.match(html, /class="booth-map-list-item is-visited"/);
  assert.match(html, /booth-map-list-state-icon[^>]*aria-hidden="true"/);
  assert.match(html, /aria-label="체험 부스 1, 진행 중, 인증 완료"/);
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  assert.match(css, /\.booth-map-list-item\.is-visited \.booth-map-list-state[^\{]*\{[^}]*var\(--success\)/s);
});

test('attendee status stays flat and editor coordinate actions align to the field height', () => {
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  assert.match(css, /\.booth-map-guest,\s*\.booth-map-progress\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent/s);
  assert.doesNotMatch(css, /\.booth-map-progress,\s*\.booth-map-guest,\s*\.booth-map-certify\s*\{/);
  assert.match(css, /\.booth-map-coordinate button\s*\{[^}]*align-self:\s*center;[^}]*height:\s*44px/s);
});

test('published map absence and image failure leave a complete booth list fallback', () => {
  const { E } = harness({ published: null });
  const html = E.boothStampPage();
  assert.match(html, /배치도가 아직 게시되지 않았습니다/);
  assert.match(html, /부스 목록/);
  for (const b of booths) assert.ok(html.includes(b.id));
  assert.equal(typeof E.boothMapImageFailed, 'function');
  assert.match(E.boothMapImageFailed(), /부스 목록/);
});

test('existing booth view is preserved and the additive editor exposes upload, coordinate and versioned actions', () => {
  const { E } = harness();
  const html = E.boothMapEditor();
  assert.match(E.views.booths(), /existing-booth-controls/);
  assert.match(html, /부스 배치도/);
  assert.match(html, /image\/png,image\/jpeg,image\/webp/);
  assert.match(html, /600/);
  assert.match(html, /name="x"/);
  assert.match(html, /name="y"/);
  for (const action of ['booth-map-save', 'booth-map-publish', 'booth-map-unpublish']) assert.match(html, new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(html, /data-action="booth-map-zoom"/, 'map controls wait until the image is usable');
  assert.match(html, /위치.+직접 입력|좌표.+입력/);
  assert.match(E.views.booths(), /existing-booth-controls[\s\S]*booth-map-editor/);
});

test('map publication state uses the shared filled semantic badge treatment', () => {
  const { E } = harness();
  const html = E.boothMapEditor();
  assert.match(html, /class="badge good">현재 게시본 유지<\/span>/);
  const unpublished = harness({ published: null }).E.boothMapEditor();
  assert.match(unpublished, /class="badge warn">미게시<\/span>/);
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  assert.doesNotMatch(css, /\.booth-map-state\s*\{/);
  assert.match(css, /\.booth-map-pin\.is-selected\s*\{[^}]*var\(--focus\)/s);
});

test('editor point changes stay local, normalize coordinates and save with expected server version', async () => {
  const { E, workspace, calls } = harness();
  E.boothMapSetPoint('booth-a', .4, .6);
  assert.equal(workspace.boothMap.draft, null, 'editing cannot mutate authoritative workspace state');
  assert.throws(() => E.boothMapSetPoint('booth-a', '', ''), /위치를 입력/);
  assert.throws(() => E.boothMapSetPoint('booth-a', 1.1, .4), /0과 1|범위/);
  await E.actions['booth-map-save']();
  assert.equal(calls[0][0], 'booth.map.save');
  assert.equal(calls[0][1].expectedDraftVersion, 0);
  assert.equal(calls[0][1].points.find(p => p.boothId === 'booth-a').x, .4);
});

test('failed versioned save cannot announce success and publish/unpublish carry exact versions', async () => {
  const { E, calls } = harness();
  const local = E.boothMapLocalState();
  local.image = map.published.image;
  local.dirty = true;
  let toastCount = 0;
  E.toast = () => { toastCount++; };
  E.run = async (name, payload) => { calls.push([name, payload]); if (name === 'booth.map.save') throw Error('version conflict'); return { boothMap: {} }; };
  await assert.rejects(E.actions['booth-map-save'](), /version conflict/);
  assert.equal(toastCount, 0);
  assert.equal(local.dirty, true);
  E.work().boothMap.draft = { version: 5, image: map.published.image, points: [] };
  local.dirty = false;
  await E.actions['booth-map-publish']();
  await E.actions['booth-map-unpublish']({ version: 3 });
  assert.deepEqual(calls.slice(1).map(call => call[0]), ['booth.map.publish', 'booth.map.unpublish']);
  assert.equal(calls[1][1].expectedDraftVersion, 5);
  assert.equal(calls[2][1].expectedPublishedVersion, 3);
});

test('canvas click places the selected booth at normalized coordinates after zoom and pan', () => {
  const { E, documentListeners } = harness();
  const local = E.boothMapLocalState();
  local.image = map.published.image;
  E.ui.boothMap.selectedId = 'booth-d';
  Object.assign(E.ui.boothMap.viewport, { scale: 2, x: -50, y: -20 });
  const editor = {};
  const stage = { dataset: { mapReady: 'true' }, closest: selector => selector === '.booth-map-editor' ? editor : null, getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }) };
  documentListeners.click({
    target: { closest: selector => selector === '[data-map-canvas]' ? stage : null },
    clientX: 250, clientY: 130
  });
  const point = local.points.find(item => item.boothId === 'booth-d');
  assert.equal(point.x, .5);
  assert.equal(point.y, .5);
});

test('pins preserve their exact edge coordinates and use edge-aware hit targets', () => {
  const { E } = harness();
  E.work().boothMap.published.points.push({ boothId: 'booth-c', x: 0, y: 1 });
  const html = E.boothStampPage();
  assert.match(html, /class="booth-map-pin is-edge-right is-edge-top" style="left:100%;top:0%"/);
  assert.match(html, /class="booth-map-pin is-edge-left is-edge-bottom" style="left:0%;top:100%"/);
  assert.match(html, /booth-map-pin-anchor/);
  assert.match(html, /is-edge-right/);
  assert.match(html, /is-edge-top/);
  assert.match(html, /left:25%;top:50%/);
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  assert.match(css, /min-width:\s*44px;\s*min-height:\s*44px/);
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const rule = new RegExp(`\\.booth-map-pin\\.is-edge-${edge} \\.booth-map-pin-anchor \\{[^}]*`);
    const match = css.match(rule)?.[0] || '';
    assert.match(match, /(?:left|right|top|bottom): 1px;/, `${edge} anchor remains inside the clipped canvas`);
    assert.doesNotMatch(match, /-5px/, `${edge} anchor is not clipped by the map boundary`);
  }
});

test('conflict guidance suppresses only the redundant toast while preserving ordinary toast styling', () => {
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  const sharedCss = fs.readFileSync('assets/css/tokens.css', 'utf8');
  assert.match(css, /:has\(\.booth-map-conflict\)[^{]*\.toast\s*\{[^}]*display:\s*none/s);
  assert.match(sharedCss, /\.toast\{position:fixed/);
  assert.doesNotMatch(css, /^\s*\.toast\s*\{[^}]*display:\s*none/s, 'the map stylesheet does not globally hide toast errors');
  const { E } = harness();
  E.boothMapLocalState().conflict = true;
  assert.match(E.boothMapEditor(), /class="booth-map-conflict" role="alert"><p>서버 초안이 먼저 변경되어 저장하지 못했습니다\. 내 좌표는 유지되었습니다\./);
  assert.match(css, /\.booth-map-conflict > p:last-child\s*\{[^}]*word-break:\s*keep-all/s);
});

test('compact event metadata and conflict guidance keep Korean copy readable', () => {
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  assert.match(css, /\.booth-map-event-meta\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  const { E, workspace } = harness();
  workspace.venue = { name: '', address: '' };
  const html = E.boothStampPage();
  assert.doesNotMatch(html, /booth-map-meta-venue|booth-map-meta-address/);
});

test('unselected mobile helper copy remains concise and complete', () => {
  const { E } = harness();
  E.ui.boothMap = null;
  const html = E.boothStampPage();
  assert.match(html, /목록이나 배치도에서 부스를 선택하세요\./);
  assert.doesNotMatch(html, /부스 목록이나 배치도에서 부스를 선택하세요\./);
});

test('synthetic floorplan render fixture is clearly labeled and not a product data seed', () => {
  const svg = fs.readFileSync('tests/fixtures/booth-map/synthetic-demo-floorplan.svg', 'utf8');
  const png = fs.readFileSync('tests/fixtures/booth-map/synthetic-demo-floorplan.png');
  assert.match(svg, /SYNTHETIC DEMO FLOORPLAN/);
  assert.match(svg, /viewBox="0 0 1200 760"/);
  assert.match(svg, /booth/i);
  assert.match(svg, /aisle/i);
  assert.doesNotMatch(svg, /<image\b|https?:\/\/(?!www\.w3\.org)/i, 'fixture contains no imported artwork or remote image');
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 760);
});

test('finished fictional demo floorplan is a local PNG distinct from the synthetic test fixture', () => {
  const demo = fs.readFileSync('tests/fixtures/booth-map/demo-venue-floorplan.png');
  const fixture = fs.readFileSync('tests/fixtures/booth-map/synthetic-demo-floorplan.png');
  assert.deepEqual([...demo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(demo.readUInt32BE(16), 1600);
  assert.equal(demo.readUInt32BE(20), 1000);
  assert.notDeepEqual(demo, fixture);
});

test('map editor stays hidden without booth-management write permission', () => {
  const { E } = harness({ can: false });
  assert.match(E.views.booths(), /existing-booth-controls/);
  assert.doesNotMatch(E.views.booths(), /booth-map-editor/);
});

test('map upload rejects oversized or unsupported files and replacement clears local positions', async () => {
  const { E, workspace } = harness();
  await assert.rejects(E.boothMapUploadFile({ name: 'huge.png', type: 'image/png', size: 600001 }), /600/);
  await assert.rejects(E.boothMapUploadFile({ name: 'map.gif', type: 'image/gif', size: 1200 }), /PNG|JPEG|WebP/);
  await assert.rejects(E.boothMapUploadFile({ name: 'empty.png', type: 'image/png', size: 0 }), /1B 이상/);
  E.boothMapSetPoint('booth-a', .25, .5);
  const uploaded = await E.boothMapUploadFile({ name: 'new.webp', type: 'image/webp', size: 1000 });
  assert.equal(uploaded.fileId, 'uploaded-1');
  assert.deepEqual(JSON.parse(JSON.stringify(E.boothMapLocalState().points)), []);
  assert.equal(workspace.boothMap.published.version, 3, 'upload leaves the currently published map untouched');
});

test('in-page map jumps preserve the SPA route and focus the requested section', () => {
  const { E, window, targets } = harness();
  let focused = 0, scroll = null;
  targets['booth-map-view'] = { getBoundingClientRect: () => ({ top: 180 }), focus: options => { focused++; assert.equal(options.preventScroll, true); } };
  window.scrollTo = options => { scroll = options; };
  const route = window.location.hash;
  E.actions['booth-map-jump']({ target: 'booth-map-view' });
  assert.equal(window.location.hash, route);
  assert.equal(focused, 1);
  assert.equal(scroll.top, 180);
  assert.equal(scroll.behavior, 'smooth');
  window.matchMedia = () => ({ matches: true });
  E.actions['booth-map-jump']({ target: 'booth-map-view' });
  assert.equal(window.location.hash, route);
  assert.equal(scroll.behavior, 'auto', 'reduced-motion preference disables smooth scrolling');
});

test('replacing a saved draft requires an explicit empty-points save before placing pins', async () => {
  const { E, workspace, calls } = harness();
  workspace.boothMap.draft = { version: 6, image: { fileId: 'old-draft' }, points: [{ boothId: 'booth-a', x: .25, y: .5 }] };
  E.ui.boothMap = null;
  const local = E.boothMapLocalState();
  E.remote.uploadFile = async file => ({ fileId: 'replacement', name: file.name, type: file.type, size: file.size });
  await E.boothMapUploadFile({ name: 'new.png', type: 'image/png', size: 1200 });
  assert.equal(local.replacementPending, true);
  assert.match(E.boothMapEditor(), /data-action="booth-map-place"[^>]*disabled/);
  assert.throws(() => E.boothMapSetPoint('booth-a', .5, .5), /먼저.*저장|빈.*저장/);
  await E.actions['booth-map-save']();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].points)), []);
  assert.equal(calls[0][1].expectedDraftVersion, 6);
  assert.equal(local.replacementPending, false);
  E.boothMapSetPoint('booth-a', .5, .5);
  await E.actions['booth-map-save']();
  assert.equal(calls[1][1].expectedDraftVersion, 7);
  assert.equal(calls[1][1].points[0].x, .5);
  assert.equal(workspace.boothMap.published.version, 3);
});

test('stamp map page uses one main region and omits empty personal progress', () => {
  const { E } = harness({ participant: { id: 'person-1', status: 'APPROVED', paymentStatus: 'FREE' }, boothList: [] });
  const html = E.boothStampPage();
  assert.doesNotMatch(html, /<main\b/i);
  assert.match(html, /booth-map-page[^>]*aria-labelledby/);
  assert.doesNotMatch(html, /내 인증\s*<strong>0\s*\/\s*0/);
  assert.match(html, /등록된 부스가 없습니다/);
  E.work().branding = { logo: null };
  E.work().notices = [];
  E.work().program = [];
  E.work().participants = [];
  const attendeeHtml = E.views.attendee();
  assert.equal((attendeeHtml.match(/<main\b/g) || []).length, 1);
});

test('stamp map chrome is compact while map controls keep accessible names and targets', () => {
  const { E } = harness();
  E.ui.boothMap = { local: null, selectedId: null, viewport: { scale: 1, x: 0, y: 0 }, imageStatus: { 'floorplan-1': 'ready' } };
  const html = E.boothStampPage();
  assert.match(html, /<h1 id="booth-map-title"[^>]*>스탬프 투어<\/h1>/);
  assert.doesNotMatch(html, /class="eyebrow"|booth-map-section-heading|게시된 배치도|booth-map-secondary/);
  assert.match(html, /class="booth-map-jump"/);
  const labels = ['배치도 확대', '배치도 축소', '보기 초기화', '배치도 왼쪽 이동', '배치도 위쪽 이동', '배치도 아래쪽 이동', '배치도 오른쪽 이동'];
  for (const label of labels) assert.match(html, new RegExp('aria-label="' + label + '"'));
  assert.equal((html.match(/data-action="booth-map-zoom"/g) || []).length, 7);
  assert.equal((html.match(/<svg[^>]*aria-hidden="true"/g) || []).length, 7);
  const css = fs.readFileSync('assets/css/booth-map.css', 'utf8');
  assert.match(css, /\.booth-map-controls[^\{]*\{[^}]*grid-template-columns:\s*repeat\(3,\s*44px\)/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)\s*\{\s*\.booth-map-jump\s*\{\s*display:\s*none/s);
});

test('map loading is announced and controls remain unavailable until image readiness', () => {
  const { E, documentListeners } = harness();
  E.ui.boothMap = null;
  const page = E.boothStampPage();
  assert.match(page, /배치도를 불러오는 중/);
  assert.match(page, /aria-live="polite"/);
  assert.doesNotMatch(page, /data-action="booth-map-zoom"/);
  const editor = E.boothMapEditor();
  assert.match(editor, /배치도를 불러오는 중/);
  assert.match(editor, /class="booth-map-loading" role="status" aria-live="polite"/);
  assert.doesNotMatch(editor, /data-action="booth-map-zoom"/);
  let renders = 0;
  E.render = () => { renders++; };
  const image = { dataset: { fileId: 'floorplan-1' }, closest: selector => selector === '[data-booth-map-image]' ? image : null };
  E.ui.boothMap.imageStatus = {};
  E.ui.boothMap.imageStatus['floorplan-1'] = 'loading';
  const loadEvent = { target: image };
  documentListeners.load(loadEvent);
  documentListeners.load(loadEvent);
  assert.equal(E.ui.boothMap.imageStatus['floorplan-1'], 'ready');
  assert.equal(renders, 1, 'a ready image causes one state transition, not an onload/render loop');
  E.ui.boothMap.imageStatus['floorplan-1'] = 'loading';
  documentListeners.error(loadEvent);
  documentListeners.error(loadEvent);
  assert.equal(E.ui.boothMap.imageStatus['floorplan-1'], 'error');
  assert.equal(renders, 2, 'a failed image settles once into the fallback state');
  assert.doesNotMatch(E.boothStampPage(), /data-action="booth-map-zoom"/);
});

test('failed map image removes ineffective zoom controls but preserves list fallback', () => {
  const { E } = harness();
  E.ui.boothMap = { local: null, selectedId: null, viewport: { scale: 1, x: 0, y: 0 }, imageStatus: { 'floorplan-1': 'error' } };
  const html = E.boothStampPage();
  assert.match(html, /배치도를 표시할 수 없습니다/);
  assert.match(html, /부스 목록에서 위치와 인증 상태/);
  assert.doesNotMatch(html, /data-action="booth-map-zoom"/);
  for (const b of booths) assert.ok(html.includes(b.id));
});

test('public canvas clicks never place or dirty editor pins', () => {
  const { E, documentListeners } = harness();
  E.boothMapLocalState().image = map.published.image;
  E.ui.boothMap.selectedId = 'booth-d';
  let writes = 0;
  E.boothMapSetPoint = () => { writes++; };
  const canvas = { closest: selector => selector === '.booth-map-editor' ? null : null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 200 }) };
  const target = { closest: selector => selector === '[data-map-canvas]' ? canvas : null };
  documentListeners.click({ target, clientX: 40, clientY: 40 });
  assert.equal(writes, 0);
  assert.equal(E.dirty, false);
});

test('409 conflict keeps the edit buffer until an explicit safe refresh action', async () => {
  const { E, calls } = harness();
  const local = E.boothMapLocalState();
  local.image = map.published.image;
  local.points = [{ boothId: 'booth-a', x: .7, y: .8 }];
  local.dirty = true;
  E.remote.bootstrap = async () => { calls.push(['bootstrap']); E.work().boothMap.draft = { version: 8, image: map.published.image, points: [] }; return {}; };
  E.run = async () => { throw Object.assign(Error('version conflict'), { status: 409 }); };
  let conflictRenders = 0;
  E.render = () => { conflictRenders++; };
  await assert.rejects(E.actions['booth-map-save'](), /version conflict/);
  assert.equal(local.dirty, true);
  assert.equal(local.points[0].x, .7);
  assert.equal(local.conflict, true);
  assert.equal(conflictRenders, 1, 'the conflict recovery choices render even though the save rejects');
  const markup = E.boothMapEditor();
  assert.match(markup, /booth-map-rebase/);
  assert.match(markup, /booth-map-discard/);
  await E.actions['booth-map-rebase']();
  assert.equal(local.points[0].x, .7);
  assert.equal(local.expectedDraftVersion, 8);
  assert.equal(local.dirty, true);
  assert.deepEqual(calls.map(call => call[0]), ['bootstrap']);
  E.run = async (name, payload) => { calls.push([name, payload]); return { boothMap: { draft: { version: 9, image: map.published.image, points: payload.points } } }; };
  await E.actions['booth-map-save']();
  assert.equal(calls[1][1].expectedDraftVersion, 8, 'a recovered save uses the version explicitly refreshed by the operator');
  assert.equal(local.dirty, false);
});

test('conflict discard action loads the refreshed authoritative draft only when explicitly chosen', async () => {
  const { E } = harness();
  const local = E.boothMapLocalState();
  local.image = { fileId: 'local-map' };
  local.points = [{ boothId: 'booth-a', x: .8, y: .2 }];
  local.dirty = true;
  E.remote.bootstrap = async () => { E.work().boothMap.draft = { version: 10, image: { fileId: 'server-map' }, points: [{ boothId: 'booth-b', x: .2, y: .3 }] }; };
  await E.actions['booth-map-discard']();
  const refreshed = E.boothMapLocalState();
  assert.equal(refreshed.image.fileId, 'server-map');
  assert.equal(refreshed.expectedDraftVersion, 10);
  assert.equal(refreshed.points[0].boothId, 'booth-b');
});

test('conflict retain action refuses rebase when image or booth set changed and keeps local points', async () => {
  const { E } = harness();
  const local = E.boothMapLocalState();
  local.image = { fileId: 'local-map' };
  local.points = [{ boothId: 'booth-a', x: .8, y: .2 }];
  local.dirty = true;
  local.conflict = true;
  local.conflictBoothIds = booths.map(booth => booth.id);
  E.remote.bootstrap = async () => { E.work().boothMap.draft = { version: 11, image: { fileId: 'changed-map' }, points: [] }; };
  await assert.rejects(E.actions['booth-map-rebase'](), /이미지 또는 부스 구성이 바뀌었습니다/);
  assert.equal(local.points[0].x, .8);
  assert.equal(local.expectedDraftVersion, 0);
  assert.equal(local.dirty, true);
});

test('product entry loads map presentation after its data adapter and its stylesheet', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes('assets/css/booth-map.css'));
  assert.ok(html.indexOf('assets/js/booth-map-data.js') < html.indexOf('assets/js/booth-map-ui.js'));
  assert.ok(html.indexOf('assets/js/booth-map-ui.js') < html.indexOf('assets/js/server-presentation.js'));
});
