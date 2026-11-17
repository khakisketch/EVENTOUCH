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

// --- EXIF orientation -------------------------------------------------------
// A phone held upright stores a landscape sensor image plus an Orientation tag
// (5-8 = rotated a quarter turn). Browsers show it upright, so the stored size
// must be the displayed size: width and height swap for tags 5-8.

// A 320x200 JPEG frame, optionally preceded by an APP1 Exif segment whose IFD0
// holds one Orientation entry.
function jpegWithOrientation(orientation, { littleEndian = false, type = 3, count = 1 } = {}) {
  const sof = Buffer.from('ffc00011080 0c8014003011100021100031100'.replace(/ /g, ''), 'hex');
  const app0 = Buffer.from('ffe000040000', 'hex');
  if (orientation === null) return Buffer.concat([Buffer.from('ffd8', 'hex'), app0, sof, Buffer.from('ffd9', 'hex')]);
  const u16 = (v) => { const b = Buffer.alloc(2); littleEndian ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); littleEndian ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return b; };
  const tiff = Buffer.concat([
    Buffer.from(littleEndian ? 'II' : 'MM'), u16(0x2a), u32(8),
    u16(1), u16(0x0112), u16(type), u32(count), u16(orientation), Buffer.alloc(2), u32(0),
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const size = Buffer.alloc(2); size.writeUInt16BE(body.length + 2);
  const app1 = Buffer.concat([Buffer.from('ffe1', 'hex'), size, body]);
  return Buffer.concat([Buffer.from('ffd8', 'hex'), app1, app0, sof, Buffer.from('ffd9', 'hex')]);
}

test('EXIF orientation 5-8 swaps the stored width and height (big and little endian)', () => {
  for (const littleEndian of [false, true]) {
    for (const orientation of [5, 6, 7, 8]) {
      assert.deepEqual(inspect(jpegWithOrientation(orientation, { littleEndian }), 'image/jpeg'), { width: 200, height: 320 },
        `orientation ${orientation} ${littleEndian ? 'II' : 'MM'}`);
    }
  }
});

test('EXIF orientation 1-4 and a missing tag keep the stored size', () => {
  for (const orientation of [1, 2, 3, 4]) {
    assert.deepEqual(inspect(jpegWithOrientation(orientation), 'image/jpeg'), { width: 320, height: 200 }, `orientation ${orientation}`);
  }
  assert.deepEqual(inspect(jpegWithOrientation(null), 'image/jpeg'), { width: 320, height: 200 });
});

test('a damaged or odd EXIF block is ignored instead of rejecting the photo', () => {
  // Out-of-range orientation value, wrong tag type, wrong count: keep the stored size.
  assert.deepEqual(inspect(jpegWithOrientation(9), 'image/jpeg'), { width: 320, height: 200 });
  assert.deepEqual(inspect(jpegWithOrientation(6, { type: 4 }), 'image/jpeg'), { width: 320, height: 200 });
  assert.deepEqual(inspect(jpegWithOrientation(6, { count: 2 }), 'image/jpeg'), { width: 320, height: 200 });
  // Bad byte-order mark, bad magic number, IFD offset pointing outside the segment.
  for (const [what, offsetInTiff, patch] of [['byte-order mark', 0, 'XX'], ['magic number', 2, '\x00\x2b'], ['IFD offset', 4, '\xff\xff\xff\xff']]) {
    const bytes = jpegWithOrientation(6);
    const tiff = bytes.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6;
    Buffer.from(patch, 'latin1').copy(bytes, tiff + offsetInTiff);
    assert.deepEqual(inspect(bytes, 'image/jpeg'), { width: 320, height: 200 }, `damaged ${what}`);
  }
  // Entry count claims more entries than the segment holds.
  const truncated = jpegWithOrientation(6);
  const ifdAt = truncated.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6 + 8;
  truncated.writeUInt16BE(500, ifdAt);
  assert.deepEqual(inspect(truncated, 'image/jpeg'), { width: 320, height: 200 });
});
