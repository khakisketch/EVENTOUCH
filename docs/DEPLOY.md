# EVENTOUCH 배포 안내

## 구성

- 프론트: 이 저장소 정적 파일. Vercel 또는 중앙 서버가 직접 서빙.
- API: `server/server.js` (Node 24, `pg` 의존성). `PORT` 환경변수 (기본 8776).
- DB: PostgreSQL (`DATABASE_URL` 필수). 앱 시작 시 번호가 붙은 migration을 적용한다.
- 파일: `STORAGE_DIR/eventouch/{photos,reports,exports}`.

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
- 백업: `DATA_DIR` + `STORAGE_DIR`을 NAS 스냅샷·외부 복사 중 하나로 이중화한다.
