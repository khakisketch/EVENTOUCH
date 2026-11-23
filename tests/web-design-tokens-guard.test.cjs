'use strict';

// Design-token ratchet (design-system foundation, 2026-11-20).
//
// The console and attendee CSS modules carried hundreds of hard-coded font
// sizes, radii and hex colours. This guard stops the number from growing:
//   - per CSS file under apps/web/app/console and apps/web/app/event it counts
//       (a) raw px font-size declarations,
//       (b) raw numeric border-radius declarations (999px, 50% and 0 allowed),
//       (c) hex colours (comments ignored);
//   - tests/fixtures/design-token-baseline.json holds the counts at the time of
//     the foundation commit. No file may exceed its baseline, and a file that
//     is not in the baseline (a new file) must have zero of all three;
//   - the new foundation files must stay at zero and may only use the three
//     font weights 400 / 600 / 800 (or --fw-regular / --fw-strong / --fw-heavy).
//
// When a screen is migrated to tokens its counts drop. Lower the baseline so
// the gain is locked in:
//     node tests/web-design-tokens-guard.test.cjs --update
// The updater rewrites the baseline from the current tree. Review the diff:
// a rising number means the ratchet was bypassed, not that the baseline is wrong.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB_APP = path.join(ROOT, 'apps', 'web', 'app');
const SCAN_DIRS = ['console', 'event'];
const BASELINE = path.join(__dirname, 'fixtures', 'design-token-baseline.json');

const FOUNDATION_FILES = [
  'console/console-ui/console-empty-state.module.css',
  'console/console-ui/status-pill.module.css',
  'console/console-ui/console-avatar.module.css',
  'console/console-ui/stat-card.module.css',
  'console/console-ui/list-row.module.css',
  'console/console-ui/count-tabs.module.css',
  'console/console-ui/console-skeleton.module.css',
];
const ALLOWED_WEIGHTS = new Set(['400', '600', '800', 'var(--fw-regular)', 'var(--fw-strong)', 'var(--fw-heavy)']);

