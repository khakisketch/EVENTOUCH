'use strict';

// Locks the approved participant-import composition (DESIGN.md "명단 가져오기
// 확정 구성"): no step line; a drop area, then one review screen whose answer is
// "N명을 등록할 수 있어요"; problems are cards; the column match is a line of
// chips that change in place and a missing required column is asked first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));

const dir = path.join(__dirname, '../apps/web/app/console/events/[id]/participants/import');
const wizardPath = path.join(dir, 'ImportWizard.tsx');
const wizard = fs.readFileSync(wizardPath, 'utf8');
const css = fs.readFileSync(path.join(dir, 'import.module.css'), 'utf8');

test('import is a drop area, then one review screen: no step line, no separate mapping step', () => {
  assert.doesNotMatch(wizard, /importSteps|modalStep|importStep\b/u);
  assert.doesNotMatch(wizard, /검토 결과 만들기|열 연결 수정|검토 취소/u);
  assert.match(wizard, /headingId="participant-import-file-heading"/u);
  assert.match(wizard, /headingId="participant-import-review-heading"/u);
  assert.match(wizard, /<label data-import-dropzone/u);
  assert.match(wizard, /type="file"/u);
  assert.match(css, /\.stage \[data-console-section-head\]/u, 'the section title stays for assistive technology only');
});

test('the review answers with a number, a distribution bar, a sample and tinted problem cards', () => {
  assert.match(wizard, /등록할 수 있어요/u);
  assert.match(wizard, /styles\.heroNumber/u);
  assert.match(wizard, /role="img" aria-label=\{`바로 등록 \$\{cleanCount\}명, 등록 후 확인 \$\{checkCount\}명, 제외 \$\{preview\.errors\.length\}행`\}/u);
  assert.match(wizard, /preview\.valid\.slice\(0, 3\)/u);
  assert.match(wizard, /aria-label="적용될 값 미리보기"/u);
  assert.match(wizard, /data-tone="check"/u);
  assert.match(wizard, /data-tone="skip"/u);
  assert.match(css, /\.notice\[data-tone="check"\]\s*\{[^}]*var\(--warning-soft\)/su);
  assert.match(css, /\.notice\[data-tone="skip"\]\s*\{[^}]*var\(--danger-soft\)/su);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u, 'import carries no literal colors');
});

test('error rows unfold in place and stay reachable by keyboard', () => {
  assert.match(wizard, /aria-expanded=\{errorsOpen\}/u);
  assert.match(wizard, /aria-controls="participant-import-errors"/u);
  assert.match(wizard, /aria-label="가져오기 오류 목록"/u);
  assert.match(wizard, /파일 \{item\.row\}행/u, 'each row names its file row so the original can be fixed');
  assert.match(wizard, /preview\.errors\.slice\(0, 50\)/u);
});

test('the contact check, consent facts and commit gate keep their rules', () => {
  // 2026-11-19: a spreadsheet-dropped leading 0 is restored and listed (not a gate);
  // a malformed email registers the person and is flagged in the roster.
  assert.match(wizard, /앞자리 0을 붙여 등록해요/u);
  assert.match(wizard, /\{item\.raw\} → \{formatPhone\(item\.phone\)\}/u, 'the restored number shows before and after');
  assert.match(wizard, /이메일 \{preview\.emailReview\.length\}건은 형식이 맞지 않아요/u);
  assert.doesNotMatch(wizard, /errors\.push\(\{ row: line, reason: "이메일 형식을 확인하세요" \}\)/u, 'a malformed email no longer drops the row');
  assert.match(wizard, /비슷한 소속 \{companySuggestions\.length\}건이 있어요/u);
  assert.match(wizard, /companyFixes\[row\.company\]/u, 'similar 소속 is only unified when the operator ticks it');
  assert.match(wizard, /가져온 유효 행은 승인 검토 없이 참가 확정으로 등록됩니다\. 동의 기록은 가져오기만으로 생성하지 않습니다\. 열 제목이 행사의 신청 항목 이름과 같으면 그 응답도 함께 가져옵니다\./u);
  assert.doesNotMatch(wizard, /preview\.phoneReview\.length > 0 && !phoneReviewed/u, 'restored phones do not block the commit');
  assert.match(wizard, /같은 요청 다시 시도/u);
  assert.match(wizard, /서버 처리 확인/u);
});

