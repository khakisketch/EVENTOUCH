'use strict';

// Public documents and organizer contact (policy backlog 2026-11-24, decisions 1, 7 and 8).
// Behavior for the pure contact rule, rendered markup for /help /terms /privacy, and source
// contracts for the links. The privacy text is checked against the constants the server really
// uses, so a changed cookie lifetime cannot leave the document saying something else.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps', 'web');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EVENT = 'app/event/[slug]';

// Loads a TS/TSX file and the relative files it imports (CommonJS). CSS modules answer with their own
// class names, next/link renders a plain anchor.
function load(rel, cache = new Map()) {
  const file = path.join(WEB, rel);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  if (file.endsWith('.css')) {
    module.exports = new Proxy({}, { get: (_, key) => String(key) });
    return module.exports;
  }
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(out, {
    module, exports: module.exports, process: { env: {} },
    require: (id) => {
      if (id === 'next/link') {
        const React = webRequire('react');
        return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
      }
      if (id.startsWith('.')) {
        const target = path.resolve(path.dirname(file), id);
        const found = ['', '.ts', '.tsx'].map((ext) => target + ext).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        return load(path.relative(WEB, found || target), cache);
      }
      return webRequire(id);
    },
  }, { filename: file });
  return module.exports;
}

const { publicRecoveryContact, participantContactOf } = load('lib/public-recovery-contact.ts');
const { SUPPORT_EMAIL, supportMailto } = load('lib/support-contact.ts');

// ---- decision 1: the contact attendees are sent to ---------------------------------------------

test('the organizer\'s own contact wins, with or without the venue guide', () => {
  const venue = { venue: { contact: '현장 02-000-0000' }, pageExperience: { published: { showVenue: true } } };
  assert.equal(publicRecoveryContact({ participantContact: '운영 사무국 02-123-4567 · help@example.com', ...venue }, ['venue']), '운영 사무국 02-123-4567 · help@example.com');
  // The field is sent whether or not the venue feature is on.
  assert.equal(publicRecoveryContact({ participantContact: '사무국 02-1' }, []), '사무국 02-1');
  assert.equal(publicRecoveryContact({ participantContact: '사무국 02-1' }, undefined), '사무국 02-1');
  assert.equal(publicRecoveryContact({ participantContact: '  사무국\n 02-1  ', ...venue }, ['venue']), '사무국 02-1');
});

test('without an organizer contact the venue rules still decide (empty, missing, old server, bad shape)', () => {
  const venue = { venue: { contact: '현장 02-000-0000' }, pageExperience: { published: { showVenue: true } } };
  for (const participantContact of ['', '   ', undefined, null, 7, { text: 'x' }, ['x']]) {
    assert.equal(publicRecoveryContact({ participantContact, ...venue }, ['venue']), '현장 02-000-0000');
    assert.equal(publicRecoveryContact({ participantContact, ...venue }, []), '', 'a hidden venue contact stays hidden');
  }
  assert.equal(publicRecoveryContact({ ...venue }, ['venue']), '현장 02-000-0000');
  for (const workspace of [null, undefined, 'x', 3, [], {}]) {
    assert.equal(publicRecoveryContact(workspace, ['venue']), '');
    assert.equal(participantContactOf(workspace), '');
  }
});

test('an over-long contact is cut to the 200 characters the server allows', () => {
  assert.equal(participantContactOf({ participantContact: '가'.repeat(500) }).length, 200);
});

test('every place that sends an attendee to the organizer shows the contact it has', () => {
  const guidance = read(`${EVENT}/attendee-guidance.ts`);
  assert.match(guidance, /value \? `문의: \$\{value\}` : fallback/);
  // Screens that only knew "ask the organizer" now read the public contact once, when they need it.
  const hook = read('lib/use-public-organizer-contact.ts');
  assert.match(hook, /publicRecoveryContact\(data\.workspace, data\.event\?\.features\)/);
  assert.match(hook, /if \(!enabled \|\| !slug\) return;/, 'no read unless the screen is about to say it');
  for (const rel of [`${EVENT}/home/HomeShell.tsx`, `${EVENT}/engage/EngageClient.tsx`, `${EVENT}/ticket/TicketView.tsx`]) {
    const source = read(rel);
    assert.match(source, /usePublicOrganizerContact\(slug, recoveryBlocked\)/, rel);
    assert.doesNotMatch(source, /noTicketHereNote\(\)/, `${rel} no longer says "행사 주최 측" without a contact`);
  }
  const register = read(`${EVENT}/register/RegisterForm.tsx`);
  assert.doesNotMatch(register, /"행사 주최 측에 문의하세요\."/);
  assert.match(register, /organizerContactLine\(recoveryContact\)/);
  // The consent area links the policy in a new tab so the half-filled form stays.
  assert.match(register, /href="\/privacy" target="_blank" rel="noopener noreferrer"/);
  assert.match(read(`${EVENT}/ticket/TicketView.tsx`), /행사 운영자\{state\.contact \? `\(\$\{state\.contact\}\)` : ""\}에게 문의하세요/);
});

