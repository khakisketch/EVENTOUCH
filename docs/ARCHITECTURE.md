# EVENTOUCH 구조

Updated: 2026-10-29 · 기준 브랜치: `main` (구현 기준은 현재 작업 트리와 테스트)

공유형 조직 격리·소유권 관리로 전환 중이다. 운영 반영 및 현재 검증 완료 범위는
`docs/STATUS.md`, 사용자 확정 정책과 조직 경계는 `docs/MULTI-TENANCY.md`를 따른다.

이 문서는 현재 구현과 목표 아키텍처를 구분해 기록한다. 제안서(`EVENTOUCH_서비스 기획 및
제안.html`)나 `행사운영플랫폼_개발기획안.pdf`는 초기 기획이므로 구현 판단의 근거로 쓰지 않는다.
단, 계약이 제안서를 토대로 성립했으므로 약속→빌드 대조는 `docs/CONTRACT-SCOPE.md`에 둔다.

코드와 테스트가 문서보다 우선한다. `docs/code-structure.svg`는 참고 그림이며, 구조 변경 시
함께 갱신한다. 이 문서의 과거 측정값은 재측정 전까지 현재 수치로 간주하지 않는다.

## 1. 한눈에

행사대행사가 여러 고객사의 행사를 운영하는 B2B 워크스페이스. 하나의 API와
유일한 제품 UI인 Next.js 새 앱(`apps/web`)이 네 종류의 화면을 제공한다.

| 표면 | 사용자 | 경로 | 인증 |
|---|---|---|---|
| 운영 콘솔 | 대행사·행사 담당 | `/console/*` | 세션 쿠키 |
| 현장 스태프 | 배정된 스태프 | `/staff`, `/staff/events/:eventId` | 세션 쿠키 |
| 참가자 웹 | 행사 참가자 | `/event/<slug>`, `/event/<slug>/register`, `/event/<slug>/ticket`, `/event/<slug>/home`, `/event/<slug>/engage` | 티켓 bearer·참가자 세션 |
| 행사장 출력 | 무대·전광판 | `/screen/<slug>` | 없음(공개) |
| 초대 수락 | 초대받은 구성원 | `/invite/<token>` | 초대 토큰 |
| 공용 입구 | 모두 | `/`, `/login` | 로그인 상태면 역할별 복귀 |

구 바닐라 앱(`index.html` 해시 라우터·`assets/`·`window.ET`)과 그 계약 검사
(화면·액션 수·로드 순서 고정)는 2026-10-17 은퇴로 제거됐다. 의도된 구 UI 계약
은퇴이며 서버 커맨드·권한·멱등 커버리지의 손실이 아니다. 서버 커맨드와 테이블
정의의 현재 범위는 각각 `server/commands/`와 `server/migrations/`를 기준으로 한다.

## 목표 아키텍처 (점진 적용)

이 목표는 전면 재작성 지시가 아니다. 현행 서비스와 계약을 유지하면서 기능 단위로 옮긴다.

- **제품 구조:** 하나의 모듈형 모놀리스. 참가자·운영자·스태프·전광판은 같은 제품/API를 쓴다.
  트래픽이나 독립 배포 필요가 확인되기 전에는 마이크로서비스로 분리하지 않는다.
- **프론트엔드:** TypeScript Next.js App Router(`apps/web`)가 유일한 제품 UI다.
  공개 행사 페이지는 서버 컴포넌트 렌더링, 운영 콘솔·QR 카메라 스캔 등 브라우저
  상태가 필요한 화면은 클라이언트 컴포넌트로 둔다. 스타일은 제품 토큰
  (`apps/web/app/tokens.css`) + CSS 모듈 + 공용 콘솔 부품
  (`apps/web/app/console/console-ui/`)으로 구현한다. 브라우저는 새 앱의 오리진에만
  닿고, `/api/*`는 새 앱의 rewrite가 API로 전달한다(`EVENTOUCH_API_URL`, 기본
  `http://127.0.0.1:8776`, compose 내부 `http://eventouch:8776`). 프론트가 API
  호스트를 직접 두지 않으므로 쿠키·CSP·CORS 정책이 유지된다. 서비스 워커·오프라인
  셸·스캔 큐는 없다. 계약 테스트 `tests/web-slice-contract.test.cjs`가 rewrite와
  읽기 전용을 고정한다.
