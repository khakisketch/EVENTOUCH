'use strict';

// Locks the approved application-form editor (DESIGN.md "신청 항목 편집 확정
// 구성", mockup fields-options.html, option A): a flat ledger of fields beside
// a redraw of what the attendee will see; editing and excluding live in one
// panel under the list; the write contracts do not change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../apps/web/app/console/events/[id]/settings/fields');
const work = fs.readFileSync(path.join(dir, 'FieldsWorkspace.tsx'), 'utf8');
const preview = fs.readFileSync(path.join(dir, 'FieldsPhonePreview.tsx'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'fields.module.css'), 'utf8');

test('a row is one tap target with two quiet move icons, not four buttons', () => {
  assert.match(work, /className=\{styles\.rowOpen\} aria-label=\{`\$\{field\.label\} 수정`\}/u, 'the row opens its own editor');
  assert.match(work, /aria-label=\{`\$\{field\.label\} 위로 이동`\}/u);
  assert.match(work, /aria-label=\{`\$\{field\.label\} 아래로 이동`\}/u);
  assert.doesNotMatch(work, /aria-label=\{`\$\{field\.label\} 제외`\}/u, 'exclusion no longer repeats on every row');
  assert.match(work, /이 항목 제외/u, 'exclusion lives in the editor');
  assert.match(work, /!\["name", "phone"\]\.includes\(draft\.id\) \? <ProductButton type="button" variant="destructive"/u, 'name and phone cannot be excluded');
});

test('one orange at a time: add while idle, save while editing', () => {
  assert.match(work, /variant="primary" icon=\{<PlusIcon \/>\} disabled=\{!writable \|\| writeLocked \|\| Boolean\(draft\)\}/u, 'add is blocked while a draft is open');
  assert.match(work, /type="submit" variant="primary"/u);
  assert.match(css, /\.phoneCta\s*\{[^}]*var\(--line\)/su, 'the preview button is not a second orange');
});

test('published and draft previews stay separate and use the attendee field controls', () => {
  assert.match(work, /<FieldsPhonePreview eventName=\{state\.name\}/u);
  assert.match(work, /const publishedFields = parsePublishedRegisterFields\(workspace\.publishedFields, "workspace"\)/u, 'the live form uses the attendee parser for the published projection');
  assert.match(work, /publishedFields=\{state\.publishedFields\} draftFields=\{draftPreviewFields\}/u, 'changing a draft cannot mutate the published preview input');
  assert.match(work, /draft\.existing\s*\?\s*state\.fields\.map/u, 'an edited field shows as typed');
  assert.match(work, /\[\.\.\.state\.fields, edited\]/u, 'a new field shows at the end');
  assert.match(work, /id: "company", label: "소속", type: "text", required: false/u, 'the canonical company field can be restored after exclusion');
  assert.match(preview, /aria-hidden="true" inert/u, 'it is not a second form');
  assert.match(preview, /ProductInput/u);
  assert.match(preview, /ProductSelect/u);
  assert.match(preview, /disabled required=\{field\.required\}/u, 'preview controls preserve required state while remaining inert');
});

test('the draft state is one pill and the exclusion confirm sits by its editor', () => {
  assert.match(work, /게시 안 된 변경 있음/u);
  const editor = work.indexOf('<ValidatedForm className={styles.editor}');
  const confirm = work.indexOf('{deleteId ? <ConsoleConfirm');
  const previewAt = work.indexOf('<FieldsPhonePreview');
  assert.ok(editor > 0 && confirm > editor && confirm < previewAt, 'the confirm follows the editor and precedes the preview');
});

test('write, recovery and conflict contracts are unchanged', () => {
  for (const text of ['field.save', 'field.move', 'field.delete', 'expectedFormVersion', 'protectExistingAnswers: true', '신청 항목 처리 확인 필요', '서버 처리 확인', '같은 요청 다시 시도', '확인 전 그만두기', '신청 항목이 변경됐습니다']) {
    assert.ok(work.includes(text), `${text} stays`);
  }
  assert.match(work, /attempt\.command === "field\.save" \|\| attempt\.command === "field\.delete"/u, 'a finished exclusion closes its editor');
});
