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

`npm start`와 `npm run dev`는 웹과 API를 모두 `127.0.0.1`에 묶는다. 다른 기기에서 이
로컬 실행에 접근할 수 없으며, 외부 제공은 인증·HTTPS를 구성한 배포 경로를 사용한다.
직접 `npm run api:start`로 실행하는 API의 기존 기본 수신 범위는 바뀌지 않는다. 필요하면
`EVENTOUCH_API_BIND`로 해당 단독 프로세스의 수신 주소를 명시한다. Compose의 API는
컨테이너 내부에서 웹의 연결을 받아야 하므로 기본 수신을 유지하고 호스트 포트는 게시하지 않는다.

## 고객사 NAS 연결

1. NAS에 공유 폴더 2개 준비: `eventouch/db`, `eventouch/storage`.
2. 중앙 서버에 마운트 (예: `/mnt/nas/eventouch/...`).
3. compose 볼륨을 NAS 경로로 교체 후 `docker compose up -d`.
4. NAS 자체를 외부에 노출하지 않는다. 파일은 항상 API로만 제공한다.

## 외부 공개

원칙: 세션 인증은 same-origin에서만 동작한다. 웹과 API를 같은 도메인으로 묶는다.

1. 웹 서비스 앞에 리버스 프록시를 둔다. 같은 도메인에서 브라우저 트래픽은 웹으로,
   `/api/*`는 웹의 rewrite를 통해 내부 API로 간다. 웹 포트는 인입 프록시만 접근할
   수 있게 두고, 프록시가 실제 연결 주소로 `X-Forwarded-For`를 덮어쓰도록 설정한다.
   `EVENTOUCH_WEB_TRUSTED_PROXIES`에는 웹이 소켓에서 확인하는 프록시 주소를 지정한다.
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

전체 묶음은 `EVENTOUCH_TEST_DATABASE_URL='postgres://.../eventouch_test' npm run verify:system`이다.
명시적 loopback 작업 DB만 받고 빌드·직렬 테스트·업무/접근성/모바일 감사를 순서대로 실행한다.
증거는 기본적으로 저장소 밖 `/tmp/eventouch-private-<uid>/`의 새 사설 디렉터리에 남긴다.
`EVENTOUCH_CAPTURE_ROOT`로 다른 새 디렉터리를 지정할 수 있으나, 안전하지 않은 상위 경로·
심볼릭 링크·기존 결과를 덮어쓰는 경로는 거부한다. 이전 증거의 경로와 파일은 그대로 보존한다.
배포 URL·실발송 자격증명·자동 발송 옵션을 검사 프로세스에 상속하지 않는다. 실행 목록만 보려면
`npm run verify:system -- --list`를 사용한다. DB 이름 검사만으로 격리가 보장되는 것은 아니므로
공유 운영 DB 대신 별도 인스턴스/작업 DB를 마련해야 한다.
통합 검증 빌드의 API rewrite는 연결할 수 없는 루프백 주소로 고정된다(감사는 자체 API를 쓴다).
검증 후 그 빌드를 제품 실행에 재사용하지 말고 목적 환경의 `EVENTOUCH_API_URL`로 다시 빌드한다.

    npm run setup   # 루트 + apps/web 의존성 설치
    npx playwright install --with-deps chromium # 브라우저 회귀 테스트와 감사에 필요
    npm run build   # server:typecheck + apps/web 빌드
    npm test   # PostgreSQL 포함 전체 스위트. 스킵이 하나라도 있으면 실패한다.
    npm run a11y   # 실행 중 Next 빌드 대상 접근성 감사
    npm run mobile # 실기기 프로필 6종 × 가로/세로 × 6실경로 = 72 레이아웃 검사
    npm run web:audit # 실행 중 Next 빌드 대상 접근성·넘침·참가자 홈 기하 감사

검사에는 격리 PostgreSQL URL과 Chromium이 필요하며, 감사에는 먼저 만든 `.next`도 필요하다.
대신 `CHROMIUM_EXECUTABLE`로 호환 브라우저 경로를 지정할 수도 있다. `npm test`는 DB가 없어
스킵되면 실패한다. 접근성·모바일·웹·콘솔 감사는 자기 API·Next와 합성 스키마를 실행하며,
`WEB_BASE`로 지정한 외부 실행 서버를 검사한 증거가 아니다. 빌드 통과와 감사 통과도 별개다.
원격 CI 실행 여부와 최신 결과는 `docs/STATUS.md`에서 확인한다.


