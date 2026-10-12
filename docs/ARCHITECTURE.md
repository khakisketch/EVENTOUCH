# EVENTOUCH 구조

Updated: 2026-10-12 · 기준 리비전: `36243c9` (branch `feat/eventouch-postgres`)

이 문서는 **현재 코드가 실제로 하는 일**을 기술한다. 제안서(`EVENTOUCH_서비스 기획 및
제안.html`)나 `행사운영플랫폼_개발기획안.pdf`는 초기 기획이고, 제품은 그 뒤에 서버 권위
구조로 다시 만들어졌으므로 구현 판단의 근거로 쓰지 않는다.

이 문서가 구조의 기준이다. 시각 요약은 `docs/code-structure.svg`(같은 리비전 기준으로
갱신됨)를 본다. 두 문서가 코드와 어긋나면 코드와 테스트가 이긴다.

> 이전 버전의 `code-structure.svg`는 다른 브랜치(`eventouch-remediation`),
> 옛 네임스페이스(ETKO), 6개 화면, 메시징 시뮬레이션 전용 시절을 기술하고 있었다.
> `36243c9` 기준으로 다시 그렸다.

## 1. 한눈에

행사대행사가 여러 고객사의 행사를 운영하는 B2B 워크스페이스. 하나의 서버가 세 종류의
화면을 제공한다.

| 표면 | 사용자 | 경로 | 인증 |
|---|---|---|---|
| 운영 콘솔 | 대행사·행사 담당·현장 스태프 | `#/console/*`, `#/staff/*` | 세션 쿠키 |
| 참가자 웹 | 행사 참가자 | `#/event/<slug>/*` | 티켓 bearer (URL) |
| 행사장 출력 | 무대·전광판 | `#/screen/<eventId>` | 없음(공개) |
| 초대 수락 | 초대받은 구성원 | `#/invite/<token>` | 초대 토큰 |

규모: 화면 39 · UI 액션 120 · 서버 커맨드 50 · DB 테이블 12.

## 2. 역할과 권한

역할은 셋이다(`server/access.js`, `server/auth.js`).

| 역할 | 범위 | 판정 방식 |
|---|---|---|
| `AGENCY` | 조직 전체 | 항상 허용 |
| `MANAGER` | 배정된 행사 | `memberships` 행 존재 |
| `STAFF` | 배정된 데스크·부스 | `staff_assignments` + 커맨드 허용목록 |

`STAFF`는 커맨드 허용목록으로 제한된다.

    assignment.read · participants.read
    check.scan · check.correct · checkin.scan · checkin.sync · checkin.correction
    booth.visit

`STAFF_TARGET_REQUIRED`(`check.scan`, `checkin.scan`, `booth.visit`)는 대상 ID까지
일치해야 한다. 즉 다른 데스크의 스캔은 서버가 거부한다.

행사 단위 쓰기 권한은 `memberships.write_permissions` 배열이며 `'all'` 또는 기능 키다.
화면 접근은 라우트 → 메뉴 그룹(`router.js`의 `groups`, 37개 매핑) → 그룹 권한 순으로
판정한다.

## 3. 행사 생명주기와 기능

단계(`E.stages`)는 **명시적 운영 상태**이며 날짜에서 파생되지 않는다. 저장되고 그대로
표시된다. 자동 보정하지 않는다.

    DRAFT(기획) → READY(운영 준비) → LIVE(진행 중) → ENDED(종료) → ARCHIVED(보관)

`LIVE`만 현장 처리를 허용한다. `ARCHIVED`는 모든 변경을 거부한다.

기능 플래그 11종(`E.features`)을 행사별로 켜고 끈다. 끈 기능은 콘솔 메뉴와 참가자
화면에서 함께 사라진다. **끄더라도 기존 응답·기록은 삭제하지 않는다.**

    poll 투표 · quiz 퀴즈 · qa Q&A · draw 추첨 · survey 만족도 · stamp 스탬프
    photo 사진 · board 게시판 · venue 장소 안내 · screen 행사장 출력 · reward 경품

참가자 상태: `PENDING`(승인 대기) · `APPROVED`(참가 확정) · `WAITLIST`(대기 명단) ·
`CANCELLED`(신청 취소).

## 4. 데이터 모델

