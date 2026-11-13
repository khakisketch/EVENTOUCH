'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.join(__dirname, '../apps/web/app');
// Per-file ceiling of secondary (white bordered) buttons. Lower a number when a
// screen is redesigned; raising one needs a role decision (DESIGN.md "Action role rules").
const SECONDARY_CEILING = require('./fixtures/button-role-ceilings.json');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.next') walk(full, out); }
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function buttonTags(src) {
  const tags = [];
  const re = /<ProductButton\b/g;
  let match;
  while ((match = re.exec(src))) {
    let i = match.index + 14, depth = 0, quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
      if (depth > 0 && (c === '"' || c === "'" || c === '`')) { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(src.slice(match.index, i));
  }
  return tags;
}

function isSecondary(tag) {
  if (/\bvariant=/.test(tag)) return /variant="secondary"/.test(tag);
  if (/\{\.\.\./.test(tag)) return false;
  return !/button-(primary|danger|quiet|ghost)\b/.test(tag);
}

function counts() {
  const result = {};
  for (const file of walk(appRoot)) {
    if (file.includes(`${path.sep}ui${path.sep}ProductButton`)) continue;
    const n = buttonTags(fs.readFileSync(file, 'utf8')).filter(isSecondary).length;
    if (n) result[path.relative(appRoot, file)] = n;
  }
  return result;
}

test('secondary buttons per screen never grow past their recorded ceiling', () => {
  const current = counts();
  for (const [file, n] of Object.entries(current)) {
    const ceiling = SECONDARY_CEILING[file] ?? 0;
    assert.ok(n <= ceiling, `${file}: ${n} secondary buttons, ceiling ${ceiling}. Decide the role (primary / ghost / destructive) before adding another white button.`);
  }
});

test('ceilings are tightened when a screen improves', () => {
  const current = counts();
  for (const [file, ceiling] of Object.entries(SECONDARY_CEILING)) {
    assert.ok((current[file] ?? 0) >= ceiling, `${file}: now ${current[file] ?? 0}, ceiling ${ceiling}. Lower the ceiling in tests/fixtures/button-role-ceilings.json.`);
  }
});
