'use strict';

// Attendee public screens review (2026-11-24, items D1-D13). Behavior where the code is pure
// (link-preview metadata, ink contrast), source contracts for the rest. Screens that were
// confirmed with the owner are not reopened: only their wording, states and spacing change.

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
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const EVENT = 'app/event/[slug]';

// A tiny loader: transpile a TS file and the relative TS files it imports (CommonJS, no React needed).
function loadTs(rel, cache = new Map()) {
  const file = path.join(WEB, rel);
  if (cache.has(file)) return cache.get(file).exports;
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  cache.set(file, module);
  vm.runInNewContext(out, {
    module, exports: module.exports, process: { env: {} },
    require: (id) => {
      if (id.startsWith('.')) return loadTs(path.relative(WEB, path.resolve(path.dirname(file), `${id}.ts`)), cache);
      return webRequire(id);
    },
  }, { filename: file });
  return module.exports;
}

// ---- D1 link-preview metadata ----------------------------------------------------------

const loadedMetadata = loadTs(`${EVENT}/event-metadata.ts`);
// The module runs in its own VM context: compare plain data, not cross-realm objects.
const metadata = {
  buildEventMetadata: (...args) => JSON.parse(JSON.stringify(loadedMetadata.buildEventMetadata(...args))),
};
const payload = (overrides = {}) => ({
  event: { slug: 'spring', name: '봄 컨퍼런스', date: '2027-04-09', start: '10:00', end: '17:00', stage: 'READY', features: ['venue'], ...overrides.event },
  workspace: {
    venue: { name: '코엑스 그랜드볼룸', address: '서울 강남구', contact: '02-0000-0000' },
    pageExperience: { published: { keyvisual: { fileId: 'banner-1' }, homeStyle: { bannerKind: 'image' }, ...overrides.published } },
    ...overrides.workspace,
  },
});

test('an event link carries its own name, date, place and banner', () => {
  const result = metadata.buildEventMetadata('spring', payload(), 'https://eventouch.example');
  assert.equal(result.title, '봄 컨퍼런스 · 4월 9일 참가 신청');
  assert.equal(result.openGraph.title, '봄 컨퍼런스');
  assert.match(result.openGraph.description, /2027년 4월 9일 \(금\) 10:00–17:00 · 코엑스 그랜드볼룸/u);
  assert.equal(result.openGraph.description, result.description);
  assert.equal(result.twitter.title, '봄 컨퍼런스');
  assert.deepEqual(result.openGraph.images, [{ url: '/api/public/events/spring/files/banner-1', alt: '봄 컨퍼런스' }]);
});

test('a banner is only shared when it can be loaded by a crawler', () => {
  // No public base configured: no absolute URL, so no image (the segment keeps the default card).
  assert.equal('images' in metadata.buildEventMetadata('spring', payload(), null).openGraph, false);
  // A fill banner, or an inline picture, is not a file a crawler can fetch.
  assert.equal('images' in metadata.buildEventMetadata('spring', payload({ published: { homeStyle: { bannerKind: 'solid' } } }), 'https://x.example').openGraph, false);
  assert.equal('images' in metadata.buildEventMetadata('spring', payload({ published: { keyvisual: { data: 'data:image/png;base64,AAAA' } } }), 'https://x.example').openGraph, false);
  assert.equal('images' in metadata.buildEventMetadata('spring', payload({ published: { keyvisual: null } }), 'https://x.example').openGraph, false);
});

test('hidden date and venue never reach a link preview, and an unknown event keeps the general title', () => {
  const hidden = metadata.buildEventMetadata('spring', payload({ published: { showSchedule: false, showVenue: false } }), null);
  assert.equal(hidden.title, '봄 컨퍼런스 · 참가 신청');
  assert.equal(hidden.description, '봄 컨퍼런스 참가 신청과 행사 안내');
  assert.doesNotMatch(JSON.stringify(hidden), /코엑스|2027|4월/u);
  assert.deepEqual(metadata.buildEventMetadata('x', { event: null }, null), {});
  assert.deepEqual(metadata.buildEventMetadata('x', null, null), {});
  assert.deepEqual(metadata.buildEventMetadata('x', { event: { name: '   ' } }, null), {});
});