PostgreSQL이 행사 데이터의 유일한 권위다. JSON 파일 저장소(`DATA_DIR`)는 과도기
폴백으로만 남아 있고 PostgreSQL 모드에서는 읽지도 쓰지도 않는다.

| 테이블 | 역할 |
|---|---|
| `accounts` | 구성원. `role`, `org_permissions`, scrypt 해시 |
| `sessions` | 세션 토큰 해시·만료 |
| `invitations` | 초대. 상태 `PENDING`/`ACCEPTED`/`REVOKED`, 만료 |
| `clients` | 고객사 |
| `events` | 행사 메타(이름·slug·일정·단계·기능) `payload` jsonb |
| `event_workspaces` | 행사 업무 데이터 전체 `payload` jsonb + `revision` |
| `memberships` | 계정↔행사 쓰기 권한 |
| `staff_assignments` | 스태프 배정(데스크/부스) |
| `stored_files` | 업로드 파일 메타(치수 포함) |
| `command_receipts` | 커맨드 멱등성 영수증 |
| `login_attempts` | 로그인 실패 카운터(계정·주소 스코프) |
| `login_lockout_overrides` | 관리자 잠금 해제 기록 |
| `global_state` | 전역 키-값 |

설계상 중요한 점: 행사 업무 데이터는 **하나의 `event_workspaces.payload` jsonb**에
들어 있다. 참가자·데스크·부스·메시지·보고서가 모두 그 안에 있고, 변경은 행 단위
잠금 + 리비전 증가로 직렬화된다.

## 5. 서버 권위와 커맨드 흐름

모든 쓰기는 단일 경로를 지난다.

    POST /api/events/:eventId/commands
    { command, commandId, payload }

`server/commands/domain.js`의 `execute`가 트랜잭션 하나에서 순서대로 처리한다.

1. `commandId` 형식 검증 후 **advisory lock** (멱등성)
2. `events` + `event_workspaces` 행 잠금, `FOR UPDATE`
3. `command_receipts` 조회 → 있으면 저장된 응답을 그대로 반환(`replayed: true`)
4. 권한 판정(`access.authorize` 또는 초대·배정 검사)
5. `ARCHIVED` 거부
6. 해당 모듈의 `apply(ctx)` 실행
7. 감사 로그 추가, 워크스페이스 저장 + 리비전 증가
8. `eventChanged`면 `events` 갱신 (slug UNIQUE 충돌은 409로 변환)
9. 영수증 기록, 응답 반환

**커밋 이후에 실행되는 것**(같은 요청 안이지만 트랜잭션 밖):

- 메시지 발송 (`dispatchCampaign`) — 느린 공급사가 행 잠금을 붙잡지 않도록
- 도달 확인 폴링 (`resolveDelivery`)

이유: 공급사 호출이 실패해도 운영자가 이미 성공으로 본 커맨드를 롤백하면 안 되고,
공급사가 접수한 메시지를 롤백으로 잃으면 안 된다.

### 커맨드 50종 (모듈별, 중복 제거 전 59개)

| 모듈 | 수 | 내용 |
|---|---|---|
| `preparation` | 18 | 행사 설정·양식·그룹·공지·프로그램·장소·브랜딩·참가자 페이지 |
| `engagement` | 14 | 참여 모듈·응답·질문·사진·게시글·추첨·출력 |
| `content-results` | 15 | 템플릿·메시지·결제·경품·보고서 |
| `operations` | 9 | 데스크·스태프 배정·입퇴장·부스 |
| `booth-map` | 3 | 부스 지도 저장·게시·게시취소 |

## 6. 인증과 방어

- 비밀번호: `scrypt` 해시. 평문·복호화 가능 저장 없음.
- 세션: `httpOnly` 쿠키, 토큰은 해시로만 저장, `SESSION_TTL_HOURS`(기본 12).
- 로그인 제한: 계정 5회/15분, 주소 20회/15분. 성공 시 리셋. 창이 지나면 자연 해제.
- 존재하지 않는 계정도 동일한 scrypt 시간을 소모해 계정 열거를 막는다.
- 잠금 응답(429)은 "잠겼다"고 알리지 않는다(공격자에게 신호가 되므로).
- 미마이그레이션 DB에서는 제한 테이블 부재를 감지해 **제한 없이 로그인을 계속 허용**한다.
  운영자가 자기 제품에 잠기는 것이 더 나쁜 실패이기 때문이다.
