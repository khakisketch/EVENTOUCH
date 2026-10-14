# EVENTOUCH 구조

Updated: 2026-10-14 · 기준 브랜치: `master` (구현 기준은 현재 저장소 코드와 테스트)

이 문서는 현재 구현과 목표 아키텍처를 구분해 기록한다. 제안서(`EVENTOUCH_서비스 기획 및
제안.html`)나 `행사운영플랫폼_개발기획안.pdf`는 초기 기획이므로 구현 판단의 근거로 쓰지 않는다.

코드와 테스트가 문서보다 우선한다. `docs/code-structure.svg`는 참고 그림이며, 구조 변경 시
함께 갱신한다. 이 문서의 과거 측정값은 재측정 전까지 현재 수치로 간주하지 않는다.

## 1. 한눈에

행사대행사가 여러 고객사의 행사를 운영하는 B2B 워크스페이스. 하나의 서버가 세 종류의
화면을 제공한다.

| 표면 | 사용자 | 경로 | 인증 |
|---|---|---|---|
| 운영 콘솔 | 대행사·행사 담당·현장 스태프 | `#/console/*`, `#/staff/*` | 세션 쿠키 |
| 참가자 웹 | 행사 참가자 | `#/event/<slug>/*` | 티켓 bearer (URL) |
| 행사장 출력 | 무대·전광판 | `#/screen/<eventId>` | 없음(공개) |
| 초대 수락 | 초대받은 구성원 | `#/invite/<token>` | 초대 토큰 |

현행 계약 테스트는 화면 39 · UI 액션 120을 고정한다. 서버 커맨드와 테이블 정의의 현재
범위는 각각 `server/commands/`와 `server/migrations/`를 기준으로 한다.

## 목표 아키텍처 (점진 적용)

이 목표는 전면 재작성 지시가 아니다. 현행 서비스와 계약을 유지하면서 기능 단위로 옮긴다.

- **제품 구조:** 하나의 모듈형 모놀리스. 참가자·운영자·스태프·전광판은 같은 제품/API를 쓴다.
  트래픽이나 독립 배포 필요가 확인되기 전에는 마이크로서비스로 분리하지 않는다.
- **프론트엔드 목표:** TypeScript 기반 Next.js App Router. 공개 행사 페이지는 검색·공유 요구에
  맞춰 서버 렌더링을 검토하고, 운영 콘솔과 QR 카메라 스캔은 브라우저 상태가 필요한 클라이언트
  화면으로 둔다. 현행 바닐라 화면은 기능 단위로 교체하고, 한 번에 전부 옮기지 않는다.
- **백엔드 목표:** Node.js + TypeScript의 도메인 모듈형 API. Fastify는 라우트·검증 경계로
  점진 도입하되, 기존 커맨드 도메인을 보존하고 프론트엔드와 업무 규칙을 중복하지 않는다.
  모든 쓰기는 서버 권위이며 PostgreSQL 트랜잭션에서 검증한다.
- **데이터:** PostgreSQL을 권위 저장소로 유지한다. 일정·폼 등 유연한 설정은 JSONB를 쓸 수 있지만,
  티켓·체크인·권한·멱등성처럼 제약과 동시성 보장이 중요한 핵심 데이터는 명시적 스키마로
  점진 이전한다. 기존 데이터는 마이그레이션과 회귀 테스트 없이 일괄 변환하지 않는다.
- **외부 작업:** 문자 등 공급사 호출은 DB 커밋과 분리한다. 재시도·장애 복구가 필요한 발송은
  트랜잭션 outbox와 작업자 도입을 검토해 요청 프로세스 종료에도 작업이 유실되지 않게 한다.
- **배포 경계:** 브라우저에는 같은 출처의 HTTPS 주소를 제공하고 API는 `/api/*`로 유지한다.
  Next.js와 API를 별도 프로세스로 옮겨도 외부 계약·쿠키 보안·CORS 정책을 임의로 깨지 않는다.

### QR·티켓·체크인 불변 조건

- QR에는 개인정보가 아닌 암호학적으로 무작위인 티켓 토큰만 싣는다. 참가자·행사·결제 상태,
  만료·취소 여부는 서버가 매 스캔마다 판정한다.
