# EVENTOUCH 배포 안내

Next의 요청별 스크립트 nonce를 위해 HTML은 동적으로 렌더링한다. 정적 HTML/CDN 캐시를
전제로 배포하지 않는다. `COOKIE_SECURE=1`은 API 쿠키와 웹의 HSTS·HTTP 업그레이드에
같이 적용되므로 HTTPS 종단을 준비한 뒤 켠다. 로컬 HTTP 검증은 0으로 유지한다.
프로덕션 시작은 빌드에 저장된 API 목적지와 실행 설정이 다르면 프로세스를 띄우기 전에
거부한다. `API_PORT`나 `EVENTOUCH_API_URL`을 바꾸면 같은 값으로 다시 빌드한다.

API 컨테이너는 UID 1000(`node`)으로 실행된다. 새 데이터/업로드 디렉터리는 이미지에서
이 계정 소유로 준비한다. 기존 볼륨이나 NAS를 재사용할 때도 같은 UID가 파일을 읽고
디렉터리에 쓸 수 있는지 먼저 확인한다. 권한 오류를 데이터 삭제·볼륨 재생성으로 해결하지
않는다. 기존 파일의 소유권을 일괄 변경하기 전에는 사용 중인 다른 계정·서비스를 확인한다.

## 구성

- 웹(유일한 제품 UI): `apps/web` 자체 이미지(`apps/web/Dockerfile`)로 빌드되며 compose의 `web`
  서비스로 뜬다. `/api/*`는 `EVENTOUCH_API_URL`(compose 내부 `http://eventouch:8776`)로
  프록시된다. rewrite 목적지는 이미지 빌드 시 baked되므로 빌드 arg와 런타임 env가
  일치해야 한다.
- API: 루트 이미지(`Dockerfile`, `server/server.js`, API 전용). `PORT` 환경변수 (기본 8776).
  공개 포트가 없으며 브라우저는 웹 서비스를 통해서만 닿는다.
- DB: PostgreSQL (`DATABASE_URL` 필수). 앱 시작 시 번호가 붙은 migration을 적용한다.
- 파일: `STORAGE_DIR` 아래 서버 생성 파일 ID로 저장; 원본 이름·행사·크기·이미지 치수는 PostgreSQL `stored_files`에 보관한다. 미설정 기본값은 `data/storage`다.

## 내부 운영

1. `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`를 설정한다. 비밀번호는 8자 이상이어야 하며 최초 AGENCY 계정만 환경변수로 만든다.
2. `npm run setup` 후 `npm run build`, `npm start` (감독 실행: API 8776 + 웹 8777).
   포트는 `API_PORT`·`WEB_PORT`로, 호스트 게시 포트는 `HOST_PORT`로 바꾼다.
3. 또는 `docker compose up -d --build` (compose가 PostgreSQL 볼륨·재시작을 관리).
4. 브라우저에서 웹 주소로 접속 → `/login` → 관리자 로그인.

## 고객사 NAS 연결

1. NAS에 공유 폴더 2개 준비: `eventouch/db`, `eventouch/storage`.
2. 중앙 서버에 마운트 (예: `/mnt/nas/eventouch/...`).
3. compose 볼륨을 NAS 경로로 교체 후 `docker compose up -d`.
4. NAS 자체를 외부에 노출하지 않는다. 파일은 항상 API로만 제공한다.

## 외부 공개

원칙: 세션 인증은 same-origin에서만 동작한다. 웹과 API를 같은 도메인으로 묶는다.

1. 웹 서비스 앞에 리버스 프록시를 둔다. 같은 도메인에서 브라우저 트래픽은 웹으로,
   `/api/*`는 웹의 rewrite를 통해 내부 API로 간다.