- 보안 헤더: CSP(nonce 기반) · `X-Frame-Options: DENY` · `nosniff` · `Referrer-Policy` ·
  `Permissions-Policy` · HSTS(`COOKIE_SECURE=1`일 때). 모든 응답에 적용.
  `EVENTOUCH_CSP_REPORT_ONLY=1`로 강제 없이 관찰할 수 있다.

## 7. 프론트엔드 구조

빌드 단계가 없다. 바닐라 ES(브라우저) + IIFE가 `window.ET`(코드에서는 `E`)를 확장한다.
`index.html`이 `defer` 스크립트 23개와 CSS 7개를 **순서대로** 로드하므로 로드 순서가
계약이다(`tests/load-order.test.cjs`가 고정).

### 화면 39 · 액션 120

화면은 `E.views.<이름>` 함수가 HTML 문자열을 반환하는 방식이다. 라우터는 경로를 파싱해
해당 뷰를 호출하고 `#app`에 넣는다. 폼은 `E.forms.<이름>`, 클릭은 `E.actions.<이름>`,
서버 커맨드 핸들러는 `E.register`로 등록한다.

### 로드 순서상의 함정 (실측)

같은 이름이 여러 파일에 정의되고 **뒤에 로드된 쪽이 이긴다.** 소스를 고쳐도 아무 일이
일어나지 않을 수 있다.

- 로그인 화면: `E.loginPage`가 **3번** 정의된다 — `router.js` → `experience.js` →
  `server-presentation.js`. 서버 모드 문구는 마지막 파일에만 있다. `router.js`를 고치면
  소스는 맞아 보이지만 화면은 그대로다(실제로 겪었다).
- **뷰 39개 중 10개가 중복 정의**된다:

      staff         experience.js → field.js → role-model.js → workflows.js   (4중)
      attendee      attendee.js → operator-experience.js → server-presentation.js
      display       display.js → experience.js → workflows.js
      booths        booth-map-ui.js → field.js
      checkin       event-flow.js → field.js
      desks         event-flow.js → field.js
      settings      console.js → experience.js
      import        experience.js → registration.js
      programs      programs.js → workflows.js
      participants  registration.js → workflows.js

- **액션 120개 중 16개가 중복 정의**된다(`scan-person`, `assign-staff`, `camera-scan`,
  `edit-desk`, `compose-message`, `client-detail`, `invite-link`, `toggle-menu` 등).

**규칙**: 화면이나 동작을 고칠 때는 어느 정의가 실제로 이기는지 먼저 확인한다.
`tests/load-order.test.cjs`가 순서 자체를 고정하고 있다.

### 구조 부채 (알려진 것)

- **`E`에 붙은 최상위 속성이 155개다.** 모듈 경계가 없고 모든 파일이 전역을 통해
  서로를 호출한다. 규모(화면 39·액션 120)에 비해 경계가 없다.
- **죽은 정의가 있다.** 위 로드 순서 때문에 덮어써지는 이전 정의들. 제거 대상이지만
  제거하면 동작이 바뀔 수 있어 테스트가 필요하다.
- 뷰가 문자열 연결이라 마크업 오류를 컴파일 타임에 잡을 수 없다. 대신 axe(12화면)와
  모바일(6기기×2방향×6화면) 자동 감사가 회귀를 잡는다.
- `assets/js/qr.js`가 1,259줄로 프론트엔드의 36%다(QR 인코더, 외부 알고리즘).

## 8. 파일별 책임

### 서버