- **백엔드 목표:** Node.js + TypeScript의 도메인 모듈형 API. Fastify는 라우트·검증 경계로
  점진 도입하되, 기존 커맨드 도메인을 보존하고 프론트엔드와 업무 규칙을 중복하지 않는다.
  모든 쓰기는 서버 권위이며 PostgreSQL 트랜잭션에서 검증한다.
  (진행: `server/commands/shared.ts` 전환 + `npm run server:typecheck`, `server/fastify/health.ts`가
  `GET /api/health`를, `server/server.js`가 DB `SELECT 1`을 포함하는 `GET /api/readyz`를,
  `server/fastify/public-reads.ts`가 `GET /api/public/*` 읽기(공개 행사·티켓·
  공개 파일)를, `server/fastify/organization-rest.ts`가 조직 REST(행사 목록/생성·고객사·조직 권한·
  행사 멤버)를, `server/fastify/command-path.ts`가 참가자 커맨드 경로(가입·이벤트 커맨드)를 서빙.
  빌드 단계 없음 — Node 24 타입 스트리핑, erasable 문법만.
  남은 구 경로: `/api/auth/*`, 파일 업로드·사진 ZIP, `/api/bootstrap`, 410 폴백.)
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
- 오프라인 지원 없음. 새 앱은 오프라인 셸·스캔 큐를 제공하지 않으므로 연결 단절은
  오류 안내와 재시도로만 다룬다. 서버 확인 전 기록은 확정 체크인으로 표시하지 않고,
  오프라인 로그인 세션을 새로 허용하지 않는다.
- QR이 bearer 자격증명인 만큼 원문 로그·오류 추적·분석 이벤트에 토큰을 남기지 않는다.
  QR 토큰의 저장·재발급·취소 방식은 핵심 엔티티를 정규화할 때 해시 저장과 유출 대응까지 함께
  설계한다. 현행 workspace 저장 방식을 바꾸기 전에는 호환성 마이그레이션을 먼저 만든다.

### 이전 순서와 완료 기준

1. 현재 구현·문서·API 계약을 기준선으로 고정하고 QR/체크인 실패·중복 테스트를 보강한다.
2. DB 마이그레이션으로 티켓/체크인 핵심 엔티티를 분리하되 기존 API 응답과 화면 계약을 유지한다.
3. TypeScript API 모듈을 먼저 분리하고, Fastify 경계에서 기존 권한·트랜잭션 테스트를 그대로 통과시킨다.
4. Next.js 화면을 기능 단위로 도입하고, 각 단위의 브라우저·접근성·모바일 검증이 끝난 뒤 구 화면을 제거한다(2026-10-17 제거 완료).
5. 실기기 QR 스캔, 운영 데이터 규모의 DB 백업·복구 리허설, 운영 로그·알림까지 검증한 뒤 운영 전환한다.

각 단계는 기존 API·권한·멱등성·저장 보존 테스트를 통과해야 완료다. 프레임워크 교체만으로
완료 처리하지 않는다.

## 2. 역할과 권한

역할은 셋이다(`server/access.js`, `server/auth.js`). 계정은 전역 로그인 신원이며,
현재 선택된 운영사의 `organization_memberships`가 실효 역할·소속 활성·조직 권한을 결정한다.
`accounts.role`을 다른 운영사의 권한으로 사용하지 않는다.

| 역할 | 범위 | 판정 방식 |
|---|---|---|
| `AGENCY` | 현재 운영사 전체 | 검증된 조직 문맥 안에서 허용 |
| `MANAGER` | 배정된 행사 | `memberships` 행 존재 |
| `STAFF` | 배정된 데스크·부스 | `staff_assignments` + 커맨드 허용목록 |

`STAFF`는 커맨드 허용목록으로 제한된다.

    assignment.read · participants.read
    check.scan · check.correct · checkin.scan · checkin.sync · checkin.correction
    booth.visit
    reward.lookup · reward.collect (배정된 DESK에서 대상자 경품 조회·수령)

`STAFF_TARGET_REQUIRED`(`check.scan`, `checkin.scan`, `booth.visit`)는 대상 ID까지
일치해야 한다. 즉 다른 데스크의 스캔은 서버가 거부한다.
`reward.lookup`·`reward.collect`도 DESK 배정을 서버에서 확인한다. STAFF bootstrap에는
전역 경품 목록을 싣지 않고, 스캔 영수증·대상자별 조회 응답에 필요한 경품만 싣는다.

행사 단위 쓰기 권한은 `memberships.write_permissions` 배열이며 `'all'` 또는 기능 키다.
화면 접근은 라우트 → 셸 메뉴(행사·고객사 + 행사 하위 목적지, 2메뉴 정본) → 그룹 권한 순으로
판정한다. 메뉴 표시는 게이트일 뿐이며 권한 판정은 항상 서버가 한다.

운영사 소유권·역할 변경과 행사별 쓰기 범위는 별개다. 기존 팀 화면 안에서 관리하되
소유권 변경으로 전역 계정 신원이나 다른 운영사의 역할을 바꾸지 않는다.
조직 선택·소속 해제·이전 탭·응답 유실의 구체 계약은 [MULTI-TENANCY.md](MULTI-TENANCY.md)에 둔다.

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

### 3.1 참가자 추첨·투표와 무대

`server/commands/attendee-experience.js`는 기존 도메인 실행기 안에서 같은 행사 잠금·
권한·영수증·감사 규율을 사용한다. 설정/결과는 워크스페이스 JSONB에 저장한다.