2. HTTPS 공개 시 `COOKIE_SECURE=1`을 API와 웹 양쪽에 설정한다. 내부 HTTP 운영에서는 0.
3. 참가자 초대 링크의 기준 주소(`EVENTOUCH_PUBLIC_URL`)는 참가자 Next 앱을 실제로
   제공하는 공개 주소여야 한다(`docs/INTEGRATIONS.md`). 확정 전에는 티켓링크 포함
   발송이 409로 차단된다.
4. 문자·결제 연동 전에는 안내 문구를 시뮬레이션 표시 그대로 둔다.

## 배포 검증

로컬 컨테이너 배포를 기동하고 아래를 확인한다. 과거 배포 서술은 이력으로만 보고,
현재 절차의 증거는 `docs/STATUS.md`에 둔다.

    docker compose -p eventouch up -d --build

- 확인하는 것: `/api/health` 200 → 로그인 → 콘솔 진입 → 쓰기 1건 → 파일 1건 →
  `docker compose restart` 후 같은 값 유지(볼륨 영속).
- 자격증명은 실행 환경에서 주입하고 저장소에 두지 않는다.
- 기존 사용자 데이터·볼륨(`eventouch-pgdata`, `etko-db`, `etko-storage`)을 리셋하지 않는다.
  `down -v`로 볼륨을 지우지 않는다.

운영 배포 위치(NAS·공개 도메인)는 아직 정해지지 않았다. 정해지면 `COOKIE_SECURE=1`로 올린다.

## 검증

    npm run setup   # 루트 + apps/web 의존성 설치
    npm run build   # server:typecheck + apps/web 빌드
    npm test   # PostgreSQL 포함 전체 스위트. 스킵이 하나라도 있으면 실패한다.
    npm run a11y   # 실행 중 Next 빌드 대상 접근성 감사
    npm run mobile # 실기기 프로필 6종 × 가로/세로 × 6실경로 = 72 레이아웃 검사
    npm run web:audit # 실행 중 Next 빌드 대상 접근성·넘침·참가자 홈 기하 감사

두 명령 모두 DB와 실행 중 빌드가 있어야 정상 동작한다. `EVENTOUCH_TEST_DATABASE_URL`,
`EVENTOUCH_A11Y_DATABASE_URL`이 없으면 백엔드 테스트는 스킵으로 처리되고,
접근성 감사는 실행되지 않는다. 웹 감사는 `npm run build` 후 실행 중인 빌드
(`WEB_BASE`, 기본 `http://127.0.0.1:8777`)가 필요하다. CI는 값을 주입하므로 빌드가
통과했다면 해당 검사들이 실제로 수행된 것이다.


`npm run mobile`은 오버플로와 44px 미만 조작 요소를 잡는다. 카메라
권한, 소프트 키보드, 실제 터치, iOS Safari 렌더링은 잡지 못한다.
실기기 확인이 필요한 항목은 `scripts/device-checklist.md`에 있다.

## compose·볼륨 운영 규칙

- 서비스: `db`(PostgreSQL) + `eventouch`(내부 API, 공개 포트 없음) + `web`(유일한
  브라우저 입구, `${HOST_PORT:-8777}:8777` 게시).
- 볼륨 `eventouch-pgdata`(DB) · `etko-db`(과도기 JSON 보관) · `etko-storage`(파일 저장소)는
  재배포·재시작 때 보존한다. `down -v` 금지. NAS 연결 시 compose 볼륨을 NAS 경로로 교체한다.

## 운영 주의

- `/api/health`는 프로세스 생존과 발송 연동 상태를, `/api/readyz`는 DB `SELECT 1`까지 확인한다.
  API 컨테이너 HEALTHCHECK는 `/api/readyz`를 쓴다. JSON 폴백 모드(무DB)는 readyz 503이며
  운영 배포로 보지 않는다.