// ---- decision 7: one support address ---------------------------------------------------------

test('the support address lives in one place and the landing reads it', () => {
  assert.equal(SUPPORT_EMAIL, 'contact@eventouch.co.kr');
  assert.equal(supportMailto(), 'mailto:contact@eventouch.co.kr');
  assert.equal(supportMailto('도입 문의'), `mailto:contact@eventouch.co.kr?subject=${encodeURIComponent('도입 문의')}`);
  const landing = read('app/page.tsx');
  assert.match(landing, /import \{ SUPPORT_EMAIL as CONTACT_EMAIL \} from "\.\.\/lib\/support-contact";/);
  assert.doesNotMatch(landing, /"contact@eventouch\.co\.kr"/);
  for (const rel of ['app/help/page.tsx', 'app/terms/page.tsx', 'app/privacy/page.tsx']) {
    assert.doesNotMatch(read(rel), /contact@eventouch\.co\.kr/, `${rel} reads the shared constant`);
  }
});

test('the landing footer links the help page and both documents, and "준비 중" is gone', () => {
  const landing = read('app/page.tsx');
  assert.match(landing, /<Link href="\/help">도움말·문의<\/Link>/);
  assert.match(landing, /<Link href="\/terms">이용약관<\/Link>/);
  assert.match(landing, /<Link href="\/privacy">개인정보처리방침<\/Link>/);
  assert.doesNotMatch(landing, /이용약관·개인정보처리방침 준비 중/);
});

test('help and contact are one link away from the console and the staff menu, in a new tab', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /href="\/help" target="_blank" rel="noopener noreferrer" aria-label="도움말·문의 \(새 탭\)"/);
  const staff = read('app/staff/StaffAccountMenu.tsx');
  assert.match(staff, /href="\/help" target="_blank" rel="noopener noreferrer" aria-label="도움말·문의 \(새 탭\)"/);
});

// ---- decisions 7 and 8: the three documents --------------------------------------------------

