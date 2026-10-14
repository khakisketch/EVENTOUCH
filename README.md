# EVENTOUCH

행사대행 운영사를 위한 행사 운영 웹 제품. 운영사 콘솔, 현장 스태프 화면, 참가자 웹(신청·티켓 QR),
행사장 전광판을 같은 서버가 함께 서빙한다.

- 지금 상태·검증 수치·블로커: **[docs/STATUS.md](docs/STATUS.md)** (현황 정본)
- 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 디자인: [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)
- 배포: [docs/DEPLOY.md](docs/DEPLOY.md) · 연동: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

## 스택

- 프론트: 구 앱은 빌드 없는 바닐라 ES + IIFE. `index.html`이 `defer` 스크립트와 CSS를 순서대로 로드한다.
- 새 앱: `apps/web`(Next.js + TypeScript). 별도 설치·빌드(아래 실행 참조), 같은 오리진 `/api` rewrite로 API를 쓴다.
- 서버: Node 24, `node:http` + `pg`. `server/server.js`가 정적 파일과 `/api/*`를 함께 처리한다.
- DB: PostgreSQL. 앱 시작 시 번호순 마이그레이션을 적용한다.
- 테스트: `node:test` + Playwright(감사·브라우저 계약).

## 시작하기

```bash
npm ci
npm start          # DATABASE_URL 필수, PORT 기본 8776
```

새 앱(포트 8777):

```bash
npm --prefix apps/web ci
npm run web:build && npm run web:start
```

최초 관리자는 환경변수로만 만든다. 셋 다 있어야 생성된다.

```bash
PORT=8776 \
DATABASE_URL='postgres://user:pass@host:5432/eventouch' \
ADMIN_EMAIL='admin@example.com' \
ADMIN_PASSWORD='8자 이상' \
node server/server.js
```

컨테이너로 띄우려면:

```bash
POSTGRES_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... docker compose up -d --build
```

## 검증

DB가 있어야 백엔드 테스트와 감사가 실제로 돈다. 없이 돌리면 스킵되고, 러너가 그것을 실패로 처리한다.

```bash
EVENTOUCH_TEST_DATABASE_URL='postgres://...' npm test    # 스킵 0이어야 통과(최신 수치는 docs/STATUS.md)
EVENTOUCH_A11Y_DATABASE_URL='postgres://...' npm run a11y # 주요 12화면 WCAG 위반 0
EVENTOUCH_MOBILE_DATABASE_URL='postgres://...' npm run mobile # 72검사(넘침·44px)
```

`npm run test:raw`는 러너 없이 `node --test`를 직접 돌린다(스킵 허용).

## 디렉터리

```
index.html              진입 문서. 스크립트·CSS 로드 순서가 곧 모듈 시스템이다
assets/css/             tokens.css(토큰) + 화면별 CSS
assets/js/              core → store → … → surface-presentation 순서로 window.ET를 확장
server/                 API·인증·권한·커맨드·발송·파일
server/commands/        이벤트 커맨드 5묶음 + 도메인 라우터(domain.js)
server/migrations/      번호순 SQL 마이그레이션
apps/web/               새 프론트엔드(Next.js+TS, 별도 설치·빌드, /api rewrite)
tests/                  node:test 스위트(+ helpers/postgres-api-server.cjs)
scripts/                테스트 러너, 접근성·모바일 감사, 정의 추적
docs/                   정본 문서(+ archive/ = 지난 계획 기록, 현재 지침 아님)
tests/fixtures/         테스트가 읽는 고정 자산(부스 지도 예시 이미지 등)
scripts/serve-demo.sh   이 환경의 데모 서버 시작(포트·DB를 환경변수로 바꾼다)
```

## 이 저장소에서 지켜지는 규율

- **캐시버스터**: `index.html`의 `?v=`는 수동이다. CSS/JS를 고치면 같은 커밋에서 1 올린다.
  서비스 워커 캐시 이름(`server/sw.js`의 `CACHE`)도 함께 올린다.
- **로드 순서**: 뒤에 로드되는 파일이 같은 이름의 뷰·액션·핸들러를 덮어쓴다.
  순서를 바꾸기 전에 `tests/load-order.test.cjs`와 `docs/ARCHITECTURE.md` 7절을 읽는다.
- **계약 고정**: `tests/frontend-contract.test.cjs`가 화면 39·액션 120과 로드 순서를 고정한다.
  의도적으로 바꿀 때만 숫자를 갱신한다.
- **서버 권위**: 운영 모드에서 행사 데이터의 유일한 권위는 PostgreSQL이다.
  JSON 저장소(`DATA_DIR`)는 데이터베이스 없이 띄운 과도기 모드에서만 동작한다.
- **문서**: 현황은 `docs/STATUS.md` 한 곳에만 쓴다. 지난 서술은 `docs/archive/`로 내린다.

에이전트로 작업할 때의 프로젝트 규칙은 [AGENTS.md](AGENTS.md)에 있다.
