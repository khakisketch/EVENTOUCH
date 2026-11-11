# EVENTOUCH

행사대행사를 위한 한국어 행사 운영 SaaS입니다. 운영 콘솔, 현장 스태프, 참가자 웹과 공개 전광판을 하나의 Next.js 앱과 API로 제공합니다.

## 시작

Node.js 24와 프로젝트 전용 PostgreSQL을 준비한 뒤:

```bash
npm run setup
npm run build
npm start
```

개발 서버는 `npm run dev`입니다. DB·최초 관리자 설정과 컨테이너 실행은 [배포 안내](docs/DEPLOY.md)를 따릅니다. 운영 비밀번호·고객 데이터·검증 증거를 저장소에 두지 마세요.

## 검증

직렬 DB 통합 테스트에는 별도의 loopback 테스트 데이터베이스를 `EVENTOUCH_TEST_DATABASE_URL`로 지정합니다. 누락된 DB 설정은 통과로 보지 않습니다. 브라우저 감사에는 빌드와 Chromium이 필요합니다. `npm run`으로 현재 제공하는 검증 명령을 확인하고, 결과는 해당 테스트·CI 실행 기록에서 확인하세요.

자동 검증은 실기기·Safari·스크린리더 실청취·실발송·고객 수용·운영 배포를 입증하지 않습니다. 실기기 확인에는 [확인 목록](scripts/device-checklist.md)을 사용하고, 운영 수용 기록은 `ops/acceptance.example.json`을 기준으로 저장소 밖에 작성합니다.

## 정본

- [제품 경계](PRODUCT.md) · [고객 요구·미확정 범위](docs/CONTRACT-SCOPE.md)
- [인증·권한·데이터 계약](docs/ARCHITECTURE.md)
- [배포·백업·복구](docs/DEPLOY.md) · [외부 연동·실발송](docs/INTEGRATIONS.md)
- [UX 계약](UX-CONTRACT.md) · [디자인 입력](DESIGN.md)
- 프로젝트 작업 원칙: [AGENTS.md](AGENTS.md)