- 같은 참가자의 동시 스캔도 PostgreSQL 잠금/제약으로 한 번만 상태를 바꾸며, 재전송은
  `commandId` 멱등성으로 처리한다. 실패·중복 결과는 스태프 화면에 구분해 보여준다.
- 오프라인에서는 셸과 스캔 큐만 허용한다. 서버 확인 전 기록은 확정 체크인으로 표시하지 않고,
  재연결 시 권한·티켓·중복을 다시 검사한다. 오프라인 로그인 세션을 새로 허용하지 않는다.
- QR이 bearer 자격증명인 만큼 원문 로그·오류 추적·분석 이벤트에 토큰을 남기지 않는다.
  QR 토큰의 저장·재발급·취소 방식은 핵심 엔티티를 정규화할 때 해시 저장과 유출 대응까지 함께
  설계한다. 현행 workspace 저장 방식을 바꾸기 전에는 호환성 마이그레이션을 먼저 만든다.

### 이전 순서와 완료 기준

1. 현재 구현·문서·API 계약을 기준선으로 고정하고 QR/체크인 실패·중복·오프라인 재전송 테스트를 보강한다.
2. DB 마이그레이션으로 티켓/체크인 핵심 엔티티를 분리하되 기존 API 응답과 화면 계약을 유지한다.
3. TypeScript API 모듈을 먼저 분리하고, Fastify 경계에서 기존 권한·트랜잭션 테스트를 그대로 통과시킨다.
4. Next.js 화면을 기능 단위로 도입한다. 각 단위의 E2E/접근성/모바일 검증이 끝나기 전 기존 화면을 제거하지 않는다.
5. 실기기 QR 스캔, 오프라인 재전송, DB 백업 복구, 운영 로그·알림까지 검증한 뒤 운영 전환한다.

각 단계는 기존 API·권한·멱등성·저장 보존 테스트를 통과해야 완료다. 프레임워크 교체만으로
완료 처리하지 않는다.

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
| `message_outbox` | 발송 의도(커맨드와 같은 트랜잭션 기록, 결과 기록 후 삭제, 부팅 드레인) |
| `checkin_records` | 체크인 이력의 write-through 투영(JSONB가 읽기 권위, 005가 기존 기록 백필) |
| `tickets` | 티켓 식별의 write-through 투영(JSONB가 읽기 권위, 006 백필은 식별자만·해시는 첫 변경 시 채움) |
| `login_attempts` | 로그인 실패 카운터(계정·주소 스코프) |
| `login_lockout_overrides` | 관리자 잠금 해제 기록 |
| `global_state` | 전역 키-값 |

설계상 중요한 점: 행사 업무 데이터는 **하나의 `event_workspaces.payload` jsonb**에
들어 있다. 참가자·데스크·부스·메시지·보고서가 모두 그 안에 있고, 변경은 행 단위
잠금 + 리비전 증가로 직렬화된다.

정규화는 expand 단계로 진행한다(읽기 권위는 그대로 둔다):

- `message_outbox` — 발송 의도. `message.retry`가 SENDING으로 바꿀 때 같은
  트랜잭션에서 행을 남기고, 결과 기록 후 삭제한다. 부팅 드레인이 남은 행을
  재처리한다. `/api/health`는 대기 건수(`outboxPending`)를 함께 둔다.
- `checkin_records` — 체크인 이력의 write-through 투영. `check.scan`·
  `check.correct`와 같은 트랜잭션에서 기록하므로 JSONB와 어긋날 수 없다.
  읽기는 `workspace.checks`가 계속 맡는다. 005 마이그레이션이 기존 기록을
  백필한다.
- `tickets` — 참가자 티켓 식별의 write-through 투영. 참가자 변경과 같은
  트랜잭션에서 해시·취소·만료를 기록한다. 006 백필은 식별자만 옮기고 해시는
  비워 둔다(SQL 마이그레이션은 공유 DB의 암호 확장을 가정하지 않는다).
  `scripts/backfill-ticket-hashes.cjs`가 NULL 해시를 채운다(멱등, `--dry-run` 지원).
  읽기 전환 전에는 이 스크립트 실행이 먼저다.

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
- outbox 확정 (`message_outbox` 행 삭제) — 결과가 기록됐을 때만. 공급사 호출이
  예외로 끝나거나 프로세스가 먼저 죽으면 행이 남아 부팅 드레인이 재발송한다.
  이미 결과가 기록된 채 남은 행은 재발송 없이 정리한다.
  주기 실행자는 없다. 드레인은 부팅 시 1회이며, 미연동이면 건너뛴다.

