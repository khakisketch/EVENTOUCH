---
target: SaaS 랜딩
total_score: 21
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 3
target_identity: "file:/home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/page.tsx"
target_fingerprint: "sha256:c24aa4f1fa0639148def13e221505ffb768b11b49d3d48b47820d5cb2d39f1f8"
target_path: /home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/page.tsx
timestamp: 2026-10-15T10-00-47Z
slug: apps-web-app-page-tsx
---
# Critique: SaaS 랜딩 (apps/web/app/page.tsx, Persuade)

Method: dual-agent (A: ses_ec105fe09ffeyxmpESg8SicD1x · B: ses_ec105fe08ffe0NCpMTOn4QB5Az)

## Design Health Score — 21/32 (Acceptable, H7·H10 n/a)

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 2 | 메일 인계 확인·복구 안내 없음 |
| 2 | Match System / Real World | 3 | 워크스페이스 표현은 범용 |
| 3 | User Control and Freedom | 3 | 로그인에 문의 복귀 없음 |
| 4 | Consistency and Standards | 3 | 로그인 2개 vs 문의 매몰 |
| 5 | Error Prevention | 2 | 문자 주장에 모의 단서 없음 |
| 6 | Recognition Rather Than Recall | 3 | 문의가 2.3뷰포트 아래 |
| 7 | Flexibility and Efficiency | n/a | 반복 운영 작업 없음 |
| 8 | Aesthetic and Minimalist Design | 3 | 정돈됐으나 개성 없음 |
| 9 | Error Recovery | 2 | 메일 실패 대비 없음 |
| 10 | Help and Documentation | n/a | 설득 표면 |

## Design Specificity Verdict

LLM: 문구는 행사 운영이나 구조는 범용 SaaS. 제품 증거(실화면) 없음.
Deterministic scan: `detect` page.tsx 0건. globals.css side-tab 1건은 스태프 공용부의 기존 관용구로 이 대상의 오탐. 브라우저 증거 3개 뷰포트 전부 넘침 0·페이지 오류 0·가시 포커스. 헤더 로그인 링크 20px 높이는 실제 44px 미달. 401은 비로그인 상태 확인용 정상 응답.

## Overall Impression

말은 되는데 증거가 없다. 평가자가 보내는 첫 화면이 로그인이고, 문자 주장은 모의 상태를 숨긴다.

## What's Working

- 3흐름·4역할·제약 고지가 평이한 한국어.
- 운영/스태프 문과 참가자 링크 분리.
- 포털 없음·QR 원칙·요금 주체 등 불편한 진실 명시.

## Priority Issues

1. [P1] 첫 화면이 평가자가 아니라 운영자용이다. 문의가 2.3뷰포트 아래. → 히어로에 이메일 문의, 로그인은 조용히. (/impeccable polish)
2. [P1] 문자 주장이 실발송처럼 읽힌다. 모의 상태 고지 없음. → 주장 옆에 한계 명시. (/impeccable clarify)
3. [P1] 실화면 증거가 없다. → 실제 데모 캡처(신청·승인·체크인·보고서). (/impeccable polish)
4. [P2] mailto에 제목·본문 없음. → 3문항 프리필 + 주소 복사 대비. (/impeccable clarify)
5. [P2] 약관 준비 중으로 끝난다. → 고지 유지, 본문 확보 시 교체. (문서, 코드 아님)

## Persona Red Flags

- Jordan: 로그인→문의 복귀 없음, 가입 없음. 문의까지 스크롤.
- Casey: 문의가 y1937, 하단 고정 없음. 카드는 충분한 타깃.
- Riley: 주장 vs STATUS 모의 불일치, 증거 없음, 약관 미완.

## Minor Observations

카드 반복, 3줄 헤드라인, 참가자 안내 텍스트는 제약상 정당.

## Questions to Consider

- 첫 행동이 문의라면 히어로 로그인은 왜 주인공인가?
- 문자를 오늘 실발송으로 파는가, 모의로 파는가?
- 무엇을 보여주면 전 과정을 믿겠는가?
