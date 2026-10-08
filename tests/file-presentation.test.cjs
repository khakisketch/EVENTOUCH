'use strict';
// Stored file references resolve by route context: attendee/display pages use
// the public file route, operator scopes use the authenticated one, and
// preview-mode inline data keeps rendering as a data URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load({ scope = 'console', remote } = {}) {
  const E = {
    esc: value => String(value ?? ''),
    ui: { filters: {} }, actions: {}, forms: {},
    route: { scope, eventId: 'event-1', slug: 'event-one' },
    event: () => ({ id: 'event-1', slug: 'event-one' }),
  };
  if (remote !== undefined) E.remote = remote;
  const window = { ET: E, addEventListener() {} };
  const document = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/ui.js'), 'utf8'), { window, document });
  return E;
}

const remote = {
  fileURL: ({ eventId, fileId, slug, public: asPublic }) => asPublic
    ? `/api/public/events/${slug}/files/${fileId}`
    : `/api/events/${eventId}/files/${fileId}`,
};
const ref = { fileId: 'file-1', name: 'photo.png', type: 'image/png', size: 10, width: 320, height: 200 };

test('attendee and display scopes resolve stored refs through the public file route', () => {
  for (const scope of ['attendee', 'display']) {
    const E = load({ scope, remote });
    assert.equal(E.fileURL(ref), '/api/public/events/event-one/files/file-1');
    assert.equal(E.image(ref, '사진'), '<img class="od-media" src="/api/public/events/event-one/files/file-1" width="320" height="200" alt="사진">');
  }
});

test('operator scopes resolve stored refs through the authenticated file route', () => {
  const E = load({ scope: 'console', remote });
  assert.equal(E.fileURL(ref), '/api/events/event-1/files/file-1');
  assert.equal(E.image(ref, '로고'), '<img class="od-media" src="/api/events/event-1/files/file-1" width="320" height="200" alt="로고">');
});

test('inline preview data keeps rendering as a data URL', () => {
  const E = load({ scope: 'attendee', remote });
  const inline = { data: 'data:image/png;base64,AAAA', width: 4, height: 4 };
  assert.equal(E.fileURL(inline), 'data:image/png;base64,AAAA');
  assert.equal(E.image(inline, '미리보기'), '<img class="od-media" src="data:image/png;base64,AAAA" width="4" height="4" alt="미리보기">');
});

test('unresolvable refs render no image and unknown dimensions are omitted', () => {
  const E = load({ scope: 'console', remote });
  assert.equal(E.image(null, 'x'), '');
  assert.equal(E.image({}, 'x'), '');
  assert.equal(E.image({ fileId: 'file-9', name: 'photo.png', type: 'image/png', size: 10 }, 'x'),
    '<img class="od-media" src="/api/events/event-1/files/file-9" alt="x">');
  const offline = load({ scope: 'console' }); // no remote adapter at all
  assert.equal(offline.fileURL(ref), '');
  assert.equal(offline.image(ref, 'x'), '');
});
