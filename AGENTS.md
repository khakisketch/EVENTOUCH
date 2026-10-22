# EVENTOUCH 프로젝트 지침

전역 하네스가 "프로젝트별 절차는 프로젝트에"라고 위임하는 자리다. 전역 규칙 위에 이 저장소의
사실만 적는다. 제품이 지금 어떤 상태인지는 [docs/STATUS.md](docs/STATUS.md)가 정본이다.
검증된 변경은 그곳에 반영하고, 현재 수치·증거를 다른 문서에 복제하지 않는다.

## 제품 구성

- **유일한 제품 UI는 `apps/web`(Next.js App Router)**이다. 구 바닐라 앱(`index.html`·
  `assets/`·매니페스트·아이콘·구 캐시 서비스 워커·`scripts/definition-trace.cjs`·
  `vercel.json` 자리 표시자)은 2026-10-17 은퇴로 제거됐다. 이후 문서·테스트·감사에서
  구 앱을 기준으로 삼지 않는다.
- **API 서버(`server/server.js`)는 API 전용**이다. 저장소 파일을 서빙하지 않는다.
  `/api/*` 외에 답하는 비-API 경로는 이전 오리진의 `/sw.js` 하나뿐이며, 그 자리에는
  은퇴 워커(`server/sw.js`)가 나간다: `eventouch-shell-*` 캐시만 지우고 스스로 등록을
  해제한다. 쿠키·스토리지·무관한 캐시는 건드리지 않는다.
  Next 오리진의 `apps/web/public/sw.js`도 같은 은퇴 워커다. 서로 다른 오리진에 남은
  이전 설치를 정리하기 위한 것이며 새 앱 오프라인 캐싱을 제공하는 기능이 아니다.
- **공유 자산은 보존한다**: Node API·PostgreSQL·인증·커맨드·업로드·데이터·
  `server/legacy-events.js`·`data/sample.json` 폴백과 기존 사용자 작업·아카이브.
  JSON 저장소는 과도기 폴백이다. `DATABASE_URL`이 있으면 읽지도 쓰지도 않고 레거시
  라우트는 410이다.

## 손대기 전에 알아야 하는 것

- **이벤트 커맨드 단일 경로**: 운영 모드의 모든 행사 쓰기는
  `POST /api/events/:eventId/commands`로 들어와 트랜잭션 하나에서 처리한다
  (멱등 키 → 행 잠금 → 영수증 확인 → 권한 → apply → 감사·저장).
  경로는 하나지만 실행기는 3종이다(`domain`·`participants`·`operations`).
  셋 다 같은 규율을 따르고, 새 커맨드는 이 순서를 그대로 따르고 응답 유실
  재시도를 위해 **영수증을 남긴다**.
- **조직 범위 작업은 전용 REST 경로**를 쓴다(이벤트 스코프가 없으므로):
  `POST /api/events`(생성) · `POST /api/clients` · `POST /api/accounts/:id/org-permissions` ·
  `POST /api/events/:id/members` · `/api/auth/invitations`. 모두 같은 멱등 규율을 따른다.
- **메시지 발송은 커밋 이후**에 실행한다. 공급사 호출이 실패해도 이미 성공으로 본 커맨드를
  롤백하면 안 되고, 공급사가 접수한 메시지를 롤백으로 잃으면 안 된다.
- **참가자 홈 스타일 계약**: `attendee.page.save/publish`의 `homeStyle` 기본값·허용
  필드·검증의 서버 정본은 `server/attendee-home-style.js`다(기본 배경 `#B9DEF0`,
  대표/보조 문구·배치·크기·정렬·글자 톤·덮개·초점 선택지만 저장, 임의 CSS/HTML/외부
  URL 없음). 초안은 `draftVersion`, 게시는 `publishedVersion` 복사,
  `expectedDraftVersion` 낙관적 가드, 공개 투영은 게시본만, 배너는 기존 600KB
  규칙·운영자 미리보기 경로를 재사용한다. 콘솔 편집기는 새 앱
  `/console/events/:id/page`가 유일한 입구다. 구 에디터 링크를 폴백으로 두지 않는다.

## 커밋 규율

- 구 앱 자산 규율(CSS/JS 수정 시 `index.html` `?v=`·서비스 워커 `CACHE` 동시 상향,
  로드 순서·화면 39·액션 120 계약 고정)은 **은퇴로 폐지**됐다. `apps/web`은
  자체 빌드이므로 기준은 타입 검사·`next build` 통과다.
- 루트의 사용자 파일(`*.zip`, 추적되지 않은 계획 문서)은 건드리지 않는다.
- `docs/archive/**`는 고치지 않고 보존하며 현재 지침으로 쓰지 않는다.

## 검증

```bash
npm run setup                                        # 루트 + apps/web 의존성 설치
npm run dev                                          # 감독 실행: API 8776 + Next 8777
npm start                                            # 빌드된 Next + API 감독 실행
npm run build                                        # server:typecheck + apps/web 빌드
npm run api:start                                    # API만 직접 실행(Next 없음)
EVENTOUCH_TEST_DATABASE_URL='postgres://...' npm test
EVENTOUCH_A11Y_DATABASE_URL='postgres://...' npm run a11y
EVENTOUCH_MOBILE_DATABASE_URL='postgres://...' npm run mobile
npm run web:audit                                    # 기존 Next 빌드로 격리 실행하는 접근성·넘침 감사
npm run web:console:audit                            # 16개 콘솔 메뉴 공통 구조·필터·입력 보호·응답 유실·보고서 인쇄
```

