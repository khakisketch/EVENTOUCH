# EVENTOUCH 프로젝트 지침

전역 하네스가 "프로젝트별 절차는 프로젝트에"라고 위임하는 자리다. 전역 규칙 위에 이 저장소의
사실만 적는다. 제품이 지금 어떤 상태인지는 [docs/STATUS.md](docs/STATUS.md)가 정본이다.

## 손대기 전에 알아야 하는 것

- **이벤트 커맨드 단일 경로**: 운영 모드의 모든 행사 쓰기는
  `POST /api/events/:eventId/commands`로 들어와 `server/commands/domain.js`의 `execute`가
  트랜잭션 하나에서 처리한다(멱등 키 → 행 잠금 → 영수증 확인 → 권한 → apply → 감사·저장).
  새 커맨드는 이 순서를 그대로 따르고, 응답 유실 재시도를 위해 **영수증을 남긴다**.
- **조직 범위 작업은 전용 REST 경로**를 쓴다(이벤트 스코프가 없으므로):
  `POST /api/events`(생성) · `POST /api/clients` · `POST /api/accounts/:id/org-permissions` ·
  `POST /api/events/:id/members` · `/api/auth/invitations`. 셋 다 같은 멱등 규율을 따른다.
- **메시지 발송은 커밋 이후**에 실행한다. 공급사 호출이 실패해도 이미 성공으로 본 커맨드를
  롤백하면 안 되고, 공급사가 접수한 메시지를 롤백으로 잃으면 안 된다.
- **JSON 저장소는 과도기 폴백**이다. `DATABASE_URL`이 있으면 읽지도 쓰지도 않고 레거시 라우트는 410이다.

## 커밋 규율

- CSS/JS를 고치면 **같은 커밋에서** `index.html`의 해당 `?v=`를 1 올리고,
  `server/sw.js`의 `CACHE` 이름도 올린다. 서비스 워커가 셸을 캐시하기 때문이다.
- 스크립트 로드 순서는 곧 모듈 시스템이다(뒤가 앞을 덮어쓴다). 순서를 바꾸면
  `tests/load-order.test.cjs`와 `docs/ARCHITECTURE.md` 7절을 함께 고친다.
- `tests/frontend-contract.test.cjs`가 화면 39·액션 120을 고정한다. 화면·액션을 더하거나 지우면
  의도임을 커밋 메시지에 쓰고 숫자를 갱신한다.
- 루트의 사용자 파일(`*.zip`, 추적되지 않은 계획 문서)은 건드리지 않는다.

## 검증

```bash
EVENTOUCH_TEST_DATABASE_URL='postgres://eventouch@localhost/eventouch_test_a?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5' npm test
EVENTOUCH_A11Y_DATABASE_URL='postgres://eventouch@localhost/eventouch_uiux_audit?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5' npm run a11y
EVENTOUCH_MOBILE_DATABASE_URL='postgres://eventouch@localhost/eventouch_uiux_mobile?host=/tmp/opencode/eventouch-pg-test-auth.l0FjK5' npm run mobile
```

- DB URL 없이 `npm test`를 돌리면 197개가 스킵되고 **실패로 처리된다**(침묵 커버리지 손실 방지).
- 테스트 파일은 **직렬 실행**이다(`scripts/run-tests.cjs`). 공유 DB와 IP 기반 로그인 스로틀 때문에
  병렬로 돌리면 서로 걸려 거짓 실패가 난다. 이 결정을 되돌리지 않는다.
- 브라우저 검증은 저장소의 Playwright(`node_modules/playwright`)를 직접 쓴다.
  일부 MCP 브라우저는 외부 호스트를 차단하므로 `127.0.0.1`을 쓴다.

## 배포

- `docker compose up -d --build`가 정본 경로다. `HOST_PORT`로 호스트 포트를 바꾼다.
- 운영에서는 `COOKIE_SECURE=1`, `ADMIN_*`은 실행 환경에서 주입하고 저장소에 두지 않는다.
- 마이그레이션은 앱 시작 시 자동 적용된다. 되돌리는 마이그레이션은 없다.
- 배포 검증 최소 기준: `/api/health` 200 → 로그인 → 콘솔 진입 → 쓰기 1건 → **재시작 후 그 값 유지**.

## 문서

- **현황은 한 곳**: `docs/STATUS.md`. 지난 서술을 다른 곳에 병렬로 남기지 않는다.
- 지난 계획·설계는 `docs/archive/`에 둔다(고치지 않고 보존, 인덱스만 `docs/archive/INDEX.md`).
- 렌더 증거는 `design-previews/`(추적 안 함)에 날짜 폴더로 남기고 `INDEX.md` 한 장을 둔다.
- 문서가 코드와 어긋나면 코드가 맞다. 문서를 고치거나 내린다.

## 하지 말 것

- 중복 정의된 뷰·액션 정리(정적 분석으로 레이어와 죽은 코드를 구분할 수 없다 — 사용자 결정).
- 오프라인 세션 지원(권한 해제 무시·기기 분실 위험으로 의도적 미지원. 셸까지만).
- 고객사 포털·로그인, 새 "조직 설정" 영역(사용자가 명시적으로 제외).
- 실발송·실기기·스크린리더를 검증했다고 말하는 것. 미검증이다.
