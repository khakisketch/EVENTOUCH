---
target: 운영 콘솔 홈·운영 현황
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/console/ConsoleHome.tsx"
target_fingerprint: "sha256:ff611346397c497100b85412e7a4c15a96ee9faf970488dab829e71c37b139d2"
target_path: /home/ksi/Desktop/SI-Projects/EVENTOUCH/apps/web/app/console/ConsoleHome.tsx
timestamp: 2026-10-15T09-13-03Z
slug: apps-web-app-console-consolehome-tsx
---
# Critique: 운영 콘솔 홈·운영 현황 (apps/web)

Method: dual-agent (A: ses_ec1320a8bffeR0hglz8Y6xGuC0 · B: ses_ec1320a88ffe9cfwGkbHSXkqC2)

## Design Health Score — 24/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 3 | 참가자 상태 변경의 진행 중 표시 없음 |
| 2 | Match System / Real World | 3 | 일부 라벨 축약·불일치 (승인 대기/승인대기) |
| 3 | User Control and Freedom | 2 | 상태 변경 즉시 확정, undo 없음 |
| 4 | Consistency and Standards | 3 | 서브내비 7개·용어 미세 분기 |
| 5 | Error Prevention | 2 | 승인에 단계 전환급 가드레일 없음 |
| 6 | Recognition Rather Than Recall | 3 | 승인 CTA가 미필터 목록으로 연결됨 |
| 7 | Flexibility and Efficiency | 2 | 승인 우선 뷰·단축키·일괄 처리 없음 |
| 8 | Aesthetic and Minimalist Design | 3 | 깔끔하나 범용적, overview 다작업 노출 |
| 9 | Error Recovery | 2 | undo 없음, 복구 안내 부족 |
| 10 | Help and Documentation | 1 | 운영 판단용 맥락 도움 없음 |

## Design Specificity Verdict

LLM: 작업 모델(D-day·승인 수·입장 수·지금 할 일)은 행사 운영에 맞춰져 있으나, 다크 사이드바·흰 KPI 카드·주황 CTA의 시각 언어는 범용 B2B 어드민과 구분되지 않는다. 특정성은 데이터·문구에 있고 시각 POV에는 없다.
Deterministic scan: `impeccable detect` 1건 — side-tab warning 1건(MessagingWorkspace.module.css:453 `.campaignHint`). warning 토큰 세트와 결합된 경고 콜아웃이라 의도적 패턴으로 판단하고 수용한다. type/layout 스코프는 0건. 브라우저 증거는 전 페이지·뷰포트에서 넘침 0, 콘솔·페이지 오류 0, 가시 포커스 있음, 44px 미만 0, title/lang 정상.

## Overall Impression

찾기는 쉽고, 승인하기는 불안하다. 카드·지표·CTA의 앞단은 단단한데, 정작 승인이라는 고위험 행위가 가드레일 없는 select 하나로 처리된다. 가장 큰 기회는 승인 트리아지 큐이다.

## What's Working

- 행사 카드가 D-day·장소·단계·등록/대기/입장 수를 한눈에 담아 구분이 된다.
- 운영 현황의 "지금 할 일"과 주황 CTA가 승인을 주행동으로 못박는다.
- 단계 전환은 현재/다음 단계 고지·확인·취소·전제조건 안내로 가드레일이 있다.

## Priority Issues

1. [P1] 행사 정렬이 달력순이라 승인할 일이 있는 행사가 묻힌다. 승인 대기 필터·대기 수 정렬을 둔다. (/impeccable polish)
2. [P1] 참가자 상태 변경이 확인 없이 즉시 확정된다. 대기 행은 명시적 승인 동작으로, 취소 등 파급 행위는 확인을 둔다. (/impeccable harden)
3. [P1] 목록 행이 이름만 보여 동명이인을 구분할 수 없다. 소속/그룹·마스킹 연락처를 함께 보여준다. (/impeccable clarify)
4. [P2] 승인 CTA가 미필터 목록으로 간다. 승인 대기 필터를 carried-over 상태로 연다. (/impeccable polish)
5. [P2] 모바일에서 대기 1건을 찾으려면 전체를 스크롤해야 한다. 대기 필터 상단 고정·하단 가림 점검. (/impeccable adapt)

## Persona Red Flags

- Alex: 승인 우선 필터·큐·단축키·일괄 없음. 10개 행사 스캔 후 미필터 28명 목록에서 또 필터 변경.
- Sam: 기반(스킵 링크·네이티브 컨트롤·live 알림)은 양호. 행 select의 키보드 선택 즉시 확정이 위험. 검색의 접근 가능 이름과 placeholder 범위 불일치. 실청취 미검증.
- Casey: 대기 필터 없이 카드·28명 스크롤. 상태 필터가 상단이라 스크롤 후 복귀 필요. 하단 탭 가림 가능.

## Minor Observations

- 승인 대기/승인대기, 현재 입장/현재입장 표기 혼용.
- 일정 미정 카드의 시간 표시 모호. 지난 일정×진행 중 병기 시 맥락 부족. 입장률 분모 미표시.

## Questions to Consider

- 운영자가 승인 일을 카드 스캔이 아니라 큐로 열게 하면 무엇이 달라지는가?
- 동명이인 승인에 필요한 최소 증거는 무엇인가?
- 승인 처리하기가 미필터 목록으로 가야 하는 경우가 있는가?
