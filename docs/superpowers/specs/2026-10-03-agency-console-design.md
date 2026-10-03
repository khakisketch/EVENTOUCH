# 대행사 콘솔 설계 (2026-10-03, A안: 셸 뷰 4개)

> 풀 패리티 승인. OD `eventouch-a82e` agency 레이어 + 전체범위 스펙(§2 역할·§3 행사/팀) 기준.

## 데이터 (`features/agency.js`)
- `store.clients: [{id, name, contact, email}]`, `saveClient`(생성/수정·이메일 검증·`requireWrite('clients')`), `removeClient(id)`.
- `setEventStatus(id, next)`: PRE→LIVE→END 전진만, 역행/점프 한글 거부, `requireWrite('events')`.
- `agencySummary()`: {total, live, pre, ended, participants, pending(미승인 사진+대기 Q&A)}. 읽기 전용.
- `ETKO.agencyUi = {step, draft}` 인메모리 마법사 상태.
- `clients` 라우트: KNOWN + READONLY 포함, STAFF 제외.

## 셸 (`app.js`·`views.js`·`index.html`·`ko.json`)
- `agency-home/events/clients/team` — nav·registry·VIEWS 모두 최상위(맨 앞).
- 라벨: 대행사 홈·행사 관리·고객사·팀과 권한.
- STAFF 진입 거부(현재 뷰 유지), CLIENT/VIEWER 읽기.

## 화면 (신규 `features/agency-ui.js`, 기존 마크업 언어)
- Home: 스탯 밴드 + 행사 카드(이동) + 최근 활동(로그 최신 8).
- Events: 3단계 마법사(기본정보→참여기능→검토) + 행사 목록(상태 pill·전환·워크스페이스 이동).
- Clients: 카드 + 추가/수정 폼 + 삭제.
- Team: 활성 행사 구성원 매트릭스 + 추가(이름·이메일·역할). `saveMember` 재사용.

## 검증
- 329 + 신규(라우팅·마법사·status·clients·4 렌더러). nav/views/qa 10뷰 고정값 14로 갱신.
- 브라우저 14뷰 × 1280/390 + AGENCY/STAFF 진입 확인.
