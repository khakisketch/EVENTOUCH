# EVENTOUCH 현황

이 문서가 **현재 상태의 정본**이다. 다른 문서가 여기와 어긋나면 이 문서가 맞다.
갱신 규칙: 작업이 끝날 때마다 갱신하고, 지난 서술은 지우거나 `## 이력`으로 내린다.

Updated: 2026-10-14
Branch: `master` · HEAD: `925a767`

## 제품

행사대행 운영사를 위한 웹 제품 하나. 운영사 구성원·고객사 담당자·현장 스태프가 쓰는 콘솔과
앱 없는 참가자 웹(신청 → 티켓 QR → 현장 체크인)을 같은 서버가 함께 서빙한다.
빌드 단계 없음(바닐라 ES + IIFE), 데이터는 PostgreSQL.

## 지금 되는 것

| 영역 | 상태 |
|---|---|
| 운영 콘솔 | 행사 목록(고객사명 포함) · 운영 현황 대시보드 · 참가자 · 현장 운영 · 부스 · 프로그램 · 메시지 · 결과·보고서 · 설정 |
| 참가자 웹 | 행사 홈 · 참가 신청 · 신청 상태 · 티켓 QR · 현장 안내 |
| 스태프 | 데스크(체크인·수동 검색·카메라 스캔) · 부스 인증 · 오프라인 케네(스캔 큐) |
| 전광판 | 공지·프로그램·사진·설문 등 5초 갱신 출력 화면 |
| 서버 권위 | 이벤트 커맨드 60종 + 조직 범위 REST 3종(고객사·조직 권한·행사 권한), 멱등 재시도 |
| 메시지 | Solapi 어댑터 구현됨, 자격증명 없어 **모의 발송**만. 발송 의도는 트랜잭션 outbox에 기록되고 부팅 시 재처리된다 |
| 배포 | Docker 컨테이너 2개(앱+DB) 기동·검증됨 |

## 검증 수치 (현재 작업 트리 실측)

- `npm test` — **495 통과, 실패 0, 스킵 0** (DB 주입 시). DB 없이 돌리면 197개가 스킵되고 실패로 처리된다.
- `npm run a11y` — 주요 12화면, serious/critical **0**
- `npm run mobile` — 6기기 × 2방향 × 6화면 = **72검사 통과**, 가로 넘침·44px 미만 조작 요소 0

## 실행

```bash
npm ci
npm start                     # DATABASE_URL 필요, 기본 포트 8776
bash scripts/serve-demo.sh     # 이 환경의 데모 서버(포트·DB를 환경변수로 바꾼다)
```

검증용 DB를 붙여 돌릴 때:

```bash
EVENTOUCH_TEST_DATABASE_URL='postgres://eventouch@localhost/eventouch_test_a?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5' npm test
EVENTOUCH_A11Y_DATABASE_URL='postgres://eventouch@localhost/eventouch_uiux_audit?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5' npm run a11y
EVENTOUCH_MOBILE_DATABASE_URL='postgres://eventouch@localhost/eventouch_uiux_mobile?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5' npm run mobile
```

## 배포

| 대상 | 주소 | 비고 |
|---|---|---|
| 컨테이너 배포본 | `https://dgx-spark-1.tailda9552.ts.net:8893/` (테일넷 전용) | `docker compose -p eventouch up -d --build`, 호스트 8891, 빈 DB |
| 개발·데모 서버 | `https://dgx-spark-1.tailda9552.ts.net:8890/` | 데모 데이터, 계정 `admin@eventouch.demo` / `Eventouch2026!` |

배포본에서 확인한 것: 로그인, 콘솔 진입, 고객사 저장, `docker compose restart` 후 데이터 유지.
관리자 자격증명은 `/tmp/opencode/eventouch-deploy.env`(600)에 있고 **커밋하지 않는다**.
운영 배포 위치(NAS·공개 도메인)와 값은 아직 정해지지 않았다 — `docs/DEPLOY.md`.

## 결정 (유효)

- 문자·알림톡은 Solapi 직결. 자격증명·발신번호·승인 템플릿이 준비되면 실발송을 후검증한다.
- 요금은 행사대행 운영사 부담. 결제·환불·기프티콘은 v1 제외(모의 발송만).
- 오프라인은 **셸까지만** 지원한다. 오프라인 세션(권한 해제 무시·기기 분실 위험)은 의도적 미지원.
- 중복 정의(뷰 10·액션 16) 제거는 하지 않는다. 정적 분석으로 레이어와 죽은 코드를 구분할 수 없다.
- 내비게이션 정본: 메인 메뉴는 `행사`·`고객사` 두 개, 현재 행사는 `행사` 아래 중첩,
  `팀·권한`·`서비스 연동`은 하단 운영자 메뉴. 새 "조직 설정" 영역은 만들지 않는다.
- 고객사는 운영사의 내부 기록이다. 고객사 포털·로그인은 제공하지 않는다.

## 블로커

