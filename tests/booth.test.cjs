const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BOOTH_PATH = path.join(ROOT, 'features', 'booth.js');

function loadBooth() {
  const sandbox = { console };
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BOOTH_PATH, 'utf8'), sandbox, {
    filename: 'features/booth.js',
  });
  return sandbox.window.ETKO || sandbox.ETKO;
}

test('boothMode defaults to SELF', () => {
  const ETKO = loadBooth();
  assert.equal(ETKO.boothMode, 'SELF', 'default booth mode must be SELF');
});

test('setBoothMode switches event-wide SELF<->STAFF; unknown keeps current', () => {
  const ETKO = loadBooth();
  assert.equal(typeof ETKO.setBoothMode, 'function', 'ETKO.setBoothMode must exist');
  assert.equal(ETKO.setBoothMode('STAFF'), 'STAFF', 'must switch to STAFF');
  assert.equal(ETKO.boothMode, 'STAFF', 'boothMode must stay STAFF event-wide');
  assert.equal(ETKO.setBoothMode('SELF'), 'SELF', 'must switch back to SELF');
  assert.equal(ETKO.setBoothMode('nope'), 'SELF', 'unknown mode must keep current');
  assert.equal(ETKO.boothMode, 'SELF', 'unknown mode must not change boothMode');
});

test('SELF copy asks booth QR scan', () => {
  const ETKO = loadBooth();
  ETKO.setBoothMode('SELF');
  const copy = ETKO.nextAction('registered');
  assert.match(copy, /[가-힣]/, 'SELF next action must be Korean');
  assert.match(copy, /부스/, 'SELF copy must mention the booth');
  assert.match(copy, /스캔|QR/, 'SELF copy must ask for a booth QR scan');
});

test('STAFF copy asks ticket show', () => {
  const ETKO = loadBooth();
  ETKO.setBoothMode('STAFF');
  const copy = ETKO.nextAction('registered');
  assert.match(copy, /[가-힣]/, 'STAFF next action must be Korean');
  assert.match(copy, /티켓/, 'STAFF copy must mention the ticket');
  assert.match(copy, /보여/, 'STAFF copy must ask to show the ticket');
});

test('IN flips home CTA', () => {
  const ETKO = loadBooth();
  ETKO.setBoothMode('SELF');
  const before = ETKO.nextAction('registered');
  const after = ETKO.nextAction('IN');
  assert.match(after, /[가-힣]/, 'IN next action must be Korean');
  assert.notEqual(after, before, 'IN must flip the home CTA copy');
  assert.match(after, /완료/, 'IN copy must signal completion');
  // Case-insensitive: sample mixes lowercase "registered" with uppercase "IN".
  assert.equal(ETKO.nextAction('in'), after, 'lowercase in must flip the same way');

  const container = { innerHTML: '' };
  ETKO.renderHome(container, 'IN');
  assert.match(container.innerHTML, /[가-힣]/, 'home CTA must show Korean');
  assert.ok(
    container.innerHTML.includes(after),
    'home CTA must sync with nextAction(IN)'
  );
});

test('booth desk renders Korean mode switch', () => {
  const ETKO = loadBooth();
  assert.equal(typeof ETKO.renderBooth, 'function', 'ETKO.renderBooth must exist');
  const container = { innerHTML: '' };
  ETKO.renderBooth(container);
  assert.match(container.innerHTML, /[가-힣]/, 'booth desk must carry Korean copy');
  // data-booth-mode wiring attributes mirror renderCheckin's data-direction
  // keys; only the visible text must stay Korean.
  var visible = container.innerHTML.replace(/<[^>]*>/g, ' ');
  assert.ok(!/SELF|STAFF/.test(visible), 'booth desk must not leak raw mode keys');
});

test('booth desk guidance follows the mode (SELF scan vs STAFF ticket)', () => {
  const ETKO = loadBooth();
  var container = { innerHTML: '' };
  ETKO.setBoothMode('SELF');
  ETKO.renderBooth(container);
  assert.match(container.innerHTML, /부스 QR/, 'SELF guidance must ask for a booth QR scan');

  container = { innerHTML: '' };
  ETKO.setBoothMode('STAFF');
  ETKO.renderBooth(container);
  assert.match(container.innerHTML, /티켓/, 'STAFF guidance must mention the ticket');
  assert.ok(
    !/부스 QR/.test(container.innerHTML),
    'STAFF guidance must not show the SELF scan copy'
  );
});
