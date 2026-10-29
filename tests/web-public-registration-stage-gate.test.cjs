'use strict';

// Public signup is only writable on READY/LIVE (server/commands/
// participants.js publicSignupEvent). An ENDED event with the intake flag
// still on must not offer a live form or entry link that can only fail:
// the entry CTA and the register route both fall back to the established
// closed state using the already-projected stage. DRAFT/ARCHIVED never reach
// these branches (public 404), so no new copy and no API change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web', 'app');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('public entry offers signup only when the stage admits it', () => {
  const page = read('event/[slug]/page.tsx');
  assert.match(page, /acceptingSignup/);
  assert.match(page, /event\.stage === "READY" \|\| event\.stage === "LIVE"/);
  assert.match(page, /\{acceptingSignup \? \(/);
  // The established closed state is reused, not rewritten.
  assert.match(page, /현재 신청을 받지 않습니다/);
});

test('public register closes on ENDED even with the intake flag on', () => {
  const page = read('event/[slug]/register/page.tsx');
  assert.match(page, /stage: string/);
  assert.match(page, /data\.event\.stage/);
  assert.match(page, /!data\.registrationOpen \|\| data\.stage === "ENDED"/);
  // Same closed branch and copy as an unpublished event.
  assert.match(page, /현재 신청을 받지 않습니다/);
});
