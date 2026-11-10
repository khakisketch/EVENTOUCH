'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureConsentNotice } = require('../server/consent-notices');

test('notice snapshots preserve exact text, deduplicate, and never alter older acceptance', () => {
  const legacy = { version: 2, at: '2026-01-01T00:00:00Z' };
  const workspace = { consentVersion: 2, consentText: ' 안내\n문장  ', participants: [{ consent: legacy }] };
  const first = ensureConsentNotice(workspace, '2026-11-01T00:00:00Z');
  assert.equal(first.text, ' 안내\n문장  ');
  assert.equal(first.version, 2);
  assert.equal(ensureConsentNotice(workspace, '2026-11-02T00:00:00Z').id, first.id);
  assert.equal(workspace.consentNotices.length, 1);
  assert.deepEqual(legacy, { version: 2, at: '2026-01-01T00:00:00Z' });
  workspace.consentVersion = 3; workspace.consentText = '새 안내';
  const next = ensureConsentNotice(workspace, '2026-11-03T00:00:00Z');
  assert.notEqual(next.id, first.id);
  assert.equal(workspace.consentNotices[0].text, ' 안내\n문장  ');
});

test('a malformed history is never overwritten and no blank notice is fabricated', () => {
  const bad = { consentVersion: 1, consentText: '안내', consentNotices: { unexpected: true } };
  assert.throws(() => ensureConsentNotice(bad, '2026-11-01T00:00:00Z'), /동의 안내 기록/);
  assert.deepEqual(bad.consentNotices, { unexpected: true });
  const empty = { consentVersion: 1, consentText: '' };
  assert.equal(ensureConsentNotice(empty, '2026-11-01T00:00:00Z'), null);
  assert.equal(Object.hasOwn(empty, 'consentNotices'), false);
});