이유: 공급사 호출이 실패해도 운영자가 이미 성공으로 본 커맨드를 롤백하면 안 되고,
공급사가 접수한 메시지를 롤백으로 잃으면 안 된다.

### 이벤트 스코프 밖의 쓰기 — 조직 범위 REST 4경로

행사 하나에 매이지 않는 작업은 위 커맨드 경로를 쓸 수 없다(경로에 `eventId`가 없다).
전용 REST 경로를 쓰되 **같은 멱등 규율**을 지킨다: `commandId` 형식 검증 → advisory lock →
`command_receipts` 확인 후 재시도면 저장된 응답 반환 → 권한 판정 → 쓰기 → 영수증 기록.

| 경로 | 하는 일 | 권한 |
|---|---|---|
| `POST /api/events` | 행사 생성 | `AGENCY` |
| `POST /api/clients` | 고객사 생성·수정 | `AGENCY` |
| `POST /api/accounts/:id/org-permissions` | 조직 범위 권한 | `AGENCY`, 조직 소유자 자신은 불가 |
| `POST /api/events/:id/members` | 행사별 접근·수정 권한 | `AGENCY` |
| `/api/auth/invitations` | 초대 생성·철회 | `AGENCY` |

- 저장되는 권한 키는 콘솔이 부를 수 있는 값으로 제한한다(`server/state.js`의
  `ORG_PERMISSIONS`·`EVENT_PERMISSIONS`). 모르는 키는 저장하지 않고 400으로 거부한다.
- 고객사 수정은 이 커맨드가 소유하지 않는 필드(연결된 담당자 계정 등)를 보존한다.
  이름을 고쳐도 연결이 끊기지 않는다.
- 클라이언트는 `assets/js/server-sync.js`의 `syncCommand`에서 이 이름들을 해당 경로로 보낸다.
  매핑이 없으면 이벤트 커맨드 경로로 흘러가 "지원하지 않는 …작업"으로 실패한다.

### 커맨드 모듈 (2026-10-12 측정 스냅샷; 현재 범위는 코드 기준)

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
`index.html`이 `defer` 스크립트 25개와 CSS 7개를 **순서대로** 로드하므로 로드 순서가
계약이다(`tests/load-order.test.cjs`가 고정).

### Next.js 이관 (슬라이스 1·2·3·4a·4b·5·6a·6b·6c·6d·6e 완료)

`apps/web`(Next.js + TypeScript App Router)이 같은 제품의 새 프론트엔드다.
이관 원칙: 기존 바닐라 앱을 끄지 않고 기능 단위로 증명·교체한다.

- 슬라이스 1: 공개 행사 안내(`app/event/[slug]`, 서버 컴포넌트).
  기존 공개 투영(`GET /api/public/events/:slug`)을 읽어 이름·일정·진행 상태를
  렌더링한다. 쓰기 없음. 미공개·없는 slug는 404.
- 슬라이스 2: 참가 신청(`app/event/[slug]/register`). 공개 양식·동의 문구를
  서버에서 읽어 그리고, 클라이언트 폼이 같은 오리진
  `POST /api/events/:slug/signup`으로 신청한다(명령 ID·양식 버전·동의 포함).
  필드 오류는 서버의 `field`로 표시하고, 성공하면 발급된 티켓으로 티켓 화면에 간다.
- 슬라이스 3: 내 티켓(`app/event/[slug]/ticket`). 주소에 한 번 실린 bearer를
  즉시 소비해 메모리로 옮기고 주소를 정리한다. 티켓 상태는 서버 조회로만
  판단하고, QR은 스태프 스캐너가 받는 토큰 원문을 인코딩한다.
