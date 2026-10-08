const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function load(files) {
  for (const m of files) { try { delete require.cache[require.resolve(m)]; } catch {} }
  delete globalThis.ETKO;
  delete globalThis.ETQR;
  globalThis.ETKO = {};
  for (const m of files) require(m);
  return globalThis.ETKO;
}

function box() {
  return { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
}

// Every <ul ...> tag in staff markup must carry the shared cards pattern.
function assertCardsLists(html, where) {
  const tags = html.match(/<ul[^>]*>/g) || [];
  assert.ok(tags.length > 0, `${where}: expected at least one list, got none`);
  for (const tag of tags) {
    assert.match(tag, /class="cards"/, `${where}: list misses the cards pattern: ${tag}`);
  }
}

// Empty output must use the shared empty pattern and keep its Korean copy.
function assertEmptyPattern(html, copy, where) {
  assert.match(html, new RegExp(copy), `${where}: empty copy missing`);
  assert.match(html, /data-empty/, `${where}: empty state misses data-empty`);
  assert.match(html, /role="status"/, `${where}: empty state misses role=status`);
}

test('desk lists and empty states share the cards pattern', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js']);
  const b = box();
  ETKO.renderDesks(b);
  assertCardsLists(b.innerHTML, 'desks');
  assertEmptyPattern(b.innerHTML, '개설된 데스크가 없습니다', 'desks');
  assertEmptyPattern(b.innerHTML, '기록이 없습니다', 'desk history');
});

test('content lists, venue note and empties share one pattern', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/content.js']);
  const b = box();
  ETKO.renderContent(b);
  assertCardsLists(b.innerHTML, 'content');
  assertEmptyPattern(b.innerHTML, '등록된 프로그램이 없습니다', 'program');
  assertEmptyPattern(b.innerHTML, '등록된 공지가 없습니다', 'notice');
  assertEmptyPattern(b.innerHTML, '게시글이 없습니다', 'board');
  assertEmptyPattern(b.innerHTML, '행사장 정보가 없습니다', 'venue');
});

test('messaging lists and empties share one pattern', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/messaging.js']);
  const b = box();
  ETKO.renderMessaging(b);
  assertCardsLists(b.innerHTML, 'messaging');
  assertEmptyPattern(b.innerHTML, '저장된 템플릿이 없습니다', 'templates');
  assertEmptyPattern(b.innerHTML, '작성된 캠페인이 없습니다', 'campaigns');
  assertEmptyPattern(b.innerHTML, '발송 기록이 없습니다', 'outbox');
});

test('engagement lists and empties share one pattern', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/engagement.js']);
  ETKO.workspace().poll.options = [];
  const b = box();
  ETKO.renderEngagement(b);
  assertCardsLists(b.innerHTML, 'engagement');
  assertEmptyPattern(b.innerHTML, '선택지가 없습니다', 'poll options');
  assertEmptyPattern(b.innerHTML, '등록된 질문이 없습니다', 'qna');
  assertEmptyPattern(b.innerHTML, '검토할 사진이 없습니다', 'photos');
});

test('booth management and stamp lists share one pattern', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/persist.js', '../features/qrcode.js', '../features/booth.js', '../features/booths.js', '../features/integrations.js']);
  const manage = box();
  ETKO.renderBoothManage(manage);
  assertCardsLists(manage.innerHTML, 'booth manage');
  assertEmptyPattern(manage.innerHTML, '등록된 부스가 없습니다', 'booth manage');
  const stamps = box();
  ETKO.renderStamps(stamps, 'p1');
  assertCardsLists(stamps.innerHTML, 'stamp tour');
  assertEmptyPattern(stamps.innerHTML, '운영 중인 부스가 없습니다', 'stamp tour');
});

test('participant directory cards and empty share one pattern', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/participants.js']);
  const empty = box();
  ETKO.renderPeople(empty, []);
  assertEmptyPattern(empty.innerHTML, '검색 결과가 없습니다', 'directory');
  const full = box();
  ETKO.renderPeople(full);
  assertCardsLists(full.innerHTML, 'directory');
});

