const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function boot({ stage = 'LIVE', deskOpen = true, mode = 'tablet' } = {}) {
  const event = { id: 'event-1', name: '테스트 행사', slug: 'test', stage, features: ['stamp'] };
  const desk = { id: 'desk-1', name: '입장 데스크', action: 'IN', mode, open: deskOpen };
  const booth = { id: 'booth-1', name: '체험 부스', zone: 'A홀', status: 'OPEN', capacity: 10, used: 4, limit: 2 };
  const workspace = { desks: [desk], booths: [booth], assignments: [{ id: 'assignment-1', accountId: 'staff-1', type: 'DESK', targetId: desk.id }], checks: [], visits: [], participants: [], stampMode: 'STAFF' };
  const handlers = {
    'participant.create': { group: 'onsite', fn() {}, options: {} },
  };
  const E = {
    views: {}, actions: {}, forms: {}, handlers,
    ui: { deskId: desk.id, filters: {}, scanResult: { title: '입장 완료', text: '홍길동' } },
    route: { scope: 'console', assignmentId: 'assignment-1' },
    session: { id: 'staff-1', name: '현장 담당자' },
    state: { accounts: [{ id: 'staff-1', name: '현장 담당자', role: 'DESK' }], events: [event], workspaces: { [event.id]: workspace } },
    esc: value => String(value ?? ''),
    button: (label, action, attrs = '', cls = '') => '<button class="btn ' + cls + '" data-action="' + action + '" ' + attrs + '>' + label + '</button>',
    link: (label, href, cls = '') => '<a class="btn ' + cls + '" href="' + href + '">' + label + '</a>',
    field: (label, name, value = '', type = 'text', attrs = '') => '<label>' + label + '<input name="' + name + '" value="' + value + '" type="' + type + '" ' + attrs + '></label>',
    select: (label, name, options, value, attrs = '') => '<label>' + label + '<select name="' + name + '" ' + attrs + '>' + options.map(([v, text]) => '<option value="' + v + '"' + (v === value ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label>',
    submit: label => '<button class="btn primary" type="submit">' + label + '</button>',
    register(name, group, fn, options = {}) { this.handlers[name] = { group, fn, options }; },
    event: () => event,
    work: () => workspace,
    metrics: () => ({ checked: 0, inside: 0, approved: 0 }),
    head: (title, subtitle = '', action = '') => '<header><h1>' + title + '</h1><p>' + subtitle + '</p>' + action + '</header>',
    eventTabs: () => '<nav class="event-tabs"></nav>',
    stats: () => '<div class="stats"></div>',
    panel: (title, body) => '<section class="panel"><h2>' + title + '</h2>' + body + '</section>',
    table: (headers, rows) => '<table><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>',
    empty: (title, body) => '<div class="empty"><strong>' + title + '</strong><p>' + body + '</p></div>',
    notice: (text, kind = '') => '<div class="notice ' + kind + '">' + text + '</div>',
    badge: (text, kind = '') => '<span class="badge ' + kind + '">' + text + '</span>',
    detail: rows => '<dl>' + rows.map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('') + '</dl>',
    can: () => false,
    consoleURL: page => '#/console/' + page,
    staffURL: assignment => '#/staff/' + assignment.id,
    url: value => value,
    roleNames: { DESK: '데스크 스태프' },
    stages: { PRE: '시작 전', LIVE: '진행 중' },
    registrationStates: { APPROVED: '확정' },
    date: value => value,
    activeAssignments: () => workspace.assignments,
    assignment: () => workspace.assignments[0],
    storageWarning: '',
    dialog() {}, confirm() {}, copyLink() {},
  };
  const document = { body: { classList: { add() {} } }, addEventListener() {}, createElement() { return {}; }, head: { append() {} } };
  const window = { ET: E, addEventListener() {}, location: { hash: '' } };
  const context = { window, document, URLSearchParams, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/field.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/event-flow.js'), 'utf8'), context);
  return { E, event, workspace, desk, booth };
}

test('onsite desk rows show open state and fixed entry or exit direction', () => {
  const { E } = boot({ deskOpen: false });
  const html = E.views.onsite();
  assert.match(html, /입장 처리/);
  assert.match(html, /닫힘/);
});

test('check-in keeps scan result beside the primary QR path and marks name search secondary', () => {
  const { E } = boot();
  const html = E.views.checkin();
  const scanResult = html.indexOf('입장 완료');
  const scanPath = html.indexOf('data-form="desk-scan"');
  const nameSearch = html.indexOf('이름으로 찾기');
  assert.ok(scanResult >= 0 && scanPath > scanResult && scanPath - scanResult < 700, 'scan result should stay in the nearby scan region');
  assert.ok(nameSearch > scanPath, 'name search should follow the QR scan panel');
  assert.match(html, /secondary|보조/);
});

test('booth list uses cards with status, remaining quantity, and per-person limit', () => {
  const { E } = boot();
  const html = E.views.booths();
  assert.match(html, /booth-card/);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /진행/);
  assert.match(html, /남은 수량[\s\S]{0,80}>6개</);
  assert.match(html, /1인 2회/);
});

test('field screens use one warning message for event-not-live and closed-desk states', () => {
  const { E, event, desk } = boot({ stage: 'PRE', deskOpen: false });
  const output = [E.views.onsite(), E.views.checkin(), E.views.booths()];
  E.route.scope = 'staff';
  desk.mode = 'tablet';
  output.push(E.views.staff());
  desk.mode = 'desk';
  output.push(E.views.staff());
  const warnings = output.map(html => html.match(/<div class="field-operation-warning warning"[^>]*>([\s\S]*?)<\/div>/)?.[1]);
  assert.ok(warnings.every(Boolean), 'each field screen should have the shared warning region: ' + warnings.map((warning, index) => index + ':' + String(warning)).join(' | '));
  assert.ok(warnings.every(value => value === warnings[0]), 'warning wording and markup position should be shared');
  assert.ok(output.slice(0, 3).every(html => html.indexOf('field-operation-warning') > html.indexOf('event-tabs')), 'console warning should follow event tabs');
  assert.ok(output.slice(3).every(html => html.indexOf('field-operation-warning') < html.indexOf('field-scan-result-region')), 'staff warning should lead the field content');
  assert.match(warnings[0], /행사가 진행 중이 아니거나 배정 데스크가 닫혀 있습니다/);
  assert.equal(event.stage, 'PRE');
});

test('staff workspace keeps a page-level title and exposes assignment switching in the header', () => {
  const { E, workspace } = boot();
  workspace.assignments.push({ id: 'assignment-2', accountId: 'staff-1', type: 'BOOTH', targetId: 'booth-1' });
  const html = E.views.staff();
  assert.match(html, /<header class="app-header staff-header">[\s\S]*?<h1>입장 데스크<\/h1>/);
  assert.match(html, /class="btn staff-assignment-trigger"[^>]*data-action="choose-assignment"/);
  assert.match(html, /class="staff-primary"/);
  assert.match(html, /class="staff-recent"[\s\S]*최근 처리/);
  assert.ok(html.indexOf('<h1>입장 데스크</h1>') < html.indexOf('최근 처리'), 'page title should precede section titles');
});
