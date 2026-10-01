# EVENTOUCH 연동 계약서

> 기본 모드: `SIMULATION`. 이 빌드는 외부 호출을 하지 않습니다.
> 실제 provider는 아래 인터페이스를 구현해 `ETKO.registerProvider`로 교체합니다.
> 저장소에 자격증명·키·토큰을 넣지 않습니다.

## 공통

- `ETKO.integrationMode()` → `'SIMULATION'` (고정)
- `ETKO.integrationAreas()` → `['auth','messages','payments','devices']`
- `ETKO.registerProvider(area, name, impl)` — 미지원 영역은 `연동 영역을 확인하세요`
- `ETKO.providerFor(area)` — 미등록 시 simulation provider

## 인증 (auth)

- `ETKO.login({email, role?})` → `{token, role, demo:true}`
  - 토큰은 `DEMO-` opaque 문자열이며 비밀번호를 다루지 않는다
  - 미등록 이메일 → `등록된 구성원이 아닙니다`
  - 역할 불일치 → `권한을 확인하세요` (세션 승격 불가)
- `ETKO.session()` → 복사본 또는 null / `ETKO.logout()` → null
- 실제 provider 구현 조건: 구성원 저장소 조회 + 서명된 세션 + 만료

## 메시지 (messages)

- `ETKO.sendCampaign(campaignId)` → `{status:'QUEUED_SIMULATION', outboxId}`
  - 미보관 캠페인 → `캠페인을 찾을 수 없습니다`
  - 발송함은 불변 outbox 항목 `{channel, toCount, body, at, delivery:'SIMULATION_ONLY'}`
  - provider 교체 시에만 `impl.send(entry)` 호출, 상태는 SENT를 주장하지 않음
- `ETKO.outbox()` → 복사 배열

## 결제 (payments)

- `ETKO.createPaymentIntent({amount, currency?, description?})` → `{id, status:'SIMULATION_ONLY', charged:false, ...}`
  - 양의 정수가 아니면 → `결제 금액을 확인하세요`
- `ETKO.paymentStatus(id)` → 스냅샷 복사 / 미존재 → `결제 내역을 찾을 수 없습니다`
- 실제 provider 구현 조건: 결제 게이트웨이 승인·청구·웹훅 검증 (이 저장소 밖)

## 장비 (devices)

- `ETKO.boothPayload(eventId, boothId)` → `` `ET:BOOTH:<eventId>:<boothId>` `` (공개 식별자, 암호화 아님)
- `ETKO.parseBoothPayload(text)` → `{eventId, boothId}` / 형식 위반 → `부스 QR을 확인하세요`
- `ETKO.deviceCaps()` → `{camera:false, printer:false, led:false, simulated:true}`
- `ETKO.deviceLabel(key)` → 카메라/프린터/전광판/부스 QR
- `ETKO.markPrinted(boothId, format?)` → 출력 확인 기록 (실제 인쇄 없음) / 미등록 부스 → `부스를 확인하세요`

## 하지 않는 것

- 실제 발송·청구·인증·장비 제어 없음
- 자격증명·개인정보의 외부 전송 없음
- `SENT`·`charged:true` 상태의 생성 없음
