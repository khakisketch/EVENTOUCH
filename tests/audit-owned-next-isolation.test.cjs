'use strict';

// Isolation contract for the four browser audits that verify-system runs
// with WEB_BASE deleted: import / hanwool / retirement must boot their own
// production Next bound to their own isolated API, never an external web
// server; all four must honor the caller EVENTOUCH_CAPTURE_ROOT.
// Static source assertions on purpose: they pin the seam without booting
// databases, browsers, or servers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OWNED = [
  'scripts/web-import-audit.cjs',
  'scripts/web-hanwool-audit.cjs',
  'scripts/web-retirement-audit.cjs',
];

test('browser audits own an isolated Next bound to the isolated API', () => {
  for (const file of OWNED) {
    const source = read(file);
    assert.match(source, /ensureAuditDatabaseEnv/, `${file} maps audit DB vars before helpers load`);
    assert.match(source, /startOwnedNext/, `${file} boots its own production Next`);
    assert.match(source, /startOwnedNext\(\{\s*apiBase:\s*harness\.baseUrl|\{\s*apiBase:\s*api\.baseUrl/, `${file} binds owned Next to its own harness`);
    assert.match(source, /webBase:\s*owned\.baseUrl/, `${file} routes the gateway through the owned Next`);
    assert.match(source, /owned\.close\(\)/, `${file} cleans up its own Next child`);
  }
});

test('browser audits never fall back to an external web server', () => {
  for (const file of OWNED) {
    const source = read(file);
    assert.doesNotMatch(source, /process\.env\.WEB_BASE\s*\|\|/, `${file} must not default to an external WEB_BASE`);
    assert.doesNotMatch(source, /webBase,\s*loseFirstResponseFor|webBase\s*\}/, `${file} must not forward an external webBase into the gateway`);
    assert.doesNotMatch(source, /127\.0\.0\.1:8777/, `${file} must not hardcode the dev Next port`);
  }
});

test('all four audits honor the caller capture root', () => {
  for (const file of [...OWNED, 'scripts/web-event-card-a2-audit.cjs']) {
    const source = read(file);
    assert.match(source, /EVENTOUCH_CAPTURE_ROOT/, `${file} honors the caller capture root`);
  }
  assert.match(read('scripts/web-event-card-a2-audit.cjs'), /event-card-a2/, 'card audit keeps its namespaced subdirectory');
  for (const sub of ['import-real', 'hanwool-real', 'retirement-real']) {
    assert.match(read(OWNED.find((f) => read(f).includes(sub))), new RegExp(sub), `${sub} capture namespace preserved`);
  }
});

test('card audit tests the current white row, not the retired A2 tint', () => {
  const card = read('scripts/web-event-card-a2-audit.cjs');
  // The approved white contract: flat white zone, published color only in
  // the 8px identity dot, drafts never leak into any card paint.
  assert.match(card, /::before/, 'card audit reads the identity dot pseudo-element');
  assert.match(card, /identity dot/, 'card audit names the current visual contract');
  assert.match(card, /FLAT_WHITE/, 'card audit pins the flat white zone');
  assert.match(card, /SOFT_DOT/, 'card audit pins the unpublished dot fallback');
  assert.match(card, /unsaved draft never moves the published dot/, 'card audit keeps the published-only/no-draft-leak check on the dot');
  assert.doesNotMatch(card, /tints the header/, 'retired A2 full-header expectation is gone');
  assert.doesNotMatch(card, /readZone/, 'retired zone-tint reader is gone');
  assert.match(card, /RETIRED A2 reference \(historical only\)/, 'old A2 reference is marked historical, not authoritative');
  // Behavioral coverage is untouched by the presentation update.
  assert.match(card, /lost response retried with the identical command id/, 'card keeps the ambiguous-loss idempotence proof');
  assert.match(card, /delayed duplicate still saves exactly one event/, 'card keeps the in-flight lock proof');
  assert.match(card, /keyboard Enter opens the event home/, 'card keeps the keyboard proof');
  assert.match(card, /direct approval link/, 'card keeps the pending-approval proof');
});
test('isolation keeps existing evidence and secrecy guards', () => {
  const importSrc = read('scripts/web-import-audit.cjs');
  assert.match(importSrc, /loseFirstResponseFor.*participant\.import/, 'import keeps the committed-response-loss replay');
  assert.match(importSrc, /calls\[0\]\.commandId.*calls\[1\]\.commandId|commandId.*receipt/i, 'import keeps the receipt-reuse assertion');
  assert.match(importSrc, /BUILD_ID/, 'import records the production build');
  const hanwool = read('scripts/web-hanwool-audit.cjs');
  assert.match(hanwool, /draw\.program\.run/, 'hanwool keeps the stage-touch loss replay');
  assert.match(hanwool, /reward\.collect/, 'hanwool keeps the collection loss replay');
  assert.match(hanwool, /clickCommandConfirm[\s\S]*실행 확인/, 'hanwool confirms execution in place without changing the asserted receipts');
  assert.match(hanwool, /rendered admission QR must be software-decodable|decodeRenderedTicket/, 'hanwool keeps the rendered-QR decode proof');
  assert.match(hanwool, /axe\.run|axeSource/, 'hanwool keeps the real-content axe gate');
  const retirement = read('scripts/web-retirement-audit.cjs');
  assert.match(retirement, /eventouch-shell-/, 'retirement keeps the legacy shell-worker proof');
  assert.match(retirement, /serviceWorker.*getRegistrations|workerUnregistered/i, 'retirement keeps the unregistration assertion');
  assert.match(retirement, /content-security-policy/i, 'retirement keeps the production CSP/nonce checks');
  assert.match(retirement, /BUILD_ID/, 'retirement records the production build');
  const card = read('scripts/web-event-card-a2-audit.cjs');
  assert.match(card, /lost response retried with the identical command id/i, 'card keeps the ambiguous-loss idempotence proof');
  assert.match(card, /BUILD_ID/, 'card records the production build');
  for (const file of [...OWNED, 'scripts/web-event-card-a2-audit.cjs']) {
    const source = read(file);
    assert.match(source, /SOLAPI_/, `${file} strips provider credentials`);
    assert.match(source, /EVENTOUCH_SMS_MOCK/, `${file} never attempts a real send`);
  }
});
