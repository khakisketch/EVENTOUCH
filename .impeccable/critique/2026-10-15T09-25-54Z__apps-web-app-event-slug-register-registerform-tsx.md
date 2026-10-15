---
target: 참가자 여정 신청-티켓-참여
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/event/[slug]/register/RegisterForm.tsx"
target_fingerprint: "sha256:0bf47b1199d7531d80af128a129c90d9c9315762fd5ac4dfcf1b0899d4b3aefb"
target_path: /home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/event/[slug]/register/RegisterForm.tsx
timestamp: 2026-10-15T09-25-54Z
slug: apps-web-app-event-slug-register-registerform-tsx
---
# Critique: 참가자 여정 신청→티켓→참여 (apps/web/app/event)

Method: dual-agent (A: ses_ec122d64cffe0JO5EdgGBnfCCW · B: ses_ec122d649ffed4msz9KvnyC9G7)

## Design Health Score — 24/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 3 | 신청 확정·코드 발송 확인 부족 |
| 2 | Match System / Real World | 3 | 탭 보관인데 기기 복구 문구 |
| 3 | User Control and Freedom | 2 | 새로고침에 폼 상태 소실, 명시적 취소 경로 없음 |
| 4 | Consistency and Standards | 3 | engage 헤더·복구 링크 배치 분기 |
| 5 | Error Prevention | 2 | 인증 전 신청 버튼 활성 |
| 6 | Recognition Rather Than Recall | 2 | engage 진입점·티켓 재접속 안내 없음 |
| 7 | Flexibility and Efficiency | 2 | 임시저장·이어하기 없음 |
| 8 | Aesthetic and Minimalist Design | 3 | 차분하나 행사 개성 부족, 장소 반복 |
| 9 | Error Recovery | 2 | 상태별 티켓 문구 뭉뚱그림, 진행 소실 |
| 10 | Help and Documentation | 2 | 인증·대기·복구 맥락 도움 부족 |

## Design Specificity Verdict

LLM: 기능은 참가자에 맞춰져 있으나 시각 언어는 범용 카드·폼. 행사별 개성 없음.
Deterministic scan: `detect` 0건(type/layout 포함). 브라우저 증거 10개면 전부 넘침 0·페이지 오류 0·가시 포커스(1곳 측정 방식상 한계 제외)·title/lang 정상. 티켓 미보유 404는 설계된 분기로 확인. 동의 체크박스 20px은 라벨 클릭 영역으로 보완되는 경계 사례.

## Overall Impression

신청은 쉽고, 티켓 이후가 끊긴다. QR를 받은 참가자가 참여 프로그램으로 가는 길이 없고, 다음 날 티켓을 여는 말이 실제 보관 범위를 과장한다.

## What's Working

- 모바일에서 행사 핵심 정보와 신청 CTA가 먼저 보인다. 44px CTA.
- 전화·인증번호 키보드·자동완성 힌트, 라벨링된 입력.
- bearer URL 정리 + 전화 인증 복구라는 보안 모델과 복구 개념.

## Priority Issues

1. [P1] 티켓 화면에 참여 프로그램 진입점이 없다. QR 보유자가 공개 프로그램을 발견할 수 없다. → 티켓 사용 가능 상태에 참여 링크. (/impeccable polish)
2. [P1] 기기 복구 문구가 탭 보관 범위를 과장한다. 탭을 닫으면 같은 기기에서도 소실. → 탭 범위 명시 + 복구 링크 노출. (/impeccable clarify)
3. [P1] 승인 대기 티켓이 오류처럼 보인다. 신청 성공이 실패처럼 끝난다. → 상태별 문구·다음 단계. (/impeccable clarify)
4. [P2] 인증 필수인데 신청 버튼이 먼저 열려 있다. 실패 제출 같은 뒷북 안내. → 인증 완료 전 신청 불가 명시 + 발송 확인·재전송 상태. (/impeccable harden)

## Persona Red Flags

- Jordan: 인증 선행 조건을 제출 시도 후에 안다. 발송 확인 없음. 다음 날 탭关闭 시 기기 문구와 어긋남. 대기 문구에 신청 실패로 오해.
- Casey: 키보드·인터럽트에 폼 상태 소실(임시저장 없음). 티켓 탭 종료 시 bearer 소실. 하단 고정 액션 없음.
- Riley: 새로고침·새 탭·다음 날 복귀가 전부 약점. 중복 제출 방어는 양호(commandId·비활성화).

## Minor Observations

- 데모 행사 날짜(10-13)가 과거인데 진행 중. 장소 중복 노출. 복구 화면 링크 배치. 동의 체크박스 20px(라벨 보완).

## Questions to Consider

- 참여 프로그램 진입 답이 URL 암기라면 여정은 완성인가?
- 기기 복구를 약속하는가, 탭 복구를 약속하는가?
- 미승인자에게 티켓 화면은 영수증인가, 오류인가?