test('checkin queue shares the cards pattern with a shared empty', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/participants.js', '../features/checkin.js', '../features/desks.js']);
  const idle = box();
  ETKO.renderCheckin(idle);
  assertEmptyPattern(idle.innerHTML, '대기 중인 항목이 없습니다', 'queue');
  ETKO.setOnline(false);
  const p = ETKO.workspace().participants.find((x) => x.status !== 'IN');
  ETKO.submitTicket(p.code, 'IN');
  const queued = box();
  ETKO.renderCheckin(queued);
  assertCardsLists(queued.innerHTML, 'queue');
  ETKO.setOnline(true);
});

test('participant home schedule list and lookup form share the patterns', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/participants.js', '../features/booth.js']);
  const lookup = box();
  ETKO.renderLookup(lookup, null);
  assert.match(lookup.innerHTML, /class="inline-form"/, 'lookup form misses inline-form');
  ETKO.homeParticipantId = 'p1';
  const home = box();
  try {
    ETKO.renderParticipant(home);
  } finally {
    ETKO.homeParticipantId = null;
  }
  assertCardsLists(home.innerHTML, 'home schedule');
  assertEmptyPattern(home.innerHTML, '등록된 일정이 없습니다', 'home schedule');
});

test('results and settings panels use labeled sections', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/results.js']);
  const results = box();
  ETKO.renderResults(results);
  assert.match(results.innerHTML, /<section class="panel" aria-label="행사 결과">/, 'results panel misses labeled section');
  const settings = box();
  ETKO.renderSettings(settings);
  assert.match(settings.innerHTML, /<section class="panel" aria-label="행사 설정">/, 'settings panel misses labeled section');
});

test('checkin shell ticket row uses the inline-form pattern', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const view = html.split('id="checkin-view"')[1].split('</section>')[0];
  assert.match(view, /class="inline-form"/, 'checkin shell misses inline-form');
  assert.match(view, /data-ticket-submit/, 'ticket submit must stay wired');
  assert.match(view, /id="ticket-code"/, 'ticket input must stay wired');
});

test('audience poll bars use theme tokens, not hardcoded colors', () => {
  const ETKO = load(['../app.js', '../features/agency.js', '../features/persist.js', '../features/registration.js', '../features/engagement.js', '../features/media.js', '../features/content.js', '../features/stage.js', '../features/scenes.js']);
  const ws = ETKO.workspace();
  ws.poll = { title: '만족도 투표', options: ['만족', '보통'], votes: [{ participantId: 'p1', option: 0 }], status: 'CLOSED' };
  const b = box();
  ETKO.renderScreen(b, { preview: 'LOGO', program: 'LOGO', sceneProgram: 'poll-result' });
  assert.match(b.innerHTML, /만족도 투표/, 'poll scene must render');
  assert.match(b.innerHTML, /poll-bar/, 'poll bars miss the theme pattern');
  assert.doesNotMatch(b.innerHTML, /style="background:#eee"/, 'poll bars still hardcode track color');
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'theme.css'), 'utf8');
  assert.match(css, /\.poll-bar/, 'theme misses poll-bar');
  assert.match(css, /var\(--brand\)/, 'poll fill must use the brand token');
});

test('theme carries the shared empty pattern', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'theme.css'), 'utf8');
  assert.match(css, /\[data-empty\]/, 'theme misses the empty pattern');
});

test('nav marks exactly the current view across all ten views', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const views = ['overview', 'participants', 'checkin', 'booth', 'participant', 'engage', 'content', 'messages', 'stage', 'screen'];
  const vm = require('node:vm');
  const buttons = views.map((view) => ({
    view,
    current: null,
    getAttribute(k) { return k === 'data-view' ? this.view : null; },
    setAttribute(k, v) { if (k === 'aria-current') this.current = v; },
    removeAttribute(k) { if (k === 'aria-current') this.current = null; },
    addEventListener() {},
  }));
  const stubDocument = {
    querySelectorAll: (selector) => selector === '[data-view]' ? buttons : [],
    querySelector: (selector) => selector === 'main' ? { setAttribute() {} } : null,
  };
  const sandbox = { console, document: stubDocument, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js' });
  const ETKO = sandbox.window.ETKO || sandbox.ETKO;
  for (const view of views) {
    ETKO.navigate(view);
    for (const btn of buttons) {
      if (btn.view === view) assert.equal(btn.current, 'page', `${view} must be marked current`);
      else assert.equal(btn.current, null, `${btn.view} must not be marked when ${view} is current`);
    }
  }
});