| 항목 | 내용 |
|---|---|
| 실발송 | Solapi API Key/Secret·발신번호·카카오 `pfId`·승인 템플릿 없음 |
| 푸시·PR | git 원격 없음(2026-10-14 사용자가 "지금은 푸시하지 않음" 선택) |
| 운영 배포 | NAS냐 공개 도메인이냐 미정, 필요한 자격증명 미확보 |
| 고객사 담당자 | 서버 `accounts.role` CHECK에 `CLIENT` 역할이 없어 초대·연결·행사 권한이 프리뷰 모드에서만 동작 |
| 서버 시각 | NTP 동기화 미확인(Solapi ±15분 제약) |

## 다음

1. Solapi 준비 → 실발송 검증(SMS·LMS·알림톡·대체발송 각 1건). `docs/INTEGRATIONS.md`
2. 운영 배포 위치 결정 → 그 값으로 자격증명 발급, `COOKIE_SECURE=1`
3. 푸시할 원격이 정해지면 push + CI(워크플로는 이미 있다: `.github/workflows/ci.yml`)
4. 고객사 담당자(CLIENT 역할) 지원 여부 결정 — 스키마 변경 + 인증 흐름 설계 필요

## 남은 미검증 (완료라고 말하지 않는다)

- 물리 기기: 카메라 스캔, 소프트 키보드, 실제 터치, iOS Safari 렌더링
- 스크린리더 실제 청취
- 문자 실발송·도달 확인
- 사람에 의한 최종 제품 수용(M1 human acceptance)

## 이력

- 2026-10-14: Next.js 이관 슬라이스 2(참가 신청). 공개 양식·동의를 서버에서 읽고
  같은 오리진 공개 signup으로 신청한 뒤 발급 티켓으로 티켓 화면에 간다.
  실제 신청→DB 저장→티켓 화면 전환을 데모에서 확인.
- 2026-10-14: Next.js 이관 슬라이스 3(내 티켓). bearer를 주소에서 1회 소비해
  메모리로 옮기고 정리, 서버 조회로만 상태 판단, 스캐너 호환 토큰 원문 QR 렌더.
  신청→발급→QR 표시 흐름을 데모에서 확인.
- 2026-10-14: Next.js 이관 슬라이스 4a(스태프 수동 체크인). 같은 오리진 세션 로그인,
  배정 데스크 선택, `check.scan` 처리와 중복 거부 표시를 데모에서 확인.
  성공 결과는 목록 새로고침 뒤에도 유지된다.
- 2026-10-14: Next.js 이관 슬라이스 4b(카메라 스캔). 프레임 디코딩→서버 검증 제출,
  카메라·권한 없으면 수동 입력 안내. 무카메라 환경에서 폴백·수동 폼·오류 0 확인.
  실제 광학 디코딩은 실기기 검증에서 확인한다.
- 2026-10-14: 발송 outbox(`message_outbox`, 004)와 체크인 기록 투영(`checkin_records`, 005) 추가.
  발송 의도는 커맨드와 같은 트랜잭션에 기록되고 결과 기록 후 확정, 남은 건 부팅 드레인이
  재처리한다. 체크인 기록은 같은 트랜잭션 write-through + 기존 기록 백필, 읽기는 JSONB 유지.
  `npm test` 488 통과. 데모 DB도 부팅 마이그레이션으로 005까지 적용, 고객사 쓰기→재시작 유지 확인.
- 2026-10-14: 서버 커맨드 실행기의 중복 순수 헬퍼를 `server/commands/shared.js`로 묶음.
  동작 변경 없음(권한·잠금·영수증은 각 실행기에 유지). `npm test` 479 통과,
  데모 서버 재시작 후 로그인→콘솔 진입 확인, 페이지 오류 0.
  증거는 `/tmp/opencode/eventouch-captures/refactor-shared-*.png`.
- 2026-10-14: 풀스택 목표를 모듈형 모놀리스로 확정하고 Next.js/TypeScript 프론트엔드와
  TypeScript/Fastify API를 점진 도입하는 기준을 `docs/ARCHITECTURE.md`에 기록. 서로 다른
  요청 ID로 같은 티켓을 동시에 스캔할 때도 체크인이 한 번만 성공하는 PostgreSQL 회귀 테스트 추가.
  `npm test` 479 통과.
- 2026-10-14: OD·Superpowers·Playwright 임시 상태와 시안 작업 폴더 제거. 테스트 픽스처는
  `tests/fixtures/booth-map/`, 데모 런처는 `scripts/serve-demo.sh`로 이동. 전체 테스트 478개,
  접근성 12화면, 모바일 72검사 통과. 관련 커밋 `6f711d2`, `925a767`.
- 2026-10-14: 콘솔 IA 재설계(사이드바·행사 목록 홈·고객사·운영 현황 대시보드), 표면 3종
  (참가자·스태프·전광판) 조치, 서버 명령 3종(고객사·조직 권한·행사 권한) 구현,
  Docker 배포 기동, 테스트 하네스 직렬화(거짓 실패 6건 제거).
- 2026-10-13: 상용화 기반(보안·운영) + UI/UX 렌더 리뷰와 결함 조치.
- 2026-10-07: PostgreSQL 전환(M1) 완료, JSON 폴백은 410.
