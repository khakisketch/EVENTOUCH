'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function loadPresentation(previewMode = false, connection = { status: 'connected', message: '' }, overrides = {}) {
  const file = path.join(root, 'assets/js/server-presentation.js');
  assert.ok(fs.existsSync(file), 'server-mode presentation must be implemented by the design workspace');
  const copied = { links: [], toasts: [], navigations: [] };
  const E = {
    previewMode, storageMode: previewMode ? 'local' : 'server',
    views: {}, forms: {}, actions: { 'invite-link': data => 'PREVIEW_INVITE_LINK:' + data.token },
    ui: { connectionState: connection },
    state: overrides.state || { accounts: [], invitations: [] },
    session: overrides.session || null,
    route: overrides.route || null,
    remote: {
      status: connection.status, error: connection.message,
      invitationLink: overrides.invitationLink || (() => null),
      acceptInvitation: overrides.acceptInvitation || (async () => {}),
    },
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])),
    icon: () => '', field: (label, name, value = '', type = 'text', attrs = '') => `<label>${label}<input name="${name}" type="${type}" value="${value}" ${attrs}></label>`,
    submit: label => `<button type="submit">${label}</button>`,
    button: (label, action) => `<button data-action="${action}">${label}</button>`,
    notice: message => `<div role="status">${message}</div>`,
    link: (label, href) => `<a href="${href}">${label}</a>`,
    date: value => String(value).slice(0, 10),
    head: title => `<header>${title}</header>`,
    panel: (title, body) => `<section><h2>${title}</h2>${body}</section>`,
    detail: rows => `<dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>`,
    accessPage: (title, message) => `<main>ACCESS:${title}:${message}</main>`,
    url: hash => { copied.links.push(hash); return 'https://product.test/' + hash; },
    copyLink: async url => { copied.copied = url; },
    toast: message => { copied.toasts.push(message); return message; },
    navigate: hash => { copied.navigations.push(hash); },
    loginPage: () => '<main>PREVIEW_SENTINEL</main>',
    invitePage: () => '<main>PREVIEW_INVITE_SENTINEL</main>',
  };
  const window = { ET: E, addEventListener() {}, location: { search: '' } };
  const document = { addEventListener() {}, querySelector: () => null };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, document, URLSearchParams });
  return { E, copied };
}

const INVITE_TOKEN = 'tok-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

test('server login omits demo credentials and role-based account chooser', () => {
  const { E } = loadPresentation();
  const html = E.loginPage();
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /admin@example\.demo|value="eventouch"|체험 비밀번호|역할을 선택하고 계정으로 시작/);
});

