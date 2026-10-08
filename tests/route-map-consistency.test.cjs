'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function extractMap(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const match = new RegExp(`const ${name}=\\{([^}]*)\\};`).exec(source);
  assert.ok(match, `${name} not found in ${file}`);
  const map = {};
  for (const pair of match[1].split(',')) {
    const [key, value] = pair.split(':').map((part) => part.trim().replace(/^['"]|['"]$/g, ''));
    if (key) map[key] = value;
  }
  return map;
}

test('router groups and operator eventPages agree on every shared page', () => {
  const groups = extractMap('assets/js/router.js', 'groups');
  const eventPages = extractMap('assets/js/operator-experience.js', 'eventPages');
  const shared = Object.keys(groups).filter((key) => key in eventPages);
  assert.ok(shared.length > 10, `expected many shared keys, found ${shared.length}`);
  for (const key of shared) {
    assert.equal(
      eventPages[key],
      groups[key],
      `page '${key}' maps to '${eventPages[key]}' in eventPages but '${groups[key]}' in groups`
    );
  }
});

test('every router group key is reachable from at least one of the two maps', () => {
  const groups = extractMap('assets/js/router.js', 'groups');
  const eventPages = extractMap('assets/js/operator-experience.js', 'eventPages');
  const union = new Set([...Object.keys(groups), ...Object.keys(eventPages)]);
  for (const key of Object.keys(groups)) {
    assert.ok(union.has(key), `group key '${key}' is missing from both maps`);
  }
});
