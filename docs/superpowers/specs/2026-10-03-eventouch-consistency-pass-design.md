# EVENTOUCH 전 화면 일관성 패스 설계 (2026-10-03)

> 목적: 디자인·흐름 사용성의 일관성. 새 기능·새 화면 없음.
> 기준 문서: `docs/superpowers/specs/2026-10-01-eventouch-full-scope-design.md`(계층·권한·흐름·제약 계승).
> 선행: Warm Operations 테마(`styles/theme.css`) + 306 테스트 그린(master d2657f9).

## 1. 원칙

- 렌더러가 내보내는 마크업 구조는 유지하고, 클래스·섹션 구조만 공통 패턴으로 정규화한다. 대부분은 `theme.css`에서 해결한다.
- 팔레트 고정: brand `#F35B2C`, action `#BC3F1B`, canvas `#FAF8F5`. 새 색·새 폰트 도입 금지.
- 전역 제약 계승: 주요 타깃 44px, 보이는 포커스, live region 중첩 금지, 320/390/768/1440 가로 스크롤 금지(표는 래퍼 내부 스크롤).
- 화면당 주 액션(Primary)은 1개. 나머지는 secondary.

## 2. 공통 셸·섹션 헤더 규칙

- 모든 뷰 섹션 헤더는 `h2` + brand 밑줄(기존 theme 규칙) 패턴으로 통일한다. 예외 뷰(screen-view 제외, 관객 표시는 별도 규칙 유지) 없이 적용한다.
- 섹션 도입 안내문은 `role="note"`로 통일한다.
- 내비 `aria-current="page"` 활성 상태가 10개 전 뷰 전환에서 빠짐없이 찍히는지 점검·보완한다.
- 파일: `index.html`(셸), `styles/theme.css`.

## 3. 카드·목록 통일

- 참가자 목록 행, 부스 목록, 씬 버튼 등 목록형 UI를 `.cards` / `.card` 단일 패턴으로 수렴한다.
- 간격·radius·padding은 토큰값 하나로 통일한다(임의 px 금지).
- 파일: 해당 `features/*.js` 렌더러(클래스 정규화만), `styles/theme.css`.

## 4. 빈 상태·피드백 통일

- 마운트가 비었을 때의 표시는 공통 empty 패턴으로 통일한다: `role="status"` 안내 문구 + 다음 액션 버튼 1개.
- 성공/경고/실패 표시는 기존 `[data-result][data-kind="good|warn|bad"]` 3종으로 일원화한다. 임시 `alert()`·제각각 인라인 스타일은 제거한다.
- 오류는 `role="alert"`로 표면화한다.
- 파일: `features/*.js`, `styles/theme.css`.

## 5. 액션 위계·폼 배치 통일

- Primary(brand 배경, `data-*` 주 액션)는 화면당 1개 원칙. 기존 Primary 목록(take, ticket-submit, signup-submit, stamp-receive, report-create, booth-add, camera-scan, lookup-submit)에 없는 임시 강조 버튼은 위계에 맞게 격하한다.
- 체크인 셸의 티켓 입력행 등 임시 배치는 `.inline-form` 패턴으로 편입한다.
- 라벨-컨트롤 조합은 `.field` 세로 스택으로 통일한다.
- 390px에서도 어긋나지 않게(stretch 전환 규칙 유지) 한다.
- 파일: `index.html`, `features/*.js`, `styles/theme.css`.

## 6. 적용 순서

1. 셸·섹션 규칙(2) → 2. 카드·목록(3) → 3. 빈 상태·피드백(4) → 4. 액션·폼(5) → 5. 브라우저 검수.
2. 각 단계는 테스트 그린을 유지한 채로 넘어간다(깨지면 다음 단계 금지).

## 7. 수락 기준

- `node --test tests/*.test.cjs` 전부 통과(기존 306 + 새 패턴 회귀 테스트 추가).
- 브라우저 10뷰 × 1280/390: 가로 overflow 0, 미달 터치 타깃 0.
- 모든 뷰에 빈 상태·피드백·주 액션이 위 규칙대로 들어가고, 예외가 있으면 이 문서에 명시한다.
- public 서버(`http://100.116.163.1:8000/index.html`)에서 하드 리프레시로 확인 가능.

## 8. 비목표

- 새 화면·새 팔레트·내비 구조 변경 없음(승인 패턴 내 작업이므로 Local Codex 경로 미사용).
- 흐름 재설계(체크인·부스 등 단계 자체 변경) 없음. 구조는 두고 표현·배치만 통일한다.
- provider·장비·실제 스크린리더·종단 수락은 코드 범위 밖(기존 Next 유지).