| 파일 | 책임 |
|---|---|
| `server/server.js` | 정적 서빙 + `/api/*` 라우팅 진입점. 보안 헤더 래핑 |
| `server/api.js` | API 경로 해석, 인증 게이트, 커맨드 위임 |
| `server/auth.js` | 세션·비밀번호·초대·로그인 제한 |
| `server/access.js` | 역할·배정 기반 권한 판정 |
| `server/state.js` | 부트스트랩 투영(역할별로 보이는 범위), 행사 생성 |
| `server/db.js` | 커넥션 풀, 트랜잭션, 마이그레이션 연결 |
| `server/migrate.js` | 번호순 마이그레이션 적용(체크섬 검증, advisory lock) |
| `server/public-events.js` | 참가자 웹용 공개 투영 |
| `server/files.js` | 파일 저장·조회 |
| `server/messaging.js` | 발송 오케스트레이션(배치 발송, 커밋 후 실행, 도달 확정) |
| `server/messaging-solapi.js` | Solapi 어댑터(HMAC 서명, 타입 판정, 페이로드) |
| `server/http.js` | 응답 헬퍼, 보안 헤더, nonce |
| `server/validation.js` | 날짜·정원 공용 검증 |
| `server/sw.js` | 오프라인 셸 서비스 워커 |
| `server/legacy-events.js` | 과도기 JSON 저장소 폴백(운영에서 410 반환) |
| `server/commands/*.js` | 도메인 커맨드 5묶음 |

### 프론트엔드

| 파일 | 책임 |
|---|---|
| `core.js` | `E` 초기화, 상태 상수(단계·기능·역할·상태), 기본 워크스페이스 |
| `store.js` | 로컬 저장, 커맨드 레지스트리 |
| `router.js` | 경로 파싱, 메뉴 그룹 매핑, 렌더 루프 |
| `ui.js` | 공용 위젯(필드·배지·패널·표·모달·토스트·인쇄) |
| `experience.js` | 운영 현황·준비·가져오기 |
| `operator-experience.js` | 대행사 4화면, 관리 셸 |
| `role-model.js` | 역할 모델, 보고서 목록 |
| `server-sync.js` | 서버 모드 동기화, 오프라인 큐, 세션 |
| `server-presentation.js` | 서버 모드 문구·상태 표현(로그인 포함) |
| `registration.js` | 참가자·양식·그룹·가져오기 |
| `field.js` | 현장 운영(데스크·체크인·부스) |
| `programs.js` | 공지·일정·장소·게시판·Q&A·사진 |
| `communication.js` | 메시지·템플릿·발송내역·경품 |
| `results.js` | 결과·보고서 |
| `attendee.js` | 참가자 웹 전체 |
| `console.js` | 설정·기능·활동 기록 |
| `event-flow.js` | 데스크·행사 QR·체크인 |
| `workflows.js` | 화면 간 흐름, 상태 전이 후처리 |
| `booth-map-ui.js` | 부스 지도 편집·표시 |
| `booth-map-data.js` | 부스 지도 기본 데이터 |
| `display.js` | 행사장 출력 |
| `phone-shell.js` | 핸드헬드 셸 |
| `qr.js` | QR 인코더·디코더(외부 알고리즘) |

## 9. 검증 수단

| 무엇을 | 어떻게 | 현재 |
|---|---|---|
| 서버·표현 계층 | `npm test` (PostgreSQL 주입) | 435/435, 스킵은 실패 처리 |
| 접근성 | `npm run a11y` (axe, 12화면) | serious+ 0 |
| 반응형·터치 | `npm run mobile` (6기기×2방향×6화면) | 72검사 통과 |
| 발송 | `docs/INTEGRATIONS.md` 체크리스트 | mock 검증 완료, 실발송 미검증 |
| 실기기 | `scripts/device-checklist.md` | 미수행(출시 게이트 아님) |

CI(`.github/workflows/ci.yml`)가 세 게이트를 모두 돌린다. 원격 저장소가 없어 아직
실제로 실행된 적은 없다.

## 10. 구조 부채 요약 (우선순위)

1. **프론트엔드 모듈 경계 부재** — `E` 전역 155개. 가장 큰 부채이며 기능 추가 전에
   정리하는 것이 순서다.
2. **가려진 중복 정의** — 뷰 10개·액션 16개가 로드 순서로 덮인다. 제거하면 동작이
   바뀔 수 있어(가려진 쪽이 실제로 쓰이지 않는지 확인 필요) 특성화 테스트가 선행되어야 한다.
3. **문서 부패 방지** — `code-structure.svg`가 한 번 커밋된 뒤 6개 화면·다른 네임스페이스
   시절로 방치되어 있었다. 구조를 바꾸는 변경은 이 문서와 SVG를 함께 갱신해야 한다.
4. **`legacy-events.js` 970줄** — 과도기 폴백. 운영에서 쓰이지 않으면 제거 후보.
5. **실발송 미검증** — 코드는 준비됨, 자격증명 대기.