test('TXT guidance names the empty-email-column form', () => {
  assert.match(wizard, /이메일이 없으면 쉼표·탭으로 구분하고 이메일 칸을 비우세요/u);
  assert.match(wizard, /띄어쓰기만으로는 소속을 구분할 수 없습니다/u);
});

test('the column match is chips that change in place; a missing required column is asked first', () => {
  assert.match(wizard, /styles\.mapChips/u);
  assert.match(wizard, /aria-label=\{`\$\{field\.label\}에 연결할 열`\}/u);
  assert.match(wizard, /disabled=\{importLocked \|\| fileKind === "txt"\}/u, 'TXT keeps its fixed order');
  assert.match(wizard, /어느 열이 \{missingLabel\}인가요\?/u);
  assert.match(wizard, /changeColumn\(missingField, String\(index\)\)/u);
  assert.doesNotMatch(wizard, /열 바꾸기/u, 'no separate mode named after the mechanism');
});

test('exactly one orange action per screen', () => {
  const primaries = wizard.match(/variant="primary"/g) || [];
  assert.equal(primaries.length, 3, 'register, and the two close/return choices of the done state');
  assert.doesNotMatch(wizard, /button-primary"[^>]*>[^<]*(등록|반영)/u);
});

// --- column detection -------------------------------------------------------

function load(names, constants) {
  const source = fs.readFileSync(wizardPath, 'utf8');
  const tree = ts.createSourceFile('ImportWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(tree));
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && constants.includes(decl.name.text)) found.set(decl.name.text, node.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  for (const name of [...constants, ...names]) assert.ok(found.has(name), `declaration ${name}`);
  const code = ts.transpileModule([...constants, ...names].map((n) => found.get(n)).join('\n'), { compilerOptions: { target: 'ES2020' } }).outputText;
  const sandbox = {};
  vm.runInNewContext(`${code}\nglobalThis.detectColumns = detectColumns;`, sandbox);
  return sandbox.detectColumns;
}

const detectColumns = load(['detectColumns', 'headerParts', 'normalizePhone'], ['HEADER_WORDS', 'EMPTY_MAP']);
const rows = (...lines) => lines.map((cells, index) => ({ cells, line: index + 2 }));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('header words real Korean spreadsheets use are recognized, including compound headers', () => {
  assert.deepEqual(plain(detectColumns(['성명', '휴대폰', '이메일', '회사/부서', '비고'], [])), { name: '0', phone: '1', email: '2', company: '3' });
  assert.deepEqual(plain(detectColumns(['Name', 'Mobile', 'E-mail', 'Company'], [])), { name: '0', phone: '1', email: '2', company: '3' });
  assert.deepEqual(plain(detectColumns([' 연락처 ', '이 름'], [])), { name: '1', phone: '0', email: '', company: '' });
});

test('phone and email columns are found by their values when the header is unfamiliar', () => {
  const found = detectColumns(['이름', '번호', 'Contact'], rows(['김하늘', '1', 'a@b.co'], ['이서준', '2', 'c@d.kr'], ['한유나', '3', 'e@f.kr']));
  assert.equal(found.name, '0');
  assert.equal(found.phone, '', 'sequence numbers are not phones');
  assert.equal(found.email, '2');
  const phones = detectColumns(['이름', '번호'], rows(['김하늘', '010-2345-6781'], ['이서준', '01099124408'], ['한유나', '(010) 7721 0045']));
  assert.equal(phones.phone, '1');
});

test('a name column is never guessed from values and no column serves two fields', () => {
  const found = detectColumns(['A', 'B'], rows(['김하늘', '010-1234-5678']));
  assert.equal(found.name, '', 'an unrecognized name column is asked, not chosen');
  assert.equal(found.phone, '1');
  const twice = detectColumns(['연락처', '휴대폰'], []);
  assert.equal(twice.phone, '0');
  assert.equal(twice.email, '');
});


// --- the event's extra form fields ------------------------------------------
// (owner decision 2026-11-18: a column titled like an extra form field imports
// its answer). The four standard columns keep working exactly as before.

function loadExtras() {
  const source = fs.readFileSync(wizardPath, 'utf8');
  const tree = ts.createSourceFile('ImportWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['parseExtraFields', 'detectExtraColumns', 'parseChecked', 'readAnswer', 'validateRows', 'headerParts', 'normalizePhone', 'isKoreanMobile', 'detectGroupColumn'];
  const constants = ['OWN_FIELD_IDS', 'CHECKED_WORDS', 'UNCHECKED_WORDS', 'MAX_GROUP', 'GROUP_WORDS'];
  const found = new Map();
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(tree));
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && constants.includes(decl.name.text)) found.set(decl.name.text, node.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  for (const name of [...constants, ...names]) assert.ok(found.has(name), `declaration ${name}`);
  const code = ts.transpileModule([...constants, ...names].map((n) => found.get(n)).join('\n'), { compilerOptions: { target: 'ES2020' } }).outputText;
  const sandbox = {};
  vm.runInNewContext(`${code}\nglobalThis.api = { parseExtraFields, detectExtraColumns, parseChecked, readAnswer, validateRows, detectGroupColumn };`, sandbox);
  return sandbox.api;
}
const extras = loadExtras();
const MEAL = { id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] };
const MEMO = { id: 'memo', label: '요청 사항', type: 'text', required: false, options: [] };
const AGREE = { id: 'agree', label: '마케팅 동의', type: 'checkbox', required: false, options: [] };
const MAIL = { id: 'contact_mail', label: '담당자 메일', type: 'email', required: false, options: [] };
const BASE = { name: '0', phone: '1', email: '', company: '' };
const run = (cells, fields, map) => plain(extras.validateRows(rows(...cells), BASE, { fields, map }));

test('only well-formed extra fields are offered, never the standard columns', () => {
  const parsed = plain(extras.parseExtraFields([
    { id: 'name', label: '이름', type: 'text', required: true },
    { id: 'phone', label: '연락처', type: 'text' },
    { id: 'email', label: '이메일', type: 'email' },
    { id: 'company', label: '소속', type: 'text' },
    { id: 'answers', label: '답', type: 'text' },
    { id: 'meal', label: ' 식사 선택 ', type: 'select', required: true, options: ['일반식', 7, '채식'] },
    { id: 'meal', label: '중복', type: 'text' },
    { id: 'file', label: '첨부', type: 'file' },
    { id: '', label: '이름 없는 id', type: 'text' },
    { id: 'blank-label', label: '  ', type: 'text' },
    null, 'text', [], { id: 5, label: 'x', type: 'text' },
  ]));
  assert.deepEqual(parsed, [{ id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] }]);
  assert.deepEqual(plain(extras.parseExtraFields(undefined)), []);
  assert.deepEqual(plain(extras.parseExtraFields('nope')), []);
});

