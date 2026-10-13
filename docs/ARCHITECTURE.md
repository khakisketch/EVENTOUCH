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
- 보안 헤더: CSP(nonce 기반) · `X-Frame-Options: SAMEORIGIN` · `nosniff` · `Referrer-Policy` ·
  `Permissions-Policy` · HSTS(`COOKIE_SECURE=1`일 때). 모든 응답에 적용.
  CSP의 `frame-ancestors 'self'`는 참가자 페이지의 "미리보기"가 같은 출처의 참가자 화면을
  iframe으로 띄우기 때문이다. 외부 출처 프레임은 계속 차단한다.
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

같은 이름이 여러 파일에 정의된다. **그 중 일부는 덮어쓰기지만 일부는 겹쳐 쌓기다.**
구분이 중요하다 — 덮어쓰기라고 알고 제거하면 살아있는 레이어를 지운다.

**겹쳐 쌓기(레이어)** — 나중 파일이 앞의 값을 붙잡아 호출한다. 모두 살아있다.

    view:staff      field.js(기본) → experience.js → workflows.js → role-model.js   (4중)
    view:display    display.js(기본) → experience.js → workflows.js
    view:checkin    field.js(기본) → event-flow.js
    view:booths     field.js(기본) → booth-map-ui.js
    view:desks      field.js(기본) → event-flow.js
    view:participants / import / settings / programs
    action:clear-scan / message-detail / invite-link / report-detail

server-presentation.js는 통째로 레이어다. `loginPage`, `adminShell`, `views.attendee`,
`reportMarkup`, `actions['invite-link']`를 감싼다.

**덮어쓰기(앞의 정의가 죽음)**

    view:attendee           attendee.js → operator-experience.js
    action:toggle-menu      ui.js → experience.js
    action:scan-person / staff-search / camera-scan / assign-staff / edit-desk
    action:compose-message / edit-module / client-detail / publish-report
    action:table-page / clear-event-filters

### 참가자 페이지 미리보기

운영자는 `참가자 페이지` 화면에서 저장한 초안을 iframe으로 확인한다. iframe은 같은 출처의
`#/event/<slug>/home?preview=1`을 열고, 그 문서는 **공개 투영이 아니라 운영자 워크스페이스**를
읽는다 — 초안은 공개 API에 없고, `DRAFT` 행사는 공개 투영 자체가 없다. 그래서 미리보기에는
운영자 세션이 필요하고, 세션·권한이 없으면 게시본이 보인다(`server-sync.js`의
`isOperatorPreview`). 미리보기에서는 신청·제출을 저장하지 않는다(`E.run` 가드) — 초안 확인이
실제 참가자 데이터를 만들면 안 되기 때문이다.

### 런타임 추적 결과 (실측)

정적으로는 판별할 수 없어서(아래) 실제로 로드하고 호출해 확인했다.
`node scripts/definition-trace.cjs`.

- **레이어 체인 56개가 확정됐다.** 정의가 전부 실행되므로 합성임이 분명하다.
  여기에는 `view:staff`(4중), `view:attendee`(3중), `view:display`(3중),
  `view:checkin`·`view:desks`·`view:booths`·`view:import`·`view:participants`·
  `view:programs`·`view:settings`, 그리고 workflows.js가 권한을 씌우는
  다수 액션이 포함된다.
- **15개 이름은 단일 호출로 확인되지 않았다.** 이것은 **죽음이 아니라 미확인**이다.
  추적이 한 가지 합성 상태에서만 돌기 때문에 승자가 그 상태에서 예외를 던지면
  기반 정의에 도달하지 못한다. 실제로 `view:attendee`가 처음엔 죽음으로 나왔지만
  가짜 DOM을 보완하니 3중 레이어로 정정됐다.

**따라서 제거는 여전히 하지 않았다.** 미확인 15개를 지우려면 preview 모드와
서버 모드 각각에서 실제 제품 경로로 도달 여부를 확인해야 한다.

### 정적 분석으로는 판별할 수 없다

레이어인지 덮어쓰기인지 정적 분석으로 판별하지 못한다. 시도한 세 가지 방법이
세 가지 다른 답을 냈다(레이어 12개 → 0개 → 26개). 캡처 표현이 파일마다 다르고
(`const oldStaff=E.views.staff`, `const baseAttendee=E.views.attendee`) 식별자도
제각각이라 정규식으로 안정적으로 잡히지 않는다.

그래서:

- `tests/frontend-contract.test.cjs`가 로드 순서·이름 목록·알려진 중복 목록을
  고정한다. **새 중복이 생기면 테스트가 실패**하므로 사고는 막힌다.
- 화면이나 동작을 고칠 때는 **어느 파일이 최종인지 먼저 확인**한다.
  `staff`를 `field.js`만 고치면 나머지 세 레이어가 그대로 덮는다.

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
2. **중복 정의 26개** — 레이어 56개 체인이 실행으로 확정됐고, 15개 이름은
   미확인이다(죽음 아님). `scripts/definition-trace.cjs`로 추적하되, 제거 전에는
   preview·서버 두 모드에서 실제 경로 도달을 확인해야 한다. 그때까지
   `tests/frontend-contract.test.cjs`가 새 중복만 막는다.
3. **문서 부패 방지** — `code-structure.svg`가 한 번 커밋된 뒤 6개 화면·다른 네임스페이스
   시절로 방치되어 있었다. 구조를 바꾸는 변경은 이 문서와 SVG를 함께 갱신해야 한다.
4. **`legacy-events.js` 970줄** — 과도기 폴백. 운영에서 쓰이지 않으면 제거 후보.
5. **실발송 미검증** — 코드는 준비됨, 자격증명 대기.
