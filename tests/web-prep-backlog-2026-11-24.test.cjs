'use strict';
// Reopened 2026-11-24 (전수 점검 담당 P, 준비 여정): the roster search reads phone digits, the empty roster
// leads with import, a non-owner is told who can create events, a failed create shows where the operator
// is looking, the login stops empty fields, a missing event offers the list instead of a retry, and
// Korean particles follow the word. Composition of the locked screens is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LIST = read('apps/web/app/console/events/[id]/participants/ParticipantList.tsx');
const HOME = read('apps/web/app/console/ConsoleHome.tsx');
const DIALOG = read('apps/web/app/console/CreateEventDialog.tsx');
const LOGIN = read('apps/web/app/login/LoginForm.tsx');
const REDIRECT = read('apps/web/app/auth-redirect.ts');
const PANEL = read('apps/web/app/console/console-ui/ConsoleStatePanel.tsx');
const TEAM = read('apps/web/app/console/team/TeamWorkspace.tsx');
const PARTICLE = read('apps/web/lib/korean-particle.ts');

function pick(source, names) {
  const tree = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parts = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) parts.push(node.getText(tree));
    ts.forEachChild(node, visit);
  })(tree);
  assert.equal(parts.length, names.length, `functions ${names.join(', ')} found`);
  return parts.join('\n');
}
function load(source, names) {
  const code = ts.transpileModule(pick(source, names).replace(/^export /gm, ''), { compilerOptions: { target: 'ES2020' } }).outputText;
  const box = {};
  vm.runInNewContext(`${code}\nglobalThis.f = { ${names.join(', ')} };`, box);
  return box.f;
}

test('P11: a phone typed with hyphens or spaces finds the person; names still match as typed', () => {
  const { matchesRosterQuery } = load(LIST, ['matchesRosterQuery']);
  const person = { name: '김하늘', company: '한빛', phone: '01012345678' };
  assert.equal(matchesRosterQuery(person, ''), true);
  assert.equal(matchesRosterQuery(person, '010-1234-5678'), true);
  assert.equal(matchesRosterQuery(person, '010 1234'), true);
  assert.equal(matchesRosterQuery(person, '1234-56'), true);
  assert.equal(matchesRosterQuery(person, '010-9999'), false);
  assert.equal(matchesRosterQuery(person, '하늘'), true);
  assert.equal(matchesRosterQuery(person, '한빛'), true);
  assert.equal(matchesRosterQuery(person, '김-1234'), false, 'letters keep the plain text match only');
  assert.match(LIST, /matchesRosterQuery\(person, search\)/u);
});

test('P8: the empty roster leads with import, then a single add, and hides the intake link until intake is open', () => {
  assert.match(LIST, /intakeOpen: workspace\.registrationOpen === true && \["READY", "LIVE"\]/u);
  const empty = LIST.slice(LIST.indexOf('title="아직 등록된 참가자가 없습니다."'));
  assert.ok(empty.indexOf('명단 가져오기') < empty.indexOf('한 명 추가') && empty.indexOf('한 명 추가') < empty.indexOf('참가 신청 링크 복사'));
  assert.match(empty, /<ProductButton type="button" variant="secondary" onClick=\{\(\) => setImportOpen\(true\)\}/u);
  assert.match(empty, /state\.intakeOpen\s*\?\s*<ProductButton type="button" variant="ghost" onClick=\{copyRegistrationLink\}/u);
  assert.match(LIST, /접수를 열면 참가 신청 링크를 쓸 수 있어요\./u);
});

test('P14: 사전 등록 is the default before the event is live and a disabled 등록 says why; a duplicate contact names its holder', () => {
  assert.match(LIST, /const addDefaultType = state\.kind === "ready" && state\.eventStage\.toUpperCase\(\) !== "LIVE" \? "PRE" : "ONSITE"/u);
  assert.match(LIST, /registrationType !== addDefaultType/u);
  assert.match(LIST, /이름을 입력하면 등록할 수 있어요\./u);
  assert.match(LIST, /existingForAdd/u);
  assert.match(LIST, /이미 등록된 사람은 \{existingForAdd\.name\}/u);
});

