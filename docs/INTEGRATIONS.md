# EVENTOUCH 연동 계약서

> 아래 "퇴역 브라우저 심"(`ETKO.*`, 시뮬레이션 전용)은 역사 기록으로 보존한다.
> 현재 서버 연동 계약이 아니다. 계정 복구 이메일과 행사 메시지는 각각 아래 현재
> 연동 절을 따른다. 이메일 복구는 참가자 SMS 경로와 별개다.
> 저장소에 자격증명·키·토큰을 넣지 않습니다.

## 퇴역 브라우저 심 (역사 기록, 현재 지침 아님)

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

## 계정 이메일 인증·복구 (실제 발송 미연동)

`server/email-transport.js`는 계정 이메일 확인과 비밀번호 복구를 위한 공급사 중립
연결 지점이다. 현재 서버 시작 경로에는 실제 메일 공급사가 연결되어 있지 않다.
공급사·비용·자격증명과 통합 방법은 별도 결정이 필요하며, 참가자용 Solapi SMS나
조직별 발송 자격증명을 계정 복구에 임의로 재사용하지 않는다.

- 기본값은 발송 불가다. `EVENTOUCH_PUBLIC_URL`도 유효한 제품 웹 주소여야 링크를
  만들 수 있다. URL이나 모의 플래그만 설정한다고 실제 발송이 연결되지는 않는다.
- `EVENTOUCH_MAIL_MOCK=1`은 **격리 개발·검증 전용**이다. 프로세스 메모리에
  모의 메일을 기록하며 실제 이메일을 보내지 않는다. 운영 발송으로 취급하지 않는다.
- 메일 링크의 일회용 bearer는 URL fragment에 담아 웹·프록시 요청에 넣지 않으며,
  DB에는 해시만 보관한다. 실제 공급사 연동 시 토큰·주소·본문을 로그나 분석기에
  노출하지 않아야 한다. 공급사의 링크 재작성 등 실발송 경로는 아직 검증하지 않았다.
- 유효기간 경과는 링크 사용을 막는 것이지 증명 행을 자동 삭제하는 정책이 아니다.
  인증 시각·이메일 증명 기록의 보존 및 정리 기준은 별도 결정이 필요하다.
- 사전 인증 없이 이미 잠긴 계정을 위한 수동 본인 확인 담당자와 절차는 미정이다.
  이 문서는 조직 소유자에게 공유 계정 전역 재설정 권한을 부여하지 않는다.

## 실제 메시지 발송 (SMS · LMS · 알림톡, Solapi)

기본값은 미연동이다. 아래 값이 설정된 경우에만 실제로 발송한다.

    SOLAPI_API_KEY=          # Solapi 콘솔 > API Key 관리
    SOLAPI_API_SECRET=
    SOLAPI_SENDER=0212345678 # 사전 등록한 공통 발신번호 (숫자만)
    SOLAPI_KAKAO_PFID=PF...  # 카카오 채널 프로필 ID. 없으면 알림톡 발송 불가
    EVENTOUCH_PUBLIC_URL=https://eventouch.example.com  # {{티켓링크}} 기준 주소

키와 시크릿이 모두 있고 발신번호까지 있어야 연결로 본다. 키만 있고 시크릿이
없으면 서명을 만들 수 없으므로 미연동으로 남긴다.

### 인증

Solapi는 Bearer 토큰이 아니라 HMAC-SHA256 서명을 쓴다.

    Authorization: HMAC-SHA256 apiKey=<KEY>, date=<ISO 8601>, salt=<랜덤>, signature=<HMAC>

서명은 `date + salt`를 `API_SECRET`으로 HMAC-SHA256 한 16진수다. 요청마다
salt를 새로 만들고, 서버 시각이 Solapi 기준 ±15분을 넘으면 거부된다. 서버의
시계 동기화(NTP)가 필수다.

### 요청

    POST https://api.solapi.com/messages/v4/send-many/detail
    { "messages": [ { "to": "01012345678", "from": "0212345678",
                      "text": "본문", "type": "SMS" } ], "showMessageList": true }

캠페인 전체를 한 번의 호출로 보낸다. 수신번호는 **숫자만** 넣어야 한다.
제품 데이터는 하이픈이 들어 있으므로 어댑터가 정규화한다.

### 채널 선택

| 요청 | 동작 | 근거 |
|---|---|---|
| SMS | 90바이트 이하만. 초과 시 LMS로 자동 승격 | Solapi autoTypeDetect |
| LMS | 장문. 제목(subject) 선택 | LMS/MMS 전용 필드 |
| MMS | 사진 문자. JPG 200KB 이하 1장 + 본문 2000바이트. 캠페인이 행사 저장 파일 1장을 지정하면 발송 시 저장소(`POST /storage/v1/files`, base64)에 1회 올려 `imageId`로 참조한다. PNG·초과는 캠페인 등록 전에 거부한다 | Solapi MMS 규격 |
| 알림톡 | 승인 템플릿 + 채널 필요 | 자유 문구 발송 불가 |