`npm run mobile`은 오버플로와 44px 미만 조작 요소를 잡는다. 카메라
권한, 소프트 키보드, 실제 터치, iOS Safari 렌더링은 잡지 못한다.
실기기 확인이 필요한 항목은 `scripts/device-checklist.md`에 있다.

## compose·볼륨 운영 규칙

- 서비스: `db`(PostgreSQL) + `eventouch`(내부 API, 공개 포트 없음) + `web`(유일한
  브라우저 입구, `${HOST_PORT:-8777}:8777` 게시).
- 볼륨 `eventouch-pgdata`(DB) · `etko-db`(과도기 JSON 보관) · `etko-storage`(파일 저장소)는
  재배포·재시작 때 보존한다. `down -v` 금지. NAS 연결 시 compose 볼륨을 NAS 경로로 교체한다.

## 운영 주의

- API 이미지는 `NODE_ENV=production`으로 실행한다. `EVENTOUCH_DEV_QUICK_LOGIN`은
  명시적 `NODE_ENV=development`에서만 허용하며 운영·미지정 환경에 남으면 기동을 거부한다.
- 프록시 뒤 클라이언트 주소는 `EVENTOUCH_TRUSTED_PROXIES`의 명시적 IP/CIDR 허용 목록을
  적용한다. 기본은 전달 헤더를 신뢰하지 않는다. 실제 프록시 경로에서 가까운 신뢰하지 않는
  주소를 고르므로 임의의 가장 왼쪽 `X-Forwarded-For`를 사용자 IP로 삼지 않는다.
- compose는 기본 네트워크를 `10.89.0.0/24`로 고정하고 `web`에 `10.89.0.10`을 준다.
  API는 이 주소만 프록시로 신뢰한다(`EVENTOUCH_TRUSTED_PROXIES` 기본값). `web`은
  `next start` 대신 `web-server.cjs`로 기동해 웹 경계가 확인한 클라이언트 주소 하나로
  `X-Forwarded-For`를 덮어쓴다.
  다른 네트워크와 충돌하면 `EVENTOUCH_PROXY_SUBNET`과 그 범위 안의
  `EVENTOUCH_WEB_PROXY_IP`를 함께 바꾼다. API 기본 신뢰 주소도 이 IP를 따른다.
  `EVENTOUCH_TRUSTED_PROXIES`를 직접 지정한다면 반드시 웹 IP를 포함해야 한다.
  기존 배포의 자동 할당 네트워크는 이 설정으로 **재생성**되므로, 배포 시 잠깐의
  네트워크 재구성이 필요하다(볼륨·데이터는 유지).
- 웹 앞에 NAS·로드밸런서 등 다른 프록시가 있으면 `EVENTOUCH_WEB_TRUSTED_PROXIES`에
  그 인입 경로의 실제 소켓 피어 IP를 설정한다. 여러 신뢰 프록시는 쉼표로 구분한다.
  CIDR을 사용하는 경우 프록시 전용 범위로 제한한다. 직접 접속이나 설정이 빈 웹은
  들어온 전달 주소를 버리고 소켓 주소를 쓴다. 신뢰 피어의 체인은 오른쪽에서부터
  확인해 처음 만나는 비신뢰 주소를 사용한다. API의 `EVENTOUCH_TRUSTED_PROXIES`에는
  계속 웹 서비스의 주소를 지정한다. 배포 시 서로 다른 두 클라이언트의 로그인 제한이
  분리되고, 직접 보낸 위조 헤더로 주소 제한을 피할 수 없는지 확인한다.
