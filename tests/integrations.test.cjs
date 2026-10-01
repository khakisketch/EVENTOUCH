const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  try { delete require.cache[require.resolve('../features/integrations.js')]; } catch {}
  delete globalThis.ETKO;
  require('../features/integrations.js');
  return globalThis.ETKO;
}

test('integration mode defaults to simulation', () => {
  const ETKO = fresh();
  assert.equal(ETKO.integrationMode(), 'SIMULATION');
});

test('provider registration validates area and isolates per area', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.registerProvider('nope', 'x', {}), /연동 영역/);
  ETKO.registerProvider('messages', 'demo-log', { send() { return 'logged'; } });
  assert.equal(ETKO.providerFor('messages').send(), 'logged');
  assert.equal(ETKO.providerFor('auth').kind, 'simulation');
});
