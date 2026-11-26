'use strict';

// Attendee audit fixes (2026-11-26). The production components are mounted in a
// small DOM with synthetic network answers; only framework controls (buttons,
// links, router, QR) are stand-ins. Nothing here reaches a server.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const WEB = path.resolve(__dirname, '../apps/web');
const EVENT = path.join(WEB, 'app/event/[slug]');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');
const { parseHTML } = webRequire('linkedom');

const dom = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let focused = null;
dom.window.HTMLElement.prototype.focus = function focus() { focused = this; };
const stored = new Map();
Object.assign(globalThis.window, {
  location: { search: '', pathname: '/event/synthetic/ticket', hash: '' },
  history: { replaceState() {} },
  sessionStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
});
const React = webRequire('react');
const { createRoot } = webRequire('react-dom/client');
const h = React.createElement;

const cssModule = new Proxy({}, { get: (_target, key) => (key === '__esModule' ? false : String(key)) });
const component = (render) => ({ __esModule: true, default: render });
const stubs = {
  'ui/ProductButton': component(({ children, variant, busy, label, icon, size, ...props }) => h('button', { type: 'button', ...props }, children)),
  'ui/ProductLink': component(({ children, variant, size, prefetch, ...props }) => h('a', props, children)),
  'next/link': component(({ children, prefetch, ...props }) => h('a', props, children)),
  'next/navigation': { useRouter: () => ({ push() {}, refresh() {} }) },
  'react-qr-code': component(() => h('svg')),
};
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  modules.set(file, module);
  new Function('exports', 'require', 'module', code)(module.exports, (id) => resolve(id, file), module);
  return module.exports;
}
function resolve(id, from) {
  if (id.endsWith('.css')) return cssModule;
  const stub = Object.keys(stubs).find((name) => id === name || id.endsWith(`/${name}`));
  if (stub) return stubs[stub];
  if (!id.startsWith('.')) return webRequire(id);
  const base = path.resolve(path.dirname(from), id);
  const file = [base, `${base}.tsx`, `${base}.ts`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(file, `resolvable import ${id}`);
  return /\.c?js$/.test(file) ? require(file) : load(file);
}
const screen = (relative) => load(path.join(EVENT, relative)).default;

// DOM nodes are compared with assert.ok: an assert.equal failure would print the whole linked tree.
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async () => { for (let n = 0; n < 6; n += 1) await new Promise(setImmediate); };
let mounted = [];
async function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await React.act(async () => { root.render(element); });
  // Effects run when the act above closes; their reads settle in a second one.
  await React.act(flush);
  return container;
}
afterEach(async () => {
  for (const { root, container } of mounted) {
    await React.act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  focused = null;
  stored.clear();
});
const propsOf = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps'))];
async function type(node, value) {
  await React.act(async () => { propsOf(node).onChange({ target: { value } }); });
}
async function submit(form) {
  await React.act(async () => {
    propsOf(form).onSubmit({ preventDefault() {}, stopPropagation() {}, currentTarget: { elements: [] } });
    await flush();
  });
  await React.act(flush);
}
async function click(node) {
  assert.ok(node, 'the control to press is on screen');
  await React.act(async () => { node.dispatchEvent(new window.Event('click', { bubbles: true })); await flush(); });
  await React.act(flush);
}
const button = (container, label) => [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === label);

// ---- 1 + 7: finding a ticket by phone -------------------------------------------------

async function openCodeStep(contact, requestReply = () => reply({ ok: true, challengeId: null, expiresAt: null })) {
  globalThis.fetch = async () => requestReply();
  const RecoverForm = screen('ticket/recover/RecoverForm.tsx');
  const view = await mount(h(RecoverForm, { slug: 'synthetic', contact }));
  await type(view.querySelector('#recover-phone'), '01012345678');
  await submit(view.querySelector('form'));
  return view;
}

test('after the code is asked for, the guest checks the number and sees who to contact', async () => {
  const view = await openCodeStep('운영 데스크 02-000-0000');
  assert.match(view.textContent, /신청할 때 쓴 번호가 맞는지 확인해 주세요\./u);
  assert.match(view.textContent, /문의: 운영 데스크 02-000-0000/u);
  assert.doesNotMatch(view.textContent, /등록되지 않은|등록된 번호|신청 내역이 없/u, 'registration is never revealed');
});

test('an unconfirmed send gives the same number check, with the plain ask when no contact is published', async () => {
  const view = await openCodeStep('', () => reply({}, 500));
  assert.match(view.textContent, /신청할 때 쓴 번호가 맞는지 확인해 주세요\. 행사 주최 측에 문의하세요\./u);
});

test('the recovery page loads the organizer contact in every verification mode', async () => {
  const page = screen('ticket/recover/page.tsx');
  const RecoverForm = screen('ticket/recover/RecoverForm.tsx');
  const Unavailable = screen('VerificationUnavailable.tsx');
  const find = (node, kind) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === kind) return node;
    return [node.props?.children].flat(Infinity).map((child) => find(child, kind)).find(Boolean) ?? null;
  };
  for (const verification of ['solapi', 'unknown', 'mock', 'none']) {
    globalThis.fetch = async (url) => reply(String(url).endsWith('/api/health')
      ? { verification }
      : { event: { features: [] }, workspace: { participantContact: '02-000-0000' } });
    const tree = await page({ params: Promise.resolve({ slug: 'synthetic' }) });
    const blocked = verification === 'mock' || verification === 'none';
    const shown = find(tree, blocked ? Unavailable : RecoverForm);
    assert.ok(shown, `${verification} renders its recovery block`);
    assert.equal(shown.props.contact, '02-000-0000', `${verification} carries the contact`);
    if (blocked) assert.equal(shown.props.purpose, 'recover');
  }
});