- 이미지 빌드·compose 실행에 같은 `EVENTOUCH_BUILD_REVISION`을 전달한다. 미지정은 `unknown`이며
  실제 소스 해시를 임의로 추정하지 않는다. 조직 소유자의 `/api/diagnostics`에서 실행 식별자와
  자기 운영사의 발송 적체를 확인한다. 다른 운영사 요청량을 포함한 전역 집계는 HTTP로 노출하지 않는다.
  HTTP 응답의 `X-Request-ID`로 요청을 연결하고 원시 URL·토큰·개인정보는
  액세스 로그에 남기지 않는다. `EVENTOUCH_REQUEST_LOGS`로 로그를 명시적으로 제어할 수 있다.

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
- 새 백업은 현재 스키마의 추가 테이블도 행 수 목록에 포함한다. 이전 format-1 백업은 그 당시
  기록한 검증 대상 전체를 유지해 비교하며 새 테이블 목록이 없다는 이유로 복원을 깨뜨리지 않는다.
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

### 예약 실행·운영 점검 도구

`ops/backup-schedule.example.cron`과 `ops/ops.env.example`은 자동화 설정 예시이며 설치하거나
운영 값을 확정한 것이 아니다. 아래 도구는 보존기간에 따른 삭제나 오프사이트 전송을 하지 않는다.

- `npm run backup:scheduled -- --project <project> --backup-root <저장소밖_백업루트> --check`
  는 백업을 생성하고 결과를 검사한다. 실제 DB·파일을 다루므로 지정한 프로젝트가 맞는지 확인한다.
- `npm run backup:check -- --backup-root <백업루트> --project <project> --verify-checksums`
  는 최신 매니페스트·크기·체크섬을 검사한다. `--max-age-hours`가 없으면 신선도 정책 미설정으로 보고한다.
- `npm run ops:readiness -- --help`로 API·웹 rewrite 경유 readyz·발송 적체·백업·디스크 점검 옵션을 확인한다.
  JSON 보고서는 `--json`으로 출력할 수 있다.
  공개 health에는 운영사 전체의 발송량을 노출하지 않는다. 적체 수치는 인증된 현재 운영사 소유자의
  `/api/diagnostics`에서 확인한다. 준비 상태 도구에 적체 상한을 지정했는데 측정값이 없으면 미검증 실패이며,
  상한을 지정하지 않으면 미측정 상태를 보고만 한다.
- `npm run ops:notify`는 보고서 기록 전용이다. 외부 수신처·채널 정책이 없으므로 실제 알림 전송은 제공하지 않는다.
- `npm run security:audit`는 루트 운영 의존성과 웹 의존성을 함께 검사하고 기본 보통(moderate) 이상이면 실패한다.
  원격 CI의 새 업무 감사와 실패 아티팩트는 합성 데이터만 대상으로 하며 보존기간을 제한한다.

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

## 납품 전 준비와 실제 관찰

`npm run ops:release:check`는 설정과 담당자의 검수 기록을 읽는 도구다. 메시지를 보내거나
DB·배포를 변경하지 않는다. 실제 수신·실기기·사람 검수가 없으면 `pending`을 유지하고 실패로
종료한다. 설정 준비를 실제 배포 검증이나 고객 승인으로 부르지 않는다.

1. 공개 HTTPS 주소·배포 대상·등록 발신번호·Solapi 채널과 승인 템플릿을 확정한다.
   공개 주소는 티켓 링크 생성과 같은 규칙으로 읽으며 쿼리, 프래그먼트, 로그인 정보가 붙은 주소는 거절한다.
   계정 복구용 SMTP 설정은 `docs/INTEGRATIONS.md`를 따른다. 값은 비밀 설정으로 주입한다.
2. 시험 행사와 동의한 시험 수신처만 선택해 제품 UI에서 SMS/LMS/MMS/알림톡·대체발송을
   각각 확인한다. 공급사 접수와 수신자 도달을 따로 기록하고, 이메일은 인증→재설정→
   새 비밀번호 로그인→옛 세션 차단까지 실제 메일함의 링크로 수행한다.
3. 운영 담당자가 행사 생성→명단 가져오기→승인→안내 검토→입장/퇴장→참여 프로그램→
   경품 수령→보고서 생성·출력까지 수행한다. 화면 도움 없이 완료 가능한지,
   막힌 위치·원래 입력 보존·복구 방법과 담당자 판단을 기록한다.
4. iPhone Safari와 Android에서 실제 카메라 QR 스캔·소프트 키보드·터치·회전·복귀를
   확인한다. 실제 스크린리더로 제목·필드·오류·상태를 청취한다. 사용하는 프린터·QR 리더기도
   실제 출력·읽기를 확인한다. 프린터/리더기를 쓰지 않으면 담당자가 `not-used`로 명시한다.
