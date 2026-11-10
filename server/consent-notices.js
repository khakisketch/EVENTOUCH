'use strict';

const crypto = require('node:crypto');

// This is the same text as the public workspace projection: legacy records
// may contain whitespace, so do not trim it before preserving the notice.
function publicConsentText(workspace) {
  return typeof workspace?.consentText === 'string' ? workspace.consentText.slice(0, 3000) : '';
}

// Called only while holding the event/workspace lock. Existing participants
// are never backfilled: a reference is evidence only for a new acceptance.
function ensureConsentNotice(workspace, now) {
  const text = publicConsentText(workspace);
  if (!text.trim()) return null;
  const version = Number(workspace.consentVersion) || 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw Object.assign(new Error('동의 안내 버전을 확인할 수 없습니다. 행사 운영자에게 문의하세요.'), { status: 409 });
  }
  if (!Object.hasOwn(workspace, 'consentNotices')) workspace.consentNotices = [];
  if (!Array.isArray(workspace.consentNotices)) {
    throw Object.assign(new Error('동의 안내 기록을 확인할 수 없습니다. 행사 운영자에게 문의하세요.'), { status: 409 });
  }
  const id = `notice-${crypto.createHash('sha256').update(JSON.stringify([version, text])).digest('hex')}`;
  const existing = workspace.consentNotices.find((item) => item && item.id === id);
  if (existing) {
    if (existing.version !== version || existing.text !== text) {
      throw Object.assign(new Error('동의 안내 기록을 확인할 수 없습니다. 행사 운영자에게 문의하세요.'), { status: 409 });
    }
    return existing;
  }
  const notice = { id, version, text, capturedAt: now };
  workspace.consentNotices.push(notice);
  return notice;
}

module.exports = { ensureConsentNotice, publicConsentText };
