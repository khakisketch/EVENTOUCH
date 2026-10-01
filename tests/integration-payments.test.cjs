const { test } = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  try { delete require.cache[require.resolve('../features/integrations.js')]; } catch {}
  delete globalThis.ETKO;
  require('../features/integrations.js');
  return globalThis.ETKO;
}

test('payment intents are simulated and never charged', () => {
  const ETKO = fresh();
  const intent = ETKO.createPaymentIntent({ amount: 5000, description: '참가비' });
  assert.equal(intent.status, 'SIMULATION_ONLY');
  assert.equal(intent.charged, false);
  assert.equal(intent.amount, 5000);
  assert.equal(ETKO.paymentStatus(intent.id).id, intent.id);
});

test('bad amounts and unknown intents are rejected in Korean', () => {
  const ETKO = fresh();
  assert.throws(() => ETKO.createPaymentIntent({ amount: 0 }), /결제 금액/);
  assert.throws(() => ETKO.createPaymentIntent({ amount: 12.5 }), /결제 금액/);
  assert.throws(() => ETKO.paymentStatus('pi-999'), /결제 내역/);
});
