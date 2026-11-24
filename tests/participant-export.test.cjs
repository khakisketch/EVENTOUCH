'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');
const XLSX = require('../apps/web/node_modules/xlsx');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/lib/participant-export.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleRef = { exports: {} };
vm.runInThisContext(`(function(exports, module) { ${compiled} })`)(moduleRef.exports, moduleRef);
const { exportFields, exportAnswers, exportFieldsComplete, exportParticipantComplete, participantExportRows, participantCsv, participantExportFilename, csvPhone } = moduleRef.exports;

function fixture() {
  const fields = exportFields([
    { id: 'name', label: '이름', type: 'text' },
    { id: 'employee', label: '사번', type: 'text' },
    { id: 'diet', label: '선택', type: 'select' },
    { id: 'agree', label: '선택', type: 'checkbox' },
    { id: 'employee', label: '중복', type: 'text' },
    { id: 'unsupported', label: '제외', type: 'secret' },
  ]);
  const answers = exportAnswers({ employee: '000123', diet: '=HYPERLINK("https://example.invalid")', agree: true, privateObject: { unexpected: 'ignore' } });
  const people = [{ name: '  =1+1', company: '합성 회사', phone: '01012345678', email: '', group: '일반', status: 'APPROVED', inside: false, everIn: false, answers }];
  return { fields, people, rows: participantExportRows(people, fields, () => '참가 확정') };
}

test('published fields and their values stay aligned in the ordered export', () => {
  const { fields, rows } = fixture();
  assert.deepEqual(fields.map(field => field.id), ['employee', 'diet', 'agree']);
  assert.deepEqual(rows[0].slice(-3), ['사번', '선택', '선택 (agree)']);
  assert.deepEqual(rows[1].slice(-3), ['000123', '=HYPERLINK("https://example.invalid")', '예']);
  assert.equal(rows[1][2], '01012345678');
});

test('export distinguishes missing or malformed source data from a real empty value', () => {
  assert.equal(exportFieldsComplete([]), true);
  assert.equal(exportFieldsComplete(undefined), false);
  assert.equal(exportFieldsComplete([{ id: 'x', label: '항목', type: 'text' }, { id: 'x', label: '중복', type: 'text' }]), false);
  assert.equal(exportFieldsComplete([{ id: 'x', label: '항목', type: 'unsupported' }]), false);
  const fields = [{ id: 'x', label: '항목', type: 'text' }];
  const person = { name: '합성', phone: '', company: '', email: '', group: '일반', status: 'APPROVED', answers: {}, rosterExportAnswerKeys: [] };
  assert.equal(exportParticipantComplete(person, fields), true, 'an unfilled field remains a valid blank');
  assert.equal(exportParticipantComplete({ ...person, answers: { x: '000123' }, rosterExportAnswerKeys: ['x'] }, fields), true);
  assert.equal(exportParticipantComplete({ ...person, answers: { x: 123 }, rosterExportAnswerKeys: ['x'] }, fields), false);
  assert.equal(exportParticipantComplete({ ...person, answers: {}, rosterExportAnswerKeys: ['x'] }, fields), false, 'a missing transmitted answer is not treated as blank');
  assert.equal(exportParticipantComplete({ ...person, answers: null }, fields), false);
  const { phone, ...partial } = person;
  assert.equal(exportParticipantComplete(partial, fields), false, 'a truncated base field is not an empty string');
});

test('unknown attendance is not exported as an absence', () => {
  const { people } = fixture();
  const rows = participantExportRows([{ ...people[0], presenceUnknown: true }], [], () => '참가 확정');
  assert.equal(rows[1][6], '확인 필요');
  assert.match(participantCsv(rows), /확인 필요/);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '참가자');
  const sheet = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }).Sheets['참가자'];
  assert.equal(sheet.G2.v, '확인 필요');
});

test('CSV neutralizes formulas including whitespace and quotes without losing rows', () => {
  const { rows } = fixture();
  const csv = participantCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /'  =1\+1/);
  assert.match(csv, /'\=HYPERLINK\(""https:\/\/example\.invalid""\)/);
  // Reopened 2026-11-24 (P12): a bare 01012345678 loses its 0 in Excel; the hyphenated form stays text.
  assert.match(csv, /010-1234-5678/);
  assert.doesNotMatch(csv, /,01012345678,/);
  assert.match(csv, /000123/);
});

test('XLSX keeps phone and employee number as text and never creates formulas', () => {
  const { rows } = fixture();
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '참가자');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const sheet = XLSX.read(bytes, { type: 'buffer' }).Sheets['참가자'];
  assert.equal(sheet.C2.t, 's');
  assert.equal(sheet.C2.v, '01012345678');
  assert.equal(sheet.H2.t, 's');
  assert.equal(sheet.H2.v, '000123');
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.f, undefined);
  assert.equal(sheet.I2.t, 's');
  assert.equal(sheet.I2.f, undefined);
});

test('CSV phone numbers keep their leading 0 in Excel without a formula wrapper', () => {
  assert.equal(csvPhone('01012345678'), '010-1234-5678');
  assert.equal(csvPhone('0111234567'), '011-123-4567');
  assert.equal(csvPhone('021234567'), '021234567', 'a landline is left as it is');
  assert.equal(csvPhone(''), '');
  const csv = participantCsv([['이름', '소속', '연락처'], ['가', '나', '01012345678'], ['다', '라', '=1+1']]);
  assert.match(csv, /^\uFEFF이름,소속,연락처\r\n가,나,010-1234-5678\r\n다,라,'=1\+1$/);
  assert.doesNotMatch(csv, /="/);
  // The header row is not a phone cell.
  assert.match(participantCsv([['01012345678', 'x', 'y']]), /^\uFEFF01012345678,x,y$/);
});

test('export file name carries the event name and the day, and drops characters a file system rejects', () => {
  const day = new Date(2026, 10, 24, 9, 30);
  assert.equal(participantExportFilename('2027 파트너 컨퍼런스', 'xlsx', day), '2027 파트너 컨퍼런스_참가자명단_20261124.xlsx');
  assert.equal(participantExportFilename('A/B: "행사"?*<>|', 'csv', day), 'A B 행사_참가자명단_20261124.csv');
  assert.equal(participantExportFilename('  ..  ', 'csv', day), '행사_참가자명단_20261124.csv');
  assert.equal(participantExportFilename('가'.repeat(100), 'xlsx', day), `${'가'.repeat(60)}_참가자명단_20261124.xlsx`);
  assert.doesNotMatch(participantExportFilename('x\u0000y\ty', 'csv', day), /[\u0000-\u001f]/u);
});
