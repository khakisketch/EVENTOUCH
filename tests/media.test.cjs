const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
globalThis.ETKO = globalThis.ETKO || {};
try {
  globalThis.ETKO.sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8')
  );
} catch (err) {}
require('../features/agency.js');
require('../features/media.js');

const ETKO = globalThis.ETKO;

function resetMedia() {
  ETKO.switchEvent('evt-1');
  var ws = ETKO.workspace();
  ws.photos = [];
  ws.product = { presentation: null, media: [] };
}

function jpeg(n) {
  return 'data:image/jpeg;base64,' + 'A'.repeat(n || 100);
}

// Step 1 (brief): empty wall on a fresh workspace.
resetMedia();
assert.deepEqual(ETKO.wallPhotos(), []);

const { test } = require('node:test');

test('upload stores a PENDING photo, hidden from the wall', () => {
  resetMedia();
  var photo = ETKO.uploadPhoto('p1', { caption: '팀 사진', data: jpeg() });
  assert.equal(photo.status, 'PENDING');
  assert.deepEqual(ETKO.wallPhotos(), []);
});

test('upload rejects unknown participants', () => {
  resetMedia();
  assert.throws(() => ETKO.uploadPhoto('ghost', { caption: 'x', data: jpeg() }), /참가자를 찾을 수 없습니다/);
});

test('upload rejects non-image data URLs', () => {
  resetMedia();
  assert.throws(
    () => ETKO.uploadPhoto('p1', { caption: 'x', data: 'data:text/plain;base64,AAAA' }),
    /사진 형식을 확인하세요/
  );
});

test('upload rejects data longer than 1MB', () => {
  resetMedia();
  assert.throws(
    () => ETKO.uploadPhoto('p1', { caption: 'big', data: jpeg(1048577) }),
    /1MB/
  );
});

test('at most 3 photos are stored with data', () => {
  resetMedia();
  ETKO.uploadPhoto('p1', { caption: '1', data: jpeg() });
  ETKO.uploadPhoto('p2', { caption: '2', data: jpeg() });
  ETKO.uploadPhoto('p3', { caption: '3', data: jpeg() });
  assert.throws(
    () => ETKO.uploadPhoto('p4', { caption: '4', data: jpeg() }),
    /최대 3장/
  );
});

test('moderatePhotos approves photos onto the wall', () => {
  resetMedia();
  var photo = ETKO.uploadPhoto('p1', { caption: '팀 사진', data: jpeg() });
  ETKO.moderatePhotos([photo.id], 'APPROVED');
  var wall = ETKO.wallPhotos();
  assert.equal(wall.length, 1);
  assert.equal(wall[0].id, photo.id);
});

test('moderatePhotos hides photos from the wall again', () => {
  resetMedia();
  var photo = ETKO.uploadPhoto('p1', { caption: '팀 사진', data: jpeg() });
  ETKO.moderatePhotos([photo.id], 'APPROVED');
  ETKO.moderatePhotos([photo.id], 'HIDDEN');
  assert.deepEqual(ETKO.wallPhotos(), []);
});

test('moderatePhotos rejects bad status and unknown ids', () => {
  resetMedia();
  var photo = ETKO.uploadPhoto('p1', { caption: 'x', data: jpeg() });
  assert.throws(() => ETKO.moderatePhotos([photo.id], 'YES'), /상태를 확인하세요/);
  assert.throws(() => ETKO.moderatePhotos(['ph-9'], 'APPROVED'), /사진을 찾을 수 없습니다/);
});

test('setWall accepts grid and spotlight with seconds 3..60', () => {
  resetMedia();
  assert.deepEqual(ETKO.setWall({ layout: 'spotlight', seconds: 10 }), { layout: 'spotlight', seconds: 10 });
  assert.throws(() => ETKO.setWall({ layout: 'grid', seconds: 2 }), /전환 시간/);
  assert.throws(() => ETKO.setWall({ layout: 'grid', seconds: 61 }), /전환 시간/);
  assert.throws(() => ETKO.setWall({ layout: 'wall', seconds: 10 }), /레이아웃을 확인하세요/);
});

test('setOutput switches type and validates media assets', () => {
  resetMedia();
  assert.deepEqual(ETKO.setOutput({ type: 'photos' }), { type: 'photos', assetId: null });
  assert.throws(() => ETKO.setOutput({ type: 'video' }), /화면 종류를 확인하세요/);
  assert.throws(() => ETKO.setOutput({ type: 'media', assetId: 'missing' }), /자료를 찾을 수 없습니다/);
  ETKO.workspace().product.media.push({ id: 'm1' });
  assert.deepEqual(ETKO.setOutput({ type: 'media', assetId: 'm1' }), { type: 'media', assetId: 'm1' });
});

test('setOutput validates photo assets for the photos type', () => {
  resetMedia();
  assert.throws(() => ETKO.setOutput({ type: 'photos', assetId: 'ph-9' }), /사진을 찾을 수 없습니다/);
  var photo = ETKO.uploadPhoto('p1', { caption: 'x', data: jpeg() });
  assert.deepEqual(ETKO.setOutput({ type: 'photos', assetId: photo.id }), { type: 'photos', assetId: photo.id });
});
