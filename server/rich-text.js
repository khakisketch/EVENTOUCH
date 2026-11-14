'use strict';
// Notice bodies are stored as a small Markdown subset (bold, italic, lists,
// links, images). Nothing here renders or sanitizes HTML: the server only
// knows which uploaded files a body references, so saving can check they are
// this event's images and the public file route can serve exactly those.
// Image syntax: ![alt](file:<fileId>). Rendering lives in apps/web/lib/rich-text.ts.

const IMAGE_REF = /!\[[^\]\n]*\]\(file:([A-Za-z0-9_-]{1,160})\)/g;
const MAX_BODY_IMAGES = 6;

function bodyImageIds(body) {
  const ids = [];
  for (const match of String(body || '').matchAll(IMAGE_REF)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

module.exports = { bodyImageIds, MAX_BODY_IMAGES };
