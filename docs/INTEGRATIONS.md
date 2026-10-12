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

## 실제 메시지 발송 (SMS · 알림톡)

기본값은 미연동이다. 아래 두 값이 모두 설정된 경우에만 실제로 발송한다.

    EVENTOUCH_MESSAGING_ENDPOINT=https://<공급사 또는 중계 서버>/send
    EVENTOUCH_MESSAGING_TOKEN=<발급받은 토큰>
    EVENTOUCH_MESSAGING_SENDER=0212345678   # 발신번호 (선택)

### 동작 방식

EVENTOUCH는 특정 공급사 SDK에 의존하지 않는다. 아래 한 가지 형태로만 요청한다.

    POST <EVENTOUCH_MESSAGING_ENDPOINT>
    authorization: Bearer <EVENTOUCH_MESSAGING_TOKEN>
    content-type: application/json

    { "from": "0212345678", "to": "01012345678",
      "text": "본문", "channel": "SMS" | "ALIMTALK",
      "reference": "<캠페인ID>:<참가자ID>" }

성공은 `2xx` + `{"ok": true, "id": "..."}` 로 판단한다. 그 밖의 응답,
`ok:false`, 타임아웃(10초), 연결 실패는 모두 발송 실패로 기록한다.
`200` 이어도 `ok:false` 면 성공으로 보지 않는다.

### 검증 상태

`/api/health` 응답의 `messaging` 값이 실제 연결 여부다. 콘솔의
**서비스 연동** 화면도 같은 값을 표시한다. 값을 확인하려고 시험 발송을
할 필요가 없다.

### 캠페인 상태

| 상태 | 의미 |
|---|---|
| `SIMULATED` | 시뮬레이션으로 기록. 발송하지 않음 |
| `NEEDS_CONNECTION` | 대상 확정, 공급사 미연동. 발송 안 됨 |
| `SENDING` | 발송 커밋됨, 결과 기록 중 |
| `SENT` | 모든 수신자 발송 확인 |
| `PARTIAL` | 일부만 성공. 실패 건은 수신자별로 사유 기록 |
| `FAILED` | 전부 실패 |

`PARTIAL`과 `FAILED`를 `SENT`로 올림하지 않는다. 수신자별 결과
(`SENT`/`FAILED` + 공급사 메시지 ID 또는 실패 사유)를 함께 저장한다.

### 공급사가 다른 형식을 요구할 때

대부분의 국내 공급사는 위 형태와 다르다. 이 경우 공급사 앞에 얇은 변환
서버를 두고 `EVENTOUCH_MESSAGING_ENDPOINT`가 그 서버를 가리키게 한다.
EVENTOUCH 코드를 고칠 필요가 없다. 변환 서버는 토큰 검증, 공급사 형식
변환, 결과 매핑만 담당하면 된다.

### 발송 시점

발송은 명령 트랜잭션이 **커밋된 뒤** 실행된다. 공급사 호출이 느려도 행사
행 잠금을 붙잡지 않고, 공급사가 접수한 메시지를 우리 트랜잭션 롤백으로
잃는 일도 없다. 같은 `commandId` 재요청은 재발송하지 않는다.

### 개인정보

수신자 전화번호는 행사 워크스페이스에 저장된 값을 사용한다. 발송 시
공급사로 전달되므로, 계약·보유기간·국외이전 여부를 고객사와 먼저
확정한다. 이 저장소에는 어떤 전화번호도 커밋하지 않는다.

## 하지 않는 것

- 실제 발송·청구·인증·장비 제어 없음
- 자격증명·개인정보의 외부 전송 없음
- `SENT`·`charged:true` 상태의 생성 없음
