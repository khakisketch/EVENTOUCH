# EVENTOUCH 실제품 백엔드 설계 (2026-10-05)

> 목표: 샘플·데모가 아닌 실제 운영 제품. Tailscale 내부 운영 + 외부 공개 배포 가능 구조. 전체 흐름 일괄.
> 사용자 승인: 아키텍처 1~4항 승인, 추가 질문 없이 완성까지 진행. 화면 디자인은 완성 후.

## 1. 아키텍처

- 프론트: 기존 정적 파일 그대로(같은 저장소). 경로·브랜드·권한 체계 유지.
- API 서버: Node 내장 모듈만(`node:http`, `node:crypto`, `node:fs`). 의존성 추가 없음.
- 영속 저장: 원자적 쓰기 JSON 파일 저장소(단일 서버, 파일 락 대신 tmp+rename). 인터페이스 뒤에 두어 추후 Postgres 교체 가능.
- 파일 저장: `STORAGE_DIR/eventouch/{photos,reports,exports}`. NAS는 나중에 해당 경로로 마운트, API로만 접근.
- 배포 산출물까지만 만든다: `Dockerfile`·compose 예시·Vercel 정적 설정. 실제 배포·NAS 마운트는 별도 승인.

## 2. 인증·권한

- 사용자: id, 이름, 역할(AGENCY/MANAGER/CLIENT/STAFF/VIEWER), 담당 행사 범위, scrypt 해시 비밀번호.
- 세션: httpOnly 쿠키, 만료 시간. 모든 쓰기 API가 서버에서 역할 검증(기존 canRoute/requireWrite 대응).
- 시드 관리자 1명. 비밀값은 환경변수, 저장소 기록 금지.

## 3. 데이터·API

- 저장 형태는 기존 `ETKO.store` v1(event·workspace·참가자·프로그램·공지·부스·데스크·기록·투표·퀴즈·Q&A·드로우·사진·메시지·보고서)을 그대로 서버로 이관.
- REST `/api/*`: auth(로그인·로그아웃·내 정보), events, participants, checkin, booths, engagement(투표·퀴즈·Q&A·드로우·만족도·사진 상태 전이), content, messages(초안·예약 저장, 발송은 SIMULATION_ONLY 유지), results/reports, files(업로드·다운로드).
- 프론트 이관: fetch 어댑터(쿠키 세션), 서버 정식 저장. 체크인 오프라인 큐는 클라이언트에 유지.

## 4. 수용 기준

- API 테스트: 인증 매트릭스(역할×쓰기), 전체 흐름(생성→신청→체크인→결과), 중복·중복 거부·복구 경로.
- 브라우저: 로그인→운영 흐름, 4 viewport overflow 없음, 콘솔 0건.
- 비밀값·개인정보가 저장소·로그에 없음.

## 5. 제외

- 문자·결제 실제 연동(계약 유지, 시뮬레이션 표시). 소셜 로그인. Vercel 실제 배포 행위. NAS 실마운트.

## 단계

- S1 인증+저장소 → S2 도메인 API → S3 파일 저장 → S4 프론트 어댑터 → S5 배포 산출물+최종 검증.