5. `ops/acceptance.example.json`을 저장소 밖 비공개 경로에 복사하고 실제 담당자·관찰 시각·
   결과를 기록한다. 날짜만 채우거나 자동 검사 결과를 사람의 관찰로 옮기지 않는다.
   추첨 대상·중복 규칙·최종 상품/수량/확률·수령자, 개인정보·백업의 보존과 삭제 예외,
   사전 이메일 미인증 계정의 수동 본인 확인 담당자·승인 절차도 별도로 확정한다.

    npm run ops:release:check -- --attestation /private/path/acceptance.json

`verify:system`의 로컬 회귀와 운영의 `ops:readiness`·compose 재시작 검증은 별도다.
실제 결과와 수치는 `docs/STATUS.md`만 따른다.

## 합성 동시 요청과 백업 복원 리허설

`npm run verify:delivery`는 `EVENTOUCH_REHEARSAL_DATABASE_URL`의 loopback 테스트 서버에
새 임시 DB 두 개를 만들고, 합성 행사와 저장 파일만 채운다. 공유 테스트 DB 자체나 기존
운영 자료를 덤프·복원하지 않는다. 테스트 역할에는 임시 DB 생성 권한이 필요하며 호스트에
`pg_dump`·`pg_restore`가 있어야 한다. 증거 루트와 TMPDIR은 저장소 밖 소유자 전용 경로다.

기본 부하는 독립적으로 연결된 클라이언트의 동시 공개 조회와 현장 데스크 쓰기다.
분포(p50/p95/p99/max)와 오류, 실제 입장 건수를 확인하고 `backup.cjs`로 덤프·파일 보관을
수행한다. 빈 대상 DB로 복원해 모든 테이블 행 수·파일 해시·기존 세션·행사 데이터와 파일
다운로드를 확인한다. 실행이 끝나면 자신이 만든 임시 DB만 정리하고 증거는 보존한다.

갑작스러운 신규 TCP 연결 폭주는 이미 연결된 사용자의 동시 요청과 다른 시험이다.
같은 호스트의 간단한 HTTP 대조 서버도 함께 측정해 커널 연결 대기열·파일 한도·프록시·
애플리케이션 병목을 구별한다. 로컬 연결 오류를 없애려고 시험의 오류를 숨기거나 운영체제
설정을 임의로 바꾸지 않는다. 운영 대상에서 콜드 연결·프록시·네트워크를 다시 확인해야 한다.
이는 실제 사람·브라우저·기기의 동시 이용이나 운영 SLA 검증을 대체하지 않는다.

`EVENTOUCH_BROWSER_LOAD_DATABASE_URL`에 쿼리 매개변수가 없고 이름에 `test`, `audit`,
`verify`, `rehearsal` 중 하나가 독립 구성 요소로 들어간 loopback 격리 DB를 지정하고
`npm run verify:browser-load`를 실행하면 합성 900명 행사에서 격리된 Chromium 탭의
티켓 표시와 스태프 화면의 동시 입장 처리를 측정한다. 자체 테스트 스키마와 사설 증거
디렉터리를 사용하며 실행 환경·동시성·오류를 함께 기록한다. 한 컴퓨터의 브라우저와
서버가 자원을 공유하므로 실제 기기·현장 네트워크·운영 부하의 대체가 아니다.

## 보존·영구 삭제 검토

보존 기산일·기간·삭제 권한·보존 예외·백업 및 파일 범위·삭제 후 영수증을 확정하기 전에는
행사 영구 삭제를 활성화하지 않는다. 다음 명령은 지정 운영사의 행사만 읽어 영향 수량과
미결정을 보여 준다. 행사·파일·영수증은 지우지 않는다.

    npm run event:purge:review -- --org-id <운영사ID> --event-id <행사ID>

실제 행사 삭제 기능은 정책 확정 후 기존 이벤트 커맨드 단일 경로와 삭제 뒤 재시도 영수증
계약을 포함해 구현한다. 단순 SQL 삭제나 파일 제거로 우회하지 않는다.
