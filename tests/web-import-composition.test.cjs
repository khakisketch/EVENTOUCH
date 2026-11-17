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
  assert.match(wizard, /role="img" aria-label=\{`바로 등록 \$\{cleanCount\}명, 확인 필요 \$\{preview\.phoneReview\.length\}명, 제외 \$\{preview\.errors\.length\}행`\}/u);
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
  assert.match(wizard, /확인할 연락처를 원본과 비교했고, 표시된 번호로 등록합니다\./u);
  assert.match(wizard, /가져온 유효 행은 승인 검토 없이 참가 확정으로 등록됩니다\. 동의 기록은 가져오기만으로 생성하지 않습니다\. 행사별 추가 신청 항목의 응답은 가져오지 않습니다\./u);
  assert.match(wizard, /preview\.phoneReview\.length > 0 && !phoneReviewed && !importUncertain/u);
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