function listCss(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCss(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(css, propertyPattern) {
  const re = new RegExp(`(?:^|[;{\\s])(${propertyPattern})\\s*:\\s*([^;}]+)`, 'gi');
  const found = [];
  for (let m = re.exec(css); m; m = re.exec(css)) found.push({ property: m[1], value: m[2].trim() });
  return found;
}

function countFile(file) {
  const css = stripComments(fs.readFileSync(file, 'utf8'));
  const fontSizePx = declarations(css, 'font-size').filter(({ value }) => /\d+(?:\.\d+)?px/i.test(value)).length;
  const radius = declarations(css, 'border(?:-[a-z]+)*-radius').filter(({ value }) => {
    const tokens = value.replace(/\/.*$/s, ' ').split(/\s+/).filter(Boolean);
    return tokens.some((token) => {
      if (/^var\(/i.test(token) || /^calc\(/i.test(token)) return false;
      const match = /^(\d*\.?\d+)(px|rem|em|%)$/i.exec(token);
      if (!match) return false;
      if (Number(match[1]) === 0) return false;
      if (match[2] === '%' && Number(match[1]) === 50) return false;
      if (match[2] === 'px' && Number(match[1]) >= 999) return false;
      return true;
    });
  }).length;
  const hex = (css.match(/#[0-9a-fA-F]{3,8}(?![\w-])/g) || []).length;
  return { fontSizePx, radius, hex };
}

function currentCounts() {
  const counts = {};
  for (const dir of SCAN_DIRS) {
    for (const file of listCss(path.join(WEB_APP, dir))) {
      counts[path.relative(WEB_APP, file).split(path.sep).join('/')] = countFile(file);
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv.includes('--update')) {
  const counts = currentCounts();
  const totals = Object.values(counts).reduce((sum, c) => ({
    fontSizePx: sum.fontSizePx + c.fontSizePx,
    radius: sum.radius + c.radius,
    hex: sum.hex + c.hex,
  }), { fontSizePx: 0, radius: 0, hex: 0 });
  fs.writeFileSync(BASELINE, `${JSON.stringify({
    note: 'Ratchet baseline for tests/web-design-tokens-guard.test.cjs. Counts may only go down. Refresh with: node tests/web-design-tokens-guard.test.cjs --update',
    totals,
    files: counts,
  }, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, BASELINE)}: ${Object.keys(counts).length} files`, totals);
  process.exit(0);
}

const { test } = require('node:test');
const assert = require('node:assert/strict');

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files;
const counts = currentCounts();
const METRICS = [
  ['fontSizePx', 'raw px font-size declarations'],
  ['radius', 'raw numeric border-radius declarations'],
  ['hex', 'hex colours'],
];

test('no console or event CSS file adds hard-coded font sizes, radii or hex colours', () => {
  const regressions = [];
  for (const [file, current] of Object.entries(counts)) {
    const allowed = baseline[file] || { fontSizePx: 0, radius: 0, hex: 0 };
    for (const [key, label] of METRICS) {
      if (current[key] > allowed[key]) {
        regressions.push(`${file}: ${current[key]} ${label} (baseline ${allowed[key]}). Use --text-*, --r-* and colour tokens from tokens.css.`);
      }
    }
  }
  assert.deepEqual(regressions, []);
});

test('the baseline matches real files and the scan covers both areas', () => {
  assert.ok(Object.keys(counts).some((file) => file.startsWith('console/')), 'console CSS is scanned');
  assert.ok(Object.keys(counts).some((file) => file.startsWith('event/')), 'event CSS is scanned');
  // The debt is mostly paid down (2026-11-20 design-system rollout): a zero total is a good result, so the
  // proof that the scan is real is the number of CSS modules it covers, not a positive debt count.
  assert.ok(Object.keys(baseline).length >= 40, 'baseline covers the CSS modules, not an empty tree');
  assert.ok(Object.values(baseline).some((c) => c.fontSizePx > 0 || c.radius > 0 || c.hex > 0), 'the scan still counts something');
});

test('the counter recognises raw values and ignores tokens, comments and allowed radii', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'token-guard-'));
  const file = path.join(tmp, 'sample.css');
  fs.writeFileSync(file, `
    /* color: #ABCDEF; font-size: 13px; border-radius: 7px; */
    .a { font-size: 13px; border-radius: 7px; color: #fff; }
    .b { font-size: var(--text-sm); border-radius: var(--r-card); color: var(--ink); }
    .c { border-radius: 999px; border-top-left-radius: 50%; border-radius: 0; }
    .d { border-radius: 4px 0 var(--r-ctl) 0; background: #1E2026FF; }
  `);
  assert.deepEqual(countFile(file), { fontSizePx: 1, radius: 2, hex: 2 });
});

test('foundation files are fully tokenised and use only the three font weights', () => {
  const problems = [];
  for (const rel of FOUNDATION_FILES) {
    const file = path.join(WEB_APP, rel);
    assert.ok(fs.existsSync(file), `${rel} exists`);
    const current = countFile(file);
    for (const [key, label] of METRICS) {
      if (current[key] !== 0) problems.push(`${rel}: ${current[key]} ${label}`);
    }
    const css = stripComments(fs.readFileSync(file, 'utf8'));
    for (const { value } of declarations(css, 'font-weight')) {
      if (!ALLOWED_WEIGHTS.has(value)) problems.push(`${rel}: font-weight ${value} is outside 400/600/800`);
    }
  }
  assert.deepEqual(problems, []);
});

test('foundation additions to shared console-ui files stay tokenised', () => {
  const css = stripComments(fs.readFileSync(path.join(WEB_APP, 'console/console-ui/console-ui.module.css'), 'utf8'));
  const rule = /\.sectionRule[^{]*\{[^}]*\}/g;
  const blocks = css.match(rule) || [];
  assert.ok(blocks.length >= 2, 'heading="rule" styles exist');
  for (const block of blocks) {
    assert.doesNotMatch(block, /\d+px\b(?!\s*solid)/, `${block.split('{')[0].trim()} uses tokens, not raw px`);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/);
  }
});
