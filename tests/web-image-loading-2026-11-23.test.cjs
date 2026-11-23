'use strict';

// Image loading guard (2026-11-23). Files here are authorized, per-person
// bytes served by the API with no-store, so next/image (a cookie-less server
// optimizer that stores derived copies) is deliberately NOT used. What the
// screens can do safely is decode off the main thread, skip offscreen
// downloads, and say which picture matters first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'apps', 'web', 'app');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});
const sources = walk(APP).filter((f) => /\.tsx$/.test(f));

// Every <img ...> opening tag, with the file it lives in.
function imgTags() {
  const out = [];
  for (const file of sources) {
    // Comment lines mention "<img>" in prose; only real JSX counts.
    const source = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join('\n');
    for (const match of source.matchAll(/<img\s[\s\S]*?\/>/gu)) {
      out.push({ file: path.relative(APP, file), tag: match[0] });
    }
  }
  return out;
}

// These decode lazily on their own terms: operator previews that remount per
// edit, the booth map editor (click targets need the settled element), and
// the venue-map preview. Each is one picture the operator just chose.
const EXEMPT_FROM_ASYNC = new Set([
  'console/events/[id]/operations/OperationsWorkspace.tsx',
  'console/events/[id]/messages/MessagingWorkspace.tsx',
  'console/events/[id]/content/ContentWorkspace.tsx',
  'console/events/[id]/photos/EvidencePhotosWorkspace.tsx', // already lazy + async on thumbnails; viewer is the one big picture on purpose
]);

test('every image decodes asynchronously unless it is an operator preview of one chosen picture', () => {
  const tags = imgTags();
  assert.ok(tags.length >= 18, `expected to see the app's images, saw ${tags.length}`);
  for (const { file, tag } of tags) {
    if (EXEMPT_FROM_ASYNC.has(file)) continue;
    assert.match(tag, /decoding="async"/u, `${file} <img> should set decoding="async"`);
  }
});

test('photo lists and thumbnails skip offscreen downloads', () => {
  const lazyFiles = [
    'event/[slug]/engage/EngageClient.tsx',
    'console/events/[id]/programs/ProgramsWorkspace.tsx',
    'console/events/[id]/programs/ReviewDrawer.tsx',
    'console/events/[id]/reports/ReportsWorkspace.tsx',
    'console/clients/ClientsList.tsx',
    'event/[slug]/GuideVenueCard.tsx',
    'event/[slug]/home/AttendeeHomeLanding.tsx',
    'event/[slug]/page.tsx',
    'ui/RichText.tsx',
  ];
  const tags = imgTags();
  for (const file of lazyFiles) {
    const mine = tags.filter((t) => t.file === file);
    assert.ok(mine.length > 0, `${file} has an <img>`);
    for (const { tag } of mine) assert.match(tag, /loading="lazy"/u, `${file} <img> is lazy`);
  }
});

test('the first picture a visitor sees is fetched first, everything else is not', () => {
  const tags = imgTags();
  const high = tags.filter((t) => /fetchPriority="high"/u.test(t.tag)).map((t) => t.file).sort();
  assert.deepEqual(high, ['event/[slug]/EventBanner.tsx', 'event/[slug]/home/HomeHero.tsx']);
  for (const { file, tag } of tags) {
    if (/fetchPriority="high"/u.test(tag)) assert.doesNotMatch(tag, /loading="lazy"/u, `${file}: a prioritised picture is never lazy`);
  }
});

test('next/image stays out: authorized files must not go through a cookie-less optimizer', () => {
  for (const file of sources) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /from ["']next\/image["']/u, `${path.relative(APP, file)} must not import next/image`);
  }
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'api.js'), 'utf8');
  // The contract this guard protects: file bytes are never cached beyond the request.
  assert.match(server, /files\.readPublic[\s\S]{0,400}content-type/u);
  assert.match(server, /res\.setHeader\('cache-control', 'no-store'\);\s*if \(req\.method === 'GET' && parts\[2\] === 'events' && parts\[4\] === 'files'/u);
});