- `vote.config.save`로 정확한 선택 수·개시/마감·집계 게시를 정한다. `vote.ranked`는
  호환 이름일 뿐 참가자 순위 입력이 아니다. `vote.tally`는 득표수 경쟁 순위와 동점을
  명시하고 3위 경계 동점을 임의 탈락시키지 않는다. 미게시 집계는 공개 응답에서 숨긴다.
- `roulette.config.save`는 무대 추첨과 독립된 시간·재고·상품 정책이다. 유한 재고는
  잔여 수량을 기본 가중치로 쓰며 무제한은 명시적 `quantity:null`과 양의 `weight`가
  필요하다. 첫 결과 이후 상품 ID/순서/이름은 고정한다. `roulette.spin`은 개인별 한 번,
  결과와 수령 가능한 경품을 함께 저장한다. 공개 `rouletteView`는 운영 여부·시간·
  경품 라벨만 제공하고 수량/가중치는 공개하지 않는다.
- `lucky.config.save`·`lucky.preassign`으로 초대 전 번호를 원자적으로 배정한다.
  신규 행사는 1~900 기본 풀, 투표·룰렛 마감 상태로 시작한다. 기존 미설정 행사는
  명시적으로 구분해 정규화하며 이미 배정한 번호를 바꾸지 않는다.
- `draw.program.save/run`은 PERSON/COMPANY 대상·그룹/업체 필터·상품 등급·
  EVENT/PROGRAM/NONE 중복 범위를 지원한다. `count:1`은 사회자 한 번 터치다.
  `showOnScreen:true`는 당첨·경품 생성·전광판 선택을 한 트랜잭션에 담고,
  출력 기능이나 게시 모듈 조건이 맞지 않으면 전부 거부한다. 게시를 내리면 연결된
  모듈 내역도 숨기며 상태 변경으로 명시적 비공개 선택을 덮어쓰지 않는다.
- 개인 당첨은 발생 건별 경품을 만든다. 업체 당첨은 PENDING 경품으로 남기고
  `reward.assign`으로 승인된 동일 업체 수령자를 운영자가 명시한 뒤 수령할 수 있다.
  `check.scan` 응답의 해당 참가자 경품과 `reward.lookup/collect`는 같은 단일 커맨드
  경로·영수증을 사용한다. 퇴장 스캔이 경품 수령을 자동 확정하지 않는다.

메시지 변수·개인 링크의 발송 조건은 [INTEGRATIONS.md](INTEGRATIONS.md)를 따른다.

### 3.2 행사별 참가자 홈 디자인

`attendee.page.save/publish`의 기존 `pageExperience.{draft,published}`에 `homeStyle`을
추가한다. 기본값·허용 필드·입력 검증의 서버 정본은 `server/attendee-home-style.js`다.
배경 HEX, 제한된 대표/보조 문구, 배치·크기·정렬·글자 톤·이미지 덮개·초점 선택지만
저장하며 임의 CSS/HTML/외부 글꼴·이미지 URL은 설정으로 받지 않는다. 미설정·이전 행사는
현재 기본 홈을 유지한다. `homeStyle` 생략은 기존 초안을 보존하고 부분 객체는 해당 필드만
병합하며 `null`은 스타일 기본값으로 되돌린다(배너 파일을 지우는 동작과 별개).

초안 저장은 `draftVersion`을 올리고, 게시는 그 버전을 `publishedVersion`으로 복사한다.
새 편집기는 `expectedDraftVersion`을 보내 다른 운영자의 최신 초안을 덮어쓰거나 잘못
게시하지 않으며, 기존 클라이언트의 버전 필드 생략은 호환된다. 응답 유실 재시도는 같은
커맨드 영수증으로 결과를 확인하고 버전을 다시 올리지 않는다.

공개·티켓 API는 게시본 `homeStyle`만 허용 목록으로 투영한다. 초안·내부 버전은 공개하지
않는다. 배너는 기존 행사 범위 파일 업로드/읽기와 PNG/JPEG/WEBP 600KB 제한을 재사용한다.
미게시 파일은 인증된 운영자 경로에서만 미리 보고, 게시 후에만 공개 파일 경로로 제공한다.
콘솔 편집기는 새 앱 `/console/events/:id/page`가 유일한 입구다(`ThemeWorkspace`, 휴대폰
미리보기·초안 저장·명시적 게시·충돌 시 `expectedDraftVersion` 409 안내).

## 4. 데이터 모델

PostgreSQL이 행사 데이터의 유일한 권위다. JSON 파일 저장소(`DATA_DIR`)는 과도기
폴백으로만 남아 있고 PostgreSQL 모드에서는 읽지도 쓰지도 않는다.