function render(rel) {
  return renderToStaticMarkup(webRequire('react').createElement(load(rel).default));
}
const pages = {
  help: render('app/help/page.tsx'),
  terms: render('app/terms/page.tsx'),
  privacy: render('app/privacy/page.tsx'),
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');

test('terms and privacy open with the draft band, help does not, and each has one h1', () => {
  const band = '법무 검토 전 초안입니다. 시행일은 정해지지 않았습니다.';
  assert.match(pages.terms, new RegExp(`role="note"[^>]*><strong>초안</strong> ${band}`));
  assert.match(pages.privacy, new RegExp(`role="note"[^>]*><strong>초안</strong> ${band}`));
  assert.doesNotMatch(pages.help, /법무 검토 전 초안/);
  for (const html of Object.values(pages)) assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  // The band comes before the title, so it is the first thing read.
  assert.ok(pages.privacy.indexOf('초안') < pages.privacy.indexOf('<h1'));
});

test('every contents link points at a section that exists, and the main landmark takes the skip link', () => {
  for (const [name, html] of Object.entries(pages)) {
    const toc = [...html.matchAll(/<a href="#([a-z-]+)">/g)].map((match) => match[1]);
    assert.ok(toc.length >= 5, `${name} has a contents list`);
    for (const id of toc) assert.match(html, new RegExp(`<section id="${id}" aria-labelledby="${id}-title"`), `${name}: #${id}`);
    assert.match(html, /<main id="main-content" tabindex="-1"/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, new RegExp(`href="mailto:${SUPPORT_EMAIL}`));
  }
});

test('help covers the four stages and the four questions an operator asks first', () => {
  const body = text(pages.help);
  for (const heading of ['행사 준비 순서', '당일 입장', '메시지 보내기', '마감과 보고서', '자주 묻는 질문', '문의하기']) assert.match(body, new RegExp(heading));
  for (const question of ['참가자가 티켓을 잃어버렸어요', '문자가 안 가요', '사진이 안 올라가요', '스캔이 안 돼요']) assert.match(body, new RegExp(question));
  assert.equal((pages.help.match(/<details/g) ?? []).length, 5, 'questions open in place, no script');
  // Menu names the screens really have.
  for (const label of ['행사 설정', '참가자 명단', '명단 가져오기', '입장·스태프', '현장 모드', '결과 보고서', '경품 지급', '현장 사진', '명단에서 찾기', '티켓 재발급']) assert.match(body, new RegExp(label));
});

test('the privacy text says what the code does: roles, no auto purge, cookie lifetimes', () => {
  const body = text(pages.privacy);
  assert.match(body, /주최 측이 개인정보를 처리하는 책임자입니다/);
  assert.match(body, /EVENTOUCH는 주최 측의 위탁을 받아[^.]*수탁자/);
  assert.match(body, /시스템은 기간이 지났다고 자동으로 삭제하지 않습니다/);
  assert.match(body, /Solapi/);
  assert.match(body, /계정 메일/);
  // What is not decided is listed, not promised.
  assert.match(body, /아직 정해지지 않은 사항/);
  for (const open of ['시행일과 개정 이력', '개인정보 보호책임자', '서버, 데이터베이스, 파일 저장소를 운영하는 업체와 지역', '백업을 보관하는 기간']) assert.match(body, new RegExp(open));
  // Nothing in the text claims an automatic deletion or names an unconfirmed host.
  assert.doesNotMatch(body, /자동으로 파기합니다|자동 파기합니다|Supabase|AWS|Amazon/);
});

test('the cookie numbers in the privacy text are the ones the server uses', () => {
  const attendees = readRoot('server/attendees.js');
  const num = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(attendees)[1]);
  const body = text(pages.privacy);
  assert.match(body, new RegExp(`약 ${num('SESSION_EVENT_TAIL_DAYS')}일까지`));
  assert.match(body, new RegExp(`${num('SESSION_DEFAULT_DAYS')}일입니다`));
  assert.match(body, new RegExp(`최대 ${num('SESSION_MAX_DAYS')}일을 넘지 않습니다`));
  assert.match(body, new RegExp(`인증번호는 ${num('CODE_TTL_MINUTES')}분 동안 유효하고 ${num('CODE_MAX_ATTEMPTS')}번까지`));
  assert.match(attendees, /const ATTENDEE_COOKIE = 'etko_attendee';/);
  assert.match(body, /etko_attendee/);
  const auth = readRoot('server/auth.js');
  assert.match(auth, /const SESSION_COOKIE = 'etko_session';/);
  assert.match(body, /etko_session/);
  assert.match(auth, /SESSION_TTL_HOURS \|\| 12/);
  assert.match(body, /기본 12시간/);
  assert.match(auth, /SESSION_MAX_DAYS \|\| 14/);
  assert.match(body, /기본 14일/);
  // Passwords and codes are stored as hashes, as the text says.
  assert.match(auth, /scrypt/);
  assert.match(readRoot('server/migrations/007_attendee-access.sql'), /sha256 hashes of codes/);
});

test('the terms do not promise what the product does not do', () => {
  const body = text(pages.terms);
  assert.match(body, /서비스는 환불을 직접 해 주지 않습니다/);
  assert.match(body, /서비스는 도착 여부를 보장하지 않으며/);
  assert.match(body, /문자 요금은 행사 대행사가 부담합니다/);
  assert.match(body, /법무 검토를 거쳐 정합니다/);
  assert.doesNotMatch(body, /99\.9|가용성을 보장|손해를 배상합니다/);
});

test('the document frame uses tokens only and keeps a reading width', () => {
  const css = fs.readFileSync(path.join(WEB, 'app/ui/document-page.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((css.match(/#[0-9a-fA-F]{3,8}(?![\w-])/g) ?? []).length, 0, 'no hex colours');
  assert.equal((css.match(/font-size:\s*[\d.]+px/g) ?? []).length, 0, 'no raw font sizes');
  assert.equal((css.match(/border-radius:\s*[\d.]+(?:px|rem)/g) ?? []).length, 0, 'no raw radii');
  assert.match(css, /max-width: 40em;/);
  assert.match(css, /@media \(max-width: 860px\)/);
  for (const weight of css.match(/font-weight:\s*[^;]+/g) ?? []) assert.match(weight, /var\(--fw-(regular|strong|heavy)\)/);
});
