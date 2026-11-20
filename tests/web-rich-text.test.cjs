'use strict';

// Notice bodies are a Markdown subset (bold, italic, lists, links, event
// pictures) stored in the existing body field. These tests pin the parser, the
// renderer's safety (no HTML in, no script or foreign fetch out), the server's
// picture rules, and that every attendee surface reads the body the same way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');
const webRequire = createRequire(path.join(WEB, 'package.json'));
const ts = webRequire('typescript');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

function load(file, requireMap = {}) {
  const source = fs.readFileSync(path.join(WEB, file), 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name in requireMap) return requireMap[name];
    return webRequire(name);
  };
  vm.runInNewContext(out, { module, exports: module.exports, require: localRequire, console }, { filename: file });
  return module.exports;
}

const lib = load('lib/rich-text.ts');
// The module runs in its own VM context; plain-data results cross realms via JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));
const parseRichText = (source) => plain(lib.parseRichText(source));
const richImageIds = (source) => plain(lib.richImageIds(source));
const { richPlainText, richSummary, safeHref } = lib;
const serverText = require('../server/rich-text.js');

test('a plain-text notice from before the editor reads the same: single breaks stay breaks, blank lines split paragraphs', () => {
  const blocks = parseRichText('첫 줄\n둘째 줄\n\n새 문단');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].c.map((node) => node.t), ['text', 'br', 'text']);
  assert.equal(richPlainText('첫 줄\n둘째 줄\n\n새 문단'), '첫 줄\n둘째 줄\n\n새 문단');
  assert.deepEqual(parseRichText('  \n\n'), []);
  assert.equal(parseRichText('a\r\nb')[0].c.length, 3, 'Windows line breaks are breaks');
});

test('marks, lists and escapes parse; an editor empty paragraph is only a blank line', () => {
  const [para] = parseRichText('**굵게** 와 *기울임* 과 \\*별표\\*');
  assert.deepEqual(para.c.map((node) => node.t), ['bold', 'text', 'italic', 'text']);
  assert.equal(para.c[3].v, ' 과 *별표*');
  const lists = parseRichText('- 하나\n- 둘\n\n1. 가\n2. 나');
  assert.deepEqual(lists.map((block) => block.t), ['ul', 'ol']);
  assert.equal(lists[0].items.length, 2);
  assert.equal(parseRichText('앞\n\n&nbsp;\n\n뒤').length, 2);
  assert.equal(richPlainText('- 하나\n- 둘'), '• 하나\n• 둘');
  assert.equal(richSummary('**굵게**\n\n- 항목'), '굵게 • 항목');
});

test('links are limited to http(s), mail and phone; pictures are only event files', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('mailto:a@b.kr'), 'mailto:a@b.kr');
  assert.equal(safeHref('tel:+82101234567'), 'tel:+82101234567');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'ftp://x', '//evil.example', 'https://a b']) {
    assert.equal(safeHref(bad), null, bad);
  }
  const [unsafe] = parseRichText('[누르세요](javascript:alert(1))');
  assert.deepEqual(unsafe.c, [{ t: 'text', v: '누르세요' }], 'an unsafe link keeps its words, loses its target');
  const [pic] = parseRichText('![현장](file:file-abc_1) ![밖](https://evil.example/x.png) ![데이터](data:image/png;base64,AAAA)');
  assert.deepEqual(pic.c.filter((node) => node.t === 'image'), [{ t: 'image', fileId: 'file-abc_1', alt: '현장' }]);
  assert.ok(!JSON.stringify(pic).includes('evil.example'), 'a foreign picture URL is never carried');
  assert.deepEqual(richImageIds('![a](file:one) ![b](file:two) ![c](file:one)'), ['one', 'two']);
  assert.deepEqual(richImageIds('**![a](file:in_bold)**'), ['in_bold']);
});