test('attendee focus rings use the existing focus token', () => {
  const css = fs.readFileSync(path.join(root, 'assets/css/server-presentation.css'), 'utf8');
  assert.match(css, /\.attendee-site-header nav a:focus-visible[^{]*\{[^}]*outline:3px solid var\(--focus\)/s);
  assert.doesNotMatch(css, /var\(--(?:accent|bg|fg|border)\)/);
});

test('server startup failure is visible and offers recovery before login submission', () => {
  const { E } = loadPresentation(false, { status: 'error', message: 'TEST_SERVER_UNAVAILABLE' });
  const html = E.loginPage();
  assert.match(html, /TEST_SERVER_UNAVAILABLE/);
  assert.match(html, /다시|재시도|연결 확인/);
});

test('explicit preview retains the existing approved preview login presentation', () => {
  assert.match(loadPresentation(true).E.loginPage(), /PREVIEW_SENTINEL/);
});

test('server invite page renders token-free metadata with a password acceptance form', () => {
  const { E } = loadPresentation(false, { status: 'connected', message: '' }, {
    route: { scope: 'invite', page: 'invite', token: INVITE_TOKEN },
  });
  E.state = { invitations: [{ id: 'inv-1', name: '초대 대상', email: 'invitee@example.test', role: 'MANAGER', eventId: 'event-1', status: 'PENDING', expiresAt: '2099-01-01T00:00:00.000Z' }] };
  const html = E.invitePage();
  assert.match(html, /초대 대상/);
  assert.match(html, /invitee@example\.test/);
  assert.match(html, /운영사 구성원/);
  assert.match(html, /data-form="accept-invite-server"/);
  assert.match(html, /name="password"/);
  assert.match(html, /minlength="8"/);
  assert.ok(html.indexOf('invite-identity') < html.indexOf('invite-accept-form'));
  assert.ok(html.indexOf('invite-accept-form') < html.indexOf('invite-access'));
  assert.match(html, /invite-identity[\s\S]*이름[\s\S]*초대 대상[\s\S]*제품 역할[\s\S]*운영사 구성원/);
  assert.match(html, /invite-accept-form[\s\S]*name="password"[\s\S]*초대 수락/);
  assert.match(html, /class="invite-access"[\s\S]*접근 범위[\s\S]*만료/);
  assert.doesNotMatch(html, /이 브라우저의 초대 체험/);
  E.state = { invitations: [] };
  assert.match(E.invitePage(), /사용할 수 없습니다/);
});

test('server invite page surfaces the expired or revoked message from the lookup', () => {
  const { E } = loadPresentation(false, { status: 'error', message: 'INVITE_EXPIRED_SENTINEL' }, {
    route: { scope: 'invite', page: 'invite', token: INVITE_TOKEN },
  });
  E.state = { invitations: [] };
  const html = E.invitePage();
  assert.match(html, /INVITE_EXPIRED_SENTINEL/);
  assert.match(html, /새 초대/);
  assert.match(html, /운영사 구성원/);
});

test('invite acceptance requires a password and routes by the accepted role', async () => {
  const accepted = [];
  const { E, copied } = loadPresentation(false, { status: 'connected', message: '' }, {
    route: { scope: 'invite', page: 'invite', token: INVITE_TOKEN },
    acceptInvitation: async (token, password) => {
      accepted.push({ token, password });
      E.session = { id: 'staff-1', role: 'STAFF' };
      E.state = { invitations: [], workspaces: { 'event-9': { assignments: [{ id: 'as-1', accountId: 'staff-1', type: 'DESK', targetId: 'desk-1' }] } } };
    },
  });
  assert.equal(typeof E.forms['accept-invite-server'], 'function');
  await assert.rejects(E.forms['accept-invite-server']({ password: 'short' }), /8자/);
  assert.equal(accepted.length, 0);
  await E.forms['accept-invite-server']({ password: 'long-password-123' });
  assert.deepEqual(accepted, [{ token: INVITE_TOKEN, password: 'long-password-123' }]);
  assert.deepEqual(copied.navigations, ['#/staff/event-9/as-1']);
  assert.equal(copied.toasts.length, 1);
});

test('accepted manager without a staff assignment lands on the events console', async () => {
  const { E, copied } = loadPresentation(false, { status: 'connected', message: '' }, {
    route: { scope: 'invite', page: 'invite', token: INVITE_TOKEN },
    acceptInvitation: async () => {
      E.session = { id: 'manager-1', role: 'MANAGER' };
      E.state = { invitations: [], workspaces: {} };
    },
  });
  await E.forms['accept-invite-server']({ password: 'long-password-123' });
  assert.deepEqual(copied.navigations, ['#/console/agency/events']);
});

test('server invite link copies only the current-tab link and explains a lost one', async () => {
  const { E, copied } = loadPresentation(false, { status: 'connected', message: '' }, {
    invitationLink: id => (id === 'inv-1' ? '#/invite/live-token' : null),
  });
  await E.actions['invite-link']({ id: 'inv-1', token: '' });
  assert.equal(copied.copied, 'https://product.test/#/invite/live-token');
  await E.actions['invite-link']({ id: 'inv-lost', token: '' });
  assert.equal(copied.copied, 'https://product.test/#/invite/live-token');
  assert.equal(copied.toasts.length, 1);
  assert.match(copied.toasts[0], /철회|다시 초대/);
});

test('preview mode keeps the local invite page and link behavior', () => {
  const { E } = loadPresentation(true, { status: 'preview', message: '' });
  assert.match(E.invitePage(), /PREVIEW_INVITE_SENTINEL/);
  assert.equal(E.actions['invite-link']({ token: 'preview-token' }), 'PREVIEW_INVITE_LINK:preview-token');
});
