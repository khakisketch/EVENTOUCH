'use strict';

// Default privacy consent notice for a NEW event. It states only what the
// system really does: nothing is purged automatically, so retention is
// phrased as "deleted at the organizer's request" (see the participant.erase
// command and the event:purge:review procedure). Legal wording is a draft
// pending legal review.
//
// apps/web/lib/consent-template.ts mirrors this file for the console UI;
// tests/consent-template.test.cjs asserts the two produce identical text.

const LEGACY_DEFAULT_CONSENT_TEXT = '행사 신청과 입장 확인을 위해 이름과 연락처를 사용합니다.';
const FALLBACK_CONTACT = '행사 주최 측';
const MAX_CONSENT_TEXT = 3000;

function line(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// (eventName, contact) -> consent notice. An empty eventName omits the event
// line (a brand-new event has no name yet); an empty contact falls back to
// "행사 주최 측".
function consentTemplate(eventName, contact) {
  const name = line(eventName, 100);
  const inquiry = line(contact, 200) || FALLBACK_CONTACT;
  return [
    '[개인정보 수집·이용 동의]',
    ...(name ? [`행사: ${name}`] : []),
    '수집 항목: 이름, 연락처, 소속 및 신청서에 입력한 항목',
    '이용 목적: 행사 신청 확인, 입장 확인, 행사 관련 안내 문자 발송',
    '보유 기간: 행사 종료 후 6개월까지 보관하고, 이후 주최 측 요청에 따라 파기합니다',
    '동의 거부: 동의하지 않을 수 있으며, 이 경우 행사 신청이 제한됩니다',
    '처리 위탁: 신청·입장 관리 시스템 운영(EVENTOUCH), 문자 발송(Solapi)',
    `문의: ${inquiry}`,
  ].join('\n').slice(0, MAX_CONSENT_TEXT);
}

function isLegacyDefaultConsentText(value) {
  return typeof value === 'string' && value.trim() === LEGACY_DEFAULT_CONSENT_TEXT;
}

module.exports = {
  LEGACY_DEFAULT_CONSENT_TEXT,
  FALLBACK_CONTACT,
  consentTemplate,
  isLegacyDefaultConsentText,
};
