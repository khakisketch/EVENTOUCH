# EVENTOUCH 배포 안내

## 구성

- 프론트: 이 저장소 정적 파일. Vercel 또는 중앙 서버가 직접 서빙.
- API: `server/server.js` (Node 24, `pg` 의존성). `PORT` 환경변수 (기본 8776).
- DB: PostgreSQL (`DATABASE_URL` 필수). 앱 시작 시 번호가 붙은 migration을 적용한다.
- 파일: `STORAGE_DIR` 아래 서버 생성 파일 ID로 저장; 원본 이름·행사·크기·이미지 치수는 PostgreSQL `stored_files`에 보관한다. 미설정 기본값은 `data/storage`다.

## 내부 운영 (Tailscale)

1. `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`를 설정한다. 비밀번호는 8자 이상이어야 하며 최초 AGENCY 계정만 환경변수로 만든다.
2. `npm ci` 후 `PORT=8776 DATABASE_URL="$DATABASE_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node server/server.js`
3. 또는 `docker compose up -d` (compose가 PostgreSQL 볼륨·재시작을 관리).
4. 브라우저에서 서버 주소로 접속 → 로그인 게이트 → 관리자 로그인.

## 고객사 NAS 연결

1. NAS에 공유 폴더 2개 준비: `eventouch/db`, `eventouch/storage`.
2. 중앙 서버에 마운트 (예: `/mnt/nas/eventouch/...`).
3. compose 볼륨을 NAS 경로로 교체 후 `docker compose up -d`.
4. NAS 자체를 외부에 노출하지 않는다. 파일은 항상 API로만 제공한다.

## 외부 공개 (Vercel)

원칙: 세션 인증은 same-origin에서만 동작한다. 정적과 API를 같은 도메인으로 묶는다.

1. 이 저장소를 Vercel 프로젝트로 연결 (정적).
2. `vercel.json`의 `API_HOST_HERE`를 중앙 서버 공개 주소로 교체한다. 교체 없이 배포하지 않는다.
3. 같은 도메인에서 `/api/*`가 중앙 서버로 가도록 리버스 프록시를 둔다 (예: 프록시에서 `/api/` → 중앙 서버, 나머지 → Vercel 정적).
4. HTTPS 공개 시 중앙 서버에 `COOKIE_SECURE=1`을 설정한다. 내부 HTTP 운영에서는 0.
5. 문자·결제 연동 전에는 안내 문구를 시뮬레이션 표시 그대로 둔다.

## 운영 주의

- 비밀값은 `.env`가 아니라 실행 환경·비밀 저장소에 둔다. 저장소에 커밋 금지.
- `ADMIN_EMAIL`과 `ADMIN_PASSWORD`를 함께 설정하지 않으면 최초 관리자 계정이 만들어지지 않는다. 기본/개발용 관리자 비밀번호는 없다.
- 백업: PostgreSQL 데이터와 `STORAGE_DIR`을 일관된 시점으로 함께 백업한다. `DATA_DIR`은 이전 JSON 자료이며 현재 행사 데이터의 권위 저장소가 아니다.

## 파일 API 계약

- 업로드: `POST /api/events/:eventId/files?name=...&commandId=...`, 원시 파일 본문, 로그인한 AGENCY/해당 행사 MANAGER만 허용. 안정된 commandId 재시도는 같은 파일을 반환하고 다른 본문/행사/계정 재사용은409다.
- PNG/JPEG/WebP/PDF만 허용, 최대8MiB. 배치도·브랜딩·프로그램 등 기존 소비자는600000바이트 제한을 별도로 적용한다. 이미지는 헤더의 치수를 서버가 확인하지만 완전한 이미지 디코딩 검증을 뜻하지 않는다.
- 운영 조회: `GET /api/events/:eventId/files/:fileId`; STAFF 불허.
- 공개 조회: `GET /api/public/events/:slug/files/:fileId`; 현재 공개 행사 화면에 게시된 참조만 허용. 초안/비공개 사진/다른 행사 파일은404. 저장 경로나 storage_key는 응답에 포함하지 않는다.
- 서버 재시작에도 DB와 파일 디렉터리를 보존해야 한다. 이 문서는 배포/NAS 연결 실행 승인이 아니다.

## 저장 경로 정책 (이중 저장 방지)

- PostgreSQL 모드(`DATABASE_URL` 설정)에서는 PostgreSQL이 유일한 행사 데이터 권위다. 이전 JSON 저장소(`DATA_DIR/*.json`)는 읽지도 쓰지도 않는다.
- 레거시 JSON 라우트(`GET/POST /api/events/:id...`, `GET /api/summary`, `POST /api/users`)는 PostgreSQL 모드에서 로그인 확인 후 `410 이전 저장 API는 종료되었습니다`를 반환한다. 시드 데이터 생성도 실행하지 않는다.
- `DATA_DIR` JSON 폴백은 데이터베이스 없이 서버를 띄운 과도기 모드에서만 동작한다. 운영에서는 `DATABASE_URL`을 항상 설정한다.
- 회귀 방지: `tests/server-api.test.cjs`의 `api database mode never writes the retired JSON store` 테스트가 410 응답과 JSON 파일 미생성을 함께 검증한다.

## 정적 자산 버전 (개발 규율)

- `index.html`의 CSS/JS `?v=` 값은 수동 캐시버스터다. 해당 파일을 수정하면 같은 커밋에서 `?v=`를 1 올린다(예: `assets/js/router.js?v=19` → `?v=20`). 자동화(콘텐츠 해시)는 별도 작업이다.
- 테스트/브라우저 검증 전에 `index.html`의 참조 목록과 실제 `assets/` 파일 목록이 일치하는지 확인한다. 새 파일은 스크립트 순서 규칙(기존 로드 순서·덮어쓰기 체인)을 따른다.
