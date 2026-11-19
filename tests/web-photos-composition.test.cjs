'use strict';

// Approved on-site photos composition (2026-11-14): coverage bar, section tiles
// with cover photos, and a justified-row gallery (every row the same height,
// every photo its own ratio) with a viewer drawer for per-photo actions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../apps/web/package.json'));
const ts = webRequire('typescript');

const DIR = path.join(__dirname, '..', 'apps/web/app/console/events/[id]/photos');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const workspace = read('EvidencePhotosWorkspace.tsx');
const gallery = read('EvidenceGallery.tsx');
const css = read('evidence-photos.module.css');

function loadPlanRows() {
  const start = gallery.indexOf('export function planRows');
  const end = gallery.indexOf('export default function EvidenceGallery');
  assert.ok(start >= 0 && end > start, 'planRows is locatable');
  const source = gallery.slice(start, end).replace('export function', 'function') + '\nresult = planRows;';
  const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = { result: null };
  vm.runInNewContext(out, sandbox);
  return sandbox.result;
}

test('approved photos design stays locked: coverage, cover tiles, justified gallery, viewer drawer', () => {
  assert.match(workspace, /className=\{styles\.coverage\}/u);
  assert.match(workspace, /className=\{styles\.sectionTiles\}/u);
  assert.match(workspace, /<EvidenceGallery/u);
  assert.match(workspace, /presentation="drawer"/u);
  assert.match(workspace, /variant="primary"[\s\S]{0,260}>사진 올리기<\/ProductButton>/u, 'one orange action: 사진 올리기');
  assert.doesNotMatch(workspace, /ConsoleSection\b|mobileCategoryPicker|categoryGrid|photoManage/u, 'no section panels, no mobile-only picker, no per-photo disclosure');
  assert.match(css, /\.galleryRow\s*\{[^}]*display:\s*flex/su);
});

test('justified rows: equal height per row, ratios kept, last row not stretched, wide photo capped', () => {
  const planRows = loadPlanRows();
  const rows = planRows([1.78, 0.56, 1.33, 0.75, 1.78, 0.56, 1, 1.78], 960, 200, 6);
  assert.ok(rows.length >= 2);
  const covered = rows.reduce((total, row) => total + (row.to - row.from), 0);
  assert.equal(covered, 8, 'every photo lands in exactly one row');
  for (const row of rows.slice(0, -1)) {
    const items = [1.78, 0.56, 1.33, 0.75, 1.78, 0.56, 1, 1.78].slice(row.from, row.to);
    const used = items.reduce((sum, ratio) => sum + ratio * row.height, 0) + 6 * (items.length - 1);
    assert.ok(Math.abs(used - 960) < 0.5, 'a full row fills the container width exactly');
  }
  assert.equal(rows[rows.length - 1].height, 200, 'the last row keeps the target height');
  const lone = planRows([4, 1], 800, 200, 6);
  assert.ok(lone[0].height <= 200 * 1.6 + 1e-9, 'a lone panorama never towers');
});

test('stored sizes lay rows out first; the displayed ratio replaces them on load (EXIF-rotated phone photos)', () => {
  assert.match(gallery, /item\.width && item\.height \? item\.width \/ item\.height : FALLBACK_RATIO/u, 'stored size, else a 4:3 slot');
  assert.match(gallery, /image\.naturalWidth && image\.naturalHeight/u, 'the browser-applied ratio is measured');
  assert.match(gallery, /onLoad=\{\(event\) => remember\(cell\.id, event\.currentTarget\)\}/u);
  assert.match(gallery, /requestAnimationFrame/u, 'measurements are batched so rows re-lay once per frame');
  assert.match(gallery, /aria-label=\{`\$\{cell\.label\} 크게 보기`\}/u, 'each photo is a named button');
});

test('per-photo actions keep their confirmations and move to the neighbour after a change', () => {
  assert.match(workspace, /requestMovePhoto\(viewerPhoto/u);
  assert.match(workspace, /requestRemovePhoto\(viewerPhoto\)/u);
  assert.match(workspace, /<ConsoleConfirm/u);
  assert.match(workspace, /보관함 참조만 제거합니다\. 원본 파일은 삭제되지 않고/u);
  assert.match(workspace, /viewerIndexRef\.current/u, 'a removed or moved photo hands the viewer to its neighbour');
  assert.match(workspace, /event\.key === "ArrowLeft"/u);
  assert.match(workspace, /event\.key === "ArrowRight"/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u, 'tokens only');
});

// Reopened 2026-11-19: same composition, stronger presentation.
// Reopened 2026-11-20 (디자인 시스템 적용): the band is flat (hairline, no grey box); an empty section is amber in the bar,
// on the tile and as a StatusPill; weights, sizes and radii are tokens.
test('Reopened 2026-11-20: flat coverage band, amber for empty sections, tokens only', () => {
  assert.match(css, /\.coverage \{[^}]*border-bottom: 1px solid var\(--line\)/su);
  assert.match(css, /\.coverageBar i \{[^}]*background: var\(--warning-line\)/su, 'a missing section is amber in the bar');
  assert.match(css, /\.tileCount \{[^}]*position: absolute/su, 'the count sits on the cover photo as a chip');
  assert.match(workspace, /<StatusPill tone="wait" size="sm">비어 있음<\/StatusPill>/u, 'an empty tile says so with a pill');
  assert.match(workspace, /<ConsoleEmptyState/u);
  assert.match(css, /a\[data-native-control="download"\] \{[^}]*border-radius: var\(--r-pill\)/su);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u);
  assert.doesNotMatch(css, /font-weight:\s*(?:[1-9]\d\d)\b/u, 'weights are the three tokens, not numbers');
});
