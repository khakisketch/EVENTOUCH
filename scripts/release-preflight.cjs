'use strict';
// Read-only: never sends mail/SMS, mutates data, deploys or enables workers.
const fs = require('node:fs');
const { isIP } = require('node:net');
const { publicOrigin } = require('../server/public-origin');
const { smtpConfiguration } = require('../server/smtp-mail');
const { loginHistoryPolicy } = require('../server/login-history');
const REQUIRED_OBSERVATIONS = ['operatorJourney', 'iosSafariCamera', 'androidCamera', 'screenReader', 'printerAndReader', 'smsDelivery', 'emailDelivery', 'customerAcceptance'];
function assess(env, attest = {}) {
  const checks = [];
  const validDate = value => Number.isFinite(Date.parse(value || '')) && Date.parse(value) <= Date.now();
  const add = (id, ready, detail) => checks.push({ id, status: ready ? 'ready' : 'pending', detail });
  const origin = publicOrigin(env);
  const url = origin ? new URL(origin) : null;
  const hostname = url?.hostname.replace(/\.$/, '') || '';
  const local = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname === '[::1]' || hostname === '[::]' ||
    (isIP(hostname) === 4 && (hostname.startsWith('127.') || hostname === '0.0.0.0'));
  add('publicOrigin', url?.protocol === 'https:' && !local, '공개 HTTPS 주소를 설정하세요. 티켓·초대·복구 링크는 실제 검수 환경에서 확인합니다.');
  add('secureCookie', env.COOKIE_SECURE === '1', '운영 HTTPS 쿠키 설정');
  add('smsConfiguration', Boolean(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && /^\d{8,15}$/.test(env.SOLAPI_SENDER || '')), 'Solapi 자격증명·등록 발신번호 필요. 설정 여부만 판정하며 도달을 증명하지 않음');
  add('kakaoConfiguration', Boolean(env.SOLAPI_KAKAO_PFID && Array.isArray(attest.kakaoTemplateCodes) && attest.kakaoTemplateCodes.length && attest.kakaoTemplateCodes.every(value => typeof value === 'string' && value.trim())), '카카오 채널과 승인 템플릿의 실제 검증 필요');
  add('mailConfiguration', Boolean(smtpConfiguration(env)), '명시적 SMTP·TLS 설정. 설정 여부만 판정하며 도달을 증명하지 않음');
  add('productionMocksOff', env.EVENTOUCH_SMS_MOCK !== '1' && env.EVENTOUCH_MAIL_MOCK !== '1', '운영 환경의 모의 발송 해제');
  const policy = loginHistoryPolicy(env);
  add('loginRetentionDecision', policy.enabled || env.EVENTOUCH_LOGIN_HISTORY_DAYS === '0', '로그인 기록 보존일 또는 미보관(0)을 명시적으로 결정');
  add('policyApproval', Boolean(attest.policyReviewer && attest.policyApprovedAt && validDate(attest.policyApprovedAt)), '추첨 규칙·상품·개인정보 보존·수동 계정 복구 담당자를 고객과 확정');
  const attested = Boolean(attest.reviewer && attest.observedAt && validDate(attest.observedAt));
  for (const id of REQUIRED_OBSERVATIONS) {
    const value = attest.checks?.[id];
    add(id, attested && (value === 'pass' || (id === 'printerAndReader' && value === 'not-used')), '실제 담당자의 관찰 기록 필요. 자동 검사나 합성 테스트로 대체하지 않음');
  }
  return { ok: checks.every(c => c.status === 'ready'), boundary: 'configuration and operator attestations; not a deployment or independent human/device verification', checks };
}
function main(argv = process.argv.slice(2)) {
  let attest = {};
  if (argv.length) { if (argv.length !== 2 || argv[0] !== '--attestation') throw new Error('사용법: npm run ops:release:check -- [--attestation <파일>]'); attest = JSON.parse(fs.readFileSync(argv[1], 'utf8')); }
  const report = assess(process.env, attest); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.ok ? 0 : 1; return report;
}
if (require.main === module) { try { main(); } catch { process.stderr.write('준비 상태 확인 실패: 환경과 검수 기록 파일 형식을 확인하세요.\n'); process.exitCode = 1; } }
module.exports = { assess, REQUIRED_OBSERVATIONS };