| 테이블 | 역할 |
|---|---|
| `accounts` | 전역 로그인 신원·scrypt 해시·본인이 검증한 이메일. 기존 역할/권한 필드는 호환 자료이며 운영사 권한의 정본이 아님 |
| `organizations` | 운영사 식별·이름·권한 변경 시계 |
| `organization_memberships` | 계정↔운영사 실효 역할·권한·활성·멤버십 리비전 |
| `sessions` | 세션 토큰 해시·만료·선택 운영사·세션별 선택 리비전과 멤버십 바인딩 |
| `account_email_proofs` | 계정 이메일 확인·비밀번호 복구의 목적별 일회용 토큰 해시와 만료·사용 상태 |
| `invitations` | 초대. 상태 `PENDING`/`ACCEPTED`/`REVOKED`, 만료 |
| `clients` | 운영사 소유 고객사 |
| `events` | 운영사 소유 행사 메타(이름·slug·일정·단계·기능) `payload` jsonb |
| `event_workspaces` | 행사 업무 데이터 전체 `payload` jsonb + `revision` |
| `memberships` | 계정↔행사 쓰기 권한 |
| `staff_assignments` | 스태프 배정(데스크/부스) |
| `stored_files` | 업로드 파일 메타(치수 포함) |
| `command_receipts` | 조직·행사·주체에 묶인 멱등성 영수증. 전역 요청 키 충돌 의미는 유지 |
| `message_outbox` | 발송 의도(커맨드와 같은 트랜잭션 기록, 결과 기록 후 삭제, 부팅 드레인) |
| `checkin_records` | 체크인 이력의 write-through 투영(JSONB가 읽기 권위, 005가 기존 기록 백필) |
| `tickets` | 티켓 식별의 write-through 투영(JSONB가 읽기 권위, 006 백필은 식별자만·해시는 첫 변경 시 채움) |
| `login_attempts` | 로그인 실패와 계정 복구·이메일 확인의 별도 요청 제한 카운터 |
| `login_lockout_overrides` | 관리자 잠금 해제 기록 |
| `attendee_challenges`·`attendee_grants`·`attendee_sessions` | 행사별 연락처 인증·일회성 신청 권한·브라우저의 행사별 접근 권한. 운영자 조직 세션과 별개 |
| `signup_request_attempts` | 공개 신청의 단기 남용 방어. 영수증과 별개이며 원문 주소/요청 키를 저장하지 않음 |
| `global_state` | 전역 키-값 |

설계상 중요한 점: 행사 업무 데이터는 **하나의 `event_workspaces.payload` jsonb**에
들어 있다. 참가자·데스크·부스·메시지·보고서가 모두 그 안에 있고, 변경은 행 단위
잠금 + 리비전 증가로 직렬화된다.
운영자 증빙 사진은 `workspace.evidencePhotos`에 별도 보관하고, 참가자 포토월의
`workspace.photos`와 목적·상태·공개 범위를 섞지 않는다. 증빙의 바이너리는 기존
`stored_files`에 두며 공개 투영과 스태프 부트스트랩에서 제외한다.

정규화는 expand 단계로 진행한다(읽기 권위는 그대로 둔다):

- `message_outbox` — 발송 의도. `message.retry`가 SENDING으로 바꿀 때 같은
  트랜잭션에서 행을 남기고, 결과 기록 후 삭제한다. 부팅 드레인이 남은 행을
  재처리한다. 공개 `/api/health`에는 운영사 간 업무량을 드러내는 대기 건수를 두지 않는다.
  인증된 현재 운영사 소유자의 `/api/diagnostics`가 자기 운영사 적체만 보고한다.
- `checkin_records` — 체크인 이력의 write-through 투영. `check.scan`·
  `check.correct`와 같은 트랜잭션에서 기록하므로 JSONB와 어긋날 수 없다.
  읽기는 `workspace.checks`가 계속 맡는다. 005 마이그레이션이 기존 기록을
  백필한다.
- `tickets` — 참가자 티켓 식별의 write-through 투영. 참가자 변경과 같은
  트랜잭션에서 해시·취소·만료를 기록한다. 006 백필은 식별자만 옮기고 해시는
  비워 둔다(SQL 마이그레이션은 공유 DB의 암호 확장을 가정하지 않는다).
  `scripts/backfill-ticket-hashes.cjs`가 NULL 해시를 채운다(멱등, `--dry-run` 지원).
  읽기 전환 전에는 이 스크립트 실행이 먼저다.