- 비밀값은 `.env`가 아니라 실행 환경·비밀 저장소에 둔다. 저장소에 커밋 금지.
- `ADMIN_EMAIL`과 `ADMIN_PASSWORD`를 함께 설정하지 않으면 최초 관리자 계정이 만들어지지 않는다. 기본/개발용 관리자 비밀번호는 없다.
- 백업: PostgreSQL 데이터와 `STORAGE_DIR`을 일관된 시점으로 함께 백업한다. `DATA_DIR`은 이전 JSON 자료이며 현재 행사 데이터의 권위 저장소가 아니다. 실행 절차는 아래 `백업과 복구`를 따른다.

## 백업과 복구

정본 경로는 compose 배포본이다. 백업은 PostgreSQL(`pg_dump` custom format)과 파일 볼륨
(`STORAGE_DIR`)을 한 디렉터리에 모으고, `manifest.json`에 체크섬·마이그레이션 버전·주요 테이블
행 수를 기록한다. 원본 DB와 볼륨에는 쓰지 않는다.

    npm run backup -- --project eventouch --out /var/backups/eventouch/2026-10-17
    npm run backup:verify -- --project eventouch --out /tmp/eventouch-backup-check

- 기본 출력은 `backups/<compose 프로젝트>-<UTC시각>/`이며 `.gitignore`에 있다. 개인정보가 들어 있으므로
  저장소 밖에 두고 DB와 같은 수준의 접근 제어(0700)를 적용한다. 오프사이트 사본은 별도로 만든다.
- `--verify`는 같은 db 서비스에 임시 DB를 만들고 복원한 뒤 기록된 모든 행 수·마이그레이션·파일
  해시를 비교하고 임시 DB를 삭제한다. 원본 DB/볼륨은 건드리지 않는다. 릴리스 전과 월 1회
  격리 프로젝트에서 리허설한다. 백업 중 쓰기가 감지되어 `countsStable`이 false이면 행 수
  비교만 건너뛰고 마이그레이션·파일 검사는 계속한다(거짓 실패 방지). 백업 자체는
  `pg_dump`의 트랜잭션 스냅샷이다.
- 복원은 체크섬뿐 아니라 파일 아카이브 판독 가능 여부와 대상 볼륨/디렉터리 점유 여부를
  **DB를 변경하기 전에** 검사한다. 사전 검사에서 실패하면 대상 DB는 그대로 남는다.
- 파일은 배타 생성이라 덮어쓰지 않는다. DB 스냅샷 뒤에 추가된 파일은 백업에 더 들어갈 수 있지만
  참조되지 않는 여분이므로 복원에 해가 없다.
- 복구는 빈 compose 프로젝트에서 db만 띄운 뒤 수행한다.

      docker compose -p eventouch-restore up -d db
      node scripts/restore.cjs <백업 디렉터리> --project eventouch-restore \
        --storage-volume eventouch-restore_etko-storage
      docker compose -p eventouch-restore up -d

  같은 프로젝트·DB로의 복원은 `--force` 없이는 거부된다. 비어 있지 않은 대상 DB나 파일
  볼륨도 `--force`가 필요하다. 복원 후 `/api/health` 200 → 로그인 → 행사·참가자·파일 1건을
  확인한다.
- PITR/WAL 아카이빙은 아직 없다. 현재 복구 목표(RPO)는 마지막 백업 시점이다. 백업 주기·보존
  기간·오프사이트 위치·암호화는 운영 결정으로 남아 있다.
- `etko-db`(과도기 JSON 보관)는 권위 데이터가 아니므로 백업에 포함하지 않는다. `DATA_DIR`에
  미이관 자료가 남아 있다면 별도로 보관한다.
- 호스트에 PostgreSQL 클라이언트가 있으면 compose 없이도 백업할 수 있다.
  `node scripts/backup.cjs --database-url ... --storage-dir ...` (복원 리허설은 compose 전용).

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
- API 서버는 저장소 파일을 HTTP로 노출하지 않는다. `data/sample.json`은 디스크 폴백일 뿐
  주소로 답하지 않으며, 이전 오리진의 `/sw.js`는 은퇴 워커만 답한다.
