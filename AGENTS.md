# EVENTOUCH 개발 지침

- 실행 동작의 정본은 코드와 테스트다. 문서는 고객·보안·데이터·운영 계약에만 둔다.
- 운영 데이터·파일·자격증명·볼륨을 초기화하거나 덮어쓰지 않는다. 운영 DB·배포·실발송은 별도 승인 없이 실행하지 않는다.
- 쓰기 경로의 권한·트랜잭션·멱등 영수증·감사 및 커밋 후 발송 경계를 보존한다: [시스템·데이터 계약](docs/ARCHITECTURE.md).
- 합성·자동 검증은 실기기·실발송·고객 수용·운영 검증을 대신하지 않는다.
- 문서는 정본 주제가 달라질 때만 갱신한다. 작업 이력은 Git에 맡긴다.

## 필요한 정본

- 시작·검증: [README.md](README.md), [배포·백업](docs/DEPLOY.md)
- 고객 요구와 미확정 수용 범위: [계약 범위](docs/CONTRACT-SCOPE.md)
- 외부 연동·실발송 수용: [연동 계약](docs/INTEGRATIONS.md)
- 화면 계약·디자인 입력: [UX-CONTRACT.md](UX-CONTRACT.md), [DESIGN.md](DESIGN.md)
- 실제 기기 확인 입력: [scripts/device-checklist.md](scripts/device-checklist.md)

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `GLOSSARY.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.