test('a rejected code is tied to its field and the field is focused', async () => {
  const view = await openCodeStep('');
  globalThis.fetch = async () => reply({ error: '인증번호를 확인하세요', field: 'code' }, 401);
  const code = view.querySelector('#recover-code');
  assert.equal(code.getAttribute('aria-describedby'), null);
  await type(code, '000000');
  await submit(view.querySelector('form'));
  assert.equal(code.getAttribute('aria-invalid'), 'true');
  const described = view.querySelector(`#${code.getAttribute('aria-describedby')}`);
  assert.match(described.textContent, /인증번호를 확인하세요/u);
  assert.ok(focused === code, 'the code field is focused');
});

test('a rejected phone number is tied to its field and the field is focused', async () => {
  const view = await openCodeStep('', () => reply({ error: '연락처를 숫자 9~15자리로 입력하세요', field: 'phone' }, 400));
  const phone = view.querySelector('#recover-phone');
  assert.equal(phone.getAttribute('aria-invalid'), 'true');
  assert.match(view.querySelector(`#${phone.getAttribute('aria-describedby')}`).textContent, /9~15자리/u);
  assert.ok(focused === phone, 'the phone field is focused');
});

test('the unavailable block talks about signup only on the signup screen', async () => {
  const Unavailable = screen('VerificationUnavailable.tsx');
  const recover = await mount(h(Unavailable, { slug: 'synthetic', purpose: 'recover' }));
  assert.doesNotMatch(recover.textContent, /신청을 받을 수 없|접수 마감|신청 마감/u);
  assert.match(recover.textContent, /지금은 문자로 티켓을 찾을 수 없습니다/u);
  assert.match(recover.textContent, /인증 문자를 보낼 수 없어 연락처 확인을 마칠 수 없습니다/u);
  const signup = await mount(h(Unavailable, { slug: 'synthetic' }));
  assert.match(signup.textContent, /지금은 신청을 받을 수 없습니다/u);
});

// ---- 2, 4, 5: the ticket --------------------------------------------------------------

async function openTicket(participant, workspace = {}) {
  globalThis.fetch = async (url) => reply(String(url).endsWith('/api/health') ? { verification: 'solapi' } : {
    event: { name: '합성 행사', features: [] },
    participant: { name: '합성 참가자', ticket: 'synthetic-ticket', status: 'APPROVED', paymentStatus: 'FREE', inside: false, everIn: false, ...participant },
    workspace,
  });
  const TicketView = screen('ticket/TicketView.tsx');
  return mount(h(TicketView, { slug: 'synthetic', initialTicket: 'synthetic-ticket' }));
}
const stateChip = (view) => view.querySelector('.ticketEntryState');

