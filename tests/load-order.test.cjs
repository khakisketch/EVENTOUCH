'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function scriptOrder() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const names = [...html.matchAll(/<script defer src="assets\/js\/([a-z0-9-]+)\.js\?v=\d+"><\/script>/g)].map((match) => match[1]);
  return { html, names };
}

test('index.html loads every product script once, in the maintained override chain', () => {
  const { names } = scriptOrder();
  assert.ok(names.length >= 20, `expected the full script set, found ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'no script may be loaded twice');
  const at = (name) => {
    const index = names.indexOf(name);
    assert.ok(index >= 0, `script ${name} must be present`);
    return index;
  };
  const chain = [
    'core', 'store', 'console', 'router', 'experience', 'workflows', 'role-model', 'event-flow',
    'operator-experience', 'server-sync', 'booth-map-data', 'booth-map-ui', 'server-presentation',
  ];
  for (let i = 1; i < chain.length; i += 1) {
    assert.ok(at(chain[i - 1]) < at(chain[i]), `${chain[i - 1]} must load before ${chain[i]} (last-loaded wins)`);
  }
});

test('every referenced product script exists on disk', () => {
  const { names } = scriptOrder();
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(root, 'assets', 'js', `${name}.js`)), `assets/js/${name}.js must exist`);
  }
});

test('index.html keeps the workflow-version gate for startup failures', () => {
  const { html } = scriptOrder();
  assert.match(html, /workflowVersion/);
});
