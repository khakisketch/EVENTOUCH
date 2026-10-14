'use strict';

// Slice-1 contract for apps/web: the browser talks to the new app's own
// origin under /api/* only, and the public event page reads the existing
// public projection. These are static source assertions on purpose: they pin
// the migration seam without booting Next.js inside the suite. Live rendering
// of the slice is verified against the demo servers outside the suite
// (evidence under /tmp/opencode/eventouch-captures/web-slice1-*.png).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

test('web-proxy-keeps-the-same-origin-api-contract', () => {
  const config = read('next.config.ts');
  assert.match(config, /source:\s*"\/api\/:path\*"/);
  assert.match(config, /destination:.*\/api\/:path\*/);
  assert.match(config, /EVENTOUCH_API_URL/);
  assert.doesNotMatch(config, /http:\/\/127\.0\.0\.1:8776\/[^a]/);
});

test('web-event-page-reads-the-public-projection-and-handles-unknown-slugs', () => {
  const page = read('app/event/[slug]/page.tsx');
  assert.match(page, /\/api\/public\/events\//);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /cache:\s*"no-store"/);
  assert.doesNotMatch(page, /\/api\/events\/\$\{/);
});

test('web-slice-does-not-take-over-writes', () => {
  const sources = ['app/page.tsx', 'app/event/[slug]/page.tsx', 'app/event/[slug]/not-found.tsx']
    .map(read)
    .join('\n');
  assert.doesNotMatch(sources, /method:\s*"POST"/i);
  assert.doesNotMatch(sources, /\/commands/);
});