test('the event layout publishes the metadata and the segment keeps the default share card', () => {
  const layout = read(`${EVENT}/layout.tsx`);
  assert.match(layout, /export async function generateMetadata\(\{ params \}/);
  assert.match(layout, /loadEventMetadata\(slug\)/);
  assert.equal(/export const metadata/.test(layout), false);
  const og = read(`${EVENT}/opengraph-image.tsx`);
  assert.match(og, /import OpengraphImage from "\.\.\/\.\.\/opengraph-image"/);
  assert.match(og, /export const size = \{ width: 1200, height: 630 \};/);
  assert.match(og, /export default OpengraphImage;/);
  // A failed read never fails the page.
  assert.match(read(`${EVENT}/event-metadata.ts`), /catch \{\s*return \{\};/);
});

// ---- D4 / D8 one explanation of where a ticket reopens ---------------------------------

test('where a ticket reopens is said once, on the ticket, and as the browser, not the tab', () => {
  const guidance = read(`${EVENT}/attendee-guidance.ts`);
  assert.match(guidance, /이 브라우저에서는 티켓을 다시 열 수 있습니다\. 다른 기기나 시크릿 창에서는 열리지 않으니 입장 QR 화면을 캡처해 두세요\./);
  const screens = [
    `${EVENT}/page.tsx`, `${EVENT}/register/page.tsx`, `${EVENT}/register/RegisterForm.tsx`, `${EVENT}/ticket/TicketView.tsx`,
    `${EVENT}/home/HomeShell.tsx`, `${EVENT}/engage/EngageClient.tsx`, `${EVENT}/VerificationUnavailable.tsx`,
  ];
  for (const rel of screens) {
    assert.doesNotMatch(read(rel), /브라우저 탭|탭을 닫지|탭을 찾을 수 없다면|다른 탭이나 기기/, `${rel} keeps no tab promise`);
  }
  // The contact the organizer published is shown next to "문의" where the screen has it.
  assert.match(guidance, /export function organizerContactLine/);
  assert.match(read(`${EVENT}/ticket/TicketView.tsx`), /organizerContactLine\(state\.contact\)/);
  assert.match(read(`${EVENT}/ticket/TicketView.tsx`), /contact: publicRecoveryContact\(data\.workspace, data\.event\?\.features\)/);
});

test('the transport behind a blocked verification is never named to an attendee', () => {
  const view = read(`${EVENT}/VerificationUnavailable.tsx`);
  assert.doesNotMatch(view, /모의 발송|문자 발송 설정/);
  assert.equal((view.match(/이미 신청했다면|이 화면에서는/g) ?? []).length <= 1, true, 'no repeated paragraphs');
});

// ---- D5 ticket screen -------------------------------------------------------------------

test('the ticket shows its receipt once and folds it away', () => {
  const view = read(`${EVENT}/ticket/TicketView.tsx`);
  assert.match(view, /const \[receiptFolded, setReceiptFolded\] = useState\(false\);/);
  assert.match(view, /window\.setTimeout\(\(\) => setReceiptFolded\(true\), RECEIPT_VISIBLE_MS\)/);
  assert.match(view, /data-folded=\{receiptFolded \|\| undefined\} aria-hidden=\{receiptFolded \|\| undefined\}/);
});

// ---- D6 photo upload shrinks instead of refusing ----------------------------------------

test('a participant photo over the limit is shrunk, not refused', () => {
  const client = read(`${EVENT}/engage/EngageClient.tsx`);
  assert.match(client, /import \{ fitImage \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/image-fit";/);
  assert.match(client, /const fitted = await fitImage\(photo\.file, PHOTO_UPLOAD_MAX_BYTES\);/);
  assert.doesNotMatch(client, /600KB 이하/);
  assert.match(client, /큰 사진은 자동으로 줄여서 올렸습니다/);
  // A retry of an unconfirmed upload keeps the file already fitted: it is only fitted on the first attempt.
  assert.match(client, /if \(!prior && photo\.file\.size > PHOTO_UPLOAD_MAX_BYTES\)/);
});

// ---- D7 engage -------------------------------------------------------------------------

test('engage: one confirmation per answer, finished tabs say so, missing survey rows are marked', () => {
  const client = read(`${EVENT}/engage/EngageClient.tsx`);
  const css = read(`${EVENT}/engage/engage.module.css`);
  assert.match(client, /pending\.command === "response\.submit" \? null : successMessage/);
  assert.doesNotMatch(client, /이미 제출했습니다/);
  assert.match(client, /<span className=\{styles\.tabDone\} role="img" aria-label="제출 완료">/);
  // A survey is checked before it is sent: the first unscored row is marked, scrolled to and focused.
  assert.match(client, /const missing = module\.questions\.filter\(\(question\) => !Object\.hasOwn\(props\.ratings, question\)\);/);
  assert.match(client, /row\?\.scrollIntoView\(\{ block: "center" \}\);\s*row\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(client, /점수를 선택하세요\./);
  assert.match(css, /\.fieldset\[data-missing\]\s*\{[^}]*var\(--danger\)/s);
  // The list of questions no longer sits on the submit button.
  assert.match(css, /\.entryList\s*\{[^}]*margin:\s*var\(--s4\) 0 0/s);
});

// ---- D8 names --------------------------------------------------------------------------

test('the home has one name, "참가자 홈", and the guide one, "행사 안내"', () => {
  for (const rel of [`${EVENT}/engage/EngageClient.tsx`, `${EVENT}/home/HomeShell.tsx`, `${EVENT}/ticket/page.tsx`]) {
    assert.doesNotMatch(read(rel), /참가 메뉴(?!")/, `${rel} does not call the home "참가 메뉴"`);
  }
  assert.match(read(`${EVENT}/engage/EngageClient.tsx`), /참가자 홈으로/);
  assert.match(read(`${EVENT}/ticket/page.tsx`), /← 참가자 홈으로/);
});

// ---- D9 application ---------------------------------------------------------------------

test('an existing ticket is offered first on the application, as a button', () => {
  const page = read(`${EVENT}/register/page.tsx`);
  assert.match(page, /<span>이미 신청하셨어요<\/span>/);
  assert.match(page, /<ProductLink className="button button-secondary" href=\{`\/event\/\$\{encodeURIComponent\(slug\)\}\/ticket`\} prefetch=\{false\}>\s*내 티켓 열기/);
  // 2026-11-27: the form under the ticket row is for another person; the row says so once.
  assert.match(page, /다른 분을 신청하는 화면입니다\./);
  assert.match(read(`${EVENT}/register/register.module.css`), /\.ticketChoice\s*\{[^}]*display:\s*flex/s);
  assert.match(read(`${EVENT}/register/register.module.css`), /\.ticketChoiceGroup\s*\{[^}]*display:\s*grid/s);
});

// ---- D10 staff wording ------------------------------------------------------------------

test('staff: the direction notice says "바뀐" only when the direction changed, one voice, and 3:14 not 03:14', () => {
  const work = read('app/staff/StaffEventWork.tsx');
  assert.match(work, /const directionChanged = Boolean\(directionReview && directionReview\.from !== null && directionReview\.from !== directionReview\.to\);/);
  assert.match(work, /directionChanged \? "바뀐 데스크 방향을 확인한 뒤 진행하세요\." : "데스크 업무 방향을 확인한 뒤 진행하세요\."/);
  assert.match(work, /result\.alreadyIn \? "이미 입장했습니다"/);
  assert.doesNotMatch(work, /이미 입장했어요/);
  assert.match(work, /\{ hour: "numeric", minute: "2-digit" \}\)\.format\(date\)/);
  const parts = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date('2027-04-09T06:14:00Z'));
  assert.equal(parts, '오후 3:14');
});

// ---- D11 404 ----------------------------------------------------------------------------

test('an unknown event address points to the address and the organizer, not the product site', () => {
  const notFound = read(`${EVENT}/not-found.tsx`);
  assert.match(notFound, /문자나 안내문에 적힌 주소를 다시 확인하거나, 행사 주최 측에 문의해 주세요\./);
  assert.doesNotMatch(notFound, /ProductLink|href=/);
});

// ---- D12 contrast -----------------------------------------------------------------------

test('accent text on an a2 ground is darkened until it reads at 4.5:1', () => {
  const palette = loadTs('lib/event-palette.ts');
  const home = loadTs('lib/attendee-home.ts');
  // The reported pair: #B24E14 over the sky ground #B9DEF0 read 3.69:1.
  assert.ok(home.contrastRatio('#B24E14', '#B9DEF0') < 4.5);
  for (const [accent, ground] of [['#B24E14', '#B9DEF0'], ['#EA552E', '#B9DEF0'], ['#2B6CB0', '#B9DEF0'], ['#FFD400', '#1E2026'], ['#EA552E', '#FFE8D9']]) {
    assert.ok(home.contrastRatio(palette.accentInkOn(accent, ground), ground) >= 4.5, `${accent} on ${ground}`);
  }
  // A color that already reads keeps its own ink: no needless change on a white-like ground.
  assert.equal(palette.accentInkOn('#EA552E', '#FFFFFF'), palette.deriveEventPalette('#EA552E').accentInk);
  const surface = read(`${EVENT}/ui/AttendeeSurface.tsx`);
  assert.match(surface, /"--ev-ground-accent-ink": accentInkOn\(accentColor, groundColor\)/);
  assert.match(read(`${EVENT}/home/home-layouts.module.css`), /\[data-attendee-mode="a2"\] \.circle \.needTicket\s*\{\s*color:\s*var\(--ev-ground-accent-ink/);
});

// ---- D13 roulette -----------------------------------------------------------------------

test('a closed roulette no longer also says its prizes are not ready, and there is no English label', () => {
  const shell = read(`${EVENT}/home/HomeShell.tsx`);
  assert.match(shell, /open \|\| result \? <p className=\{styles\.rouletteWaiting\} role="status">룰렛 경품이 아직 준비되지 않았습니다\.<\/p> : null/);
  assert.match(shell, /룰렛 운영이 종료되었습니다\./);
  assert.doesNotMatch(shell, /E-Ticket|E-TICKET/);
  assert.equal((shell.match(/럭키 티켓/g) ?? []).length, 2);
});
