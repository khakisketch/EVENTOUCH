'use strict';
function invalid() { throw Object.assign(new Error('이미지 형식 또는 크기를 확인하세요'), {status:400}); }

// EXIF Orientation (IFD0 tag 0x0112) of a JPEG APP1 segment, 1 when absent or
// not trustworthy. `start` is the TIFF header, `end` the segment end; every
// read stays inside that range, and anything odd means "no rotation" rather
// than rejecting a photo that is otherwise fine.
function exifOrientation(bytes, start, end) {
  if (end - start < 8) return 1;
  const order = bytes.toString('latin1', start, start + 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const little = order === 'II';
  const u16 = (at) => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at) => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  if (u16(start + 2) !== 0x2a) return 1;
  const ifd = start + u32(start + 4);
  if (ifd < start + 8 || ifd + 2 > end) return 1;
  const entries = u16(ifd);
  // A count that does not fit the segment means the block is damaged.
  if (ifd + 2 + entries * 12 > end) return 1;
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) !== 0x0112) continue;
    // One SHORT: the value sits in the first two bytes of the value field.
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return 1;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}
function inspectImage(bytes, contentType) {
  if (!Buffer.isBuffer(bytes)) invalid();
  let width, height;
  if (contentType === 'image/png') {
    if (bytes.length < 33 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') invalid();
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (contentType === 'image/jpeg') {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) invalid();
    let at = 2, orientation = 1, exifSeen = false;
    while (at < bytes.length && at < 65536) {
      if (bytes[at++] !== 0xff) invalid();
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda || at + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || at + size > bytes.length) invalid();
      if (marker === 0xe1 && !exifSeen && size >= 14 && bytes.toString('latin1', at + 2, at + 8) === 'Exif\0\0') {
        exifSeen = true;
        orientation = exifOrientation(bytes, at + 8, at + size);
      }
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 8) invalid();
        height = bytes.readUInt16BE(at+3); width = bytes.readUInt16BE(at+5);
        // Orientation 5-8 is a quarter turn: browsers show the photo upright,
        // so the stored size must be the displayed size.
        if (orientation >= 5) [width, height] = [height, width];
        break;
      }
      at += size;
    }
  } else if (contentType === 'image/webp') {
    if (bytes.length < 20 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WEBP' ||
        bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    const kind = bytes.toString('ascii',12,16), size = bytes.readUInt32LE(16);
    if (20 + size > bytes.length) invalid();
    if (kind === 'VP8X' && size === 10) {
      width = bytes.readUIntLE(24,3)+1; height = bytes.readUIntLE(27,3)+1;
    } else if (kind === 'VP8L' && size >= 5 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff)+1; height = ((bits >>> 14) & 0x3fff)+1;
    } else if (kind === 'VP8 ' && size >= 10 && bytes.subarray(23,26).toString('hex') === '9d012a') {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 10000 || height > 10000) invalid();
  return { width, height };
}
module.exports = { inspectImage };