for (const [allowReentry, label, tone] of [
  [true, '퇴장 · 재입장할 수 있어요', 'good'],
  [false, '퇴장 · 재입장은 데스크에 문의하세요', 'wait'],
  // A response that does not say so never promises re-entry.
  [undefined, '퇴장 · 재입장은 데스크에 문의하세요', 'wait'],
]) {
  test(`a guest who left reads the event's re-entry rule (${allowReentry})`, async () => {
    const view = await openTicket({ everIn: true }, { allowReentry });
    assert.equal(stateChip(view).textContent, label);
    assert.equal(stateChip(view).getAttribute('data-tone'), tone);
    assert.doesNotMatch(view.textContent, /재입장 정책/u);
  });
}

test('the re-entry rule changes nothing for a guest inside or not yet entered', async () => {
  const inside = await openTicket({ everIn: true, inside: true }, { allowReentry: false });
  assert.equal(stateChip(inside).textContent, '입장 중');
  const fresh = await openTicket({}, { allowReentry: false });
  assert.equal(stateChip(fresh).textContent, '참가 확정');
  assert.equal(stateChip(fresh).getAttribute('data-tone'), 'good');
});

for (const [status, paymentStatus] of [['APPROVED', 'PENDING'], ['APPROVED', ''], ['PENDING', 'PENDING'], ['WAITLIST', 'PENDING']]) {
  test(`an unconfirmed fee (${status}/${paymentStatus || 'blank'}) sends the guest to the organizer, never to pay here`, async () => {
    const view = await openTicket({ status, paymentStatus, ticket: '' }, { participantContact: '02-000-0000' });
    assert.match(view.textContent, /참가비는 주최 측에서 확인합니다\. 문의: 02-000-0000/u);
    assert.doesNotMatch(view.textContent, /결제를|결제하|안내받은 방법/u);
  });
}

for (const status of ['PENDING', 'WAITLIST']) {
  test(`${status} says the result shows here and a text may not come`, async () => {
    const view = await openTicket({ status, paymentStatus: 'FREE', ticket: '' });
    assert.match(view.textContent, /결과는 이 화면에서 확인할 수 있습니다\. 행사에 따라 안내 문자가 오지 않을 수 있으니 상태를 다시 확인해 주세요\./u);
    assert.doesNotMatch(view.textContent, /확정 안내를 받았다면|참가비/u);
  });
}

test('approval wording adds no polling and stays off a confirmed ticket', async () => {
  const view = await openTicket({});
  assert.doesNotMatch(view.textContent, /안내 문자가 오지 않을 수|참가비/u);
  assert.doesNotMatch(fs.readFileSync(path.join(EVENT, 'ticket/TicketView.tsx'), 'utf8'), /setInterval/u);
});

// ---- 4, 5: the application form -------------------------------------------------------

async function openForm(props) {
  const RegisterForm = screen('register/RegisterForm.tsx');
  const view = await mount(h(RegisterForm, {
    slug: 'synthetic', fields: [], consentText: '', consentVersion: 1, formVersion: 1, verificationRequired: false,
    recoveryContact: '02-000-0000', ...props,
  }));
  return view.querySelector('.outcomeNote').textContent;
}

test('a fee-gated signup says the organizer confirms the fee and how to reach them', async () => {
  for (const props of [{ paymentPending: true }, { paymentPending: true, approvalRequired: true }, { paymentPending: true, waitlist: true }]) {
    const note = await openForm(props);
    assert.match(note, /참가비는 주최 측에서 확인합니다\. 문의: 02-000-0000/u);
    assert.doesNotMatch(note, /결제/u);
  }
  assert.match(await openForm({ paymentPending: true, recoveryContact: '' }), /참가비는 주최 측에서 확인합니다\. 행사 주최 측에 문의하세요\./u);
});