바이트는 **한글 1자 = 2바이트**로 계산한다. 그래서 SMS 한도가 흔히 "한글 45자"로
불린다. 행사 안내문은 대부분 이 한도를 넘으므로 LMS로 나가는 것이 정상이다.

### 알림톡 템플릿

알림톡은 사전 승인된 템플릿으로만 발송된다. 그래서 제품 템플릿에 Solapi
템플릿 ID를 연결해야 하며, 연결이 없으면 **캠페인 생성 자체를 거부**한다.
발송 불가능한 캠페인을 만들어 두는 것보다 낫다.

1차 승인 대상 3종 (제안서 문구 기준):

| 템플릿 | 채널 | 본문 |
|---|---|---|
| 행사 안내 | 알림톡 | {{이름}}님, {{행사명}}에 오신 것을 환영합니다. 모바일 티켓을 준비해주세요. |
| 하루 전 리마인드 | 알림톡 | 등록하신 행사가 내일 진행됩니다. 모바일 티켓을 준비해주세요. |
| 만족도 안내 | SMS | 오늘의 경험을 들려주세요. 여러분의 의견을 기다립니다. |

변수는 `{{이름}} {{행사명}} {{행사일}} {{티켓링크}} {{럭키번호}}` 5종이며 Solapi의
`#{변수명}` 형식으로 변환된다. `{{티켓링크}}`는 개인 티켓 링크이므로
**저장하지 않고 발송 시점에만 만든다.** 캠페인 이력에 티켓 bearer가 남으면
안 된다.

`EVENTOUCH_PUBLIC_URL`은 **참가자 Next 앱을 실제로 제공하는 공개 주소**여야 한다.
개인 링크는 `/event/:slug/home?ticket=...`로 연결된다. API만 제공하는 주소를
지정하지 않는다. `http(s)`만 허용하고 사용자명·비밀번호·쿼리·프래그먼트가 있는
주소는 거부한다. `{{티켓링크}}`를 요청한 캠페인에서 주소가 없거나 잘못되면
발송 의도를 저장하기 전에 409로 거부한다. 커밋 후 발송 대기 중 주소가 사라져도
자리표시자를 보내지 않고 outbox에 남겨 설정 복구 후 재처리한다.

`{{럭키번호}}`를 쓰는 초대는 운영 콘솔의 `추첨·투표`에서 번호를 먼저 배정한다.
대상자 중 미배정 인원이 있으면 실제 발송 요청을 409로 거부하며 빈칸으로 보내지 않는다.
번호 풀과 배정 대상은 운영자가 설정하고, 이미 배정된 번호는 유지한다.

### 대체발송

알림톡이 실패하면 문자로 자동 대체된다(`disableSms: false`). 수신자가
카카오 채널을 차단했거나 템플릿이 반려된 경우에도 안내가 도달한다.
대체발송 건은 `replacedFallback`으로 표시해 알림톡으로 도착하지 않았음을
운영자가 알 수 있게 한다. **대체발송은 별도 요금이 발생한다.**

### 접수와 도달은 다르다

이게 이 연동에서 가장 중요한 성질이다. `send-many`의 2xx 응답은
**접수 결과**이며 도달 결과가 아니다. 그래서:

| 상태 | 의미 |
|---|---|
| `NEEDS_CONNECTION` | 공급사 미연동. 발송 안 됨 |
| `SIMULATED` | 시뮬레이션 기록. 발송 안 됨 |
| `SENDING` | 공급사가 접수함. **도달 미확인** |
| `SENT` | 전 수신자 도달 확인 |
| `PARTIAL` | 일부만 도달 |
| `FAILED` | 전부 실패 또는 전부 접수 거부 |
| `CANCELLED` | 취소 |

접수를 곧 발송으로 올림하지 않는다. 수신자별로 `SENDING → SENT/FAILED`가
따로 기록되고, 실패 사유와 Solapi 상태코드가 함께 남는다.

### 참가자 인증번호 발송 (선구현)

참가자 연락처 확인·복구용 6자리 인증번호는 같은 Solapi SMS 경로로 나간다
(`server/verification-transport.js`). 문구 형식:

    [EVENTOUCH] 인증번호 123456 (행사명)

짧은 SMS 한도(90바이트) 안에 들어가므로 항상 SMS로 발송되고 LMS로 승격되지
않는다. 캠페인 outbox와는 별도 경로다: 인증번호는 발송 후에도 DB에 남지
않으며(해시만 저장), 재시도는 새 인증번호 발급(재전송 간격 60초·일 10회 제한)으로 처리한다.

모드 선택(명시적, 조용한 기본값 없음):

