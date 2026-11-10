'use strict';

// Solapi documents that 4-byte characters cannot be sent by SMS/LMS and
// rejects non-printing controls. This deliberately checks only those known
// cases: it is NOT a complete Solapi or EUC-KR character-set validator.
// A UTF-16 offset lets a browser select the offending part without persisting
// the character or the personalized message in an error object.
function findSmsTextIssue(value) {
  const text = String(value == null ? '' : value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) return { kind: 'supplementary', index };
      return { kind: 'invalid_unicode', index };
    }
    if (code >= 0xdc00 && code <= 0xdfff) return { kind: 'invalid_unicode', index };
    // Preserve native LF and CRLF as entered. An isolated CR, tab, and all
    // other C0/C1 controls are not printable text and must not be silently
    // stripped or normalized.
    if (code === 0x0a) continue;
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) {
      index += 1;
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return { kind: 'control', index };
  }
  return null;
}

module.exports = { findSmsTextIssue };