test('P10: the cancelled-person sentence, the cancel review buttons and the status notice grammar', () => {
  const { presenceSentence } = load(LIST, ['presenceSentence']);
  const base = { inside: false, everIn: false, presenceUnknown: false };
  assert.equal(presenceSentence({ ...base, status: 'CANCELLED' }), '신청이 취소되어 출입 대상이 아닙니다.');
  assert.equal(presenceSentence({ ...base, status: 'PENDING' }), '참가 확정 전이라 출입 대상이 아닙니다.');
  assert.equal(presenceSentence({ ...base, status: 'APPROVED' }), '아직 입장한 기록이 없습니다.');
  assert.match(LIST, /confirmLabel="신청 취소하기"\s*cancelLabel="돌아가기"/u);
  assert.match(LIST, /id="roster-cancel-confirm"/u);
  assert.doesNotMatch(LIST, /\(으\)로 바꿨습니다|\(으\)로 지정했습니다/u);
  assert.doesNotMatch(TEAM, /\(으\)로 바꿨습니다|\(으\)로 바꿉니다/u);
  const { roParticle, eulParticle } = load(PARTICLE, ['lastSyllable', 'finalIndex', 'roParticle', 'eulParticle']);
  assert.equal(roParticle('승인 대기'), '로');
  assert.equal(roParticle('참가 확정'), '으로');
  assert.equal(roParticle('신청 취소'), '로');
  assert.equal(roParticle('대기 명단'), '으로');
  assert.equal(roParticle('서울'), '로', 'a final ㄹ takes 로');
  assert.equal(roParticle('그룹'), '으로');
  assert.equal(roParticle('VIP'), '로', 'not Hangul: no final consonant assumed');
  assert.equal(eulParticle('행사 리마인드'), '를');
  assert.equal(eulParticle('경품'), '을');
});

test('P4: a non-owner sees who can create events, and a failure with no field is shown at the top and brought into view', () => {
  assert.match(HOME, /\/api\/auth\/me/u);
  assert.match(HOME, /setCanCreate\(me\.user\.role === "AGENCY" \|\| me\.user\.orgOwner === true\)/u);
  assert.match(HOME, /canCreate === false \?/u);
  assert.match(HOME, /조직 소유자만 새 행사를 만들 수 있습니다\./u);
  assert.match(HOME, /조직 소유자에게 행사 생성을 요청하세요/u);
  assert.match(HOME, /<ProductButton type="button" variant="ghost" icon=\{<PlusIcon \/>\} onClick=\{\(\) => setCreateOpen\(true\)\}>/u, 'the empty list offers the same action, quietly');
  assert.match(DIALOG, /<p role="alert" ref=\{formFailureRef\} tabIndex=\{-1\}>\{failure\.message\}<\/p>/u);
  assert.match(DIALOG, /note\.scrollIntoView\(\{ block: "nearest" \}\)/u);
  assert.ok(DIALOG.indexOf('ref={formFailureRef}') < DIALOG.indexOf('id="create-name"'), 'the failure sits above the fields');
});

