---
target: 스태프 현장 업무
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:/home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/staff/StaffEventWork.tsx"
target_fingerprint: "sha256:422d8d128f31f62e7acc535cadd99dc0ec361fc14c3d505a8e4beedc02321730"
target_path: /home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/staff/StaffEventWork.tsx
timestamp: 2026-10-15T10-00-47Z
slug: apps-web-app-staff-staffeventwork-tsx
---
# Critique: 스태프 현장 업무 (apps/web/app/staff)

Method: dual-agent (A: ses_ec105fe1affeqijVimVhJTSCiz · B: ses_ec105fe0affegUTyDPBoC7MhVS)

## Design Health Score — 25/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 3 | 성공에 완료·다음 단계 큐 부족 |
| 2 | Match System / Real World | 3 | SELF 부스 QR가 텍스트 문자열 |
| 3 | User Control and Freedom | 2 | 오스캔 확정 후 현장 복구 없음 |
| 4 | Consistency and Standards | 3 | 허브 재시도와 행사지역 재시도 다름 |
| 5 | Error Prevention | 2 | 카메라 즉시 제출·종료 부스 선택 가능 |
| 6 | Recognition Rather Than Recall | 3 | 최근 기록에 시각·데스크 없음 |
| 7 | Flexibility and Efficiency | 2 | 정정·고속 처리가속 없음 |
| 8 | Aesthetic and Minimalist Design | 3 | 하단 10행 저정보 꼬리 |
| 9 | Error Recovery | 2 | 오인정 스캔 복구 불가 |
| 10 | Help and Documentation | 2 | 스캔·복구 맥락 도움 부족 |

## Design Specificity Verdict

LLM: 배정·입퇴장 방향 등 작업 모델은 현장에 맞춰져 있으나 시각 언어는 범용 체크인 폼.
Deterministic scan: `detect` 0건. 브라우저 증거 8개면 전부 넘침 0·오류 0·가시 포커스·44px 이상·title/lang 정상. 허브 무키오스크는 구조상 당연.

## Overall Impression

빠르게 찍기는 되는데, 잘못 찍으면 답이 없다. 오스캔 복구 부재가 현장 최대 리스크.

## What's Working

- 배정 범위 업무 + 데스크 방향 명시.
- 오티켓 오류는 한국어·코드 유지·재시도 가능.
- 키오스크 목적 명확(공용 태블릿, 무인 아님 고지).

## Priority Issues

1. [P1] 허브 재시도 버튼이 다시 불러오지 않는다. 로딩만 돌아간다. → reloadTick 연결. (/impeccable polish)
2. [P1] 유효 오스캔의 현장 복구가 없다. 서버 check.correct가 있는데 화면에 없다. → 최근 결과·기록에 사유 포함 정정. (/impeccable harden)
3. [P1] SELF 부스 QR가 스캔 불가 텍스트다. → 실제 QR + 복사·인쇄 경로, 없으면 공급처 명시. (/impeccable polish)
4. [P2] 네임택 미리보기가 결과와 멀리 떨어진다. → 결과 옆 배치·포커스 이동. (/impeccable layout)
5. [P2] 종료 부스가 진행 전으로 표시되고 선택된다. → WAITING/CLOSED 구분·비활성. (/impeccable clarify)

## Persona Red Flags

- Casey: 비활성 버튼 2.14:1(역광), 인터럽트에 초안 소실, 오스캔 복구 없음.
- Sam: 카메라 영역 포커스 미이동·상태 미발표, 네임택 포커스 없음.
- Alex: 스캔 후 포커스 이탈, 대량 처리 가속 없음, 오스캔 복구 없음.

## Minor Observations

키오스크 전환이 결과 초기화. 최근 처리 시각·데스크 없음. 카메라 액션 숨김 전제 미고지.

## Questions to Consider

- 오스캔 정정은 현장 1단계인가, 매니저 인계인가?
- 키오스크는 대형 입력기인가, 부스 QR 공급처인가?
- 최근 처리는 10개 이름인가, 타임스탬프 짧은 목록인가?