운영 콘솔의 목록·셸은 `GET /api/console/directory`의 경량 요약을 읽고, 행사 화면은
`GET /api/events/:id/bootstrap`에서 해당 행사 하나의 상태를 읽는다. 기존 `/api/bootstrap`은
호환 경로로 유지하되 같은 운영사·역할 투영을 적용한다. 브라우저의 공유 읽기는 탭 메모리의
진행 요청만 합치고 쓰기·조직 전환에 무효화한다. 참가자 전체 선택·CSV·메시지 인계 계약을
유지하기 위해 행사 상세의 명단을 서버 페이지네이션으로 임의 변경하지 않는다.

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
  기본은 부팅 드레인과 수동 도달 확인이다. 선택적 유지보수·예약 실행의 이중 게이트와
  공급사 조회 불명의 보류 규칙은 [INTEGRATIONS.md](INTEGRATIONS.md)를 따른다.

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
- 클라이언트는 새 앱의 워크스페이스 컴포넌트에서 이 이름들을 해당 경로로 보낸다.
  매핑이 없으면 이벤트 커맨드 경로로 흘러가 "지원하지 않는 …작업"으로 실패한다.

### 커맨드 모듈 (2026-10-12 측정 스냅샷; 현재 범위는 코드 기준)

| 모듈 | 수 | 내용 |
|---|---|---|
| `preparation` | 18 | 행사 설정·양식·그룹·공지·프로그램·장소·브랜딩·참가자 페이지 |
| `engagement` | 14 | 참여 모듈·응답·질문·사진·게시글·추첨·출력 |
| `content-results` | 15 | 템플릿·메시지·결제·경품·보고서 |
| `operations` | 9 | 데스크·스태프 배정·입퇴장·부스 |
| `booth-map` | 3 | 부스 지도 저장·게시·게시취소 |
| `event-evidence` | 3 | 운영자 증빙 사진 추가·분류 이동·보관함에서 제거 |

증빙 사진 커맨드는 `evidence.photo.add/move/remove`이며 AGENCY 또는 행사 멤버
MANAGER만 호출할 수 있다. 파일 참조는 같은 행사에 운영자가 올린 PNG/JPEG/WebP에
한정한다. 제거는 워크스페이스 참조만 없애며 저장 파일 바이트를 지우거나 기존 행사 `file.read`
권한을 회수하지 않는다. 매니저가 참조를 제거해도 이미 알려진 file ID는 기존 파일 권한에 따라 읽힌다.
읽기 ZIP은 별도 GET이며 쓰기 커맨드 경로를 대체하지 않는다:

- `GET /api/events/:eventId/evidence-photos.zip?section=<fixed-key>` — 지정 섹션의 증빙만.
- `GET /api/events/:eventId/attendee-photos.zip` — 참가자 포토월의 승인 사진만.

두 경로 모두 `file.read` 행사 권한(AGENCY/멤버 MANAGER)을 매 요청 확인하고,
파일명을 서버에서 생성하며 응답은 `no-store`다. 참가자 이름·ID, 검토 대기·숨김 사진,
증빙 사진은 참가자 ZIP에 포함하지 않는다. 원본 참조 중 하나라도 없으면 부분 ZIP을 완성본처럼 반환하지 않고,
헤더 전 오류 응답으로 종료한다.

## 6. 인증과 방어

- 비밀번호: `scrypt` 해시. 평문·복호화 가능 저장 없음.
- 세션: `httpOnly` 쿠키, 토큰은 해시로만 저장, `SESSION_TTL_HOURS`(기본 12).
- 로그인 제한: 계정 5회/15분, 주소 20회/15분. 성공 시 리셋. 창이 지나면 자연 해제.
- 존재하지 않는 계정도 동일한 scrypt 시간을 소모해 계정 열거를 막는다.
- 잠금 응답(429)은 "잠겼다"고 알리지 않는다(공격자에게 신호가 되므로).
- 미마이그레이션 DB에서는 제한 테이블 부재를 감지해 **제한 없이 로그인을 계속 허용**한다.
  운영자가 자기 제품에 잠기는 것이 더 나쁜 실패이기 때문이다.
- 계정 복구는 로그인과 별개다. 사전에 로그인한 본인이 현재 비밀번호와 이메일 소유를
  확인한 주소에만 복구 링크를 보낸다. 기존 이메일·초대 수락을 소유 증명으로 보지 않는다.
  복구 토큰은 해시·만료·일회 사용으로 관리하고, 비밀번호 변경과 기존 세션 전부의
  무효화를 한 트랜잭션에서 처리한다. 복구 제한 스키마가 없으면 복구는 허용하지 않는다.
  공급사·수동 예외의 미정 상태는 `docs/INTEGRATIONS.md`를 따른다.
- 보안 헤더: API는 nonce 기반 CSP · `X-Frame-Options: SAMEORIGIN` · `nosniff` ·
  `Referrer-Policy` · `Permissions-Policy` · HSTS(`COOKIE_SECURE=1`일 때) · COOP를
  모든 응답에 적용한다. CSP의 `frame-ancestors 'self'`는 같은 출처의 참가자 화면을
  프레임으로 띄우는 운영자 미리보기 때문이다. 외부 출처 프레임은 계속 차단한다.
  `EVENTOUCH_CSP_REPORT_ONLY=1`로 강제 없이 관찰할 수 있다.
