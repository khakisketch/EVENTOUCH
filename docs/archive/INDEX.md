# 아카이브 인덱스

지난 계획·설계 기록이다. **고치지 않고 보존한다.** 현재 상태는 [../STATUS.md](../STATUS.md),
현재 구조는 [../ARCHITECTURE.md](../ARCHITECTURE.md)를 본다.

여기 있는 문서는 그 시점의 결정과 근거를 담고 있다. "현재"라고 적힌 서술이 있어도
그 당시의 현재이며, 지금과 다르면 STATUS.md가 맞다.

## 계획 (plans/)

| 문서 | 무엇을 했나 |
|---|---|
| `2026-10-01-eventouch-full-scope-build` | 전체 범위 구축(첫 뼈대) |
| `2026-10-01-eventouch-frontend-journeys` | 프론트 여정 1차: 행사 준비 |
| `2026-10-01-eventouch-content-screens` | 콘텐츠 화면(공지·일정·안내) |
| `2026-10-01-eventouch-desk-screens` | 데스크 화면(체크인) |
| `2026-10-01-eventouch-engage-screens` | 참여 화면(설문·퀴즈·사진) |
| `2026-10-01-eventouch-integrations` | 연동(문자·결제) 설계와 구현 |
| `2026-10-01-eventouch-ko-ux-implementation` | 한국어 UX 정리 |
| `2026-10-01-eventouch-remediation` | 1차 결함 수습 |
| `2026-10-02-eventouch-mobile` | 참가자 모바일 |
| `2026-10-02-eventouch-screen` | 전광판 |
| `2026-10-03-od-visual-handoff` | 비주얼 인계 기록 |
| `2026-10-04-eventouch-14-view-ux-redesign` | 14화면 UX 재설계 |
| `2026-10-04-eventouch-contextual-shell` | 맥락형 셸 도입 |
| `2026-10-05-eventouch-product-backend` | 실제 백엔드 전환 |
| `2026-10-06-eventouch-preparation-registration-ux` | 준비·참가 신청 UX (사용자 보관 문서, 추적하지 않음) |
| `2026-10-07-eventouch-postgresql` | PostgreSQL 전환(M1) — 서버 권위 확립 |
| `2026-10-07-eventouch-booth-stamp-map` | 부스 인증 지도 |
| `2026-10-09-event-management-mobile-redesign` | 행사 목록 모바일 재설계 |
| `2026-10-09-event-operations-overview-redesign` | 운영 현황 재설계 1차 |
| `2026-10-09-eventouch-ui-micro-polish` | 소규모 UI 감사 계약 |
| `2026-10-09-operations-console-density` | 콘솔 밀도(헤더 축소·중복 제거) |
| `2026-10-09-operations-visual-language` | 운영 화면 비주얼 언어 |
| `2026-10-10-list-ops-consistency` | 목록·운영 일관성 |
| `2026-10-10-operations-home-rebuild` | 운영 홈 재구축(업무 실행 중심) |
| `2026-10-10-ops-home-simplify` | 운영 홈 단순화(화면 책임·중복) |
| `2026-10-10-regress-restore-checkin` | 목록 카드 회귀 복구 + 체크인 우선순위 |

## 설계 (specs/)

| 문서 | 무엇을 정했나 |
|---|---|
| `2026-10-01-eventouch-full-scope-design` | 전체 범위 설계 v1 |
| `2026-10-03-agency-console-design` | 대행사 콘솔 셸(4뷰) |
| `2026-10-03-eventouch-consistency-pass-design` | 전 화면 일관성 기준 |
| `2026-10-04-eventouch-14-view-ux-redesign-design` | 14화면 정보구조 |
| `2026-10-04-eventouch-contextual-shell-design` | 맥락형 운영 셸 |
| `2026-10-05-eventouch-product-backend-design` | 통합 웹 + PostgreSQL 아키텍처 |
| `2026-10-06-eventouch-fullswap-design` | full-swap 재구축(B안) — 채택되지 않음 |
| `2026-10-07-eventouch-booth-stamp-map-design` | 부스 인증 지도 설계 |

## 상태 스냅샷

| 문서 | 시점 | 비고 |
|---|---|---|
| `product-state-2026-10-10.md` | 2026-10-10 | 당시 정본. 이후 워크트리 통합·배포로 서술이 무효 → STATUS.md로 대체 |
| `legacy-test-attribution.md` | 2026-10-08 | 레거시 테스트를 `tests/legacy`로 격리한 이유와 목록 |

## 아직 유효한 결정 (여기서 뽑아 STATUS.md로 옮긴 것)

- 레거시 프론트/테마 테스트는 고치지 않고 격리했다. 재도입하려면 계약 재검토가 필요하다.
- 중복 정의된 뷰·액션 정리는 하지 않는다(정적 분석으로 레이어와 죽은 코드를 구분할 수 없다).
- 오프라인은 셸까지만. 결제·환불 시뮬레이션 UI는 제거하고 서버 계약만 남겼다.
- 부스 지도는 위치 추적이 아니다(GPS·현재 위치·길안내 제외).
