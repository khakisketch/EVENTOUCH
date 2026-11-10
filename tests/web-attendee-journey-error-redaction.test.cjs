'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeErrorSummary } = require('../scripts/web-attendee-journey-audit.cjs');

test('navigation failure retains the reason but never the ticket query', () => {
  const marker = 'SYNTHETIC_SECRET_MARKER';
  for (const message of [
    `page.goto: net::ERR_CONNECTION_CLOSED at http://127.0.0.1/event/demo/engage?ticket=${marker}&view=home`,
    `page.goto: failure for /event/demo?x=1&ticket=${marker}`,
    `error ticket=${marker} network failure`,
  ]) {
    const summary = safeErrorSummary(new Error(message));
    assert.equal(summary.includes(marker), false);
    assert.ok(summary.includes('failure') || summary.includes('ERR_CONNECTION_CLOSED'));
    assert.match(summary, /redacted/);
  }
});
