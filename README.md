# EVENTOUCH

행사대행 운영사를 위한 행사 운영 웹 제품. 제품 UI는 Next.js 새 앱 하나이며,
Node API 서버와 PostgreSQL이 뒤에서 행사 데이터를 권위로 들고 있다.
운영사 콘솔, 현장 스태프 화면, 참가자 웹(신청·티켓 QR), 행사장 전광판을 같은 오리진에서 제공한다.

- 지금 상태·검증 수치·블로커: **[docs/STATUS.md](docs/STATUS.md)** (현황 정본)
- 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 디자인: [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)
- 배포: [docs/DEPLOY.md](docs/DEPLOY.md) · 연동: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

## 스택

- 프론트: `apps/web`(Next.js + TypeScript App Router). 유일한 제품 UI다.
  브라우저는 이 앱의 오리진에만 닿고, `/api/*`는 같은 오리진 rewrite로 API에 전달된다.
- 서버: Node 24 + `pg`의 API 전용 서버. `server/server.js`가 `/api/*`와 은퇴 워커
  `/sw.js`만 답하고 저장소 정적 파일은 서빙하지 않는다.
- DB: PostgreSQL. 앱 시작 시 번호순 마이그레이션을 적용한다.
- 테스트: `node:test` + Playwright(감사·브라우저 계약).

## 시작하기

```bash
npm run setup
npm run build
npm start            # 감독 실행: API 8776 + 빌드된 Next 8777
```

개발 중에는:

```bash
npm run dev          # 감독 실행: API 8776 + Next dev 8777
npm run api:start    # API만 직접 실행(Next 없이 API를 볼 때)
```

포트 기본값은 API 8776·웹 8777이며 `API_PORT`·`WEB_PORT`로 바꾼다.
Next의 `/api/*` rewrite 목적지는 빌드 시 baked되므로, 다른 API를 바라보게 하려면
같은 `EVENTOUCH_API_URL`로 빌드하고 실행한다(기본 `http://127.0.0.1:8776`).

최초 관리자는 환경변수로만 만든다. 셋 다 있어야 생성된다.

```bash
PORT=8776 \
DATABASE_URL='postgres://user:pass@host:5432/eventouch' \
ADMIN_EMAIL='admin@example.com' \
ADMIN_PASSWORD='8자 이상' \
npm run api:start
```

컨테이너로 띄우려면:

```bash
POSTGRES_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... docker compose up -d --build
```

`HOST_PORT`로 호스트에 게시되는 Next 포트를 바꾼다(내부 API는 공개 포트가 없다).

## 검증

DB가 있어야 백엔드 테스트와 감사가 실제로 돈다. 없이 돌리면 스킵되고, 러너가 그것을 실패로 처리한다.

```bash
EVENTOUCH_TEST_DATABASE_URL='postgres://...' npm test    # 스킵 0이어야 통과(최신 수치는 docs/STATUS.md)
EVENTOUCH_A11Y_DATABASE_URL='postgres://...' npm run a11y # 기존 Next 빌드로 격리 접근성 감사
EVENTOUCH_MOBILE_DATABASE_URL='postgres://...' npm run mobile # 6기기×2방향×6실경로=72 레이아웃 검사(넘침·44px)
npm run web:audit                                       # 격리 접근성·넘침·참가자 홈 기하 감사
EVENTOUCH_TEST_DATABASE_URL='postgres://...' npm run web:console:audit # 콘솔 공통 구조·입력 보호·재시도·보고서 출력
```

`npm run test:raw`는 러너 없이 `node --test`를 직접 돌린다(스킵 허용).
`a11y`·`mobile`·`web:audit`·`web:console:audit`는 `npm run build`로 만든 `.next`를 임시 Next에서 실행한다.
서버 렌더도 같은 격리 API를 사용하며 종료 때 자기 서버와 픽스처만 정리한다.
이 명령들의 `WEB_BASE`는 대체되며, 외부 실행 서버·배포본을 검사한 증거가 아니다.
참가자 가져오기·한울·테마 브라우저 감사는 `npm run web:import:audit`·
`npm run web:hanwool:audit`·`npm run web:theme:audit`이며, 격리 DB와 실행 중
빌드(`WEB_BASE`, 기본 `http://127.0.0.1:8777`)가 필요하다.

## 백업·복구

compose 배포본의 DB와 파일 볼륨을 한 번에 백업하고, 체크섬·행 수·파일 해시까지 검증하는
리허설을 지원한다.

```bash
npm run backup -- --project eventouch --out /var/backups/eventouch/2026-10-17
npm run backup:verify -- --project eventouch --out /tmp/eventouch-backup-check
node scripts/restore.cjs <백업 디렉터리> --project eventouch-restore \
  --storage-volume eventouch-restore_etko-storage
```

출력에는 개인정보가 있으므로 저장소 밖에 두고 접근을 제한한다. 세부 절차·복구 순서·
현재 한계(PITR 없음)는 [docs/DEPLOY.md](docs/DEPLOY.md)를 따른다.

## 디렉터리

```
apps/web/               유일한 제품 UI(Next.js+TS App Router, CSS 모듈, /api rewrite)
apps/web/app/           라우트: /(랜딩) · /login · /console/** · /event/[slug]/** ·
                        /staff/** · /screen/[slug] · /invite/[token]
apps/web/app/console/console-ui/  콘솔 공용 프레임·도구막대·섹션·입력/작업·피드백·대화상자
apps/web/app/console/console-navigation.ts  메뉴 이름·경로 정본(권한 판정과 분리)
apps/web/app/tokens.css 제품 디자인 토큰 정본
apps/web/proxy.ts       문서 응답 보안 헤더 경계(API rewrite 제외)
server/                 API·인증·권한·커맨드·발송·파일(정적 서빙 없음)
server/commands/        이벤트 커맨드 묶음 + 실행기(domain·participants·operations)
server/fastify/         TypeScript 경계 모듈(health·공개 읽기·조직 REST·커맨드 경로)
server/migrations/      번호순 SQL 마이그레이션
server/sw.js            은퇴 워커(구 셸 캐시 eventouch-shell-*만 정리 후 등록 해제)
server/legacy-events.js 과도기 JSON 저장소 폴백(운영에서 410 반환)
tests/                  node:test 스위트(+ helpers/postgres-api-server.cjs)
scripts/                감독 실행, 테스트 러너, 접근성·모바일·웹 감사, 격리 감사 픽스처
docs/                   정본 문서(+ archive/ = 지난 계획 기록, 현재 지침 아님)
tests/fixtures/         테스트가 읽는 고정 자산(부스 지도 예시 이미지 등)
scripts/serve-demo.sh   이 환경의 데모 서버 시작(API+웹 감독 실행, 기존 데이터 보존)
```

## 이 저장소에서 지켜지는 규율

- **서버 권위**: 운영 모드에서 행사 데이터의 유일한 권위는 PostgreSQL이다.
  JSON 저장소(`DATA_DIR`)는 데이터베이스 없이 띄운 과도기 모드에서만 동작한다.
- **단일 쓰기 경로**: 행사 쓰기는 멱등 커맨드 경로 하나로만 처리하고, 발송은 커밋 이후에 실행한다.
- **문서**: 현황·수치는 `docs/STATUS.md` 한 곳에만 쓴다. 지난 서술은 `docs/archive/`로 내린다.

에이전트로 작업할 때의 프로젝트 규칙은 [AGENTS.md](AGENTS.md)에 있다.
