'use strict';

// An already-open usable ticket can go stale: the server may revoke the
// ticket (operator cancellation) or reinstate it while the screen stays
// mounted, and a blind reload was the only path off the stale QR. A manual
// re-check on the usable ticket closes that gap without claiming live
// freshness: the QR stays mounted while checking, only a definitive 404
// clears the bearer and ends the stale QR (same rule as the loading path),
// and transient failures keep the visible ticket with another try. No new
// persistence, no polling, no server change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEW = path.join(__dirname, '..', 'apps', 'web', 'app', 'event', '[slug]', 'ticket', 'TicketView.tsx');

function source() {
  return fs.readFileSync(VIEW, 'utf8');
}

test('usable ticket offers a manual re-check that keeps the QR mounted', () => {
  const view = source();
  assert.match(view, /recheckUsableTicket/);
  assert.match(view, /확인 중입니다/);
  // The QR branch owns the control; the receipt branch keeps its own. The
  // in-check copy states the uncertainty honestly instead of implying a
  // working offline entry.
  assert.match(view, /이 QR의 입장 가능 여부는 확정되지 않습니다/);
});

test('usable re-check ends only on definitive rejection, retries the rest', () => {
  const view = source();
  // 404 clears the in-tab bearer exactly like the loading path.
  assert.match(view, /clearStoredTicket\(requestSlug\)/);
  assert.match(view, /ticketRef\.current = \{ slug: requestSlug, ticket: "" \}/);
  // Transient failures never touch the bearer or the mounted QR, and the
  // copy must not promise a working offline entry: eligibility is
  // explicitly unconfirmed.
  assert.match(view, /setRecheckError/);
  assert.match(view, /이 QR의 입장 가능 여부는 확정되지 않았습니다/);
  assert.doesNotMatch(view, /localStorage/);
});

test('usable re-check reuses the in-tab bearer, not a new secret', () => {
  const view = source();
  assert.match(view, /ticketRef\.current\.ticket \|\| state\.ticket/);
  assert.match(view, /authorization: `Bearer /);
});

test('usable re-check drops late responses after a slug change or reload', () => {
  const view = source();
  // A re-check invalidated by a newer slug or load never writes: the
  // sequence + slug guard drops the late response instead of letting it
  // overwrite another event or bearer.
  assert.match(view, /recheckSeqRef/);
  assert.match(view, /liveSlugRef/);
  assert.match(view, /const live = \(\) => recheckSeqRef\.current === seq && liveSlugRef\.current === requestSlug/);
  assert.match(view, /if \(!live\(\)\) return;/);
  // Each fresh load invalidates in-flight re-checks and clears their voice,
  // so a reused screen never sticks on a stale disabled button.
  const invalidations = view.match(/recheckSeqRef\.current \+= 1/g) || [];
  assert.equal(invalidations.length, 2); // fresh load + unmount cleanup
  assert.match(view, /setRechecking\(false\);\s*\n\s*setRecheckError\(null\);/);
  // Even the final reset is scoped: it never clears a newer request.
  assert.match(view, /finally \{\s*\n\s*if \(live\(\)\) setRechecking\(false\);\s*\n\s*\}/);
});