test('approval and waitlist signups say where the result shows; an instant ticket does not', async () => {
  for (const props of [{ approvalRequired: true }, { waitlist: true }]) {
    assert.match(await openForm(props), /결과는 신청 후 열리는 내 티켓 화면에서 확인합니다\. 행사에 따라 안내 문자가 오지 않을 수 있습니다\./u);
  }
  const instant = await openForm({});
  assert.doesNotMatch(instant, /안내 문자|참가비/u);
});

// ---- 6: the arrival page --------------------------------------------------------------

async function openArrival({ known, action } = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/ticket')) return reply({}, 404);
    const sent = JSON.parse(init.body);
    const person = { name: '합성 참가자', company: '', deskName: '1번 데스크' };
    if (sent.action === 'view') return reply({ eventName: '합성 행사', deskName: '1번 데스크', open: true, nametag: true, action,
      known: known === undefined ? { name: person.name, company: '', state: null } : known });
    return reply({ ...person, result: action === 'OUT' ? 'left' : 'waiting' });
  };
  const ArriveView = screen('arrive/ArriveView.tsx');
  return mount(h(ArriveView, { slug: 'synthetic', deskId: 'desk' }));
}

for (const [action, label, head] of [['IN', '도착 접수', '접수됐습니다'], ['OUT', '퇴장', '퇴장했습니다']]) {
  test(`after ${label} the result heading takes focus`, async () => {
    const view = await openArrival({ action });
    assert.ok(focused === null, 'loading never moves focus');
    await click(button(view, label));
    const heading = view.querySelector('h1');
    assert.ok(focused === heading, 'the result heading is focused');
    assert.equal(heading.textContent, '합성 참가자');
    assert.equal(heading.getAttribute('tabindex'), '-1');
    const spoken = heading.getAttribute('aria-describedby').split(' ').map((id) => view.querySelector(`#${id}`).textContent);
    assert.equal(spoken[0], head, 'the verdict is read with the name');
  });
}

test('"내가 아니에요" moves focus to the form heading', async () => {
  const view = await openArrival();
  await click(button(view, '내가 아니에요'));
  const heading = view.querySelector('#arrive-title');
  assert.equal(heading.textContent, '신청하신 분인지 확인할게요');
  assert.equal(heading.getAttribute('tabindex'), '-1');
  assert.ok(focused === heading, 'the form heading is focused');
});

test('a page that opens on an earlier result keeps focus where the browser put it', async () => {
  const view = await openArrival({ known: { name: '합성 참가자', company: '', state: 'inside' } });
  assert.match(view.textContent, /이미 입장하셨어요/u);
  assert.ok(focused === null, 'nothing took focus');
});

// ---- 3: plain words in the participant home -------------------------------------------

test('the participant home speaks of tickets and booths in guest words', () => {
  const home = fs.readFileSync(path.join(EVENT, 'home/HomeShell.tsx'), 'utf8');
  for (const gone of [
    '원래 참가자', '원래 티켓', '이전 티켓', '현재 티켓과 섞지', '처음 보낸 행사', '서버 요청을 취소', '늦은 응답',
    '원래 입력은', '운영 시간 미설정', '재고 잔여', '재고 제한 없음', '요청은 다시 보내지', '아직 처리 여부를', '요청을 처리',
  ]) assert.ok(!home.includes(gone), `${gone} is gone`);
  assert.match(home, /const OTHER_TICKET_RESULT = "앞서 열었던 티켓으로 보낸 내용은 확인했습니다\. 지금 티켓의 결과가 아니니 그 티켓을 다시 열어 확인해 주세요\.";/u);
  assert.match(home, /이 내용을 보낸 티켓이 열려 있지 않습니다\. 그 티켓을 다시 연 뒤 확인해 주세요\./u);
  assert.match(home, /운영 시간은 부스에서 확인해 주세요/u);
  assert.match(home, /`남은 수량 \$\{Math\.max\(0, booth\.capacity - booth\.used\)\}개 \(전체 \$\{booth\.capacity\}개\)`/u);
  assert.match(home, /"수량 제한 없음"/u);
});