- 슬라이스 4a: 스태프 체크인(로그인·배정 데스크·수동 입력). 같은 오리진 세션으로
  부트스트랩을 읽고 `check.scan`을 배정 데스크에서만 처리한다. 성공 결과는
  새로고침 뒤에도 유지되고, 중복 스캔은 서버 판정 그대로 보여준다.
- 슬라이스 4b: 카메라 스캔. 프레임 루프에서 QR을 디코딩해 같은 서버 검증 제출로
  넘긴다. 카메라·권한이 없으면 수동 입력으로 안내하고 데스크를 막지 않는다.
  실제 광학 디코딩은 실기기 검증에서 확인한다.
- 슬라이스 5: 전광판(`app/screen/[slug]`). 인증 없이 공개 투영을 5초 주기로 읽고
  공지·프로그램·장소를 순환한다. 끊김에는 마지막 화면을 유지한다. 운영자의
  display.set 지정은 공개 투영에 설정이 없어 아직 따르지 않는다 — 설정 공개
  계약이 먼저 필요하고, 그전까지 구 화면이 운영자 지정 출력을 맡는다.
  (서버 계약 추가됨: 공개 투영이 타입·moduleId·noticeId만 싣는다.
  새 앱 전광판이 이를 따르는 것은 다음 슬라이스.)
- 슬라이스 6a: 운영 콘솔 읽기(행사 목록 홈·행사별 운영 현황). 같은 오리진 세션으로
  부트스트랩을 읽고, 목록·지표·대기·최근 입퇴장을 렌더링한다.
  로그인은 역할에 따라 스태프 흐름과 콘솔로 나눈다.
- 슬라이스 6b: 참가자 상태 변경. 운영자 세션에서 `participant.status`로 승인·대기·
  취소한다. 화면 게이트는 표시 전용이고 권한 판정은 서버가 한다.
- 슬라이스 6c: 메시지 템플릿 저장, 수신자 선택 캠페인 작성·재시도, 전달 상태 조회를 기존
  이벤트 커맨드 경로로 처리한다. 상태 표시는 한국어이며 캠페인 이력은 티켓 bearer를 렌더하지 않는다.
- 슬라이스 6d: 현장 운영 준비(데스크 저장·가동/중지, 부스 저장, 스태프 배정·해제).
  진행 중 전환 조건을 화면에 안내하고, 빈 행사에서 데스크 추가→배정→전환까지 실동작 확인.
- 슬라이스 6e: 행사 설정(기본정보·기능 플래그·접수 게시/닫기·참가자 페이지 초안/게시).
  설정→접수 열기→공개 페이지 신청 CTA 반영까지 실동작 확인. 셸 하위 메뉴에
  현장 운영·행사 설정을 추가해 모든 행사 목적지가 사이드바에서 발견된다.
- 브라우저는 새 앱의 오리진에만 닿는다. `/api/*`는 새 앱의 rewrite가 API로
  전달한다(`EVENTOUCH_API_URL`, 기본 `http://127.0.0.1:8776`). 프론트가 API
  호스트를 직접 두지 않으므로 쿠키·CSP·CORS 정책이 유지된다.
- 계약 테스트 `tests/web-slice-contract.test.cjs`가 rewrite와 읽기 전용을 고정한다.
- 다음 슬라이스는 결과·보고서와 참가자 페이지 나머지(참가자 홈 정보 확장), 그다음
  Fastify/TypeScript API 이관. 참가 신청·티켓·스태프 스캔·전광판·현장 운영·설정은 완료.
- 구 앱의 계약 테스트(화면 39·액션 120·로드 순서)는 이관이 끝날 때까지 유지한다.

### 화면 39 · 액션 120

화면은 `E.views.<이름>` 함수가 HTML 문자열을 반환하는 방식이다. 라우터는 경로를 파싱해
해당 뷰를 호출하고 `#app`에 넣는다. 폼은 `E.forms.<이름>`, 클릭은 `E.actions.<이름>`,
서버 커맨드 핸들러는 `E.register`로 등록한다.

### 콘솔 셸의 정보구조 (2026-10-14 확정)

셸은 `E.adminShell`(`assets/js/operator-experience.js`) 하나가 만들고, 스코프에 따라 내용만 바뀐다.
**바깥 랜드마크는 스코프가 바뀌어도 자리를 지킨다.**