- Next 문서 응답은 `apps/web/proxy.ts`가 요청별 nonce를 요청·응답 CSP에 함께 싣고
  Next가 같은 nonce를 하이드레이션 스크립트에 부여한다. 루트 레이아웃은 이를 위해
  동적으로 렌더링한다(정적 HTML/CDN 캐싱을 전제로 두지 않는다). 운영 `script-src`는
  nonce와 `strict-dynamic`을 쓰며 `unsafe-inline`·`unsafe-eval`은 허용하지 않는다.
  React의 검증된 테마 style 속성은 `style-src 'unsafe-inline'`으로 허용하되 스크립트
  정책을 완화하지 않는다. 카메라(self)·같은 출처 미리보기·nosniff·리퍼러·COOP도 유지한다.
  HSTS와 insecure-request 업그레이드는 `COOKIE_SECURE=1`에서만 켜 로컬 HTTP를
  임의로 HTTPS로 바꾸지 않는다. `/api/*`는 API 자신의 보안 정책을 덮어쓰지 않는다.

## 7. 프론트엔드 (유일한 제품 UI)

`apps/web`(Next.js + TypeScript App Router)이 제품의 유일한 프론트엔드다. 구 바닐라 앱은
2026-10-17 은퇴로 제거됐으므로 아래만 현재 계약이다. 현재 제품의 토큰 구현은
`apps/web/app/tokens.css`, 화면 스타일은 CSS 모듈 + 공용 콘솔 부품
(`apps/web/app/console/console-ui/`의 `ConsolePageHeader`·`ConsoleSection`·
`ConsoleStatePanel`)으로 구현한다. 기존 시각 기준은 2026-10-27 사용자 요청으로 제거했고,
이후 사용자가 레퍼런스 기반 화이트 체계의 실제 제품 전체 적용을 승인했다.
현재 시각 체계는 [DESIGN.md](../DESIGN.md), 적용·검증 상태는 `docs/STATUS.md`를 따른다.

브라우저는 새 앱의 오리진에만 닿는다. `/api/*`는 새 앱의 rewrite가 API로
전달한다(`EVENTOUCH_API_URL`, 기본 `http://127.0.0.1:8776`). 프론트가 API
호스트를 직접 두지 않으므로 쿠키·CSP·CORS 정책이 유지된다. 서비스 워커·오프라인
셸·스캔 큐는 없으며, 연결 단절은 오류 안내와 재시도로만 다룬다.

입구·세션 계약: 공용 로그인은 `/login`이며 `?next=`는 로컬 allowlist로 검증하고
도착 화면이 서버 기준 역할·배정을 재확인한다. `/staff/login`은 호환 리다이렉트로
유지한다. `/staff`는 배정 허브(단건 자동 진입, 복수 선택)이며 실제 스캔은
`/staff/events/:eventId`에서 배정 범위로만 처리한다. 티켓 bearer는 주소에 실린
1회를 즉시 소비해 메모리로 옮기고 주소를 정리하며, 티켓 상태는 서버 조회로만
판단한다. QR에는 스태프 스캐너가 받는 토큰 원문을 인코딩한다.

### Next.js 화면 (이관 완료, 구 앱 제거됨)

기능 단위 이관 슬라이스의 증명 기록이다. 각 단위는 실제 API·DB 연결 흐름과
접근성·모바일 검증을 통과했고, 구 앱은 2026-10-17 은퇴로 제거됐다.

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
  공지·프로그램·장소를 순환한다. 끊김에는 마지막 화면을 유지한다.
- 슬라이스 6a: 운영 콘솔 읽기(행사 목록 홈·행사별 운영 현황). 같은 오리진 세션으로
  부트스트랩을 읽고, 목록·지표·대기·최근 입퇴장을 렌더링한다.
  로그인은 `/login`에서 공통으로 받고 역할별 기본 목적지로 보낸다.
- 슬라이스 6b: 참가자 상태 변경. 운영자 세션에서 `participant.status`로 승인·대기·
  취소한다. 화면 게이트는 표시 전용이고 권한 판정은 서버가 한다.
- 슬라이스 6c: 메시지 템플릿 저장, 수신자 선택 캠페인 작성·재시도, 전달 상태 조회를 기존
  이벤트 커맨드 경로로 처리한다. 상태 표시는 한국어이며 캠페인 이력은 티켓 bearer를 렌더하지 않는다.
- 슬라이스 6d: 현장 운영 준비(데스크 저장·가동/중지, 부스 저장, 스태프 배정·해제).
  진행 중 전환 조건을 화면에 안내하고, 빈 행사에서 데스크 추가→배정→전환까지 실동작 확인.
- 슬라이스 6e: 행사 설정(기본정보·기능 플래그·접수 게시/닫기·참가자 페이지 초안/게시).
  설정→접수 열기→공개 페이지 신청 CTA 반영까지 실동작 확인. 셸 하위 메뉴에
  현장 운영·행사 설정을 추가해 모든 행사 목적지가 사이드바에서 발견된다.
