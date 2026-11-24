'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server/consent-template');
const web = require('../apps/web/lib/consent-template.ts');

test('web and server consent templates are identical', () => {
  assert.equal(web.LEGACY_DEFAULT_CONSENT_TEXT, server.LEGACY_DEFAULT_CONSENT_TEXT);
  assert.equal(web.FALLBACK_CONTACT, server.FALLBACK_CONTACT);
  for (const [name, contact] of [['', ''], ['봄 행사', ''], ['봄 행사', '운영 사무국 02-123-4567 · help@example.com'], ['  긴\n이름  ', '  a\n b '], [undefined, null], ['가'.repeat(300), '나'.repeat(300)]]) {
    assert.equal(web.consentTemplate(name, contact), server.consentTemplate(name, contact));
  }
  assert.equal(web.isLegacyDefaultConsentText(` ${server.LEGACY_DEFAULT_CONSENT_TEXT}\n`), true);
  assert.equal(web.isLegacyDefaultConsentText('다른 문구'), false);
});

test('template follows the confirmed wording and never promises automatic deletion', () => {
  const text = server.consentTemplate('', '');
  assert.equal(text, [
    '[개인정보 수집·이용 동의]',
    '수집 항목: 이름, 연락처, 소속 및 신청서에 입력한 항목',
    '이용 목적: 행사 신청 확인, 입장 확인, 행사 관련 안내 문자 발송',
    '보유 기간: 행사 종료 후 6개월까지 보관하고, 이후 주최 측 요청에 따라 파기합니다',
    '동의 거부: 동의하지 않을 수 있으며, 이 경우 행사 신청이 제한됩니다',
    '처리 위탁: 신청·입장 관리 시스템 운영(EVENTOUCH), 문자 발송(Solapi)',
    '문의: 행사 주최 측',
  ].join('\n'));
  assert.match(server.consentTemplate('봄 행사', '02-123-4567'), /^\[개인정보 수집·이용 동의\]\n행사: 봄 행사\n/);
  assert.match(server.consentTemplate('봄 행사', '02-123-4567'), /문의: 02-123-4567$/);
  assert.ok(server.consentTemplate('가'.repeat(500), '나'.repeat(500)).length <= 3000);
});