test('an extra field is found by its label, in a compound header too, and never steals a taken column', () => {
  const fields = [MEAL, MEMO];
  assert.deepEqual(plain(extras.detectExtraColumns(['이름', '연락처', ' 식사_선택 ', '요청 사항'], fields, new Set(['0', '1']))), { meal: '2', memo: '3' });
  assert.deepEqual(plain(extras.detectExtraColumns(['이름', '연락처', '식사 선택/알레르기'], [{ ...MEAL, label: '식사 선택' }], new Set(['0', '1']))), { meal: '2' }, 'a part of a compound header counts');
  assert.deepEqual(plain(extras.detectExtraColumns(['이름', '연락처', '식사 선택'], fields, new Set(['0', '1', '2']))), {}, 'a column a standard field took stays with it');
  assert.deepEqual(plain(extras.detectExtraColumns(['식사 선택', '식사 선택'], [MEAL, { ...MEMO, label: '식사 선택' }], new Set())), { meal: '0', memo: '1' }, 'one column serves one field');
  assert.deepEqual(plain(extras.detectExtraColumns(['이름', '비고'], fields, new Set(['0']))), {}, 'no guessing from values');
});

test('a checkbox column accepts the words people type and nothing else', () => {
  for (const yes of ['예', ' 네 ', 'Y', 'yes', 'TRUE', '1', 'O', '✓']) assert.equal(extras.parseChecked(yes), true, yes);
  for (const no of ['', '아니오', '아니요', 'N', 'No', 'FALSE', '0', '-']) assert.equal(extras.parseChecked(no), false, no);
  for (const odd of ['maybe', '가끔', '2']) assert.equal(extras.parseChecked(odd), null, odd);
});