- 슬라이스 6f: 공통 로그인·행사별 현장 업무. `/login`이 운영자·스태프 공용 입구이며
  `?next=`는 로컬 allowlist로 검증하고 도착 화면이 서버 기준 역할·배정을 재확인한다.
  `/staff/login`은 호환 리다이렉트로 유지한다. `/staff`는 배정 허브(단건 자동 진입,
  복수 선택)이며 실제 스캔은 `/staff/events/:eventId`에서 배정 범위로만 처리한다.
  스캔·멱등·세션 계약은 4a·4b와 동일하다.
- 슬라이스 7a: 참가자 인증·세션·복구. 6자리 인증번호(해시 저장, 10분·5회 시도·
  재전송 간격·일 한도)와 1회용 신청 그랜트, 읽기 전용 브라우저 세션을 분리한다.
  Solapi SMS 실발송 경로를 선구현하고 자격증명·모의 모두 없으면 503으로 정직하게
  답한다. 검증 필수는 행사별 `verificationRequired` opt-in이며, 신청·복구 성공 시
  세션을 합치고 취소·연락처 변경 시 끊는다. QR 단독 세션 발급 경로는 없다.
  새 앱 신청 인증 단계·`/ticket/recover`·세션 티켓 복원이 같은 계약을 쓴다.
- 슬라이스 7b: 결과·보고서 이관 + 인증 토글. 행사 목적지 `결과 보고서`
  (`/console/events/:id/reports`)에서 서버 스냅샷과 같은 공식의 실시간 분석과
  보고서 초안 작성·수정·공유·새 버전을 기존 멱등 커맨드 경로로 처리한다.
  고객사 포털은 제공하지 않으므로 공유는 상태 기록만 남기고 공유 링크를 만들지
  않는다. `event.update`가 `verificationRequired`를 받아 행사 설정 토글로 잇는다.
- 슬라이스 7c: 팀 초대 발급 이관 + 서비스 입구. 팀 화면에서 구성원 초대 발급
  (1회 표시 링크·복사·대기 목록·멱등 철회)을 기존 초대 API 그대로 처리하고,
  `/`는 공용 로그인 중심 입구(로그인 상태면 역할별 복귀)로 둔다. 조직 격리
  설계는 `docs/MULTI-TENANCY.md`로 확정하고 마이그레이션·롤아웃은 제외한다.
- 브라우저는 새 앱의 오리진에만 닿는다. `/api/*`는 새 앱의 rewrite가 API로
  전달한다(`EVENTOUCH_API_URL`, 기본 `http://127.0.0.1:8776`). 프론트가 API
  호스트를 직접 두지 않으므로 쿠키·CSP·CORS 정책이 유지된다.
- 계약 테스트 `tests/web-slice-contract.test.cjs`가 rewrite와 읽기 전용을 고정한다.
- 구 앱의 계약 테스트(화면 수·액션 수·로드 순서 고정)와 `scripts/definition-trace.cjs`는
  은퇴와 함께 제거됐다. `tests/audit-retirement-contract.test.cjs`가 그 제거를 고정한다.

### 콘솔 셸의 정보구조

셸은 새 앱의 `ConsoleShell`(`apps/web/app/console/ConsoleShell.tsx`) 하나가 만들고,
스코프에 따라 내용만 바뀐다. **바깥 랜드마크는 스코프가 바뀌어도 자리를 지킨다.**

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

행사 목록(`/console`)이 워크스페이스 홈이다. 별도 KPI 대시보드를 두지 않고,
행사별 대시보드는 그 행사의 `운영 현황`이 맡는다.

### 운영 현황 화면의 순서

`EventOverview`는 운영자가 묻는 순서대로 배치한다: 헤더(일정·장소·단계·접수) →
핵심 지표(등록·승인 대기·현재 입장·입장률) → 지금 할 일(주 행동 + 대기 건수) →
진행/추이(진행 중이면 시간대별 입장, 아니면 정원 대비 진행률) → 최근 입퇴장 → 접힌 집계 기준.
그룹 사이 간격은 24px, 그룹 안은 4~12px로 리듬을 만든다(균일 간격은 그룹을 읽히지 않는다).

### 참가자 홈 미리보기

콘솔 편집기(`/console/events/:id/page`)의 휴대폰 미리보기는 참가자 홈과 같은 표시
컴포넌트로 초안을 렌더하고 참가자 행동을 실행하지 않는다. 초안은 공개 응답·이미지
경로로 노출하지 않으며, 저장되지 않은 변경·저장된 초안·게시된 화면을 혼동시키지 않는다.

## 8. 파일별 책임

### 서버