- `npm test`는 **직렬 실행**이다(`scripts/run-tests.cjs`). 공유 DB와 IP 기반 로그인 스로틀 때문에
  병렬로 돌리면 서로 걸려 거짓 실패가 난다. 이 결정을 되돌리지 않는다.
- DB URL 없이 `npm test`를 돌리면 스킵되고 **실패로 처리된다**(침묵 커버리지 손실 방지).
- 접근성·모바일·웹 감사는 먼저 만든 `apps/web/.next`로 임시 Next를 실행하고,
  서버 렌더와 브라우저 모두 같은 격리 API/PostgreSQL 픽스처를 보게 한다. 기존 서버나
  `WEB_BASE`를 검사한 결과로 부르지 않는다. 정상 경로는 실제 화면 준비 표식을 확인하며,
  오류·404·로그인 복귀 화면이 대신 떠 있으면 감사는 실패한다. 공개 경로에는 인증 쿠키를 넣지 않는다.
  구 정적 셸 계약(화면 수·액션 수·로드 순서)은 은퇴했고, 그 검사가 사라진 것은
  의도된 계약 은퇴이지 API·권한·멱등 커버리지 손실이 아니다. 검사를 약화해서
  수치를 맞추지 않는다(최종 수치·증거는 `docs/STATUS.md`에만 둔다).
- 모바일 감사는 6기기 × 2방향 × 6실경로 = 72 레이아웃 검사 + 44px 터치 목표를 본다.
  실기기·Safari·스크린리더 실청취·실발송은 미검증이며 완료라 말하지 않는다.
- 콘솔 감사도 같은 격리 API/DB에 연결된 자기 Next를 실행한다. 메뉴 제목만 보지 않고 실제 준비 표식·
  데스크톱/모바일 공통 프레임·필터와 선택·미저장 경고·커밋 후 응답 유실 재시도·동결 보고서 출력을 확인한다.
  인쇄는 Chromium의 DOM/인쇄 매체/PDF 모의이며 실프린터 검증이 아니다.
- 브라우저 검증은 저장소의 Playwright(`node_modules/playwright`)를 직접 쓴다.
  일부 MCP 브라우저는 외부 호스트를 차단하므로 `127.0.0.1`을 쓴다.
- 렌더 검증 캡처는 저장소에 두지 않는다. 작업 폴더(`/tmp/opencode/eventouch-captures/`)에 남기고,
  저장소에 필요한 증거·수치는 `docs/STATUS.md`에만 적는다. 다른 문서에 현재
  검증 수치를 복제하지 않는다.

## 배포

- `docker compose up -d --build`가 정본 경로다. 서비스는 `db` + 내부 API(`eventouch`,
  공개 포트 없음) + 제품 UI(`web`)이며, `HOST_PORT`가 게시하는 것은 Next 하나다
  (이전 API 포트가 이제 Next 포트다). `/api/*` rewrite 목적지는 이미지 빌드 시
  baked되고(`EVENTOUCH_API_URL` build arg) 런타임 env와 일치해야 한다
  (compose 내부 `http://eventouch:8776`).
- 운영에서는 `COOKIE_SECURE=1`, `ADMIN_*`은 실행 환경에서 주입하고 저장소에 두지 않는다.
- 마이그레이션은 앱 시작 시 자동 적용된다. 되돌리는 마이그레이션은 없다.
- 기존 사용자 데이터·볼륨(`eventouch-pgdata`, `etko-db`, `etko-storage`)을 리셋하지 않는다.
  `down -v`로 볼륨을 지우지 않는다(NAS 연결 시 해당 마운트 경로도 동일).
- 배포 검증 최소 기준: `/api/health` 200 → 로그인 → 콘솔 진입 → 쓰기 1건 → 파일 1건 →
  **재시작 후 그 값 유지**.

## 문서

- **현황은 한 곳**: `docs/STATUS.md`. 지난 서술을 다른 곳에 병렬로 남기지 않는다.
- 정본 연결: 구조·권한·데이터는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  디자인은 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md),
  배포는 [docs/DEPLOY.md](docs/DEPLOY.md), 연동은 [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).
  정본 내용을 여러 문서에 복제하지 않는다.
- 지난 계획·설계는 `docs/archive/`에 있다. **고치지 않고 보존하며, 현재 지침으로 쓰지 않는다.**
  거기 적힌 경로·도구·워크플로는 그 시점의 것이고 지금은 존재하지 않을 수 있다.
- 문서가 코드와 어긋나면 코드가 맞다. 문서를 고치거나 내린다.

## 하지 말 것

- 오프라인 세션 지원(권한 해제 무시·기기 분실 위험으로 의도적 미지원).
  새 Next 앱에 구 오프라인 셸·스캔 큐가 있었던 것처럼 오프라인 캐싱·체크인 큐를 약속하지 않는다.
  연결 단절은 오류 안내 + 재시도로만 다룬다.
- 고객사 포털·로그인, 새 "조직 설정" 영역(사용자가 명시적으로 제외).
- 실발송·실기기·스크린리더를 검증했다고 말하는 것. 미검증이다.
- 은퇴한 구 소스를 되살리는 정리(구 뷰·액션 중복 정리 규칙은 더 이상 유효하지 않다).
- 루트 ZIP·추적되지 않은 사용자 계획 문서·아카이브 변경, 임의의 새 권한·비용·플랫폼 결정.