test('each answer is held to the server rules for its field type', () => {
  const ok = (field, raw) => plain(extras.readAnswer(field, raw));
  assert.deepEqual(ok(MEAL, '채식'), { value: '채식' });
  assert.match(ok(MEAL, '육식').error, /식사 선택의 선택지에 없는 값입니다\(육식\)/);
  assert.match(ok(MEAL, '').error, /식사 선택을\(를\) 입력하세요/, 'a required column cannot be blank');
  assert.deepEqual(ok(MEMO, ''), { value: '' }, 'an optional blank is fine');
  assert.match(ok(MEMO, 'x'.repeat(4001)).error, /4,000자/);
  assert.deepEqual(ok(MAIL, 'owner@example.test'), { value: 'owner@example.test' });
  assert.match(ok(MAIL, 'nope').error, /형식을 확인/);
  assert.deepEqual(ok(AGREE, '예'), { value: true });
  assert.deepEqual(ok(AGREE, '아니오'), { value: false });
  assert.match(ok(AGREE, '가끔').error, /예·아니오로 입력하세요/);
  assert.match(ok({ ...AGREE, required: true }, '아니오').error, /동의\(체크\)해야/);
  assert.deepEqual(ok({ ...MEAL, options: ['A'] }, 'A'), { value: 'A' });
});

test('rows carry answers only for the columns the file has, and the standard result does not change', () => {
  const data = [['김하늘', '01012345678', '채식', '창가', '예'], ['이서준', '01012345679', '일반식', '', '아니오']];
  const out = run(data, [MEAL, MEMO, AGREE], { meal: '2', memo: '3', agree: '4' });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.valid, [
    { name: '김하늘', phone: '01012345678', email: '', company: '', line: 2, answers: { meal: '채식', memo: '창가', agree: true } },
    { name: '이서준', phone: '01012345679', email: '', company: '', line: 3, answers: { meal: '일반식', agree: false } },
  ]);
  // No extra columns mapped: the row is exactly the standard row, with no answers key at all.
  const bare = run(data, [MEAL, MEMO, AGREE], {});
  assert.deepEqual(bare.errors, [], 'a required field with no column never blocks rows');
  assert.equal(Object.hasOwn(bare.valid[0], 'answers'), false);
  assert.deepEqual(plain(extras.validateRows(rows(...data), BASE)).valid, bare.valid, 'omitting the extra argument behaves the same');
});