| 조건 | 동작 |
|---|---|
| Solapi 3종(`SOLAPI_API_KEY`·`SOLAPI_API_SECRET`·`SOLAPI_SENDER`) 설정 | 실제 SMS 발송 |
| `EVENTOUCH_SMS_MOCK=1` | 모의 기록(프로세스 메모리 + 데모 서버 로그). HTTP 응답에 코드가 절대 포함되지 않음 |
| 둘 다 없음 | `NOT_CONFIGURED` → 인증 요청에 503. 발송된 것처럼 속이지 않음 |

실발송 검증 체크리스트(자격증명 확보 후): SMS 1건 도달 확인 →
서버 로그·DB·응답에 코드 잔류 없음 확인 → 재전송 간격·일 한도·시도 횟수
초과 동작 확인 → `/api/health`의 `verification`이 `solapi`로 표시됨 확인.

### 도달 확인 (폴링)

    GET https://api.solapi.com/messages/v4/list?messageIds=["M1","M2"]&limit=500

운영자가 캠페인 상세에서 **발송 결과 확인**을 누르면 조회한다. 기본 동작은 수동이며
아래 유지보수 옵션을 명시적으로 켜기 전에는 상시 폴링하거나 예약을 자동 실행하지 않는다.
조회는 페이지를 이어서 수집하고, 일부 수신자 ID만 없어도 그 부분을 다시 연결한다.

상태 해석:

- `PENDING`/`SENDING` → 미확정 (SENDING 유지)
- `COMPLETE` + 상태코드 4xxx → 도달
- `COMPLETE` + 4xxx 미만 → 실패

미확정 수신자가 하나라도 있으면 캠페인은 `SENDING`으로 남는다. 모르는 것을
결과로 단정하지 않는다.

### 재시작 복구와 선택적 유지보수

- outbox 복구는 공급사 보유 증거가 있으면 다시 보내지 않는다. 명시적 미보유와
  조회 실패·429·타임아웃·빈 성공 응답을 구분하며, 확인 불가는 큐를 보존하고 다시 확인한다.
- 공급사 조회는 행사 행 잠금 밖에서 실행한다. 결과 반영 때 최신 상태를 다시 확인하여
  조회 중 취소·새 발송을 덮어쓰지 않는다. 접수와 도달은 여전히 서로 다른 사실이다.
- `EVENTOUCH_MESSAGE_MAINTENANCE=1`은 주기적 outbox 재처리와 도달 확인을 켠다.
  `EVENTOUCH_MESSAGE_MAINTENANCE_INTERVAL_MS`로 간격을 지정한다. 기본은 꺼짐이다.
- **예약 자동 실행은 별도** `EVENTOUCH_MESSAGE_AUTO_SEND_DUE=1`이 필요하다. 두 옵션 없이
  기존 예약의 수동 실행 의미는 바뀌지 않는다. 자동 실행을 활성화하기 전 발신·비용 정책을 확인한다.
- 수동 실행과 자동 실행은 기한·공개 주소·럭키번호 등의 같은 서버 가드를 사용한다.
  공급사 미연결·취소·모의 캠페인을 실제 발송으로 승격하지 않는다.
- 공급사의 실제 미보유 응답 형태·대량 조회·실발송은 운영 계정에서 후검증해야 한다.
  코드의 모의 검증을 실제 공급사 검증으로 부르지 않는다.

### 사용량 제한

Solapi는 발송 100회/5초, 조회 20회/5초로 제한한다. 초과 시 429가 오고
`x-retry-after` 헤더로 대기 시간을 알려준다. 캠페인 단위 배치 호출이라
일반적인 행사 규모에서는 문제되지 않는다.

### 요금

문자·알림톡 요금은 **행사대행 운영사가 부담**한다(사용자 확정). 캠페인에
단가를 표시하지 않으며 청구 화면도 두지 않는다. 대체발송이 발생하면
문자 요금이 추가된다.

### 실발송 검증 체크리스트

코드와 테스트는 mock으로 검증되어 있다. 실제 발송 확인에는 아래가 필요하다.

- [ ] Solapi 콘솔에서 API Key/Secret 발급, 비밀 저장소에 보관
- [ ] 발신번호 등록 (공통 1개)
- [ ] 카카오 채널 연결 후 `pfId` 확보
- [ ] 위 3종 템플릿 승인 요청 → 승인 후 `templateId` 확보
- [ ] 테스트 수신번호로 SMS/LMS 1건씩 실발송
- [ ] MMS 1건 실발송(이미지 접수·도달 확인. 업로드 응답의 이미지 ID 매핑은 모의로만 검증됨)
- [ ] 알림톡 1건 + 대체발송 1건(채널 차단 상태) 확인
- [ ] `/api/health`의 `messaging`이 true, `messagingProvider`가 `solapi`인지 확인
- [ ] 서버 시각이 NTP로 동기화되어 있는지 확인 (±15분 제약)

확인 전에는 "실발송 검증 완료"라고 말하지 않는다.

## 하지 않는 것

- 실제 발송·청구·인증·장비 제어 없음
- 자격증명·개인정보의 외부 전송 없음
- `SENT`·`charged:true` 상태의 생성 없음