test('the renderer builds elements from data only: raw HTML is text, links are guarded, pictures resolve through the caller', () => {
  const { default: RichText } = load('app/ui/RichText.tsx', {
    react: React,
    'react/jsx-runtime': webRequire('react/jsx-runtime'),
    '../../lib/rich-text': lib,
    './RichText.module.css': { __esModule: true, default: { rich: 'rich', image: 'image' } },
  });
  const html = renderToStaticMarkup(React.createElement(RichText, {
    source: '<script>alert(1)</script> **굵게** [링크](https://example.com)\n\n- 가\n- 나\n\n![현장](file:abc) [나쁜](javascript:alert(1))',
    imageSrc: (id) => `/api/public/events/seoul/files/${id}`,
  }));
  assert.ok(!html.includes('<script'), 'raw HTML is escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('javascript:'), 'unsafe links never reach href');
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">링크<\/a>/);
  assert.match(html, /<ul><li>가<\/li><li>나<\/li><\/ul>/);
  assert.match(html, /<img class="image" src="\/api\/public\/events\/seoul\/files\/abc" alt="현장" loading="lazy"\/>/);
});

test('the server reads the same picture references the web does, and caps them', () => {
  const samples = ['![a](file:one)\n\n![b](file:two) 글 ![c](file:one)', '없음', '![x](https://evil.example/x.png)', '![z](file:a-b_c)'];
  for (const sample of samples) {
    assert.deepEqual(serverText.bodyImageIds(sample), richImageIds(sample), sample);
  }
  assert.equal(serverText.MAX_BODY_IMAGES, 6);
});

test('saving checks each picture is this event\'s image, and the public file route serves exactly the published ones', () => {
  const preparation = fs.readFileSync(path.join(ROOT, 'server/commands/preparation.js'), 'utf8');
  assert.match(preparation, /async function saveNotice\(ctx, input\)/);
  assert.match(preparation, /const imageIds = bodyImageIds\(body\);/);
  assert.match(preparation, /imageIds\.length > MAX_BODY_IMAGES/);
  assert.match(preparation, /ctx\.resolveFile\(\{ fileId \}, \{ eventId: ctx\.event\.id, contentTypes: \['image\/png', 'image\/jpeg', 'image\/webp'\], maxBytes: 600000 \}\)/);
  const files = fs.readFileSync(path.join(ROOT, 'server/files.js'), 'utf8');
  assert.match(files, /\.\.\.ws\.notices\.flatMap\(n => bodyImageIds\(n\.body\)\.map\(fileId => \(\{ fileId \}\)\)\)/);
  assert.match(files, /if \(!refs\.some\(ref => ref && ref\.fileId === fileId\)\) throw failure\(404/);
});

test('every attendee surface renders the body the same safe way; the board shows words only', () => {
  const page = fs.readFileSync(path.join(WEB, 'app/event/[slug]/page.tsx'), 'utf8');
  const home = fs.readFileSync(path.join(WEB, 'app/event/[slug]/home/HomeShell.tsx'), 'utf8');
  const board = fs.readFileSync(path.join(WEB, 'app/screen/[slug]/DisplayBoard.tsx'), 'utf8');
  assert.match(home, /<RichText [^>]*source=\{notice\.body\}[^>]*imageSrc=\{\(fileId\) => `\/api\/public\/events\/\$\{encodeURIComponent\(slug\)\}\/files\/\$\{encodeURIComponent\(fileId\)\}`\}/, 'home');
  // Reopened 2026-11-20: the guide's notices are GuideNoticeList (shared with the console phone), which renders the body through RichText with the event's file route.
  assert.match(page, /<GuideNoticeList notices=\{notices\} imageSrc=\{photoUrl\} \/>/, 'event page');
  assert.match(page, /const photoUrl = \(fileId: string\) => `\/api\/public\/events\/\$\{encodeURIComponent\(slug\)\}\/files\/\$\{encodeURIComponent\(fileId\)\}`/, 'event page file route');
  assert.match(fs.readFileSync(path.join(WEB, 'app/event/[slug]/GuideNoticeList.tsx'), 'utf8'), /<RichText source=\{notice\.body\} imageSrc=\{imageSrc\} \/>/, 'guide notice list');
  assert.equal((board.match(/richPlainText\(notice\.body\)/g) || []).length, 2, 'selected and cycling notice frames');
  assert.doesNotMatch(board, /\{notice\.body\}/);
  assert.doesNotMatch(page + home, /dangerouslySetInnerHTML/);
});