| 파일 | 책임 |
|---|---|
| `server/server.js` | API 전용 진입점. `/api/*` 라우팅 + 은퇴 워커 `/sw.js`. 저장소 정적 파일 서빙 없음 |
| `server/api.js` | API 경로 해석, 인증 게이트, 커맨드·조직 범위 REST 위임 |
| `server/auth.js` | 세션·비밀번호·초대·로그인 제한 |
| `server/account-recovery.js`·`server/email-transport.js` | 본인 이메일 확인·복구 토큰과 제한, 기본 비활성 메일 발송 연결 지점 |
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
| `server/sw.js` | 은퇴 워커. 구 셸 캐시(`eventouch-shell-*`)만 지우고 등록 해제. fetch·캐시 핸들러 없음 |
| `server/legacy-events.js` | 과도기 JSON 저장소 폴백(운영에서 410 반환) |
| `server/commands/*.js` | 도메인 커맨드 5묶음 |
| `server/commands/shared.js` | 실행기 3종(domain·participants·operations)이 공유하는 순수 헬퍼. 실패 생성·값 정리·요청 식별자·티켓 해시·티켓 조회·베어러 파싱만 둔다. 권한·잠금·영수증 판정은 각 실행기에 남긴다 |

### 새 앱(`apps/web`)

| 경로 | 책임 |
|---|---|
| `app/layout.tsx` | 루트 레이아웃·건너뛰기 링크·전역 CSS |
| `app/page.tsx` | 서비스 입구(공용 로그인 중심 랜딩) |
| `app/login/page.tsx` | 공용 로그인(운영자·스태프, `?next=` allowlist) |
| `app/console/**` | 운영 콘솔 셸·홈·행사별 목적지(현황·참가자·가져오기·콘텐츠·메시지·현장 운영·프로그램·경품·보고서·설정·사진·추첨·홈 꾸미기 편집기) |
| `app/console/console-ui/` | 공용 부품(`ConsolePageHeader`·`ConsoleSection`·`ConsoleStatePanel`) |
| `app/event/[slug]/` | 참가자 화면(안내·신청·티켓·복구·홈·참여) |
| `app/staff/` | 스태프 배정 허브·행사별 현장 업무·호환 로그인 리다이렉트 |
| `app/screen/[slug]/` | 전광판 공개 출력 |
| `app/invite/[token]/` | 초대 수락 |
| `app/tokens.css` | 제품 디자인 토큰 정본 |
| `app/globals.css` | 전역 스타일·반응형·인쇄 |
| `proxy.ts` | 문서 응답 보안 헤더 경계(`/api/*` 제외) |
| `next.config.ts` | `/api/*` → API rewrite(`EVENTOUCH_API_URL`) |
| `Dockerfile` | 새 앱 전용 이미지(rewrite 목적지 빌드 시 baked) |

## 9. 검증 수단

| 무엇을 | 어떻게 | 기준 |
|---|---|---|
| 서버·API·권한·멱등 | `npm test` (PostgreSQL 주입, 직렬, 스킵 실패) | 최신 실측값은 `docs/STATUS.md` 참조 |
| 새 앱 접근성 | `npm run a11y` (실행 중 Next + 격리 API·DB 픽스처, axe) | serious+ 0 |
| 새 앱 반응형·터치 | `npm run mobile` (6기기×2방향×6실경로=72검사) | 넘침·44px 미만 0 |
| 새 앱 접근성·넘침·홈 기하 | `npm run web:audit` (기존 빌드 + 격리 API·DB 픽스처) | serious+·넘침 0 |
| 가져오기·한울·테마 흐름 | `npm run web:import:audit`·`web:hanwool:audit`·`web:theme:audit` (실제 API·격리 DB) | 각 감사 통과 |
| 발송 | `docs/INTEGRATIONS.md` 체크리스트 | mock 검증 완료, 실발송 미검증 |
| 실기기 | `scripts/device-checklist.md` | 미수행(출시 게이트 아님) |
| 은퇴 고정 | `tests/audit-retirement-contract.test.cjs` | 구 UI 검사 제거 상태 유지 |

CI(`.github/workflows/ci.yml`)는 루트 의존성 설치 + DB 마이그레이션 + `npm test` +
서버 타입 검사 잡, 모바일·접근성 감사 잡, 새 앱 설치·타입 검사·빌드 잡을 모두 돌린다.
원격 CI의 실행 여부와 결과는 `docs/STATUS.md`를 따른다. 구 앱 대상 검사는 은퇴했고, 그 검사가
사라진 것은 의도된 계약 은퇴이지 API 커버리지 손실이 아니다. 검사를 약화해서 수치를
맞추지 않는다.

## 10. 구조 부채 요약 (우선순위)

1. **`legacy-events.js` 과도기 폴백** — 운영에서 쓰이지 않으면 제거 후보. 410 시맨틱 회귀
   검사가 전제를 보증한다.
2. **실발송 미검증** — 코드는 준비됨, 자격증명 대기.
3. **문서 부패 방지** — `code-structure.svg`는 참고 그림이다. 구조를 바꾸는 변경은
   이 문서와 SVG를 함께 갱신해야 한다.
