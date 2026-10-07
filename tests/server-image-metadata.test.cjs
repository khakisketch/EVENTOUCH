'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { floorplanPng } = require('./helpers/floorplan-image.cjs');
const inspect = (...args) => require('../server/image-metadata').inspectImage(...args);

test('PNG dimensions come from bytes, not supplied metadata', () => {
  assert.deepEqual(inspect(floorplanPng(), 'image/png'), { width: 320, height: 200 });
});
test('JPEG frame dimensions are read after a bounded marker scan', () => {
  const jpeg = Buffer.from('ffd8ffe000040000ffc000110800c8014003011100021100031100ffd9', 'hex');
  assert.deepEqual(inspect(jpeg, 'image/jpeg'), { width: 320, height: 200 });
});
test('WebP extended, lossless and lossy headers provide dimensions', () => {
  const extended = Buffer.alloc(30);
  extended.write('RIFF'); extended.writeUInt32LE(22, 4); extended.write('WEBPVP8X', 8);
  extended.writeUInt32LE(10, 16); extended.writeUIntLE(319, 24, 3); extended.writeUIntLE(199, 27, 3);
  assert.deepEqual(inspect(extended, 'image/webp'), { width: 320, height: 200 });
  const lossless = Buffer.alloc(26);
  lossless.write('RIFF'); lossless.writeUInt32LE(18, 4); lossless.write('WEBPVP8L', 8);
  lossless.writeUInt32LE(5, 16); lossless[20] = 0x2f;
  lossless.writeUInt32LE(319 | (199 << 14), 21);
  assert.deepEqual(inspect(lossless, 'image/webp'), { width: 320, height: 200 });
  const lossy = Buffer.alloc(30);
  lossy.write('RIFF'); lossy.writeUInt32LE(22, 4); lossy.write('WEBPVP8 ', 8);
  lossy.writeUInt32LE(10, 16); Buffer.from('9d012a', 'hex').copy(lossy, 23);
  lossy.writeUInt16LE(320, 26); lossy.writeUInt16LE(200, 28);
  assert.deepEqual(inspect(lossy, 'image/webp'), { width: 320, height: 200 });
});
test('truncated images, MIME mismatch and excessive dimensions are rejected', () => {
  for (const [bytes, type] of [
    [floorplanPng().subarray(0, 20), 'image/png'],
    [floorplanPng(), 'image/jpeg'],
    [Buffer.from('ffd8ffe000ffff', 'hex'), 'image/jpeg'],
    [Buffer.from('RIFF0000WEBPVP8X'), 'image/webp'],
  ]) assert.throws(() => inspect(bytes, type), { status: 400 });
  const invalid = floorplanPng(); invalid.writeUInt32BE(10001, 16);
  assert.throws(() => inspect(invalid, 'image/png'), { status: 400 });
  invalid.writeUInt32BE(0, 16);
  assert.throws(() => inspect(invalid, 'image/png'), { status: 400 });
});