```
EVENTOUCH / 행사 운영              워드마크 + 제품 한 줄
행사                              ← 메인 메뉴 1 (행사 안에서는 active-path)
  현재 행사 ▸ 전환                 ← 행사 스코프에서만
    현황과 결과 / 참가자 관리 / 현장·프로그램 운영 / 행사 설정
고객사                            ← 메인 메뉴 2
[운영자 ▾]                        ← 하단 팝오버: 팀·권한 · 서비스 연동 · 로그아웃
```

- 그룹은 접는 아코디언이 아니라 소제목(`.nav-section-label`)이다. 목적지를 클릭 뒤에 숨기지 않는다.
- 기능이 꺼진 목적지와 권한 없는 목적지는 **렌더하지 않는다**(빈 자리표시자를 만들지 않는다).
- 활성 표시는 배경 + 좌측 강조선 두 신호를 쓴다(주변시에서 약한 단일 신호를 피한다).
- 스크롤은 메뉴 영역(`.side-nav`)에서만 일어나고 운영자 블록은 하단에 남는다.
- 상단 브레드크럼의 `운영 워크스페이스`는 위치 신호로 유지한다.

행사 목록(`#/console/agency/events`)이 워크스페이스 홈이다. 별도 KPI 대시보드를 두지 않고,
행사별 대시보드는 그 행사의 `운영 현황`이 맡는다.

### 운영 현황 화면의 순서

`E.views.overview`는 운영자가 묻는 순서대로 배치한다: 헤더(일정·장소·단계·접수) →
핵심 지표(등록·승인 대기·현재 입장·입장률) → 지금 할 일(주 행동 + 대기 건수) →
진행/추이(진행 중이면 시간대별 입장, 아니면 정원 대비 진행률) → 최근 입퇴장 → 접힌 집계 기준.
그룹 사이 간격은 24px, 그룹 안은 4~12px로 리듬을 만든다(균일 간격은 그룹을 읽히지 않는다).

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
| `server/api.js` | API 경로 해석, 인증 게이트, 커맨드·조직 범위 REST 위임 |
| `server/auth.js` | 세션·비밀번호·초대·로그인 제한 |
| `server/access.js` | 역할·배정 기반 권한 판정 |
| `server/state.js` | 부트스트랩 투영(역할별로 보이는 범위), 행사 생성·고객사 저장·조직/행사 권한 저장 |
| `server/db.js` | 커넥션 풀, 트랜잭션, 마이그레이션 연결 |
| `server/migrate.js` | 번호순 마이그레이션 적용(체크섬 검증, advisory lock) |
| `server/public-events.js` | 참가자 웹용 공개 투영 |
| `server/files.js` | 파일 저장·조회 |
| `server/messaging.js` | 발송 오케스트레이션(배치 발송, 커밋 후 실행, 도달 확정) |
| `server/message-outbox.js` | 발송 의도의 트랜잭션 outbox. 같은 트랜잭션에서 발송 의도를 기록하고, 결과 기록 시 행을 삭제하며, 부팅 시 남은 행을 재처리한다. 이미 끝난 건 재발송 없이 정리 |
| `server/messaging-solapi.js` | Solapi 어댑터(HMAC 서명, 타입 판정, 페이로드) |
| `server/http.js` | 응답 헬퍼, 보안 헤더, nonce |
| `server/validation.js` | 날짜·정원 공용 검증 |
| `server/sw.js` | 오프라인 셸 서비스 워커 |
| `server/legacy-events.js` | 과도기 JSON 저장소 폴백(운영에서 410 반환) |
| `server/commands/*.js` | 도메인 커맨드 5묶음 |
| `server/commands/shared.js` | 실행기 3종(domain·participants·operations)이 공유하는 순수 헬퍼. 실패 생성·값 정리·요청 식별자·티켓 해시·티켓 조회·베어러 파싱만 둔다. 권한·잠금·영수증 판정은 각 실행기에 남긴다 |

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
| 서버·표현 계층 | `npm test` (PostgreSQL 주입) | 최신 실측값은 `docs/STATUS.md` 참조 |
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
