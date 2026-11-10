'use strict';

// Exercise the actual shared client/server parser against the public server
// projection, including older workspaces normalized by the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const web = path.join(root, 'apps/web');
const ts = require(require.resolve('typescript', { paths: [web] }));
const { publicEvent, publicWorkspace } = require('../server/public-events');
const { normalizeWorkspace } = require('../server/state');

function loadParser() {
  const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const contact = {};
  vm.runInNewContext(compile(path.join(web, 'lib/public-recovery-contact.ts')), { exports: contact });
  const parser = {};
  vm.runInNewContext(compile(path.join(web, 'app/event/[slug]/register/register-data.ts')), {
    exports: parser,
    require(id) {
      if (id === '../../../../lib/public-recovery-contact') return contact;
      throw new Error(`Unexpected import ${id}`);
    },
  });
  return parser.parseRegisterData;
}

const parse = loadParser();
const event = publicEvent({ id: 'fixture', slug: 'fixture', payload: {
  name: '합성 행사', stage: 'READY', features: [],
} });
function projection(source) { return { event, workspace: publicWorkspace(normalizeWorkspace(source), event) }; }
function valid() {
  return projection({ registrationOpen: true, publishedVersion: 2, consentText: '합성 동의', consentVersion: 3,
    verificationRequired: true, approvalRequired: false,
    publishedFields: [{ id: 'name', label: '이름', type: 'text', required: true },
      { id: 'phone', label: '연락처', type: 'text', required: true },
      { id: 'meal', label: '식사', type: 'select', required: true, options: ['채식', '일반'] }] });
}

test('normal and normalized legacy public projections remain readable', () => {
  const normal = parse(valid());
  assert.ok(normal);
  assert.equal(normal.consentText, '합성 동의');
  assert.equal(normal.consentVersion, 3);
  assert.equal(normal.verificationRequired, true);
  assert.equal(normal.fields.length, 1);
  const legacy = parse(projection({ registrationOpen: true, publishedVersion: 1, publishedFields: [] }));
  assert.ok(legacy, 'legacy values are filled by the real public projection');
  assert.equal(legacy.consentVersion, 1);
  const noConsent = valid(); noConsent.workspace.consentText = '';
  assert.ok(parse(noConsent), 'an explicitly empty consent is not a missing consent field');
  const oldField = valid(); oldField.workspace.publishedFields[2].type = 'SELECT';
  assert.equal(parse(oldField).fields[0].type, 'select', 'legacy case matches the server validator');
  const optionalEmpty = valid(); optionalEmpty.workspace.publishedFields[2].required = false; optionalEmpty.workspace.publishedFields[2].options = [];
  assert.ok(parse(optionalEmpty), 'a legacy optional field without choices can still be skipped');
});

test('partial or malformed successful public responses do not become a new form', () => {
  const alterations = [
    ['consent text missing', d => { delete d.workspace.consentText; }],
    ['consent text null', d => { d.workspace.consentText = null; }],
    ['consent version missing', d => { delete d.workspace.consentVersion; }],
    ['consent version invalid', d => { d.workspace.consentVersion = 0; }],
    ['verification missing', d => { delete d.workspace.verificationRequired; }],
    ['verification invalid', d => { d.workspace.verificationRequired = 'true'; }],
    ['approval missing', d => { delete d.workspace.approvalRequired; }],
    ['stage missing', d => { delete d.event.stage; }],
    ['stage invalid', d => { d.event.stage = 'unknown'; }],
    ['event name missing', d => { delete d.event.name; }],
    ['features missing', d => { delete d.event.features; }],
    ['feature invalid', d => { d.event.features = [1]; }],
    ['price missing', d => { delete d.workspace.price; }],
    ['price invalid', d => { d.workspace.price = '0'; }],
    ['registration missing', d => { delete d.workspace.registrationOpen; }],
    ['published fields missing', d => { delete d.workspace.publishedFields; }],
    ['form version mismatch', d => { d.workspace.formVersion += 1; }],
    ['field omitted metadata', d => { delete d.workspace.publishedFields[2].required; }],
    ['field invalid type', d => { d.workspace.publishedFields[2].type = 'unknown'; }],
    ['field option invalid', d => { d.workspace.publishedFields[2].options = [1]; }],
    ['required select has no choices', d => { d.workspace.publishedFields[2].options = []; }],
    ['required select has no usable choices', d => { d.workspace.publishedFields[2].options = [' ', '']; }],
    ['required select includes a blank choice', d => { d.workspace.publishedFields[2].options = ['일반', ' ']; }],
    ['field missing id', d => { delete d.workspace.publishedFields[2].id; }],
    ['duplicate custom ids', d => { d.workspace.publishedFields.push({ ...d.workspace.publishedFields[2] }); }],
    ['ids normalize to the same server key', d => { d.workspace.publishedFields.push({ ...d.workspace.publishedFields[2], id: ' meal ' }); }],
  ];
  for (const [name, modify] of alterations) {
    const value = structuredClone(valid()); modify(value);
    assert.equal(parse(value), null, name);
  }
});
