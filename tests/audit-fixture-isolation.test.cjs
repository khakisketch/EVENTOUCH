'use strict';

// Audit-fixture correctness: the shared browser fixture must own an isolated
// Next production server bound to the isolated API, and every audit must
// gate each route on its real loaded content before axe/overflow probes run.
// These are static source assertions plus pure-helper checks on purpose:
// they pin the seam without booting databases, browsers, or servers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('audit-fixture-owns-an-isolated-next-bound-to-the-harness', () => {
  const fixture = require('../scripts/audit-fixture.cjs');
  for (const name of ['startOwnedNext', 'assertNextBuild', 'verifyOwnedNextRendersFixture', 'routeReadiness', 'assertAuditRoute', 'webDir']) {
    assert.equal(typeof fixture[name], 'function', `fixture exposes ${name}`);
  }
  const source = read('scripts/audit-fixture.cjs');
  // SSR binds through the owned child environment only: no request headers,
  // no Host trust, nothing the product reads.
  assert.match(source, /EVENTOUCH_API_URL/);
  assert.match(source, /127\.0\.0\.1/);
  assert.doesNotMatch(source, /x-forwarded-host/i);
  assert.doesNotMatch(source, /x-api-url/i);
  // Only the committed production artifact is served; a missing build fails.
  assert.match(source, /BUILD_ID/);
  assert.match(source, /required-server-files/);
  assert.match(source, /run 'npm --prefix apps\/web run build' first/);
  // An externally running build is never audited silently.
  assert.match(source, /superseded/);
  // Lifecycle unwinds exactly the owned processes.
  assert.match(source, /gateway -> owned Next -> harness|gateway.*web.*harness/);
});

test('audit-fixture-gates-every-real-route-on-loaded-content', () => {
  const fixture = require('../scripts/audit-fixture.cjs');
  for (const name of ['home', 'event', 'attendee-home', 'register', 'screen', 'staff', 'console-participants']) {
    const readiness = fixture.routeReadiness(name);
    assert.ok(readiness, `${name} has a readiness gate`);
    assert.ok(Array.isArray(readiness.expect) && readiness.expect.length > 0, `${name} waits for a loaded marker`);
    assert.ok(Array.isArray(readiness.forbidText), `${name} lists wrong-state copy`);
  }
  // The register gate must reject the not-found and closed states, not just
  // wait for a form: otherwise a misbound SSR API passes as a target screen.
  const register = fixture.routeReadiness('register');
  assert.ok(register.forbidText.some((text) => text.includes('신청할 수 없는 행사')), 'register rejects not-found');
  assert.ok(register.forbidText.some((text) => text.includes('신청을 받지 않습니다')), 'register rejects closed');
  // Intentional error states stay ungated: audits cover them as-is.
  for (const name of ['unknown-slug', 'unknown-screen', 'login', 'private-anon', 'staff-authed']) {
    assert.equal(fixture.routeReadiness(name), null, `${name} is an intentional error state`);
  }
});

test('audit-fixture-rejects-a-missing-next-build-without-touching-anything', () => {
  const fixture = require('../scripts/audit-fixture.cjs');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-fixture-build-check-'));
  try {
    assert.throws(() => fixture.assertNextBuild(empty), /production Next build/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'eventouch-fixture-build-ok-'));
  try {
    fs.mkdirSync(path.join(fake, '.next'), { recursive: true });
    fs.writeFileSync(path.join(fake, '.next', 'BUILD_ID'), 'test-build');
    fs.writeFileSync(path.join(fake, '.next', 'required-server-files.json'), '{}');
    assert.equal(fixture.assertNextBuild(fake), fake);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('all-three-audits-gate-routes-and-close-the-owned-fixture', () => {
  for (const file of ['scripts/accessibility-audit.cjs', 'scripts/mobile-audit.cjs', 'scripts/web-audit.cjs']) {
    const source = read(file);
    assert.match(source, /assertAuditRoute/, `${file} gates routes on loaded content`);
    assert.match(source, /fixture\.close\(\)/, `${file} unwinds the owned fixture`);
    assert.doesNotMatch(source, /fixture\.gateway\.close/, `${file} closes through fixture.close, not piecemeal`);
  }
});

test('audit-gates-do-not-weaken-existing-axe-and-layout-coverage', () => {
  const mobile = read('scripts/mobile-audit.cjs');
  assert.match(mobile, /iPhone SE/);
  assert.match(mobile, /portrait/);
  assert.match(mobile, /landscape/);
  assert.match(mobile, /auditRoutes/);
  for (const file of ['scripts/accessibility-audit.cjs', 'scripts/web-audit.cjs']) {
    assert.match(read(file), /page\.evaluate\(axeSource\)/, `${file} keeps protocol-injected axe under the production CSP`);
  }
  assert.match(read('scripts/web-audit.cjs'), /attendeeHomeNavigation/);
});