test('a bad answer is a row error with its file row, and does not poison the duplicate check', () => {
  const out = run([
    ['김하늘', '01012345678', '육식'],
    ['김하늘', '01012345678', '채식'],
    ['이서준', '01012345679', ''],
  ], [MEAL], { meal: '2' });
  assert.deepEqual(out.errors, [
    { row: 2, reason: '식사 선택의 선택지에 없는 값입니다(육식)' },
    { row: 4, reason: '식사 선택을(를) 입력하세요' },
  ]);
  assert.deepEqual(out.valid.map((row) => row.line), [3], 'the first row failed on its answer, so the same phone on row 3 is not a duplicate');
});

// Reopened 2026-11-24 (전수 점검 P1/P2): columns without a field were dropped
// silently, and a nine-digit number counted as "바로 등록". 그룹 is a fifth
// column the server already accepts; a non-mobile number registers but is listed.
test('unmapped columns are announced, 그룹 can be connected, and a non-mobile number is checked after registering', () => {
  assert.match(wizard, /가져오지 않는 열 \{skippedColumns\.length\}개/u);
  assert.match(wizard, /aria-label="그룹에 연결할 열"/u);
  assert.match(wizard, /const MAX_GROUP = 80/u);
  assert.match(wizard, /연락처 \{preview\.phoneCheck\.length\}건은 휴대폰 번호 형식이 아니에요/u);
});

test('a 9-digit number is not "바로 등록" and the server 9~15 digit rule is untouched', () => {
  const source = fs.readFileSync(wizardPath, 'utf8');
  const tree = ts.createSourceFile('ImportWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = ['isKoreanMobile', 'normalizePhone'];
  const parts = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text)) parts.push(node.getText(tree));
    ts.forEachChild(node, visit);
  })(tree);
  const code = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: 'ES2020' } }).outputText;
  const box = {};
  vm.runInNewContext(`${code}\nglobalThis.f = { isKoreanMobile, normalizePhone };`, box);
  const { isKoreanMobile, normalizePhone } = box.f;
  assert.equal(isKoreanMobile(normalizePhone('010-1234-5678')), true);
  assert.equal(isKoreanMobile(normalizePhone('10-1234-5678')), true, 'a dropped leading 0 is restored first');
  assert.equal(isKoreanMobile(normalizePhone('011-123-4567')), true);
  assert.equal(isKoreanMobile(normalizePhone('010-1234-56')), false, 'nine digits');
  assert.equal(isKoreanMobile(normalizePhone('02-123-4567')), false, 'a landline');
  assert.equal(isKoreanMobile(normalizePhone('+1 415 555 0100')), false);
});

test('the 그룹 column is found by header, carried on the row, and capped at the server limit', () => {
  assert.equal(extras.detectGroupColumn(['이름', '연락처', '그룹'], new Set(['0', '1'])), '2');
  assert.equal(extras.detectGroupColumn(['이름', '연락처', '식사 구분', '직책'], new Set(['0', '1'])), '', 'unknown headers are not guessed');
  assert.equal(extras.detectGroupColumn(['그룹', '이름'], new Set(['0'])), '', 'a taken column is not reused');
  const out = plain(extras.validateRows(rows(['김하늘', '01012345678', 'VIP'], ['이서준', '01012345679', '']), BASE, undefined, '2'));
  assert.equal(out.valid[0].group, 'VIP');
  assert.equal(Object.hasOwn(out.valid[1], 'group'), false, 'an empty cell leaves the server default');
  const long = plain(extras.validateRows(rows(['김하늘', '01012345678', 'x'.repeat(81)]), BASE, undefined, '2'));
  assert.match(long.errors[0].reason, /그룹이 80자를 초과합니다/);
  const dup = plain(extras.validateRows(rows(['김하늘', '01012345678'], ['이서준', '010-1234-5678']), BASE));
  assert.match(dup.errors[0].reason, /파일 2행과 같은 연락처/);
  const odd = plain(extras.validateRows(rows(['김하늘', '010-1234-56']), BASE));
  assert.equal(odd.valid.length, 1, 'the server 9~15 digit rule still accepts it');
  assert.deepEqual(odd.phoneCheck.map((item) => item.row), [2]);
});