test('P15: the login stops empty fields before sending and says when the session ended', () => {
  assert.match(LOGIN, /이메일을 입력하세요\./u);
  assert.match(LOGIN, /비밀번호를 입력하세요\./u);
  assert.ok(LOGIN.indexOf('이메일을 입력하세요.') < LOGIN.indexOf('fetch("/api/auth/login"'), 'the check runs before the request');
  assert.match(LOGIN, /searchParams\.get\("expired"\) === "1"/u);
  assert.match(LOGIN, /로그인이 만료되었습니다\. \{safeRequested \? "다시 로그인하면 이 화면으로 돌아옵니다\."/u);
  assert.match(REDIRECT, /\? "&" : "\?"\}expired=1/u);
  const tree = ts.createSourceFile('a.ts', REDIRECT, ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(REDIRECT.replace(/export /g, ''), { compilerOptions: { target: 'ES2020' } }).outputText;
  const box = {};
  vm.runInNewContext(`${code}\nglobalThis.f = { loginHref, loginHrefForLocation };`, box);
  assert.equal(box.f.loginHrefForLocation('/console/events/e1/participants', '?q=1'), '/login?next=%2Fconsole%2Fevents%2Fe1%2Fparticipants%3Fq%3D1&expired=1');
  assert.equal(box.f.loginHrefForLocation('/api/x', ''), '/login?expired=1');
  assert.equal(box.f.loginHref('/invite/' + 'a'.repeat(40)), `/login?next=${encodeURIComponent('/invite/' + 'a'.repeat(40))}`, 'invitation links carry no expiry flag');
  assert.ok(tree);
});

test('P16: a missing or forbidden event offers the event list, not a retry', () => {
  const { reasonOf } = load(PANEL, ['reasonOf']);
  assert.equal(reasonOf('행사를 찾을 수 없습니다.'), 'notFound');
  assert.equal(reasonOf('행사에 대한 접근 권한을 확인하세요.'), 'forbidden');
  assert.equal(reasonOf('행사를 찾을 수 없거나 접근 권한이 없습니다.'), 'forbidden');
  assert.equal(reasonOf('연결하지 못했습니다. 다시 시도하세요.'), 'error');
  assert.match(PANEL, /href="\/console"/u);
  assert.match(PANEL, /행사 목록으로/u);
  assert.match(PANEL, /gone \? \(\s*<ProductLink/u);
  assert.match(PANEL, /다시 불러오기/u, 'every other failure keeps its retry');
  assert.match(PANEL, /reason\?: "notFound" \| "forbidden" \| "error"/u, 'callers keep the same props; reason is optional');
});

test('P17: the invite dialog says what each role can do and that no email is sent; the permission tab opens on the nearest event', () => {
  assert.match(TEAM, /이메일은 발송되지 않으니 링크를 직접 전달하세요/u);
  assert.match(TEAM, /조직 구성원은 지정된 행사의 명단·콘텐츠·메시지 등을 운영합니다/u);
  assert.match(TEAM, /현장 스태프는 배정된 행사의 입장 확인 화면만 사용합니다/u);
  assert.match(TEAM, /sortTeamEventsForAssign\(events\)\.map\(\(item\) => \(\s*<option key=\{item\.id\} value=\{item\.id\}>\{teamEventOptionLabel\(item\)\}/u, 'closed events show their stage in the invite list');
  const fn = pick(TEAM, ['closestEventId']);
  const code = ts.transpileModule(fn, { compilerOptions: { target: 'ES2020' } }).outputText;
  const box = {};
  vm.runInNewContext(`${code}\nglobalThis.f = closestEventId;`, box);
  const today = new Date();
  const key = (offset) => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const events = [
    { id: 'old', stage: 'ARCHIVED', date: key(-200) },
    { id: 'later', stage: 'READY', date: key(40) },
    { id: 'soon', stage: 'READY', date: key(5) },
    { id: 'done', stage: 'ENDED', date: key(-2) },
  ];
  assert.equal(box.f(events), 'soon');
  assert.equal(box.f([...events, { id: 'now', stage: 'LIVE', date: key(0) }]), 'now');
  assert.equal(box.f([{ id: 'only', stage: 'ENDED', date: key(-9) }]), 'only');
  assert.equal(box.f([{ id: 'a', stage: 'ENDED', date: key(-9) }, { id: 'b', stage: 'ARCHIVED', date: key(-3) }]), 'b');
  assert.equal(box.f([]), '');
  assert.match(TEAM, /useState\(\(\) => closestEventId\(events\)\)/u);
});

test('P5/P6/P7/P9: planning-stage intake wording, safe address codes, venue pointer and the basics drawer', () => {
  const SETTINGS = read('apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx');
  const CSS = read('apps/web/app/console/events/[id]/settings/settings.module.css');
  assert.match(SETTINGS, /const intakeWaiting = currentStage === "DRAFT" && state\.registrationOpen;/u);
  assert.match(SETTINGS, /장소가 아직 없습니다\. 공지·안내의 장소 안내에서 입력하세요\./u);
  assert.match(SETTINGS, /장소를 입력하려면 장소 안내를 켜야 합니다\./u);
  assert.match(SETTINGS, /placeholder="제한 없음"\s+value=\{basics\.capacity === "0" \? "" : basics\.capacity\}/u);
  assert.doesNotMatch(SETTINGS, /정원 \(0=제한 없음\)/u);
  assert.match(CSS, /div\.scheduleFields \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(CSS, /\.scheduleFields \.twoCols \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u);
  // The verification note sits inside the policy list, right after its checkbox.
  const policy = SETTINGS.slice(SETTINGS.indexOf('<div className={styles.policyList}>'));
  assert.ok(policy.indexOf('참가 신청 전 연락처 인증 필요') < policy.indexOf('인증번호는 신청자의 휴대전화로 발송됩니다') && policy.indexOf('인증번호는 신청자의 휴대전화로 발송됩니다') < policy.indexOf('</div>'));
});

test('P18/P19: logos shrink instead of being refused, client chips say their state, and the fields screen drops version jargon', () => {
  const CLIENTS = read('apps/web/app/console/clients/ClientsList.tsx');
  assert.match(CLIENTS, /const fitted = await fitImage\(file\);/u);
  assert.match(CLIENTS, /로고 \{client\.logoFileId \? "등록됨" : "없음"\}/u);
  const FIELDS = read('apps/web/app/console/events/[id]/settings/fields/FieldsWorkspace.tsx');
  assert.match(FIELDS, /저장된 수정 \{state\.formVersion\}건/u);
  assert.doesNotMatch(read('apps/web/app/console/events/[id]/settings/fields/FieldsPhonePreview.tsx'), /게시 \$\{publishedVersion\}차|초안 버전/u);
});
